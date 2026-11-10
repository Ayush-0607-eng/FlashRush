import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { expect } from 'vitest'
import { createPool } from '../src/db'
import { expireReservation, type ExpireOutcome } from '../src/domain/expiry'
import { reconcile } from '../src/domain/reconciliation'
import { reserve, type ReservationView } from '../src/domain/reservations'
import { createSale, type SaleInput, type SaleView } from '../src/domain/sales'
import { createSession } from '../src/domain/sessions'
import { AppError } from '../src/errors'
import { createLogger } from '../src/logger'
import { errorMessage, sleep } from '../src/utils'

export const sessionSecret = 'test-session-secret-0123456789abcdef-test'
export const databaseUrl = process.env.TEST_DATABASE_URL ?? ''
export const redisUrl = process.env.TEST_REDIS_URL ?? ''
export const silentLogger = createLogger('silent', 'test')

export function openPool(max = 40): Pool {
  return createPool(databaseUrl, max, (error) => console.error('pool error', error.message), 60000)
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE outbox, idempotency_keys, payment_attempts, orders, reservations, sales, sessions, worker_status RESTART IDENTITY CASCADE'
  )
}

export function makeSession(pool: Pool) {
  return createSession(pool, sessionSecret, 24)
}

export function makeSale(pool: Pool, overrides: Partial<SaleInput> = {}): Promise<SaleView> {
  const now = Date.now()
  return createSale(pool, {
    name: 'Test Sale',
    description: 'Test',
    priceMinor: 50000,
    total: 100,
    maxPerSession: 4,
    holdSeconds: 300,
    startsAt: new Date(now - 3600000),
    endsAt: new Date(now + 3600000),
    ...overrides
  })
}

export const newKey = () => `key-${randomUUID()}`

export async function hold(pool: Pool, saleId: string, quantity = 1): Promise<{ session: { id: string; token: string }; reservation: ReservationView }> {
  const session = await makeSession(pool)
  const result = await reserve(pool, { sessionId: session.id, saleId, quantity, idempotencyKey: newKey() })
  return { session, reservation: result.body.data }
}

export async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return error instanceof AppError ? error.code : `unexpected:${errorMessage(error)}`
  }
}

export async function forceDue(pool: Pool, reservationId: string, offsetMs: number): Promise<void> {
  await pool.query("UPDATE reservations SET expires_at = clock_timestamp() + ($2::int * interval '1 millisecond') WHERE id = $1", [
    reservationId,
    offsetMs
  ])
}

export async function counters(pool: Pool, saleId: string): Promise<{ total: number; reserved: number; sold: number }> {
  const { rows } = await pool.query<{ total: number; reserved: number; sold: number }>('SELECT total, reserved, sold FROM sales WHERE id = $1', [saleId])
  return rows[0]
}

export async function countRows(pool: Pool, table: string, where = 'true'): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)
  return rows[0].n
}

export async function expectConsistent(pool: Pool): Promise<void> {
  const report = await reconcile(pool, { repair: false })
  expect(report.discrepancies).toEqual([])
}

export async function expireUntilSettled(pool: Pool, reservationId: string): Promise<ExpireOutcome> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const outcome = await expireReservation(pool, reservationId)
    if (outcome !== 'NOT_DUE') return outcome
    await sleep(10)
  }
  throw new Error('reservation never became due')
}

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}
