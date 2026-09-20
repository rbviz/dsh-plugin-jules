/**
 * The durable half of watching: a record of what was being watched.
 *
 * Background jobs are process-local. The registry holds them in memory and
 * tears every one down when its service disposes, so a harness restart ends
 * every watch silently — while the Jules sessions themselves carry on in
 * Google's cloud, because they were never ours to begin with.
 *
 * Nothing can bring the job back. A job needs a live owning agent to receive a
 * completion notice, and at plugin load there is no agent, so this journal does
 * not pretend to restore one. It preserves the *fact* of what was being
 * watched, which the prompt turns into an instruction to re-arm — and which
 * clears itself, because an entry is only interesting until the watch budget it
 * recorded would have run out anyway.
 *
 * @module dsh-plugin-jules/journal
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** One armed watch, as it needs to survive a restart. */
export interface WatchRecord {
  /** Bare Jules session id. */
  session: string
  /** Epoch ms the watch was armed. */
  startedAt: number
  /** Epoch ms after which the watch would have given up on its own. */
  expiresAt: number
}

/** The durable shape of one record, validated at open and on every write. */
const watchRecord = z.object({
  session: z.string(),
  startedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
})

/**
 * The watch journal domain.
 *
 * `backup-and-skip` because this is a re-arm hint and nothing more: one unreadable
 * record must never cost the plugin its load.
 */
export const julesWatchDomainSpec = defineDomain({
  name: 'jules_watches',
  version: 1,
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: { watches: domainTable<string, WatchRecord>(watchRecord) },
})

/**
 * Records an active watch, so a restart can still say what was in flight.
 *
 * Writes never reject. A journal failure costs the restart note, never the
 * watch, so it must not take down the job that is doing the real work — but it
 * is logged, because swallowing it silently is exactly how this went unnoticed
 * for a release.
 */
export interface WatchJournal {
  /** Record a freshly armed watch, replacing any earlier entry for that session. Never rejects. */
  arm(record: WatchRecord): Promise<void>
  /** Forget one session, once its watch has settled for any reason. Never rejects. */
  release(session: string): Promise<void>
  /** Every record whose watch was still running, oldest first. */
  pending(now?: number): WatchRecord[]
}

/**
 * Describe the watches a restart orphaned.
 *
 * A live job cannot exist before an agent does, so the most this can do is tell
 * the next agent what to re-arm. Returns an empty string when there is nothing
 * to report, which keeps the prompt section unchanged in the common case.
 * @param records - records the journal still holds.
 * @returns the paragraph to append to the model guidance, or ''.
 */
export function orphanNote(records: readonly WatchRecord[]): string {
  if (records.length === 0) return ''
  const ids = records.map(record => record.session).join(', ')
  return '\n\nNote: background watches do not survive a harness restart, and '
    + (records.length === 1 ? 'one watch was' : records.length + ' watches were')
    + ' still armed when this harness last stopped: ' + ids + '. '
    + 'The Jules sessions themselves kept running in the cloud. Re-arm the ones you still care about with '
    + 'jules_watch; a session that has since finished needs only a jules_status.'
}

/**
 * Open the journal over the mounted storage domain.
 *
 * A composition without the domain form still gets the whole tool family — it
 * simply loses the ability to say what was being watched before a restart, which
 * is why this answers `undefined` rather than failing the plugin.
 * @param ctx - plugin context supplying the storage domain form.
 * @returns the journal, or undefined when no storage is mounted.
 */
export async function openWatchJournal(ctx: Context): Promise<WatchJournal | undefined> {
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain === undefined) return undefined
  const domain = await storageDomain.open(julesWatchDomainSpec)
  ctx.effect(() => () => domain.close(), 'jules.watchJournal.close')
  const table = domain.table('watches')
  const warn = (message: string, error: unknown): void => {
    ctx.logger.warn(`jules: ${message}: ${String(error)}`)
  }
  return {
    async arm(record: WatchRecord): Promise<void> {
      try {
        await table.put(record.session, record)
      } catch (error) {
        warn(`could not record the watch for session ${record.session}`, error)
      }
    },
    async release(session: string): Promise<void> {
      try {
        await table.delete(session)
      } catch (error) {
        warn(`could not release the watch for session ${session}`, error)
      }
    },
    pending(now: number = Date.now()): WatchRecord[] {
      const live: WatchRecord[] = []
      for (const [, record] of table.entries()) {
        if (record.expiresAt > now) live.push(record)
        // Expired entries are no longer interesting, so drop them rather than
        // let a dead watch keep reporting itself forever.
        else {
          table.delete(record.session).catch((error: unknown) => {
            warn(`could not prune the expired watch for session ${record.session}`, error)
          })
        }
      }
      return live.sort((left, right) => left.startedAt - right.startedAt)
    },
  }
}
