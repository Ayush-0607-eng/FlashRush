import type { Pool } from 'pg'
import { readStatus } from './domain/workerStatus'

const MAX_SAMPLES = 2000

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return Math.round(sorted[Math.max(0, index)] * 100) / 100
}

export class Metrics {
  private readonly startedAt = Date.now()
  private requests = 0
  private serverErrors = 0
  private rateLimited = 0
  private readonly statusClasses = new Map<string, number>()
  private readonly reservationOutcomes = new Map<string, number>()
  private readonly latencies: number[] = []

  recordRequest(status: number, milliseconds: number): void {
    this.requests += 1
    if (status >= 500) this.serverErrors += 1
    const bucket = `${Math.floor(status / 100)}xx`
    this.statusClasses.set(bucket, (this.statusClasses.get(bucket) ?? 0) + 1)
    this.latencies.push(milliseconds)
    if (this.latencies.length > MAX_SAMPLES) this.latencies.shift()
  }

  recordRateLimited(): void {
    this.rateLimited += 1
  }

  recordReservation(outcome: string): void {
    this.reservationOutcomes.set(outcome, (this.reservationOutcomes.get(outcome) ?? 0) + 1)
  }

  snapshot() {
    const sorted = [...this.latencies].sort((a, b) => a - b)
    const uptimeSeconds = Math.max(1, (Date.now() - this.startedAt) / 1000)
    return {
      uptimeSeconds: Math.round(uptimeSeconds),
      requestsTotal: this.requests,
      requestsPerSecond: Math.round((this.requests / uptimeSeconds) * 100) / 100,
      serverErrors: this.serverErrors,
      errorRate: this.requests === 0 ? 0 : this.serverErrors / this.requests,
      statusClasses: Object.fromEntries(this.statusClasses),
      rateLimitRejections: this.rateLimited,
      reservationOutcomes: Object.fromEntries(this.reservationOutcomes),
      latencyMs: { samples: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) }
    }
  }
}

export async function databaseSnapshot(pool: Pool) {
  const [sales, statuses, outbox, orders, reconciliation, heartbeat] = await Promise.all([
    pool.query<{ sales: number; total: number; reserved: number; sold: number }>(
      'SELECT count(*)::int AS sales, COALESCE(sum(total), 0)::int AS total, COALESCE(sum(reserved), 0)::int AS reserved, COALESCE(sum(sold), 0)::int AS sold FROM sales'
    ),
    pool.query<{ status: string; count: number; overdue: number }>(
      `SELECT status, count(*)::int AS count,
              count(*) FILTER (WHERE status = 'RESERVED' AND expires_at <= now())::int AS overdue
       FROM reservations GROUP BY status`
    ),
    pool.query<{ pending: number; oldest_pending_seconds: number | null; failed_attempts: number }>(
      `SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
              EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE published_at IS NULL)))::float8 AS oldest_pending_seconds,
              COALESCE(sum(attempts) FILTER (WHERE published_at IS NULL), 0)::int AS failed_attempts
       FROM outbox`
    ),
    pool.query<{ count: number }>('SELECT count(*)::int AS count FROM orders'),
    readStatus(pool, 'reconciliation'),
    readStatus(pool, 'heartbeat')
  ])
  const byStatus: Record<string, number> = {}
  let overdue = 0
  for (const row of statuses.rows) {
    byStatus[row.status] = row.count
    overdue += row.overdue
  }
  return {
    inventory: sales.rows[0],
    reservationsByStatus: byStatus,
    overdueReservations: overdue,
    orders: orders.rows[0].count,
    outbox: outbox.rows[0],
    lastReconciliation: reconciliation,
    worker: heartbeat
  }
}
