# dsh-plugin-jules

[![CI](https://github.com/rbviz/dsh-plugin-jules/actions/workflows/ci.yml/badge.svg)](https://github.com/rbviz/dsh-plugin-jules/actions/workflows/ci.yml)

Google [Jules](https://jules.google.com) as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) capability.

Jules is a remote coding agent: you give it a task and a repository, and it works asynchronously in
Google's cloud on its own clone — planning, editing files, running commands, and opening a pull
request. This plugin puts that agent behind ten `jules_*` tools, so a harness model can hand off
long-running work, follow it, approve its plan, answer it, and pull back the diff.

It talks to the documented Jules v1alpha REST API directly and has **no runtime dependencies**.

## What it gives you

- **Delegation that outlives a turn.** `jules_create` returns a session id immediately; the work
  continues in the cloud whether or not anything is listening.
- **Notification instead of polling.** `jules_watch` registers a background watch and the harness
  delivers a completion notice, so the model ends its turn rather than looping on status checks.
- **Plan review.** `requirePlanApproval` genuinely gates edits, and `jules_approve_plan` releases them
  once you have read the plan.
- **Results you can use.** `jules_patch` returns the unified diff — in pages for large ones, with a
  list of every touched file — ready for `git apply`.

## Requirements

- DeepSeek Harness, with a base-backed profile (the base bundle provides `tools`, `systemPrompt`,
  `jobs`, and the storage stack this plugin uses).
- Node 22 or newer.
- A Jules account with at least one repository connected through the Jules GitHub App.
- A Jules API key: **https://jules.google.com/settings**. Jules allows three keys per account and
  shows each one once.

## Install

The package declares `dsh.bundle`, so it installs as an ordinary profile bundle. From a checkout of
this repository:

```sh
node scripts/link-dsh-deps.mjs   # once, and after changing peerDependencies
npm run build                    # compiles src/ to lib/

dsh plugin --profile <your-profile> add /path/to/jules-plugin
```

Then restart the harness. Confirm the layer composed:

```sh
dsh --profile <your-profile> --dump-config | grep -A 3 'id: jules'
```

### From GitHub

```sh
dsh plugin --profile <your-profile> add github:rbviz/dsh-plugin-jules
```

pnpm 10 and later refuses to run a dependency's `prepare` script until it is explicitly allowed, so
the first attempt fails and prints the exact key to add to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-plugin-jules: true
```

Treat that allowance as **permission to execute this package's code on your machine at install time**,
outside any sandbox the agent runs under — only allow packages whose source you trust, and pin a commit
(`github:rbviz/dsh-plugin-jules#<sha>`) so a later push cannot silently change what runs.

`prepare` links the peer dependencies and compiles `src/` to `lib/`, because a git install fetches
sources and `lib/` is deliberately not committed. A registry install skips `prepare` entirely and ships
`lib/` prebuilt.

### Without installing

For a local loop you can skip the package entirely and insert the built entry point by absolute path
from your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: jules
      name: '/path/to/jules-plugin/lib/index.js'
      config:
        apiKeyEnv: JULES_API_KEY
```

Do **not** do this while the bundle is installed. Both layers would insert the row id `jules`, and the
composition aborts at boot with `duplicate loader entry id: jules` rather than guess which wins. Use one
owner or the other; to change how an installed bundle behaves, **override its row by id** instead. A
patch replaces the row's whole config rather than merging into it, so restate every key you want.

## Authentication

1. Create a key at https://jules.google.com/settings.
2. Expose it under the credential name in `apiKeyEnv` (default `JULES_API_KEY`). Either export it
   before starting the harness, or store it through the harness credential store so configuration keeps
   naming a secret rather than containing one.

```sh
export JULES_API_KEY=...
```

The key is resolved on every request — literal `apiKey` first, then `ctx.credentials`, then the launch
environment — so a rotated key applies to the next call with no reload. With no key configured, tools
fail with an actionable message rather than a bare 401.

## Quick start

```text
jules_sources                     # which repositories Jules may work in
jules_create                      # prompt + source + requirePlanApproval + autoCreatePr
jules_watch                       # returns a job id; then END YOUR TURN
  ... the completion notice arrives ...
job_output                        # read the report
jules_status                      # read the plan, then jules_approve_plan
jules_patch                       # review or land the diff
```

## Tools

| Tool | Purpose |
|---|---|
| `jules_sources` | List repositories connected to Jules. A repository must appear here before `jules_create` can target it. |
| `jules_create` | Start a session and return a session id immediately. Takes `prompt`, optional `source`, `branch`, `title`, `requirePlanApproval`, `autoCreatePr`. Omit `source` for a repoless session. |
| `jules_list` | List recent sessions, newest first, with state and pull request links. |
| `jules_status` | One session in full: state, plan, approval, pull requests, generated files, latest command, last agent message. |
| `jules_activities` | The event log: plan generation and approval, messages, progress, completion, failure, artifacts. |
| `jules_approve_plan` | Approve a pending plan so the agent may edit files. |
| `jules_send_message` | Answer a question, correct a plan, or hand over follow-up work. |
| `jules_watch` | Watch in the background; returns a job id and notifies you when there is something to read. |
| `jules_wait` | Hold the turn open for the same wait, for when nothing else can proceed meanwhile. |
| `jules_patch` | The newest unified diff, with every touched file listed and `offset`/`nextOffset` paging. |

Every id argument accepts `123`, `sessions/123`, or the `jules.google.com/session/123` URL, and every
source argument accepts `owner/repo`, `github/owner/repo`, or the full resource name.

## Configuration

Set in the loader row's `config` block. Every field has a default except the credential.

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | — | Literal key. Prefer `apiKeyEnv` so no secret enters a config file. |
| `apiKeyEnv` | `JULES_API_KEY` | Credential reference holding the key. |
| `baseURL` | `https://jules.googleapis.com/v1alpha` | API root. |
| `defaultSource` | — | Repository `jules_create` targets when the call omits one. Setting it makes repoless sessions unavailable. |
| `requestTimeoutMs` | `30000` | Per-request deadline. |
| `defaultPageSize` | `30` | Page size for list calls that do not choose one. |
| `maxPageSize` | `100` | Largest page size a caller may request. |
| `maxPatchBytes` | `200000` | Largest diff slice `jules_patch` returns. |
| `pollIntervalMs` | `5000` | Delay between status polls inside `jules_wait`. |
| `waitDefaultMs` | `120000` | Wait budget `jules_wait` uses when the caller does not set one. |
| `waitMaxMs` | `300000` | Largest wait budget a caller may request. |
| `maxActivityPages` | `10` | Activity pages one read may walk. |
| `enableWatch` | `true` | Expose `jules_watch`. |
| `watchPollIntervalMs` | `15000` | Delay between polls inside `jules_watch`. |
| `watchDefaultMs` | `1800000` | Watch budget `jules_watch` uses when the caller does not set one. |
| `watchMaxMs` | `7200000` | Largest watch budget a caller may request. |
| `watchSettleOnMessage` | `true` | End a watch when the agent posts a message, not only on a state change. |
| `retryMaxAttempts` | `4` | Attempts per request, including the first. |
| `retryBaseDelayMs` | `1000` | First backoff step; doubles per attempt. |
| `retryMaxDelayMs` | `30000` | Ceiling for one backoff step. |

Cross-field mistakes fail at load with a named error rather than at the first call: `defaultPageSize`
above `maxPageSize`, `waitDefaultMs` above `waitMaxMs`, `watchDefaultMs` above `watchMaxMs`,
`retryBaseDelayMs` above `retryMaxDelayMs`, and a `baseURL` that is not an absolute URL.

## Waiting: watch, do not poll

A Jules session runs for minutes to hours. The tooling is shaped so a model never has to poll, and says
so in three places, because polling is the failure mode that wastes the most for the least:

- the model guidance leads with it — create, watch, **end your turn**;
- every waiting-adjacent tool description names what it is *for* rather than what it does, so
  `jules_status` reads as a confirmation step rather than an invitation;
- `jules_status` **says so when it is asked twice**. It remembers what it last reported, per caller and
  session, and when nothing has moved it renders:

  > note: nothing has changed since your last check 45s ago. Do not keep polling — a jules_watch
  > notice is what tells you something happened.

  The canonical value carries `unchangedForMs`, so the fact is data rather than prose, and the nudge is
  additive: the full report is still there.

### A restart ends the watch, not the work

Background jobs are process-local: the harness holds them in memory and tears them down on shutdown.
Restarting therefore ends every watch silently — while the Jules sessions themselves carry on in
Google's cloud, because they were never ours to begin with.

The job cannot be restored. A job needs a live owning agent to receive a completion notice, and at
plugin load there is no agent; anything claiming to restore a watch at boot would be polling with
nobody to tell.

What survives is the *fact*. `jules_watch` records the session in a durable `jules_watches` domain,
and a watch that reaches its own conclusion removes it. Entries expire with the budget they recorded,
so nothing accumulates. After a restart the model guidance grows a paragraph naming what was still
armed:

> Note: background watches do not survive a harness restart, and 2 watches were still armed when this
> harness last stopped: 123, 456. The Jules sessions themselves kept running in the cloud. Re-arm the
> ones you still care about with `jules_watch`; a session that has since finished needs only a
> `jules_status`.

The section text is evaluated per assembly, so the note appears as soon as the plugin loads and clears
as watches are re-armed. A deliberately killed watch keeps its entry until its budget expires —
distinguishing "the user stopped this" from "the harness is going down" is not something the available
signals do reliably, and guessing wrong would drop exactly the record this exists to keep.

Records carry no owner, so once a restart makes everything non-live the note lists watches armed by any
session sharing that harness home. In a single-session setup that is invisible; with several it is
noise rather than a wrong action, since re-arming is harmless.

A composition without the storage domain simply loses the note; the tool family is unaffected.

## What the Jules API does not allow

Service limitations, not gaps in the plugin. Worth knowing before planning around them:

- **No cancel, pause, or resume.** `:cancelPlan`, `:pause` and `:resume` all 404. A session runs
  to completion or failure, and a stuck command cannot be interrupted. The only lever is a message.
- **No separate "reject plan" action.** `:approvePlan` exists; there is no `:rejectPlan`. Sending a
  message with corrections is the only way to change a plan.
- **A follow-up resumes from the session's own snapshot.** `:sendMessage` takes only a prompt — no base
  or branch control. Treat a follow-up as iterating on *that session's* branch.
- **The PR base follows the starting branch.** There is no `prBase` at creation, so set `branch` on
  `jules_create` to control it.
- **No cost, token, or runtime accounting**, and no way to ask an agent to report back after N minutes.

### Partial signals

- **`progressUpdated` often carries an empty summary.** `jules_status` therefore surfaces
  `latestCommand`, taken from the newest `bashOutput` artifact, so a stalled session can at least be
  traced to a command.
- **`generatedFiles` is empty in practice.** `jules_patch` — which reads the `changeSet` artifact —
  is the authoritative change list, and its `files` field lists every touched path.
- **`requirePlanApproval` and `autoCreatePr` are inputs the service does not echo back.** They are
  reported as `yes`/`no`/`unknown`, decided by evidence (a PR exists, a plan was approved) with
  `unknown` when there is none, rather than a fabricated `false`.
- **An approval is confirmed by its event, not by the phase it returns with.** `jules_approve_plan`
  polls briefly for the `planApproved` activity after approving, because the service is eventually
  consistent about its own actions: the phase can still read `AWAITING_PLAN_APPROVAL` — or something
  further along — and `planApproved` can still read false, for an approval that in fact landed and
  started work. The reply says which of the two happened (`approvalConfirmed`), and when it could
  not confirm in time it says that rather than implying the approval failed. If you need certainty,
  read the `planApproved` event yourself, or wait for the agent's first progress event.
- **`Session.state` is advisory.** A session can post its final answer and leave `state` reading
  `IN_PROGRESS` indefinitely — the Jules web UI shows the same stuck state. The plugin reads the
  activity log instead of trusting the field.
- **The activity cursor is a filter, not a parameter.** The API reference documents `?createTime=`, but
  the service rejects it ("Cannot bind query parameter. Field 'createTime' could not be found"). The
  plugin sends the AIP-160 expression the official SDK uses, and treats a rejection as a bandwidth
  problem rather than a failure.

## Design notes

**Canonical values, not prose.** Every tool declares an output schema and returns a value matching it;
`render` separately produces the text the model reads. Optional scalars project to `''` and absent
lists to `[]`, so a value is always lossless JSON with a fixed shape.

**Waiting is one implementation.** `jules_wait` and `jules_watch` share `runWatch`, so they cannot
disagree about when a session is done or what to report. A watch settles on new evidence: a terminal
state, a state it moved into, or activity that arrived after it started. The log it reads at the start
is baseline — used for the report, never a trigger — so watching a session whose last activity is the
question you just answered waits for the actual reply.

**Failures are typed, and partial failures are named.** Transport failures, timeouts, 404s,
  auth rejections, rate limits, and a 2xx body that is not JSON each raise their own error class, so a
  caller can tell them apart instead of reading prose. Retries cover exactly 429 and 5xx and are
  bounded. Where a partial failure is survivable the result says so rather than filling in the blank:
  if the session read succeeds but its activity log does not, the projection carries
  `logRead: false` and the report opens with a warning, because "no plan pending" and "we could
  not look" call for opposite actions. `jules_approve_plan` distinguishes three outcomes — confirmed,
  not yet visible, and unverifiable — so an unreadable log never reads as a failed approval.

**Journal writes never reject.** A journal failure costs the restart note, never the watch, so it must
  not take down the job doing the real work — but it is logged, because swallowing it silently is how
  a broken journal went unnoticed for a release.

**Retries that match the service.** Jules documents 429 and 5xx but publishes no limits, and its own SDK
reports high concurrency failing *silently* with misleading errors. The client retries those statuses
with exponential backoff, honours `Retry-After`, and gives up with a typed error. A session that is not
queryable yet — Jules mints the id before the resource exists — is retried rather than reported.

**Module resolution.** A profile installs an out-of-tree bundle with pnpm's `link:` protocol, which
creates no `node_modules` beside the real package, and Node resolves a symlinked package to its
realpath. The plugin's own `import '@deepseek-ai/dsh-tools'` would therefore fail even though the harness
had just loaded the file. `scripts/link-dsh-deps.mjs` links each declared peer at the copy the running
installation already uses, so both sides share one module instance.

## Development

```sh
node scripts/link-dsh-deps.mjs   # once, or after changing peerDependencies
npm run build                    # tsc, using the TypeScript the harness already ships
npm test                         # build, then the full suite
node scripts/link-dsh-deps.mjs --check   # report missing peers, change nothing
```

`scripts/build.mjs` resolves TypeScript from `$DSH_TSC`, then the linked `node_modules`, then
`$DSH_HOME`, so the plugin needs no toolchain of its own and never runs `pnpm install`.

Tests run in two layers. Unit tests cover normalization, request construction, retry and error
classification against a stubbed transport, projections, and renders. Real-composition tests mount the
built plugin through the Cordis loader beside the genuine harness services and drive tools through the
real execution pipeline — including the storage stack, so the durable watch journal is exercised rather
than assumed.

### Source map

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: name, injections, Config schema, credential resolution, registration, model guidance. |
| `src/client.ts` | The `fetch`-based v1alpha client, error classes, and the retry policy. |
| `src/types.ts` | Wire types and the reference normalization the tools apply before calling. |
| `src/views.ts` | Projections to canonical values, and the text each one renders to. |
| `src/tools.ts` | The `defineTool` declarations. |
| `src/watch.ts` | `runWatch` — the settling rules shared by `jules_wait` and `jules_watch` — and the job adapter. |
| `src/journal.ts` | The durable watch journal and the restart note. |
| `src/async.ts` | The cancellable sleep both waiting paths use. |
| `cordis.patch.yml` | The bundle layer a profile applies. |

## License

MIT — see [LICENSE](LICENSE). Permissive by design: commercial use, modification, and redistribution are
all fine, and the only obligation is keeping the copyright notice. Nothing here is copyleft, so
building it into a commercial product needs no legal review of this repository.

The plugin bundles **no third-party code**. All ten of its imports — the `@deepseek-ai/*` packages and
`zod` — are peer dependencies that the harness provides, and every one of them is MIT, as is
DeepSeek Harness itself.

Two things separate from this licence, worth knowing before shipping: using the plugin requires a Jules
account and is subject to Google's terms of service, and *Jules* is Google's trademark, used here
descriptively — nothing in this project is affiliated with or endorsed by Google.
