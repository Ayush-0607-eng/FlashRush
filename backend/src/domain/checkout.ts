import type { Pool, PoolClient } from 'pg'
import { withTransaction } from '../db'
import {
  reservationAlreadyConfirmed,
  reservationCancelled,
  reservationExpired,
  reservationNotFound
} from '../errors'
import { hashRequest, runIdempotent } from './idempotency'
import { lockReservation, releaseHold, toReservationView, type LockedReservation, type ReservationRow, type ReservationView } from './reservations'

export type CheckoutOutcome = 'success' | 'fail'

export interface OrderView {
  id: string
  reservationId: string
  saleId: string
  quantity: number
  totalMinor: number
  paymentStatus: string
  simulated: true
  createdAt: string
}

interface OrderRow {
  id: string
  reservation_id: string
  sale_id: string
  quantity: number
  total_minor: number
  payment_status: string
  created_at: Date
}

export interface CheckoutInput {
  sessionId: string
  reservationId: string
  outcome: CheckoutOutcome
  idempotencyKey: string
}

export interface CheckoutBody {
  data?: { order: OrderView; reservation: ReservationView }
  error?: { code: string; message: string }
  reservation?: ReservationView
}

function toOrderView(row: OrderRow): OrderView {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    saleId: row.sale_id,
    quantity: row.quantity,
    totalMinor: row.total_minor,
    paymentStatus: row.payment_status,
    simulated: true,
    createdAt: row.created_at.toISOString()
  }
}

async function lockOwned(client: PoolClient, sessionId: string, reservationId: string): Promise<LockedReservation> {
  const reservation = await lockReservation(client, reservationId)
  if (!reservation || reservation.session_id !== sessionId) throw reservationNotFound()
  return reservation
}

async function existingOrder(client: PoolClient, reservationId: string): Promise<OrderRow> {
  const { rows } = await client.query<OrderRow>('SELECT * FROM orders WHERE reservation_id = $1', [reservationId])
  return rows[0]
}

async function confirm(client: PoolClient, reservation: LockedReservation): Promise<{ order: OrderRow; confirmed: ReservationRow }> {
  const updated = await client.query<ReservationRow>(
    `UPDATE reservations SET status = 'CONFIRMED', resolved_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE id = $1 AND status = 'RESERVED' RETURNING *`,
    [reservation.id]
  )
  if (updated.rowCount !== 1) throw new Error(`reservation ${reservation.id} changed state while locked`)
  const moved = await client.query(
    `UPDATE sales SET reserved = reserved - $2, sold = sold + $2, updated_at = now()
     WHERE id = $1 AND reserved >= $2`,
    [reservation.sale_id, reservation.quantity]
  )
  if (moved.rowCount !== 1) throw new Error(`inventory invariant violated while confirming reservation ${reservation.id}`)
  const order = await client.query<OrderRow>(
    `INSERT INTO orders (reservation_id, sale_id, session_id, quantity, total_minor)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [reservation.id, reservation.sale_id, reservation.session_id, reservation.quantity, reservation.unit_price_minor * reservation.quantity]
  )
  await client.query(`INSERT INTO payment_attempts (reservation_id, outcome) VALUES ($1, 'SUCCESS')`, [reservation.id])
  return { order: order.rows[0], confirmed: updated.rows[0] }
}

export function checkout(pool: Pool, input: CheckoutInput) {
  const requestHash = hashRequest({ reservationId: input.reservationId, outcome: input.outcome })
  const params = { sessionId: input.sessionId, scope: 'checkout' as const, key: input.idempotencyKey, requestHash }
  return runIdempotent<CheckoutBody>(pool, params, async (client) => {
    const reservation = await lockOwned(client, input.sessionId, input.reservationId)

    if (reservation.status === 'CONFIRMED') {
      if (input.outcome === 'fail') throw reservationAlreadyConfirmed()
      const order = await existingOrder(client, reservation.id)
      return { status: 200, body: { data: { order: toOrderView(order), reservation: toReservationView(reservation) } } }
    }
    if (reservation.status === 'CANCELLED') throw reservationCancelled()
    if (reservation.status === 'EXPIRED' || reservation.expired) throw reservationExpired()

    if (input.outcome === 'fail') {
      await client.query(`INSERT INTO payment_attempts (reservation_id, outcome) VALUES ($1, 'FAILED')`, [reservation.id])
      return {
        status: 402,
        body: {
          error: { code: 'PAYMENT_DECLINED', message: 'Simulated payment declined. The reservation is still held until it expires.' },
          reservation: toReservationView(reservation)
        }
      }
    }

    const { order, confirmed } = await confirm(client, reservation)
    return { status: 201, body: { data: { order: toOrderView(order), reservation: toReservationView(confirmed) } } }
  })
}

export async function cancelReservation(pool: Pool, sessionId: string, reservationId: string): Promise<ReservationView> {
  return withTransaction(pool, async (client) => {
    const reservation = await lockOwned(client, sessionId, reservationId)
    if (reservation.status === 'CANCELLED') return toReservationView(reservation)
    if (reservation.status === 'CONFIRMED') throw reservationAlreadyConfirmed()
    if (reservation.status === 'EXPIRED' || reservation.expired) throw reservationExpired()
    const updated = await client.query<ReservationRow>(
      `UPDATE reservations SET status = 'CANCELLED', resolved_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'RESERVED' RETURNING *`,
      [reservation.id]
    )
    if (updated.rowCount !== 1) throw new Error(`reservation ${reservation.id} changed state while locked`)
    await releaseHold(client, reservation.sale_id, reservation.quantity)
    return toReservationView(updated.rows[0])
  })
}
