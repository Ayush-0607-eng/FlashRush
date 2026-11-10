import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Redis } from 'ioredis'
import { RateLimiter } from '../src/http/rateLimiter'
import { createRedis, waitForRedis } from '../src/redis'
import { sleep } from '../src/utils'
import { redisUrl, silentLogger } from './helpers'

describe('token bucket rate limiter', () => {
  let redis: Redis

  beforeAll(async () => {
    redis = createRedis(redisUrl, silentLogger)
    expect(await waitForRedis(redis, 5000)).toBe(true)
  })
  beforeEach(() => redis.flushdb())
  afterAll(() => {
    redis.disconnect()
  })

  const limiter = (capacity: number, refillPerSecond: number, failMode: 'open' | 'closed' = 'open', client?: Redis) =>
    new RateLimiter(client ?? redis, { book: { capacity, refillPerSecond } }, failMode, silentLogger)

  it('allows the burst capacity and then rejects with a retry hint', async () => {
    const bucket = limiter(3, 0.5)
    const decisions = []
    for (let index = 0; index < 5; index += 1) decisions.push(await bucket.consume('book', 'client-a'))
    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false, false])
    expect(decisions[0].remaining).toBe(2)
    expect(decisions[3].retryAfterMs).toBeGreaterThan(0)
    expect(decisions[3].retryAfterMs).toBeLessThanOrEqual(2000)
  })

  it('keeps separate buckets per identifier', async () => {
    const bucket = limiter(1, 0.01)
    expect((await bucket.consume('book', 'one')).allowed).toBe(true)
    expect((await bucket.consume('book', 'one')).allowed).toBe(false)
    expect((await bucket.consume('book', 'two')).allowed).toBe(true)
  })

  it('admits exactly the capacity under concurrent callers', async () => {
    const bucket = limiter(10, 0.001)
    const decisions = await Promise.all(Array.from({ length: 80 }, () => bucket.consume('book', 'shared')))
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10)
  })

  it('refills tokens over time up to the capacity', async () => {
    const bucket = limiter(2, 20)
    await bucket.consume('book', 'refill')
    await bucket.consume('book', 'refill')
    expect((await bucket.consume('book', 'refill')).allowed).toBe(false)
    await sleep(300)
    const decisions = await Promise.all([bucket.consume('book', 'refill'), bucket.consume('book', 'refill'), bucket.consume('book', 'refill')])
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(2)
  })

  it('fails open or closed when redis is unreachable according to configuration', async () => {
    const dead = createRedis('redis://127.0.0.1:1', silentLogger)
    try {
      const open = await limiter(1, 1, 'open', dead).consume('book', 'x')
      expect(open).toMatchObject({ allowed: true, degraded: true })
      await expect(limiter(1, 1, 'closed', dead).consume('book', 'x')).rejects.toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE', status: 503 })
    } finally {
      dead.disconnect()
    }
  })
})
