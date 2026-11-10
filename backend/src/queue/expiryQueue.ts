import { Queue, Worker } from 'bullmq'
import type { RedisOptions } from 'ioredis'
import type { Pool } from 'pg'
import { expireReservation } from '../domain/expiry'
import type { OutboxMessage, Publisher } from '../domain/outbox'
import type { Logger } from '../logger'
import { withTimeout } from '../utils'

export const EXPIRY_QUEUE = 'reservation-expiry'
const EXPIRY_MARGIN_MS = 250
const PUBLISH_TIMEOUT_MS = 3000

export interface ExpiryJob {
  reservationId: string
}

export function createExpiryQueue(connection: RedisOptions, logger: Logger): Queue<ExpiryJob> {
  const queue = new Queue<ExpiryJob>(EXPIRY_QUEUE, { connection })
  queue.on('error', (error) => logger.warn({ err: error }, 'expiry queue error'))
  return queue
}

export function createPublisher(queue: Queue<ExpiryJob>): Publisher {
  return async (message: OutboxMessage) => {
    const payload = message.payload as ExpiryJob
    await withTimeout(
      queue.add('expire', payload, {
        jobId: message.dedupeKey,
        delay: message.delayMs + EXPIRY_MARGIN_MS,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 }
      }),
      PUBLISH_TIMEOUT_MS,
      'queue publish'
    )
  }
}

export function createExpiryWorker(connection: RedisOptions, pool: Pool, logger: Logger): Worker<ExpiryJob> {
  const worker = new Worker<ExpiryJob>(
    EXPIRY_QUEUE,
    async (job) => {
      const outcome = await expireReservation(pool, job.data.reservationId)
      if (outcome === 'NOT_DUE') throw new Error('reservation is not due yet')
      return outcome
    },
    { connection, concurrency: 10 }
  )
  worker.on('error', (error) => logger.warn({ err: error }, 'expiry worker error'))
  worker.on('failed', (job, error) => logger.warn({ err: error, jobId: job?.id }, 'expiry job failed'))
  return worker
}

export async function queueCounts(queue: Queue<ExpiryJob>): Promise<Record<string, number> | null> {
  try {
    return await withTimeout(queue.getJobCounts('waiting', 'active', 'delayed', 'failed'), 2000, 'queue counts')
  } catch {
    return null
  }
}
