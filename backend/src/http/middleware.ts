import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Config } from '../config'
import { SESSION_COOKIE, findSession } from '../domain/sessions'
import { adminDisabled, adminRequired, csrfHeaderRequired, idempotencyKeyRequired, rateLimited, sessionRequired } from '../errors'
import type { Logger } from '../logger'
import type { Metrics } from '../metrics'
import type { Pool } from 'pg'
import type { RateLimiter } from './rateLimiter'
import { idempotencyKeySchema } from './schemas'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export function wrap(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next)
  }
}

export function requestContext(logger: Logger, metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id')
    req.requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID()
    req.log = logger.child({ requestId: req.requestId })
    res.setHeader('X-Request-Id', req.requestId)
    const started = process.hrtime.bigint()
    res.on('finish', () => {
      const milliseconds = Number(process.hrtime.bigint() - started) / 1e6
      metrics.recordRequest(res.statusCode, milliseconds)
      if (req.path !== '/api/v1/health') {
        req.log.info({ method: req.method, path: req.path, status: res.statusCode, ms: Math.round(milliseconds * 100) / 100 }, 'request')
      }
    })
    next()
  }
}

export function requireCsrfHeader(): RequestHandler {
  return (req, _res, next) => {
    const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
    if (safe || req.get('x-requested-with') === 'flashrush') {
      next()
      return
    }
    next(csrfHeaderRequired())
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim())
      } catch (error) {
        if (error instanceof URIError) return undefined
        throw error
      }
    }
  }
  return undefined
}

export function attachSession(pool: Pool, config: Config): RequestHandler {
  const load = async (req: Request): Promise<void> => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (!token) return
    const sessionId = await findSession(pool, config.SESSION_SECRET, token)
    if (sessionId) req.sessionId = sessionId
  }
  return (req, _res, next) => {
    load(req).then(() => next(), next)
  }
}

export function requireSession(): RequestHandler {
  return (req, _res, next) => {
    if (req.sessionId) next()
    else next(sessionRequired())
  }
}

export function idempotencyKey(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.get('idempotency-key'))
  if (!parsed.success) throw idempotencyKeyRequired()
  return parsed.data
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function adminGuard(config: Config): RequestHandler {
  return (req, _res, next) => {
    if (!config.ADMIN_TOKEN) {
      next(adminDisabled())
      return
    }
    const provided = req.get('x-admin-token') ?? ''
    if (timingSafeEqual(digest(provided), digest(config.ADMIN_TOKEN))) next()
    else next(adminRequired())
  }
}

export function rateLimit(limiter: RateLimiter, metrics: Metrics, bucket: 'read' | 'book'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    limiter.consume(bucket, req.ip ?? 'unknown').then((decision) => {
      res.setHeader('X-RateLimit-Limit', String(decision.limit))
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining))
      if (decision.allowed) {
        next()
        return
      }
      const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
      res.setHeader('Retry-After', String(retryAfterSeconds))
      metrics.recordRateLimited()
      next(rateLimited(retryAfterSeconds))
    }, next)
  }
}
