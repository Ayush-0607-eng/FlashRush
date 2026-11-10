import type { Redis } from 'ioredis'
import type { Logger } from '../logger'
import { rateLimiterUnavailable } from '../errors'

const TOKEN_BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local stamp = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  stamp = now
end
local elapsed = math.max(0, now - stamp)
tokens = math.min(capacity, tokens + elapsed * refill / 1000)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / refill * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill * 1000) + 1000)
return {allowed, math.floor(tokens), retry}
`

export interface BucketConfig {
  capacity: number
  refillPerSecond: number
}

export interface Decision {
  allowed: boolean
  remaining: number
  retryAfterMs: number
  limit: number
  degraded: boolean
}

interface TokenBucketCommands {
  tokenBucket(key: string, capacity: number, refill: number, cost: number): Promise<[number, number, number]>
}

export class RateLimiter {
  private lastWarning = 0

  constructor(
    private readonly redis: Redis,
    private readonly buckets: Record<string, BucketConfig>,
    private readonly failMode: 'open' | 'closed',
    private readonly logger: Logger
  ) {
    this.redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_SCRIPT })
  }

  async consume(bucket: string, identifier: string): Promise<Decision> {
    const config = this.buckets[bucket]
    try {
      const commands = this.redis as unknown as TokenBucketCommands
      const [allowed, remaining, retryAfterMs] = await commands.tokenBucket(`rl:${bucket}:${identifier}`, config.capacity, config.refillPerSecond, 1)
      return { allowed: allowed === 1, remaining, retryAfterMs, limit: config.capacity, degraded: false }
    } catch (error) {
      this.warn(error)
      if (this.failMode === 'closed') throw rateLimiterUnavailable()
      return { allowed: true, remaining: config.capacity, retryAfterMs: 0, limit: config.capacity, degraded: true }
    }
  }

  private warn(error: unknown): void {
    const now = Date.now()
    if (now - this.lastWarning < 10000) return
    this.lastWarning = now
    this.logger.warn({ err: error, failMode: this.failMode }, 'rate limiter could not reach redis')
  }
}
