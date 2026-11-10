import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { withTransaction } from '../db'
import { idempotencyKeyReused } from '../errors'

export type IdempotencyScope = 'reserve' | 'checkout'

export interface StoredResponse<T> {
  status: number
  body: T
}

export interface IdempotentResult<T> extends StoredResponse<T> {
  replayed: boolean
}

export interface IdempotencyParams {
  sessionId: string
  scope: IdempotencyScope
  key: string
  requestHash: string
}

export function hashRequest(payload: Record<string, string | number>): string {
  const canonical = JSON.stringify(Object.keys(payload).sort().map((name) => [name, payload[name]]))
  return createHash('sha256').update(canonical).digest('hex')
}

export function runIdempotent<T>(
  pool: Pool,
  params: IdempotencyParams,
  operation: (client: PoolClient) => Promise<StoredResponse<T>>
): Promise<IdempotentResult<T>> {
  return withTransaction(pool, async (client) => {
    const claimed = await client.query(
      `INSERT INTO idempotency_keys (session_id, scope, key, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4, 0, '{}'::jsonb)
       ON CONFLICT (session_id, scope, key) DO NOTHING`,
      [params.sessionId, params.scope, params.key, params.requestHash]
    )
    if (claimed.rowCount === 0) {
      const existing = await client.query<{ request_hash: string; response_status: number; response_body: T }>(
        'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE session_id = $1 AND scope = $2 AND key = $3',
        [params.sessionId, params.scope, params.key]
      )
      const stored = existing.rows[0]
      if (stored.request_hash !== params.requestHash) throw idempotencyKeyReused()
      return { status: stored.response_status, body: stored.response_body, replayed: true }
    }
    const result = await operation(client)
    await client.query(
      'UPDATE idempotency_keys SET response_status = $4, response_body = $5::jsonb WHERE session_id = $1 AND scope = $2 AND key = $3',
      [params.sessionId, params.scope, params.key, result.status, JSON.stringify(result.body)]
    )
    return { status: result.status, body: result.body, replayed: false }
  })
}
