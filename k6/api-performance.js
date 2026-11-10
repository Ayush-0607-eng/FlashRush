import http from 'k6/http'
import { check, sleep } from 'k6'
const base = __ENV.BASE_URL || 'http://localhost:18473/api/v1'
export const options = { vus: Number(__ENV.VUS || 15), duration: __ENV.DURATION || '60s', thresholds: { http_req_failed: ['rate<0.02'], http_req_duration: ['p(95)<800'] } }
export default function () {
  for (const path of ['/health', '/ready', '/sales']) {
    const response = http.get(`${base}${path}`)
    check(response, { [`${path} responds successfully`]: r => r.status === 200 })
  }
  sleep(0.3)
}
