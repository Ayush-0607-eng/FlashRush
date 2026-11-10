import { randomUUID } from 'node:crypto'
import { loadConfig } from './config'
import { createPool } from './db'
import { cleanup } from './domain/maintenance'
import { relayOutbox } from './domain/outbox'
import { reconcile } from './domain/reconciliation'
import { sweepExpired } from './domain/expiry'
import { recordStatus } from './domain/workerStatus'
import { createLogger, type Logger } from './logger'
import { createExpiryQueue, createExpiryWorker, createPublisher, queueCounts } from './queue/expiryQueue'
import { bullConnection } from './redis'
import { errorMessage, sleep } from './utils'

function startLoop(name: string, intervalMs: number, task: () => Promise<void>, logger: Logger, signal: AbortSignal): Promise<void> {
  return (async () => {
    while (!signal.aborted) {
      try {
        await task()
      } catch (error) {
        logger.error({ err: error, loop: name }, 'loop iteration failed')
      }
      await sleep(intervalMs, signal)
    }
  })()
}

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config.LOG_LEVEL, 'worker')
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX, (error) => logger.error({ err: error }, 'postgres pool error'))
  const connection = bullConnection(config.REDIS_URL)
  const queue = createExpiryQueue(connection, logger)
  const publish = createPublisher(queue)
  const expiryWorker = createExpiryWorker(connection, pool, logger)
  const workerId = randomUUID()
  const startedAt = new Date().toISOString()
  const controller = new AbortController()
  const { signal } = controller

  const relayTask = async () => {
    for (;;) {
      const result = await relayOutbox(pool, publish, config.OUTBOX_BATCH_SIZE)
      if (result.failed > 0) logger.warn({ failed: result.failed }, 'outbox relay could not publish; will retry with backoff')
      if (signal.aborted || result.examined < config.OUTBOX_BATCH_SIZE || result.failed > 0) return
    }
  }

  const sweepTask = async () => {
    for (;;) {
      const result = await sweepExpired(pool)
      if (result.expired > 0) logger.info({ expired: result.expired }, 'sweeper released expired reservations')
      if (signal.aborted || result.examined < 200) return
    }
  }

  const reconcileTask = async () => {
    const report = await reconcile(pool, { repair: false })
    await recordStatus(pool, 'reconciliation', { ...report, ranAt: new Date().toISOString() })
    if (report.discrepancies.length > 0) logger.error({ discrepancies: report.discrepancies }, 'inventory discrepancies detected')
  }

  const heartbeatTask = async () => {
    const counts = await queueCounts(queue)
    await recordStatus(pool, 'heartbeat', { workerId, pid: process.pid, startedAt, redis: counts !== null, queue: counts })
  }

  const maintenanceTask = async () => {
    const result = await cleanup(pool)
    logger.info(result, 'maintenance completed')
  }

  logger.info({ workerId }, 'worker started')
  const loops = [
    startLoop('outbox-relay', config.OUTBOX_POLL_MS, relayTask, logger, signal),
    startLoop('expiry-sweeper', config.EXPIRY_SWEEP_INTERVAL_MS, sweepTask, logger, signal),
    startLoop('reconciliation', config.RECONCILE_INTERVAL_MS, reconcileTask, logger, signal),
    startLoop('heartbeat', config.HEARTBEAT_INTERVAL_MS, heartbeatTask, logger, signal),
    startLoop('maintenance', 600000, maintenanceTask, logger, signal)
  ]

  let stopping = false
  const shutdown = async (name: string) => {
    if (stopping) return
    stopping = true
    logger.info({ signal: name }, 'worker shutting down')
    const forced = setTimeout(() => process.exit(1), 15000)
    forced.unref()
    controller.abort()
    await Promise.all(loops)
    await expiryWorker.close()
    await queue.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  console.error(errorMessage(error))
  process.exit(1)
})
