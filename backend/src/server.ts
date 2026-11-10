import { loadConfig } from './config'
import { createPool } from './db'
import { createLogger } from './logger'
import { Metrics } from './metrics'
import { createRedis, waitForRedis } from './redis'
import { createApp } from './http/app'
import { RateLimiter } from './http/rateLimiter'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config.LOG_LEVEL, 'api')
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX, (error) => logger.error({ err: error }, 'postgres pool error'))
  const redis = createRedis(config.REDIS_URL, logger)
  const redisReady = await waitForRedis(redis, 3000)
  if (!redisReady) logger.warn('redis was not ready at startup; continuing in degraded mode')
  const limiter = new RateLimiter(
    redis,
    {
      read: { capacity: config.RATE_LIMIT_READ_CAPACITY, refillPerSecond: config.RATE_LIMIT_READ_REFILL_PER_SEC },
      book: { capacity: config.RATE_LIMIT_BOOK_CAPACITY, refillPerSecond: config.RATE_LIMIT_BOOK_REFILL_PER_SEC }
    },
    config.RATE_LIMIT_FAIL_MODE,
    logger
  )
  const app = createApp({ config, pool, redis, logger, metrics: new Metrics(), limiter })
  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'api listening'))

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'shutting down')
    const forced = setTimeout(() => process.exit(1), 10000)
    forced.unref()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
    redis.disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
