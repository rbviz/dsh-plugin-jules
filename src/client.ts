/**
 * A dependency-free client for the Jules v1alpha REST API.
 *
 * The Jules CLI is not usable here: it authenticates with an interactive OAuth
 * flow kept in the OS keyring, reads no `JULES_*` environment variable, emits
 * no machine-readable output, and talks to an internal backend rather than the
 * documented v1alpha service. The REST API is therefore the only interface a
 * long-running harness plugin can drive, and it needs nothing beyond `fetch`.
 *
 * @module dsh-plugin-jules/client
 */

import type {
  Activity, CreateSessionRequest, ListActivitiesResponse, ListSessionsResponse,
  ListSourcesResponse, Session, Source,
} from './types.ts'

/** A Jules API call failed. */
export class JulesError extends Error {
  /** HTTP status, when the failure came from a response. */
  readonly status: number | undefined

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JulesError'
    this.status = status
  }
}

/** The API rejected the credential, or no credential was configured. */
export class JulesAuthError extends JulesError {
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, status, options)
    this.name = 'JulesAuthError'
  }
}

/** The API asked the caller to slow down and the retry budget was exhausted. */
export class JulesRateLimitError extends JulesError {
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, status, options)
    this.name = 'JulesRateLimitError'
  }
}

/** The named resource does not exist, or is not visible to this credential. */
export class JulesNotFoundError extends JulesError {
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, status, options)
    this.name = 'JulesNotFoundError'
  }
}

/** One request outlived its configured deadline. */
export class JulesTimeoutError extends JulesError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, undefined, options)
    this.name = 'JulesTimeoutError'
  }
}

/** The transport failed before a response arrived. */
export class JulesNetworkError extends JulesError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, undefined, options)
    this.name = 'JulesNetworkError'
  }
}

/** Retry policy for the transient failures the service documents. */
export interface JulesRetryOptions {
  /** Total number of attempts, including the first. Defaults to 4. */
  maxAttempts: number
  /** First backoff step in milliseconds; doubles per attempt. Defaults to 1000. */
  baseDelayMs: number
  /** Ceiling for one backoff step in milliseconds. Defaults to 30000. */
  maxDelayMs: number
}

/** Everything one client needs to reach the service. */
export interface JulesClientOptions {
  /** Resolved API key. Read per request, so a rotation lands on the next call. */
  resolveApiKey: () => Promise<string | undefined>
  /** API root without a trailing slash. */
  baseURL: string
  /** Per-request deadline in milliseconds. */
  requestTimeoutMs: number
  /** Page size used when a caller does not choose one. */
  defaultPageSize: number
  /** Largest page size the service accepts. */
  maxPageSize: number
  /** Retry policy for 429 and 5xx responses. */
  retry: JulesRetryOptions
  /** Optional `User-Agent`, sent when the runtime allows it. */
  userAgent?: string
  /**
   * Test seam: replaces the global `fetch`.
   *
   * The suite drives every retry, timeout, and error-classification path through
   * this rather than through a mock server, so the transport is the only thing
   * swapped out — request construction and response handling stay the real code.
   */
  fetchImpl?: typeof fetch
}

/** One query string entry; `undefined` entries are dropped. */
type QueryValue = string | number | undefined

/** What every request accepts. */
interface RequestOptions {
  query?: Record<string, QueryValue>
  body?: unknown
  /** Caller cancellation, normally a tool call's `exec.signal`. */
  signal?: AbortSignal
}

/** Error envelope the service returns for a non-2xx response. */
interface ErrorEnvelope {
  error?: { code?: number; message?: string; status?: string }
}

/**
 * The statuses a retry can plausibly fix.
 *
 * Deliberately not "any 5xx": 501 and 505 mean the service does not implement
 * what was asked, and 400/401/403/404 are decisions rather than accidents.
 * Retrying those would spend the caller's deadline re-asking a question that was
 * already answered. 502/503/504 are gateway and availability failures, which are
 * the transient kind.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * Sleep, resolving early when the caller cancels.
 * @param ms - milliseconds to wait.
 * @param signal - cancellation signal.
 */
async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read the service's error envelope without trusting its shape.
 * @param response - the failed response.
 * @returns the message to surface, or a status-derived fallback.
 */
async function errorMessage(response: Response): Promise<string> {
  const fallback = `Jules API request failed with HTTP ${response.status}`
  try {
    const text = await response.text()
    if (text.length === 0) return fallback
    const parsed = JSON.parse(text) as ErrorEnvelope
    const message = parsed.error?.message
    return typeof message === 'string' && message.length > 0 ? message : fallback
  } catch {
    return fallback
  }
}

/**
 * Map a status and message onto the most specific error class.
 * @param status - HTTP status of the response.
 * @param message - service-supplied message.
 * @returns the error to throw.
 */
