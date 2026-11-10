import { Redis, type RedisOptions } from 'ioredis'
import type { Logger } from './logger'

export function createRedis(url: string, logger: Logger): Redis {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 1000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000)
  })
  let lastWarning = 0
  client.on('error', (error) => {
    const now = Date.now()
    if (now - lastWarning > 10000) {
      lastWarning = now
      logger.warn({ err: error }, 'redis connection error')
    }
  })
  return client
}

export async function waitForRedis(client: Redis, timeoutMs: number): Promise<boolean> {
  if (client.status === 'ready') return true
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      client.off('ready', onReady)
      resolve(false)
    }, timeoutMs)
    const onReady = () => {
      clearTimeout(timer)
      resolve(true)
    }
    client.once('ready', onReady)
  })
}

export function bullConnection(url: string): RedisOptions {
  const parsed = new URL(url)
  const options: RedisOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379
  }
  if (parsed.username) options.username = decodeURIComponent(parsed.username)
  if (parsed.password) options.password = decodeURIComponent(parsed.password)
  if (parsed.pathname.length > 1) options.db = Number(parsed.pathname.slice(1))
  if (parsed.protocol === 'rediss:') options.tls = {}
  return options
}
