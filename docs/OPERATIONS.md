# FlashRush operations and deployment

## Runtime topology

- **web**: React + TypeScript static bundle served by Nginx. `/api/v1`, `/api-docs` and `/openapi.json` are reverse-proxied to the API, so browser traffic is same-origin.
- **api**: Express/TypeScript service. Anonymous browser sessions are represented by an HTTP-only cookie; mutating requests require `X-Requested-With: flashrush`. Reservation and checkout writes require idempotency keys.
- **worker**: outbox relay, BullMQ expiry consumer, database expiry sweeper, periodic reconciliation and heartbeat.
- **postgres**: durable source of truth for inventory, reservations, orders, idempotency and outbox.
- **redis**: rate-limit buckets and BullMQ transport only. It is not consulted to decide whether inventory is available.

## Windows PowerShell: run the complete application

Install Docker Desktop and ensure its Linux container engine is running. No host Node.js or npm installation is needed.

```powershell
# From the extracted project directory
cd .\flashrush

# Generate .env with strong local demo secrets (safe to rerun only before deployment)
docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/init-env.mjs

# Build and start web, API, worker, PostgreSQL and Redis
docker compose up --build -d

# Inspect service health and logs
docker compose ps
docker compose logs -f web api worker

# Open the app
Start-Process http://localhost:18473

# Open interactive API docs
Start-Process http://localhost:18473/api-docs
```

The API is also exposed directly at `http://localhost:18491/api/v1` for command-line use. The browser uses the same-origin Nginx proxy. Database migrations are run by the one-shot `migrate` service before API/worker startup.

### Stop, restart and reset

```powershell
docker compose stop                 # stop, keep data
docker compose start                # start existing containers
docker compose down                 # remove containers/network, keep volumes
docker compose up --build -d        # rebuild and start
# DESTRUCTIVE: deletes PostgreSQL and Redis persisted data
docker compose down -v
```

### Create a sale for the first run

The frontend intentionally does not fabricate sale cards. Create a sale through the protected admin API. Read `ADMIN_TOKEN` from `.env` (do not commit it).

```powershell
$envText = Get-Content .env -Raw
$admin = ([regex]::Match($envText, '(?m)^ADMIN_TOKEN=(.+)$')).Groups[1].Value.Trim()
$headers = @{ 'X-Requested-With'='flashrush'; 'X-Admin-Token'=$admin; 'Content-Type'='application/json' }
$now = [DateTime]::UtcNow
$body = @{
  name = 'Indie Music Night'
  description = 'A limited-capacity live music experience. Reserve your place before the drop closes.'
  priceMinor = 149900
  total = 250
  maxPerSession = 4
  holdSeconds = 300
  startsAt = $now.AddMinutes(-5).ToString('o')
  endsAt = $now.AddDays(7).ToString('o')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:18491/api/v1/admin/sales' -Headers $headers -Body $body
```

`priceMinor` is the amount in the currency's minor unit (for INR, paise). The demo checkout is simulated; it does not charge a card or call a payment provider.

## OpenAPI / Swagger

- Interactive Swagger UI: `/api-docs`
- Machine-readable OpenAPI: `/openapi.json`
- Import `docs/openapi.json` into any OpenAPI-compatible client.

## k6 load testing (Docker only)

Use a sale that is currently `ACTIVE`. For inventory/concurrency tests, start with a disposable sale and a modest VU count. These scripts exercise the live API; they do not seed data and do not claim benchmark results.

```powershell
# Replace the UUID with the id returned by the admin create-sale request
$env:SALE_ID = '<ACTIVE-SALE-UUID>'
$env:BASE_URL = 'http://host.docker.internal:18473/api/v1'

# Mixed flash-sale arrival rate
 docker run --rm -i -e BASE_URL -e SALE_ID -v "${PWD}/k6:/scripts" grafana/k6 run /scripts/flash-sale.js

# Concurrent reservation attempts
 docker run --rm -i -e BASE_URL -e SALE_ID -e VUS=40 -e ITERATIONS=80 -v "${PWD}/k6:/scripts" grafana/k6 run /scripts/concurrent-reservations.js

# Read-only API performance profile
 docker run --rm -i -e BASE_URL -e VUS=15 -e DURATION=60s -v "${PWD}/k6:/scripts" grafana/k6 run /scripts/api-performance.js
```

Run one profile at a time initially. k6 thresholds are script guardrails, not measured claims about production capacity. Save the k6 output with the environment, commit hash, Docker resource limits, sale inventory and test duration when you conduct a real run. Never compare results from different environments as if they were equivalent.

## Failure recovery and operational notes

- PostgreSQL is authoritative. If Redis is unavailable, the configured rate limiter may fail open or closed (`RATE_LIMIT_FAIL_MODE`); reservation correctness is unaffected.
- If the API or worker restarts, the database retains reservation state. The worker's expiry sweeper catches overdue `RESERVED` rows even if delayed BullMQ jobs were lost.
- The transactional outbox stores expiry work in the same transaction as a reservation. The relay may publish at least once; deterministic job IDs and idempotent expiry transitions make duplicates safe.
- Reconciliation is report-only by default. Use the admin reconcile endpoint with `{"repair":true}` only after reviewing the report; repair refuses to alter overcommitted inventory.
- Back up PostgreSQL volumes before upgrades. Redis persistence is useful for queue continuity but not a source of truth.
- Configure strong secrets, TLS termination, secure cookies, proxy trust, origin allow-lists, resource limits, monitoring and backup/restore procedures before any internet-facing deployment. This repository is a portfolio-grade reference, not a security-audited payment platform.

## Optional dependency lockfiles (still Docker-only)

This source bundle intentionally does not include generated npm lockfiles. To create and commit them without installing Node.js/npm on Windows:

```powershell
docker run --rm -v "${PWD}/backend:/app" -w /app node:22-alpine npm install --package-lock-only --no-audit --no-fund
docker run --rm -v "${PWD}/frontend:/app" -w /app node:22-alpine npm install --package-lock-only --no-audit --no-fund
```

After generating the files, rebuild the images. For a reproducible release pipeline, update the Dockerfiles to use `npm ci` with the committed lockfiles.
