import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter, Rate } from 'k6/metrics'

const base = __ENV.BASE_URL || 'http://localhost:18473/api/v1'
const saleId = __ENV.SALE_ID
if (!saleId) throw new Error('Set SALE_ID to an existing ACTIVE sale UUID')
const accepted = new Counter('reservation_created_or_rejected_as_expected')
const unexpected = new Rate('unexpected_responses')
export const options = {
  scenarios: { flash_sale: { executor: 'ramping-arrival-rate', startRate: 5, timeUnit: '1s', preAllocatedVUs: 30, maxVUs: 150, stages: [{ target: 20, duration: '30s' }, { target: 60, duration: '60s' }, { target: 100, duration: '30s' }, { target: 0, duration: '20s' }] } },
  thresholds: { http_req_failed: ['rate<0.20'], http_req_duration: ['p(95)<1500'], unexpected_responses: ['rate<0.05'] }
}
const params = { headers: { 'X-Requested-With': 'flashrush', 'Content-Type': 'application/json' } }
export default function () {
  const session = http.post(`${base}/session`, null, params)
  const sessionOk = check(session, { 'session established': r => r.status === 200 || r.status === 201 })
  if (!sessionOk) { unexpected.add(1); return }
  const response = http.post(`${base}/sales/${saleId}/reservations`, JSON.stringify({ quantity: 1 }), { ...params, headers: { ...params.headers, 'Idempotency-Key': `k6-${__VU}-${__ITER}-${Date.now()}` } })
  const ok = check(response, { 'reservation accepted or domain-rejected': r => [201, 409, 410, 422].includes(r.status) })
  accepted.add(ok ? 1 : 0); unexpected.add(ok ? 0 : 1)
  sleep(0.2)
}
