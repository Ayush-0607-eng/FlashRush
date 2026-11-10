import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cancelReservation, checkout } from '../src/domain/checkout'
import { expireReservation } from '../src/domain/expiry'
import { getReservation, listBookings } from '../src/domain/reservations'
import { countRows, counters, expectConsistent, forceDue, hold, makeSale, makeSession, newKey, openPool, outcomeOf, resetDatabase } from './helpers'

describe('checkout and cancellation', () => {
  const pool = openPool()

  beforeEach(() => resetDatabase(pool))
  afterAll(() => pool.end())

  it('moves inventory from reserved to sold on a successful simulated payment', async () => {
    const sale = await makeSale(pool, { priceMinor: 25000 })
    const { session, reservation } = await hold(pool, sale.id, 3)
    const result = await checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() })
    expect(result.status).toBe(201)
    expect(result.body.data?.order).toMatchObject({ quantity: 3, totalMinor: 75000, paymentStatus: 'SIMULATED_PAID', simulated: true })
    expect(result.body.data?.reservation.status).toBe('CONFIRMED')
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 3 })
    await expectConsistent(pool)
  })

  it('keeps the hold after a declined payment and allows a retry', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id)
    const declined = await checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'fail', idempotencyKey: newKey() })
    expect(declined.status).toBe(402)
    expect(declined.body.error?.code).toBe('PAYMENT_DECLINED')
    expect((await getReservation(pool, session.id, reservation.id)).status).toBe('RESERVED')
    expect(await countRows(pool, 'orders')).toBe(0)
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 1, sold: 0 })
    const paid = await checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() })
    expect(paid.status).toBe(201)
    expect(await countRows(pool, 'payment_attempts')).toBe(2)
    await expectConsistent(pool)
  })

  it('releases a declined reservation when it later expires', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id)
    await checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'fail', idempotencyKey: newKey() })
    await forceDue(pool, reservation.id, -1000)
    expect(await expireReservation(pool, reservation.id)).toBe('EXPIRED')
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 0 })
    await expectConsistent(pool)
  })

  it('refuses checkout after the reservation is past its expiry', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id)
    await forceDue(pool, reservation.id, -1000)
    expect(await outcomeOf(checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() }))).toBe(
      'RESERVATION_EXPIRED'
    )
    expect(await countRows(pool, 'orders')).toBe(0)
    expect((await counters(pool, sale.id)).sold).toBe(0)
  })

  it('refuses checkout once the reservation has been expired by the worker', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id)
    await forceDue(pool, reservation.id, -1000)
    await expireReservation(pool, reservation.id)
    expect(await outcomeOf(checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() }))).toBe(
      'RESERVATION_EXPIRED'
    )
  })

  it('cancels a reservation and releases inventory exactly once', async () => {
    const sale = await makeSale(pool)
    const { session, reservation } = await hold(pool, sale.id, 2)
    const results = await Promise.all(Array.from({ length: 5 }, () => cancelReservation(pool, session.id, reservation.id)))
    expect(results.every((result) => result.status === 'CANCELLED')).toBe(true)
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 0 })
    await expectConsistent(pool)
  })

  it('does not allow checkout after cancellation or cancellation after confirmation', async () => {
    const sale = await makeSale(pool)
    const cancelled = await hold(pool, sale.id)
    await cancelReservation(pool, cancelled.session.id, cancelled.reservation.id)
    expect(
      await outcomeOf(checkout(pool, { sessionId: cancelled.session.id, reservationId: cancelled.reservation.id, outcome: 'success', idempotencyKey: newKey() }))
    ).toBe('RESERVATION_CANCELLED')
    const paid = await hold(pool, sale.id)
    await checkout(pool, { sessionId: paid.session.id, reservationId: paid.reservation.id, outcome: 'success', idempotencyKey: newKey() })
    expect(await outcomeOf(cancelReservation(pool, paid.session.id, paid.reservation.id))).toBe('RESERVATION_ALREADY_CONFIRMED')
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 1 })
    await expectConsistent(pool)
  })

  it('hides reservations from other sessions', async () => {
    const sale = await makeSale(pool)
    const { reservation } = await hold(pool, sale.id)
    const stranger = await makeSession(pool)
    expect(await outcomeOf(checkout(pool, { sessionId: stranger.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() }))).toBe(
      'RESERVATION_NOT_FOUND'
    )
    expect(await outcomeOf(cancelReservation(pool, stranger.id, reservation.id))).toBe('RESERVATION_NOT_FOUND')
    expect(await outcomeOf(getReservation(pool, stranger.id, reservation.id))).toBe('RESERVATION_NOT_FOUND')
    expect(await listBookings(pool, stranger.id)).toEqual([])
  })

  it('lists bookings with their orders', async () => {
    const sale = await makeSale(pool, { name: 'Gig' })
    const { session, reservation } = await hold(pool, sale.id)
    await checkout(pool, { sessionId: session.id, reservationId: reservation.id, outcome: 'success', idempotencyKey: newKey() })
    const bookings = await listBookings(pool, session.id)
    expect(bookings).toHaveLength(1)
    expect(bookings[0].saleName).toBe('Gig')
    expect(bookings[0].reservation.status).toBe('CONFIRMED')
    expect(bookings[0].order?.paymentStatus).toBe('SIMULATED_PAID')
  })
})
