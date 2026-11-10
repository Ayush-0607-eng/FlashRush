import { Router, type Request, type Response } from 'express'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import type { Config } from '../config'
import { checkout, cancelReservation } from '../domain/checkout'
import { reconcile } from '../domain/reconciliation'
import { getReservation, listBookings, reserve } from '../domain/reservations'
import { createSale, getSale, listSales, updateSale } from '../domain/sales'
import { SESSION_COOKIE, createSession } from '../domain/sessions'
import { readStatus } from '../domain/workerStatus'
import { AppError } from '../errors'
import type { Logger } from '../logger'
import { databaseSnapshot, type Metrics } from '../metrics'
import { adminGuard, attachSession, idempotencyKey, rateLimit, requireCsrfHeader, requireSession, wrap } from './middleware'
import type { RateLimiter } from './rateLimiter'
import { checkoutSchema, createSaleSchema, reconcileSchema, reserveSchema, updateSaleSchema, uuidSchema } from './schemas'

export interface AppDeps {
  config: Config
  pool: Pool
  redis: Redis
  logger: Logger
  metrics: Metrics
  limiter: RateLimiter
}

const HEARTBEAT_STALE_SECONDS = 20

async function probe(check: () => Promise<unknown>, logger: Logger, name: string): Promise<boolean> {
  try {
    await check()
    return true
  } catch (error) {
    logger.warn({ err: error, probe: name }, 'readiness probe failed')
    return false
  }
}

function sendStored(res: Response, result: { status: number; body: unknown; replayed: boolean }): void {
  if (result.replayed) res.setHeader('Idempotency-Replayed', 'true')
  res.status(result.status).json(result.body)
}

function sessionIdOf(req: Request): string {
  if (!req.sessionId) throw new AppError(401, 'SESSION_REQUIRED', 'A valid demo session is required')
  return req.sessionId
}

export function buildRouter(deps: AppDeps): Router {
  const { config, pool, redis, logger, metrics, limiter } = deps
  const router = Router()
  const readLimit = rateLimit(limiter, metrics, 'read')
  const bookLimit = rateLimit(limiter, metrics, 'book')
  const session = [attachSession(pool, config), requireSession()]

  router.use(requireCsrfHeader())

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  router.get(
    '/ready',
    wrap(async (_req, res) => {
      const postgres = await probe(() => pool.query('SELECT 1'), logger, 'postgres')
      const redisUp = await probe(() => redis.ping(), logger, 'redis')
      const status = !postgres ? 'unavailable' : redisUp ? 'ready' : 'degraded'
      res.status(postgres ? 200 : 503).json({ status, checks: { postgres, redis: redisUp } })
    })
  )

  router.use((req, res, next) => (req.method === 'GET' ? readLimit(req, res, next) : next()))

  router.get(
    '/sales',
    wrap(async (_req, res) => {
      res.json({ data: await listSales(pool) })
    })
  )

  router.get(
    '/sales/:id',
    wrap(async (req, res) => {
      res.json({ data: await getSale(pool, uuidSchema.parse(req.params.id)) })
    })
  )

  router.post(
    '/session',
    bookLimit,
    attachSession(pool, config),
    wrap(async (req, res) => {
      if (req.sessionId) {
        res.json({ data: { created: false } })
        return
      }
      const created = await createSession(pool, config.SESSION_SECRET, config.SESSION_TTL_HOURS)
      res.cookie(SESSION_COOKIE, created.token, {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: config.COOKIE_SAMESITE,
        maxAge: config.SESSION_TTL_HOURS * 3600 * 1000,
        path: '/'
      })
      res.status(201).json({ data: { created: true } })
    })
  )

  router.post(
    '/sales/:id/reservations',
    bookLimit,
    ...session,
    wrap(async (req, res) => {
      const saleId = uuidSchema.parse(req.params.id)
      const body = reserveSchema.parse(req.body)
      const key = idempotencyKey(req)
      try {
        const result = await reserve(pool, { sessionId: sessionIdOf(req), saleId, quantity: body.quantity, idempotencyKey: key })
        metrics.recordReservation(result.replayed ? 'replayed' : 'created')
        sendStored(res, result)
      } catch (error) {
        metrics.recordReservation(error instanceof AppError ? error.code : 'ERROR')
        throw error
      }
    })
  )

  router.get(
    '/reservations/:id',
    ...session,
    wrap(async (req, res) => {
      res.json({ data: await getReservation(pool, sessionIdOf(req), uuidSchema.parse(req.params.id)) })
    })
  )

  router.post(
    '/reservations/:id/checkout',
    bookLimit,
    ...session,
    wrap(async (req, res) => {
      const reservationId = uuidSchema.parse(req.params.id)
      const body = checkoutSchema.parse(req.body)
      const key = idempotencyKey(req)
      const result = await checkout(pool, { sessionId: sessionIdOf(req), reservationId, outcome: body.outcome, idempotencyKey: key })
      sendStored(res, result)
    })
  )

  router.post(
    '/reservations/:id/cancel',
    bookLimit,
    ...session,
    wrap(async (req, res) => {
      res.json({ data: await cancelReservation(pool, sessionIdOf(req), uuidSchema.parse(req.params.id)) })
    })
  )

  router.get(
    '/bookings',
    ...session,
    wrap(async (req, res) => {
      res.json({ data: await listBookings(pool, sessionIdOf(req)) })
    })
  )

  router.get(
    '/metrics',
    wrap(async (_req, res) => {
      res.json({ data: { process: metrics.snapshot(), database: await databaseSnapshot(pool) } })
    })
  )

  router.get(
    '/worker/health',
    wrap(async (_req, res) => {
      const heartbeat = await readStatus(pool, 'heartbeat')
      const alive = heartbeat !== null && heartbeat.ageSeconds < HEARTBEAT_STALE_SECONDS
      res.status(alive ? 200 : 503).json({ data: { alive, heartbeat } })
    })
  )

  router.post(
    '/admin/sales',
    bookLimit,
    adminGuard(config),
    wrap(async (req, res) => {
      res.status(201).json({ data: await createSale(pool, createSaleSchema.parse(req.body)) })
    })
  )

  router.patch(
    '/admin/sales/:id',
    bookLimit,
    adminGuard(config),
    wrap(async (req, res) => {
      res.json({ data: await updateSale(pool, uuidSchema.parse(req.params.id), updateSaleSchema.parse(req.body)) })
    })
  )

  router.post(
    '/admin/reconcile',
    bookLimit,
    adminGuard(config),
    wrap(async (req, res) => {
      const body = reconcileSchema.parse(req.body ?? {})
      res.json({ data: await reconcile(pool, { repair: body.repair }) })
    })
  )

  return router
}
