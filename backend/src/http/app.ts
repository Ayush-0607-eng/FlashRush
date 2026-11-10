import cors from 'cors'
import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import swaggerUi from 'swagger-ui-express'
import openApi from '../openapi.json'
import { ZodError } from 'zod'
import { pgErrorCode } from '../db'
import { AppError } from '../errors'
import { requestContext } from './middleware'
import { buildRouter, type AppDeps } from './routes'

interface BodyParserError {
  type: string
  status: number
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return typeof error === 'object' && error !== null && typeof (error as BodyParserError).type === 'string' && typeof (error as BodyParserError).status === 'number'
}

function errorHandler(deps: AppDeps): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const requestId = req.requestId
    const respond = (status: number, code: string, message: string, details?: unknown) => {
      res.status(status).json({ error: { code, message, details, requestId } })
    }
    if (error instanceof AppError) {
      respond(error.status, error.code, error.message, error.details)
      return
    }
    if (error instanceof ZodError) {
      respond(400, 'VALIDATION_ERROR', 'The request is invalid', error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })))
      return
    }
    if (isBodyParserError(error)) {
      const tooLarge = error.type === 'entity.too.large'
      respond(tooLarge ? 413 : 400, tooLarge ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR', tooLarge ? 'The request body is too large' : 'The request body is not valid JSON')
      return
    }
    if (pgErrorCode(error) === '23514') {
      respond(422, 'CONSTRAINT_VIOLATION', 'The change violates an inventory or schedule constraint')
      return
    }
    req.log.error({ err: error }, 'unhandled error')
    deps.logger.debug({ requestId }, 'responding with internal error')
    respond(500, 'INTERNAL', 'Something went wrong')
  }
}

const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.requestId } })
}

export function createApp(deps: AppDeps): express.Express {
  const app = express()
  const origins = new Set(deps.config.allowedOrigins)
  app.disable('x-powered-by')
  app.set('trust proxy', deps.config.TRUST_PROXY)
  app.use(requestContext(deps.logger, deps.metrics))
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || origins.has(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Requested-With', 'X-Admin-Token', 'X-Request-Id'],
      exposedHeaders: ['Retry-After', 'Idempotency-Replayed', 'X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
      maxAge: 600
    })
  )
  app.use(express.json({ limit: '10kb' }))
  app.get('/openapi.json', (_req, res) => res.json(openApi))
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApi, { explorer: true, customSiteTitle: 'FlashRush API' }))
  app.use('/api/v1', buildRouter(deps))
  app.use(notFound)
  app.use(errorHandler(deps))
  return app
}
