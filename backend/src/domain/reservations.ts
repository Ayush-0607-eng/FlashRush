
import type { Pool, PoolClient } from 'pg'
import { AppError, invalidQuantity, purchaseLimitExceeded, reservationNotFound, saleNotActive, saleNotFound, soldOut } from '../errors'
import { hashRequest, runIdempotent } from './idempotency'

export type ReservationStatus = 'RESERVED' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED'

export interface ReservationRow {
  id: string
  sale_id: string
  session_id: string
  quantity: number
  unit_price_minor: number
  status: ReservationStatus
  expires_at: Date
  created_at: Date
  resolved_at: Date | null
}

export interface LockedReservation extends ReservationRow {
  expired: boolean
}

export interface ReservationView {
  id: string
  saleId: string
  quantity: number
  unitPriceMinor: number
  totalMinor: number
  status: ReservationStatus
  expiresAt: string
  createdAt: string
  resolvedAt: string | null
}

export interface BookingView {
  reservation: ReservationView
  saleName: string
  order: { id: string; totalMinor: number; paymentStatus: string; createdAt: string } | null
}

export interface ReserveInput {
  sessionId: string
  saleId: string
  quantity: number
  idempotencyKey: string
}

export function toReservationView(row: ReservationRow): ReservationView {
  return {
    id: row.id,
    saleId: row.sale_id,
    quantity: row.quantity,
    unitPriceMinor: row.unit_price_minor,
    totalMinor: row.unit_price_minor * row.quantity,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null
  }
}

export async function lockReservation(client: PoolClient, id: string): Promise<LockedReservation | null> {
  const { rows } = await client.query<LockedReservation>(
    'SELECT r.*, (r.expires_at <= clock_timestamp()) AS expired FROM reservations r WHERE r.id = $1 FOR UPDATE',
    [id]
  )
  return rows.length > 0 ? rows[0] : null
}

export async function releaseHold(client: PoolClient, saleId: string, quantity: number): Promise<void> {
  const result = await client.query(
    'UPDATE sales SET reserved = reserved - $2, updated_at = now() WHERE id = $1 AND reserved >= $2',
    [saleId, quantity]
  )
  if (result.rowCount !== 1) {
    throw new Error(`inventory invariant violated while releasing ${quantity} units of sale ${saleId}`)
  }
}

async function explainRejection(client: PoolClient, saleId: string): Promise<AppError> {
  const { rows } = await client.query<{ open: boolean }>(
    'SELECT (starts_at <= clock_timestamp() AND ends_at > clock_timestamp()) AS open FROM sales WHERE id = $1',
    [saleId]
  )
  if (rows.length === 0) return saleNotFound()
  return rows[0].open ? soldOut() : saleNotActive()
}

export function reserve(pool: Pool, input: ReserveInput) {
  const requestHash = hashRequest({ saleId: input.saleId, quantity: input.quantity })
  const params = {
    sessionId: input.sessionId,
    scope: 'reserve' as const,
    key: input.idempotencyKey,
    requestHash
  }

  return runIdempotent<{ data: ReservationView }>(pool, params, async (client) => {
    const limits = await client.query<{ max_per_session: number }>(
      'SELECT max_per_session FROM sales WHERE id = $1',
      [input.saleId]
    )

    if (limits.rows.length === 0) throw saleNotFound()

    const maxPerSession = limits.rows[0].max_per_session
    if (input.quantity < 1 || input.quantity > maxPerSession) {
      throw invalidQuantity(maxPerSession)
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.sessionId}:${input.saleId}`
    ])

    const held = await client.query<{ held: number }>(
      `SELECT COALESCE(SUM(quantity), 0)::int AS held
       FROM reservations
       WHERE sale_id = $1
         AND session_id = $2
         AND status IN ('RESERVED', 'CONFIRMED')`,
      [input.saleId, input.sessionId]
    )

    if (held.rows[0].held + input.quantity > maxPerSession) {
      throw purchaseLimitExceeded(maxPerSession)
    }

    const updated = await client.query<{ price_minor: number; hold_seconds: number }>(
      `UPDATE sales
       SET reserved = reserved + $2, updated_at = now()
       WHERE id = $1
         AND starts_at <= clock_timestamp()
         AND ends_at > clock_timestamp()
         AND total - reserved - sold >= $2
       RETURNING price_minor, hold_seconds`,
      [input.saleId, input.quantity]
    )

    if (updated.rowCount === 0) {
      throw await explainRejection(client, input.saleId)
    }

    const { price_minor: priceMinor, hold_seconds: holdSeconds } = updated.rows[0]

    const inserted = await client.query<ReservationRow>(
      `INSERT INTO reservations (
         sale_id,
         session_id,
         quantity,
         unit_price_minor,
         expires_at
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         clock_timestamp() + make_interval(secs => $5::int)
       )
       RETURNING *`,
      [input.saleId, input.sessionId, input.quantity, priceMinor, holdSeconds]
    )

    const reservation = inserted.rows[0]

    await client.query(
      `INSERT INTO outbox (topic, dedupe_key, payload, available_at)
       SELECT
         'reservation.expire',
         $1,
         $2::jsonb,
         expires_at
       FROM reservations
       WHERE id = $3`,
      [
        `expire-${reservation.id}`,
        JSON.stringify({ reservationId: reservation.id }),
        reservation.id
      ]
    )

    return {
      status: 201,
      body: { data: toReservationView(reservation) }
    }
  })
}

export async function getReservation(pool: Pool, sessionId: string, id: string): Promise<ReservationView> {
  const { rows } = await pool.query<ReservationRow>(
    'SELECT * FROM reservations WHERE id = $1 AND session_id = $2',
    [id, sessionId]
  )

  if (rows.length === 0) throw reservationNotFound()

  return toReservationView(rows[0])
}

interface BookingRow extends ReservationRow {
  sale_name: string
  order_id: string | null
  order_total_minor: number | null
  order_payment_status: string | null
  order_created_at: Date | null
}

export async function listBookings(pool: Pool, sessionId: string): Promise<BookingView[]> {
  const { rows } = await pool.query<BookingRow>(
    `SELECT
       r.*,
       s.name AS sale_name,
       o.id AS order_id,
       o.total_minor AS order_total_minor,
       o.payment_status AS order_payment_status,
       o.created_at AS order_created_at
     FROM reservations r
     JOIN sales s ON s.id = r.sale_id
     LEFT JOIN orders o ON o.reservation_id = r.id
     WHERE r.session_id = $1
     ORDER BY r.created_at DESC
     LIMIT 100`,
    [sessionId]
  )

  return rows.map((row) => ({
    reservation: toReservationView(row),
    saleName: row.sale_name,
    order:
      row.order_id && row.order_total_minor !== null && row.order_payment_status && row.order_created_at
        ? {
            id: row.order_id,
            totalMinor: row.order_total_minor,
            paymentStatus: row.order_payment_status,
            createdAt: row.order_created_at.toISOString()
          }
        : null
  }))
}
