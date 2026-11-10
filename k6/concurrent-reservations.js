import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'
const base = __ENV.BASE_URL || 'http://localhost:18473/api/v1'
const saleId = __ENV.SALE_ID
if (!saleId) throw new Error('Set SALE_ID to an existing ACTIVE sale UUID')
const created = new Counter('reservations_created')
const expectedRejections = new Counter('inventory_or_limit_rejections')
export const options = { vus: Number(__ENV.VUS || 40), iterations: Number(__ENV.ITERATIONS || 80), thresholds: { http_req_failed: ['rate<0.20'], http_req_duration: ['p(95)<1500'] } }
export default function () {
  const headers = { 'X-Requested-With': 'flashrush', 'Content-Type': 'application/json' }
  const session = http.post(`${base}/session`, null, { headers })
  if (!check(session, { 'session ready': r => r.status === 200 || r.status === 201 })) return
  const response = http.post(`${base}/sales/${saleId}/reservations`, JSON.stringify({ quantity: 1 }), { headers: { ...headers, 'Idempotency-Key': `race-${__VU}-${__ITER}-${Date.now()}` } })
  if (check(response, { 'created': r => r.status === 201 })) created.add(1)
  else if (check(response, { 'rejected by business rule': r => [409, 410, 422].includes(r.status) })) expectedRejections.add(1)
  sleep(0.1)
}
