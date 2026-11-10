import type { Pool } from 'pg'
import { withTransaction } from '../db'
import { errorMessage } from '../utils'

export interface OutboxMessage {
  id: string
  topic: string
  dedupeKey: string
  payload: unknown
  delayMs: number
}

export type Publisher = (message: OutboxMessage) => Promise<void>

export interface RelayResult {
  examined: number
  published: number
  failed: number
}

interface PendingRow {
  id: string
  topic: string
  dedupe_key: string
  payload: unknown
  delay_ms: string
}

export function relayOutbox(pool: Pool, publish: Publisher, batchSize = 100): Promise<RelayResult> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<PendingRow>(
      `SELECT id, topic, dedupe_key, payload,
              GREATEST(0, EXTRACT(EPOCH FROM (available_at - clock_timestamp())) * 1000)::bigint AS delay_ms
       FROM outbox
       WHERE published_at IS NULL AND next_attempt_at <= now()
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize]
    )

    const publishedIds: string[] = []
    let failureIndex = -1
    let failureReason = ''
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      try {
        await publish({ id: row.id, topic: row.topic, dedupeKey: row.dedupe_key, payload: row.payload, delayMs: Number(row.delay_ms) })
        publishedIds.push(row.id)
      } catch (error) {
        failureIndex = index
        failureReason = errorMessage(error)
        break
      }
    }

    if (publishedIds.length > 0) {
      await client.query('UPDATE outbox SET published_at = now(), last_error = NULL WHERE id = ANY($1::bigint[])', [publishedIds])
    }

    let failed = 0
    if (failureIndex >= 0) {
      const failedIds = rows.slice(failureIndex).map((row) => row.id)
      failed = failedIds.length
      await client.query(
        `UPDATE outbox
         SET attempts = attempts + 1,
             last_error = $2,
             next_attempt_at = now() + make_interval(secs => LEAST(power(2, attempts), 60)::int)
         WHERE id = ANY($1::bigint[])`,
        [failedIds, failureReason.slice(0, 500)]
      )
    }
    return { examined: rows.length, published: publishedIds.length, failed }
  })
}
