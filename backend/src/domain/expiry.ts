import type { Pool } from 'pg'
import { withTransaction } from '../db'
import { lockReservation, releaseHold } from './reservations'

export type ExpireOutcome = 'EXPIRED' | 'ALREADY_RESOLVED' | 'NOT_DUE' | 'NOT_FOUND'

export interface SweepResult {
  examined: number
  expired: number
}

export function expireReservation(pool: Pool, reservationId: string): Promise<ExpireOutcome> {
  return withTransaction(pool, async (client) => {
    const reservation = await lockReservation(client, reservationId)
    if (!reservation) return 'NOT_FOUND'
    if (reservation.status !== 'RESERVED') return 'ALREADY_RESOLVED'
    if (!reservation.expired) return 'NOT_DUE'
    await client.query(
      `UPDATE reservations SET status = 'EXPIRED', resolved_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'RESERVED'`,
      [reservationId]
    )
    await releaseHold(client, reservation.sale_id, reservation.quantity)
    return 'EXPIRED'
  })
}

export async function sweepExpired(pool: Pool, batchSize = 200, concurrency = 10): Promise<SweepResult> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM reservations WHERE status = 'RESERVED' AND expires_at <= now() ORDER BY expires_at LIMIT $1`,
    [batchSize]
  )
  let expired = 0
  for (let index = 0; index < rows.length; index += concurrency) {
    const chunk = rows.slice(index, index + concurrency)
    const outcomes = await Promise.all(chunk.map((row) => expireReservation(pool, row.id)))
    expired += outcomes.filter((outcome) => outcome === 'EXPIRED').length
  }
  return { examined: rows.length, expired }
}
