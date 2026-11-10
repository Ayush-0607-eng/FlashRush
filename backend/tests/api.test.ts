import type { Server } from 'node:http'
import type { Express } from 'express'
import type { Redis } from 'ioredis'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { recordStatus } from '../src/domain/workerStatus'
import { createApp } from '../src/http/app'
import { RateLimiter } from '../src/http/rateLimiter'
import { Metrics } from '../src/metrics'
import { createRedis, waitForRedis } from '../src/redis'
import { countRows, counters, databaseUrl, expectConsistent, makeSale, makeSession, newKey, openPool, redisUrl, resetDatabase, sessionSecret, silentLogger } from './helpers'

const adminToken = 'test-admin-token-0123456789abcdef'
const csrf = { 'X-Requested-With': 'flashrush' }

function envFor(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    SESSION_SECRET: sessionSecret,
    ADMIN_TOKEN: adminToken,
    ALLOWED_ORIGINS: 'http://localhost:18473',
    RATE_LIMIT_READ_CAPACITY: '100000',
    RATE_LIMIT_READ_REFILL_PER_SEC: '100000',
    RATE_LIMIT_BOOK_CAPACITY: '100000',
    RATE_LIMIT_BOOK_REFILL_PER_SEC: '100000',
    ...overrides
  }
}

