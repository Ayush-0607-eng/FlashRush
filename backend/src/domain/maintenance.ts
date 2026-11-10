import type { Pool } from 'pg'

export interface CleanupResult {
  outbox: number
  idempotencyKeys: number
  sessions: number
}

export async function cleanup(pool: Pool): Promise<CleanupResult> {
  const outbox = await pool.query(`DELETE FROM outbox WHERE published_at IS NOT NULL AND published_at < now() - interval '1 hour'`)
  const keys = await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`)
  const sessions = await pool.query(
    `DELETE FROM sessions s WHERE s.expires_at < now() AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.session_id = s.id)`
  )
  return { outbox: outbox.rowCount ?? 0, idempotencyKeys: keys.rowCount ?? 0, sessions: sessions.rowCount ?? 0 }
}
