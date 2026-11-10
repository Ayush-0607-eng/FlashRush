import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { expireReservation, sweepExpired } from '../src/domain/expiry'
import { relayOutbox, type OutboxMessage, type Publisher } from '../src/domain/outbox'
import { bullConnection } from '../src/redis'
import { createExpiryQueue, createExpiryWorker, createPublisher } from '../src/queue/expiryQueue'
import { sleep } from '../src/utils'
import { countRows, counters, expectConsistent, forceDue, hold, makeSale, openPool, redisUrl, resetDatabase, silentLogger, waitFor } from './helpers'
import { Redis } from 'ioredis'

describe('transactional outbox', () => {
  const pool = openPool()
  const redis = new Redis(redisUrl)

  beforeEach(async () => {
    await resetDatabase(pool)
    await redis.flushdb()
  })
  afterAll(async () => {
    await pool.end()
    redis.disconnect()
  })

  async function seedOutbox(count: number): Promise<void> {
    await pool.query(
      `INSERT INTO outbox (topic, dedupe_key, payload, available_at)
       SELECT 'reservation.expire', 'seed-' || g, jsonb_build_object('n', g), now() FROM generate_series(1, $1::int) g`,
      [count]
    )
  }

  it('writes one outbox row in the same transaction as the reservation', async () => {
    const sale = await makeSale(pool)
    const { reservation } = await hold(pool, sale.id)
    const { rows } = await pool.query<{ dedupe_key: string; same_time: boolean }>(
      `SELECT o.dedupe_key, (o.available_at = r.expires_at) AS same_time FROM outbox o JOIN reservations r ON r.id = $1`,
      [reservation.id]
    )
    expect(rows).toEqual([{ dedupe_key: `expire-${reservation.id}`, same_time: true }])
  })

  it('publishes each message once when several relays run concurrently', async () => {
    await seedOutbox(120)
    const published: string[] = []
    const publisher: Publisher = async (message) => {
      await sleep(2)
      published.push(message.dedupeKey)
    }
    const drain = async () => {
      for (;;) {
        const result = await relayOutbox(pool, publisher, 20)
        if (result.examined === 0) return
      }
    }
    await Promise.all(Array.from({ length: 6 }, drain))
    expect(published).toHaveLength(120)
    expect(new Set(published).size).toBe(120)
    expect(await countRows(pool, 'outbox', 'published_at IS NULL')).toBe(0)
  })

  it('backs off failed publications and publishes them once the broker recovers', async () => {
    await seedOutbox(5)
    const failing: Publisher = async () => {
      throw new Error('redis unavailable')
    }
    const failed = await relayOutbox(pool, failing, 100)
    expect(failed).toEqual({ examined: 5, published: 0, failed: 5 })
    expect(await countRows(pool, 'outbox', 'attempts = 1 AND published_at IS NULL AND last_error IS NOT NULL')).toBe(5)
    expect((await relayOutbox(pool, failing, 100)).examined).toBe(0)
    await pool.query('UPDATE outbox SET next_attempt_at = now()')
    const seen: string[] = []
    const recovered = await relayOutbox(pool, async (message) => void seen.push(message.dedupeKey), 100)
    expect(recovered).toEqual({ examined: 5, published: 5, failed: 0 })
    expect(seen).toHaveLength(5)
  })

  it('republishes after a crash between publication and commit and the duplicate is harmless', async () => {
    const sale = await makeSale(pool, { holdSeconds: 60 })
    const { reservation } = await hold(pool, sale.id)
    const deliveries: OutboxMessage[] = []
    const crashing: Publisher = async (message) => {
      deliveries.push(message)
      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = current_database() AND state = 'idle in transaction' AND query LIKE '%FOR UPDATE SKIP LOCKED%'`
      )
    }
    await expect(relayOutbox(pool, crashing, 10)).rejects.toThrow()
    expect(await countRows(pool, 'outbox', 'published_at IS NULL')).toBe(1)
    const queue = createExpiryQueue(bullConnection(redisUrl), silentLogger)
    try {
      const publish = createPublisher(queue)
      const recovered: Publisher = async (message) => {
        deliveries.push(message)
        await publish(message)
      }
      expect((await relayOutbox(pool, recovered, 10)).published).toBe(1)
      await publish(deliveries[0])
      expect(deliveries.map((message) => message.dedupeKey)).toEqual([`expire-${reservation.id}`, `expire-${reservation.id}`])
      expect((await queue.getJobCounts('delayed')).delayed).toBe(1)
    } finally {
      await queue.close()
    }
  })

  it('keeps expiring reservations through the sweeper while the queue is unavailable', async () => {
    const sale = await makeSale(pool)
    const { reservation } = await hold(pool, sale.id)
    const unavailable: Publisher = async () => {
      throw new Error('queue down')
    }
    expect((await relayOutbox(pool, unavailable, 10)).failed).toBe(1)
    await forceDue(pool, reservation.id, -1000)
    expect((await sweepExpired(pool)).expired).toBe(1)
    expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 0 })
    expect(await countRows(pool, 'outbox', 'published_at IS NULL')).toBe(1)
    await pool.query('UPDATE outbox SET next_attempt_at = now()')
    const queue = createExpiryQueue(bullConnection(redisUrl), silentLogger)
    try {
      await relayOutbox(pool, createPublisher(queue), 10)
      expect(await expireReservation(pool, reservation.id)).toBe('ALREADY_RESOLVED')
    } finally {
      await queue.close()
    }
    await expectConsistent(pool)
  })

  it('expires a reservation through the delayed BullMQ job end to end', async () => {
    const sale = await makeSale(pool, { holdSeconds: 1 })
    const { reservation } = await hold(pool, sale.id)
    const connection = bullConnection(redisUrl)
    const queue = createExpiryQueue(connection, silentLogger)
    const worker = createExpiryWorker(connection, pool, silentLogger)
    try {
      expect((await relayOutbox(pool, createPublisher(queue), 10)).published).toBe(1)
      await waitFor(async () => (await countRows(pool, 'reservations', `id = '${reservation.id}' AND status = 'EXPIRED'`)) === 1, 20000)
      expect(await counters(pool, sale.id)).toEqual({ total: 100, reserved: 0, sold: 0 })
    } finally {
      await worker.close()
      await queue.close()
    }
    await expectConsistent(pool)
  })
})