describe('http api', () => {
  const pool = openPool()
  let redis: Redis
  let server: Server

  function buildApp(overrides: Record<string, string> = {}): Express {
    const config = loadConfig(envFor(overrides))
    const limiter = new RateLimiter(
      redis,
      {
        read: { capacity: config.RATE_LIMIT_READ_CAPACITY, refillPerSecond: config.RATE_LIMIT_READ_REFILL_PER_SEC },
        book: { capacity: config.RATE_LIMIT_BOOK_CAPACITY, refillPerSecond: config.RATE_LIMIT_BOOK_REFILL_PER_SEC }
      },
      config.RATE_LIMIT_FAIL_MODE,
      silentLogger
    )
    return createApp({ config, pool, redis, logger: silentLogger, metrics: new Metrics(), limiter })
  }

  beforeAll(async () => {
    redis = createRedis(redisUrl, silentLogger)
    expect(await waitForRedis(redis, 5000)).toBe(true)
    server = buildApp().listen(0)
  })
  beforeEach(async () => {
    await resetDatabase(pool)
    await redis.flushdb()
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
    redis.disconnect()
  })

  it('reports liveness and readiness', async () => {
    expect((await request(server).get('/api/v1/health')).body).toEqual({ status: 'ok' })
    const ready = await request(server).get('/api/v1/ready')
    expect(ready.status).toBe(200)
    expect(ready.body).toEqual({ status: 'ready', checks: { postgres: true, redis: true } })
  })

  it('requires the CSRF header on unsafe methods', async () => {
    const response = await request(server).post('/api/v1/session')
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('CSRF_HEADER_REQUIRED')
  })

  it('issues an HTTP-only session cookie once and recognises it afterwards', async () => {
    const created = await request(server).post('/api/v1/session').set(csrf)
    expect(created.status).toBe(201)
    const cookie = (created.headers['set-cookie'] as unknown as string[])[0]
    expect(cookie).toContain('fr_sid=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    const again = await request(server).post('/api/v1/session').set(csrf).set('Cookie', cookie.split(';')[0])
    expect(again.status).toBe(200)
    expect(again.body.data.created).toBe(false)
  })

  it('rejects booking calls without a session', async () => {
    const sale = await makeSale(pool)
    const response = await request(server).post(`/api/v1/sales/${sale.id}/reservations`).set(csrf).set('Idempotency-Key', newKey()).send({ quantity: 1 })
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('SESSION_REQUIRED')
  })

  it('protects administrative operations', async () => {
    const body = { name: 'Gig', priceMinor: 1000, total: 10, startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString() }
    expect((await request(server).post('/api/v1/admin/sales').set(csrf).send(body)).body.error.code).toBe('ADMIN_REQUIRED')
    expect((await request(server).post('/api/v1/admin/sales').set(csrf).set('X-Admin-Token', 'wrong-token-wrong-token-wrong').send(body)).status).toBe(403)
    const created = await request(server).post('/api/v1/admin/sales').set(csrf).set('X-Admin-Token', adminToken).send(body)
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ name: 'Gig', total: 10, available: 10, status: 'ACTIVE' })
    const invalid = await request(server).post('/api/v1/admin/sales').set(csrf).set('X-Admin-Token', adminToken).send({ ...body, priceMinor: 0 })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('disables admin operations when no token is configured', async () => {
    const disabled = buildApp({ ADMIN_TOKEN: '' }).listen(0)
    try {
      const response = await request(disabled).post('/api/v1/admin/sales').set(csrf).set('X-Admin-Token', adminToken).send({})
      expect(response.body.error.code).toBe('ADMIN_DISABLED')
    } finally {
      await new Promise<void>((resolve) => disabled.close(() => resolve()))
    }
  })

  it('runs the whole booking journey with idempotent retries', async () => {
    const sale = await makeSale(pool, { total: 10 })
    const session = await makeSession(pool)
    const cookie = `fr_sid=${session.token}`
    const key = newKey()
    const reserveUrl = `/api/v1/sales/${sale.id}/reservations`
    const created = await request(server).post(reserveUrl).set(csrf).set('Cookie', cookie).set('Idempotency-Key', key).send({ quantity: 2 })
    expect(created.status).toBe(201)
    const reservationId = created.body.data.id as string
    const replay = await request(server).post(reserveUrl).set(csrf).set('Cookie', cookie).set('Idempotency-Key', key).send({ quantity: 2 })
    expect(replay.status).toBe(201)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    expect(replay.body.data.id).toBe(reservationId)
    const reused = await request(server).post(reserveUrl).set(csrf).set('Cookie', cookie).set('Idempotency-Key', key).send({ quantity: 3 })
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    const missing = await request(server).post(reserveUrl).set(csrf).set('Cookie', cookie).send({ quantity: 1 })
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')

    const declined = await request(server).post(`/api/v1/reservations/${reservationId}/checkout`).set(csrf).set('Cookie', cookie).set('Idempotency-Key', newKey()).send({ outcome: 'fail' })
    expect(declined.status).toBe(402)
    expect(declined.body.error.code).toBe('PAYMENT_DECLINED')
    const paid = await request(server).post(`/api/v1/reservations/${reservationId}/checkout`).set(csrf).set('Cookie', cookie).set('Idempotency-Key', newKey()).send({ outcome: 'success' })
    expect(paid.status).toBe(201)
    expect(paid.body.data.order).toMatchObject({ quantity: 2, simulated: true, paymentStatus: 'SIMULATED_PAID' })

    const bookings = await request(server).get('/api/v1/bookings').set('Cookie', cookie)
    expect(bookings.body.data).toHaveLength(1)
    expect(bookings.body.data[0].order.id).toBe(paid.body.data.order.id)
    const detail = await request(server).get(`/api/v1/sales/${sale.id}`)
    expect(detail.body.data).toMatchObject({ reserved: 0, sold: 2, available: 8 })
    const cancel = await request(server).post(`/api/v1/reservations/${reservationId}/cancel`).set(csrf).set('Cookie', cookie)
    expect(cancel.body.error.code).toBe('RESERVATION_ALREADY_CONFIRMED')
    await expectConsistent(pool)
  })

  it('does not oversell when 100 sessions hit one sale over HTTP', async () => {
    const sale = await makeSale(pool, { total: 30 })
    const sessions = await Promise.all(Array.from({ length: 100 }, () => makeSession(pool)))
    const responses = await Promise.all(
      sessions.map((session) =>
        request(server).post(`/api/v1/sales/${sale.id}/reservations`).set(csrf).set('Cookie', `fr_sid=${session.token}`).set('Idempotency-Key', newKey()).send({ quantity: 1 })
      )
    )
    expect(responses.filter((response) => response.status === 201)).toHaveLength(30)
    const rejected = responses.filter((response) => response.status === 409)
    expect(rejected).toHaveLength(70)
    expect(rejected.every((response) => response.body.error.code === 'SOLD_OUT')).toBe(true)
    expect(await counters(pool, sale.id)).toEqual({ total: 30, reserved: 30, sold: 0 })
    expect(await countRows(pool, 'reservations')).toBe(30)
    await expectConsistent(pool)
  })

  it('answers 429 with Retry-After once the booking bucket is empty', async () => {
    const limited = buildApp({ RATE_LIMIT_BOOK_CAPACITY: '3', RATE_LIMIT_BOOK_REFILL_PER_SEC: '0.01' }).listen(0)
    try {
      const statuses: number[] = []
      let last: request.Response | undefined
      for (let index = 0; index < 5; index += 1) {
        last = await request(limited).post('/api/v1/session').set(csrf)
        statuses.push(last.status)
      }
      expect(statuses.slice(0, 3).every((status) => status === 201 || status === 200)).toBe(true)
      expect(statuses.slice(3)).toEqual([429, 429])
      expect(last?.body.error.code).toBe('RATE_LIMITED')
      expect(Number(last?.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    } finally {
      await new Promise<void>((resolve) => limited.close(() => resolve()))
    }
  })

  it('validates identifiers and bodies', async () => {
    const session = await makeSession(pool)
    const cookie = `fr_sid=${session.token}`
    expect((await request(server).get('/api/v1/sales/not-a-uuid')).body.error.code).toBe('VALIDATION_ERROR')
    const malformed = await request(server).post('/api/v1/session').set(csrf).set('Content-Type', 'application/json').send('{broken')
    expect(malformed.status).toBe(400)
    const oversize = await request(server).post('/api/v1/session').set(csrf).send({ blob: 'x'.repeat(20000) })
    expect(oversize.status).toBe(413)
    const sale = await makeSale(pool)
    const badQuantity = await request(server).post(`/api/v1/sales/${sale.id}/reservations`).set(csrf).set('Cookie', cookie).set('Idempotency-Key', newKey()).send({ quantity: 'many' })
    expect(badQuantity.status).toBe(400)
  })

  it('reports metrics derived from real activity and worker health from the heartbeat', async () => {
    const sale = await makeSale(pool, { total: 5 })
    const session = await makeSession(pool)
    await request(server).post(`/api/v1/sales/${sale.id}/reservations`).set(csrf).set('Cookie', `fr_sid=${session.token}`).set('Idempotency-Key', newKey()).send({ quantity: 1 })
    const metrics = await request(server).get('/api/v1/metrics')
    expect(metrics.body.data.process.requestsTotal).toBeGreaterThan(0)
    expect(metrics.body.data.process.reservationOutcomes.created).toBe(1)
    expect(metrics.body.data.database.inventory).toMatchObject({ total: 5, reserved: 1, sold: 0 })
    expect(metrics.body.data.database.outbox.pending).toBe(1)
    expect((await request(server).get('/api/v1/worker/health')).status).toBe(503)
    await recordStatus(pool, 'heartbeat', { workerId: 'test' })
    const health = await request(server).get('/api/v1/worker/health')
    expect(health.status).toBe(200)
    expect(health.body.data.alive).toBe(true)
  })
})