function errorFor(status: number, message: string): JulesError {
  if (status === 401 || status === 403) return new JulesAuthError(message, status)
  if (status === 404) return new JulesNotFoundError(message, status)
  if (status === 429) return new JulesRateLimitError(message, status)
  return new JulesError(message, status)
}

/**
 * Build the AIP-160 expression that selects activities newer than a cursor.
 *
 * The API reference documents `?createTime=<rfc3339>`, but the service rejects
 * it outright — "Cannot bind query parameter. Field 'createTime' could not be
 * found in request message" — so this sends the filter expression the official
 * Jules SDK uses instead. Because that form is not in the reference, callers
 * must treat a rejected cursor as a bandwidth problem rather than a failure;
 * {@link runWatch} does exactly that.
 * @param since - RFC 3339 timestamp; strictly newer activities are returned.
 * @returns the filter expression.
 */
export function activitiesSinceFilter(since: string): string {
  return `create_time>"${since}"`
}

/** Drive the Jules v1alpha REST API. */
export class JulesClient {
  readonly #options: JulesClientOptions

  constructor(options: JulesClientOptions) {
    this.#options = options
  }

  /**
   * Perform one authenticated request, retrying the transient failures the
   * service documents.
   * @param method - HTTP method.
   * @param path - path below the API root, starting with `/`.
   * @param options - query, body, and caller cancellation.
   * @returns the decoded JSON body, or `undefined` for an empty response.
   * @throws {JulesAuthError} when no key is configured or the key is rejected.
   * @throws {JulesRateLimitError} when 429 persists past the retry budget.
   * @throws {JulesTimeoutError} when the deadline passes first.
   * @throws {JulesNetworkError} when the transport fails.
   * @throws {JulesError} for every other non-2xx response.
   */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const apiKey = await this.#options.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new JulesAuthError(
        'No Jules API key is configured. Create one at https://jules.google.com/settings '
        + 'and expose it as the credential named by the "apiKeyEnv" option (JULES_API_KEY by default).',
      )
    }
    const url = new URL(this.#options.baseURL + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = {
      'X-Goog-Api-Key': apiKey,
      Accept: 'application/json',
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.#options.userAgent !== undefined) headers['User-Agent'] = this.#options.userAgent

    const { maxAttempts, baseDelayMs, maxDelayMs } = this.#options.retry
    let lastError: JulesError | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      options.signal?.throwIfAborted()
      const timeout = AbortSignal.timeout(this.#options.requestTimeoutMs)
      const signal = options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout])
      let response: Response
      try {
        response = await (this.#options.fetchImpl ?? fetch)(url, {
          method,
          headers,
          ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
          signal,
        })
      } catch (error) {
        // Caller cancellation is not this client's failure to report.
        options.signal?.throwIfAborted()
        if (timeout.aborted) {
          throw new JulesTimeoutError(
            `Jules API ${method} ${path} exceeded ${this.#options.requestTimeoutMs} ms`,
            { cause: error },
          )
        }
        throw new JulesNetworkError(`Jules API ${method} ${path} could not be reached`, { cause: error })
      }

      if (response.ok) {
        // :approvePlan and :sendMessage answer with an empty body, and 204 has no
        // body by definition. Both mean "it worked", not "the response was
        // missing", so they resolve to undefined rather than failing a parse.
        if (response.status === 204) return undefined as T
        const text = await response.text()
        if (text.length === 0) return undefined as T
        try {
          return JSON.parse(text) as T
        } catch (error) {
          // A 2xx that is not JSON is a broken endpoint or a proxy in the way,
          // not a caller mistake; it belongs in this client's error taxonomy
          // rather than surfacing as a bare SyntaxError.
          throw new JulesError(
            `Jules API ${method} ${path} returned a body that is not JSON`,
            response.status,
            { cause: error },
          )
        }
      }

      const message = await errorMessage(response)
      const failure = errorFor(response.status, message)
      if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) {
        if (response.status === 429 && attempt === maxAttempts) {
          throw new JulesRateLimitError(
            `${message} (gave up after ${attempt} attempts)`, response.status,
          )
        }
        throw failure
      }
      lastError = failure
      const retryAfter = Number(response.headers.get('retry-after'))
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : baseDelayMs * 2 ** (attempt - 1)
      await delay(Math.min(backoff, maxDelayMs), options.signal)
    }
    /* c8 ignore next -- the loop returns or throws on its final attempt */
    throw lastError ?? new JulesError('Jules API request failed')
  }

  /**
   * Bounded page size for one list call.
   *
   * Clamped rather than rejected: a page size is a preference, and a caller
   * asking for more than the service allows should get the largest page there
   * is, not a failed call. The service rejects out-of-range values outright, so
   * this is what keeps a model-supplied number from turning into an error.
   * @param requested - the caller's preference, when it expressed one.
   * @returns a page size the service accepts.
   */
  #pageSize(requested: number | undefined): number {
    const { defaultPageSize, maxPageSize } = this.#options
    const wanted = requested ?? defaultPageSize
    return Math.max(1, Math.min(Math.trunc(wanted), maxPageSize))
  }

  /**
   * List the repositories connected to Jules.
   * @param options - paging and cancellation.
   * @returns one page of sources.
   */
  async listSources(options: { pageSize?: number; pageToken?: string; signal?: AbortSignal } = {}): Promise<ListSourcesResponse> {
    return this.request<ListSourcesResponse>('GET', '/sources', {
      query: { pageSize: this.#pageSize(options.pageSize), pageToken: options.pageToken },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
  }

  /**
   * Read one connected repository.
   * @param name - canonical source resource name.
   * @param signal - cancellation signal.
   * @returns the source.
   */
  async getSource(name: string, signal?: AbortSignal): Promise<Source> {
    return this.request<Source>('GET', `/${name}`, { ...signal === undefined ? {} : { signal } })
  }

  /**
   * Create a session, which starts the remote agent immediately.
   * @param input - prompt, optional source context, and automation flags.
   * @param signal - cancellation signal.
   * @returns the created session.
   */
  async createSession(input: CreateSessionRequest, signal?: AbortSignal): Promise<Session> {
    return this.request<Session>('POST', '/sessions', { body: input, ...signal === undefined ? {} : { signal } })
  }

  /**
   * List sessions visible to this credential, newest first.
   * @param options - paging and cancellation.
   * @returns one page of sessions.
   */
  async listSessions(options: { pageSize?: number; pageToken?: string; signal?: AbortSignal } = {}): Promise<ListSessionsResponse> {
    return this.request<ListSessionsResponse>('GET', '/sessions', {
      query: { pageSize: this.#pageSize(options.pageSize), pageToken: options.pageToken },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
  }

  /**
   * Read one session, including its outputs once it finishes.
   * @param id - bare session id.
   * @param signal - cancellation signal.
   * @returns the session.
   */
  async getSession(id: string, signal?: AbortSignal): Promise<Session> {
    return this.request<Session>('GET', `/sessions/${encodeURIComponent(id)}`, { ...signal === undefined ? {} : { signal } })
  }

  /**
   * Read a session's event log, oldest first.
   * @param id - bare session id.
   * @param options - paging, an optional `since` cursor, and cancellation.
   * @returns one page of activities.
   */
  async listActivities(
    id: string,
    options: { pageSize?: number; pageToken?: string; since?: string; signal?: AbortSignal } = {},
  ): Promise<ListActivitiesResponse> {
    return this.request<ListActivitiesResponse>('GET', `/sessions/${encodeURIComponent(id)}/activities`, {
      query: {
        pageSize: this.#pageSize(options.pageSize),
        pageToken: options.pageToken,
        filter: options.since === undefined ? undefined : activitiesSinceFilter(options.since),
      },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
  }

  /**
   * Read every activity page, oldest first.
   *
   * The event log is append-only and immutable, so walking it whole is safe;
   * the page cap keeps a runaway log from consuming unbounded memory.
   * @param id - bare session id.
   * @param options - page cap, cursor, and cancellation.
   * @returns every activity the walk collected.
   */
  async listAllActivities(
    id: string,
    options: { maxPages?: number; since?: string; pageSize?: number; signal?: AbortSignal } = {},
  ): Promise<Activity[]> {
    const maxPages = options.maxPages ?? 10
    const collected: Activity[] = []
    let pageToken: string | undefined
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.listActivities(id, {
        pageSize: options.pageSize ?? this.#options.maxPageSize,
        ...pageToken === undefined ? {} : { pageToken },
        ...options.since === undefined ? {} : { since: options.since },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      collected.push(...response.activities ?? [])
      pageToken = response.nextPageToken
      if (pageToken === undefined || pageToken.length === 0) break
    }
    return collected
  }

  /**
   * Approve the plan a session is waiting on.
   * @param id - bare session id.
   * @param signal - cancellation signal.
   */
  async approvePlan(id: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>('POST', `/sessions/${encodeURIComponent(id)}:approvePlan`, {
      body: {},
      ...signal === undefined ? {} : { signal },
    })
  }

  /**
   * Send a message to the session's agent.
   * @param id - bare session id.
   * @param prompt - what to tell the agent.
   * @param signal - cancellation signal.
   */
  async sendMessage(id: string, prompt: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>('POST', `/sessions/${encodeURIComponent(id)}:sendMessage`, {
      body: { prompt },
      ...signal === undefined ? {} : { signal },
    })
  }
}
