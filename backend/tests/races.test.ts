import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cancelReservation, checkout } from '../src/domain/checkout'
import { expireReservation } from '../src/domain/expiry'
import { countRows, counters, expectConsistent, expireUntilSettled, forceDue, hold, makeSale, newKey, openPool, outcomeOf, resetDatabase } from './helpers'
import { sleep } from '../src/utils'

describe('state transition races', () => {
  const pool = openPool()

  beforeEach(() => resetDatabase(pool))
  afterAll(() => pool.end())

  it('lets exactly one of checkout and expiry win at the expiry boundary', async () => {
    const sale = await makeSale(pool)
    let confirmed = 0
    for (let round = 0; round < 30; round += 1) {
      const { session, reservation } = await hold(pool, sale.id)
      await forceDue(pool, reservation.id, Math.floor(Math.random() * 30))
      const [paid, expired] = await Promise.all([
        outcomeOf(checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() })),
        expireUntilSettled(pool, reservation.id)
      ])
      if (paid === 'ok') {
        confirmed += 1
        expect(expired).toBe('ALREADY_RESOLVED')
      } else {
        expect(paid).toBe('RESERVATION_EXPIRED')
        expect(expired).toBe('EXPIRED')
      }
    }
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: confirmed })
    expect(await countRows(pool, 'orders')).toBe(confirmed)
    expect(await countRows(pool, 'reservations', "status = 'CONFIRMED'")).toBe(confirmed)
    expect(await countRows(pool, 'reservations', "status = 'EXPIRED'")).toBe(30 - confirmed)
    await expectConsistent(pool)
  })

  it('lets exactly one of checkout and cancellation win', async () => {
    const sale = await makeSale(pool)
    let confirmed = 0
    for (let round = 0; round < 30; round += 1) {
      const { session, reservation } = await hold(pool, sale.id)
      const [paid, cancelled] = await Promise.all([
        outcomeOf(checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() })),
        outcomeOf(cancelReservation(pool, session.id, reservation.id))
      ])
      if (paid === 'ok') {
        confirmed += 1
        expect(cancelled).toBe('RESERVATION_ALREADY_CONFIRMED')
      } else {
        expect(paid).toBe('RESERVATION_CANCELLED')
        expect(cancelled).toBe('ok')
      }
    }
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: confirmed })
    expect(await countRows(pool, 'orders')).toBe(confirmed)
    await expectConsistent(pool)
  })

  it('lets exactly one of cancellation and expiry win', async () => {
    const sale = await makeSale(pool)
    for (let round = 0; round < 30; round += 1) {
      const { session, reservation } = await hold(pool, sale.id)
      await forceDue(pool, reservation.id, Math.floor(Math.random() * 30))
      const [cancelled, expired] = await Promise.all([
        outcomeOf(cancelReservation(pool, session.id, reservation.id)),
        expireUntilSettled(pool, reservation.id)
      ])
      if (cancelled === 'ok') expect(expired).toBe('ALREADY_RESOLVED')
      else {
        expect(cancelled).toBe('RESERVATION_EXPIRED')
        expect(expired).toBe('EXPIRED')
      }
    }
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 0 })
    await expectConsistent(pool)
  })

  it('releases inventory exactly once when many duplicate expiry jobs run together', async () => {
    const sale = await makeSale(pool)
    const { reservation } = await hold(pool, sale.id, 3)
    await forceDue(pool, reservation.id, -1000)
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => expireReservation(pool, reservation.id)))
    expect(outcomes.filter((outcome) => outcome === 'EXPIRED')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'ALREADY_RESOLVED')).toHaveLength(9)
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 0 })
    await expectConsistent(pool)
  })

  it('ignores an early expiry job and leaves the reservation held', async () => {
    const sale = await makeSale(pool)
    const { reservation } = await hold(pool, sale.id)
    expect(await expireReservation(pool, reservation.id)).toBe('NOT_DUE')
    expect((await counters(pool, sale.id)).reserved).toBe(1)
  })

  it('lets a delayed expiry job run harmlessly after confirmation', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id)
    await checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() })
    await forceDue(pool, reservation.id, -1000)
    expect(await expireReservation(pool, reservation.id)).toBe('ALREADY_RESOLVED')
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 1 })
  })

  it('makes checkout wait for an in-flight expiry and then fail without confirming', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id)
    const expiring = await pool.connect()
    try {
      await expiring.query('BEGIN')
      await expiring.query('SELECT id FROM reservations WHERE id = $1 FOR UPDATE', [reservation.id])
      const pending = outcomeOf(checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() }))
      await sleep(300)
      await expiring.query("UPDATE reservations SET status = 'EXPIRED', resolved_at = clock_timestamp() WHERE id = $1", [reservation.id])
      await expiring.query('UPDATE sales SET reserved = reserved - 1 WHERE id = $1', [sale.id])
      await expiring.query('COMMIT')
      expect(await pending).toBe('RESERVATION_EXPIRED')
    } finally {
      expiring.release()
    }
    expect(await countRows(pool, 'orders')).toBe(0)
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 0 })
  })

  it('makes expiry wait for an in-flight confirmation and then release nothing', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id)
    await forceDue(pool, reservation.id, -1000)
    const confirming = await pool.connect()
    try {
      await confirming.query('BEGIN')
      await confirming.query('SELECT id FROM reservations WHERE id = $1 FOR UPDATE', [reservation.id])
      const pending = expireReservation(pool, reservation.id)
      await sleep(300)
      await confirming.query("UPDATE reservations SET status = 'CONFIRMED', resolved_at = clock_timestamp() WHERE id = $1", [reservation.id])
      await confirming.query('UPDATE sales SET reserved = reserved - 1, sold = sold + 1 WHERE id = $1', [sale.id])
      await confirming.query('INSERT INTO orders (reservation_id, sale_id, session_id, quantity, total_minor) VALUES ($1, $2, $3, 1, 50000)', [
        reservation.id,
        sale.id,
        session.id
      ])
      await confirming.query('COMMIT')
      expect(await pending).toBe('ALREADY_RESOLVED')
    } finally {
      confirming.release()
    }
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 1 })
    await expectConsistent(pool)
  })
})
