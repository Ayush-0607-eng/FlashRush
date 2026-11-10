# FlashRush

**FlashRush** is a full-stack flash-sale and ticket reservation portfolio project. It combines a responsive React + TypeScript storefront with a transactionally safe Node.js API, PostgreSQL inventory ledger, Redis rate limiting, BullMQ expiry delivery, and a transactional outbox.

## Project status

- Phase 1–2: backend core, PostgreSQL migrations, Redis/BullMQ worker, idempotency, reconciliation and backend integration tests are included.
- Phase 3: React + TypeScript frontend is implemented and wired to the real API. It includes sale discovery, detail/quantity selection, timed reservation, simulated checkout, booking confirmation and history, dark/light themes and mobile layouts.
- Phase 4: Docker-based k6 scenarios, OpenAPI specification + Swagger UI, operations/deployment guide and expanded architecture documentation are included.

**Verification honesty:** source code and tests have been added, but this environment has not run a Docker build, npm install, PostgreSQL migration, integration suite or k6 test. Tests in the repository are written, not claimed as executed. No throughput, latency or capacity results are asserted.

## Architecture

```text
Browser
  │ same-origin HTTP
  ▼
Nginx + React UI :18473 ───── /api/v1 ─────► Express API :4000
                                                   │
                         ┌─────────────────────────┼────────────────────────┐
                         ▼                         ▼                        ▼
                    PostgreSQL                  Redis                 BullMQ queue
                 inventory + ledger       rate-limit buckets          expiry jobs
                         ▲                         ▲                        ▲
                         │                         │                        │
                         └──────────── Worker / outbox relay ───────────────┘
```

PostgreSQL is the sole authority for inventory. Redis is not used to decide whether tickets can be reserved. The API and worker run as separate containers. The web container serves static assets and reverse-proxies API and documentation routes to the backend.

## Run everything (Windows PowerShell, Docker only)

Prerequisites: Docker Desktop with the Linux container engine running. You do not need to install Node.js, npm, PostgreSQL or Redis on Windows.

```powershell
cd .\flashrush
# Generate local secrets and .env
 docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/init-env.mjs
# Build and start the complete stack
 docker compose up --build -d
# Check services
 docker compose ps
 docker compose logs -f web api worker
# Open the application
 Start-Process http://localhost:18473
# Swagger UI
 Start-Process http://localhost:18473/api-docs
```

On first startup, Compose waits for PostgreSQL and Redis health, runs migrations, then starts API/worker/web. The API is also available directly at `http://localhost:18491/api/v1`.

### Create initial demo content

The UI does not substitute mock data for backend data. Create a real sale via the admin API using the token from `.env`:

```powershell
$admin = ([regex]::Match((Get-Content .env -Raw), '(?m)^ADMIN_TOKEN=(.+)$')).Groups[1].Value.Trim()
$headers = @{ 'X-Requested-With'='flashrush'; 'X-Admin-Token'=$admin; 'Content-Type'='application/json' }
$now = [DateTime]::UtcNow
$body = @{ name='Indie Music Night'; description='A limited-capacity live music experience.'; priceMinor=149900; total=250; maxPerSession=4; holdSeconds=300; startsAt=$now.AddMinutes(-5).ToString('o'); endsAt=$now.AddDays(7).ToString('o') } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:18491/api/v1/admin/sales' -Headers $headers -Body $body
```

`priceMinor` is in minor currency units (paise for INR). Checkout is deliberately simulated and does not process real payments.

## Verification and tests

The backend suite uses real PostgreSQL and Redis containers (not mocked dependencies). It covers API behavior, reservation concurrency/rules, idempotency, checkout, expiry, outbox, reconciliation and rate limiting.

```powershell
# Execute backend tests using disposable containers
 docker compose --profile test run --rm test
# Strict backend type check
 docker compose --profile test run --rm test npm run typecheck
```

The frontend TypeScript build is part of the Docker image build. A successful build has not been asserted until you run `docker compose up --build` yourself. The repository includes these tests/scripts as written; the commands above are the actual execution path.

## Load tests (k6 in Docker)

See [docs/OPERATIONS.md](docs/OPERATIONS.md#k6-load-testing-docker-only). Scripts:

- `k6/flash-sale.js` — ramping arrival-rate reservation workload.
- `k6/concurrent-reservations.js` — simultaneous reservation attempts against one sale.
- `k6/api-performance.js` — read-only health/readiness/sales workload.

Each script requires a real active sale UUID. Thresholds are test guardrails only. No performance result is included because no load test has been run in this environment.

## API documentation

- Swagger UI: `http://localhost:18473/api-docs`
- OpenAPI JSON: `http://localhost:18473/openapi.json`
- Source: `docs/openapi.json`

## Core design decisions

- **Concurrency:** conditional inventory update and PostgreSQL row locking prevent overselling; a per-session/sale advisory lock enforces purchase limits.
- **Idempotency:** keys are scoped by session and operation; request hashes detect key reuse with a different payload; successful response bodies are replayable.
- **Reservation expiry:** outbox + BullMQ provides prompt expiry; the database sweeper is the independent recovery path.
- **Transactional outbox:** reservation and expiry-event intent commit atomically. Delivery is at least once; consumers must remain idempotent.
- **Reconciliation:** recomputes reserved/sold counters from the reservation ledger; repairs are explicit and reject overcommit conditions.
- **Redis:** rate limiting and job transport only. It is not part of inventory correctness.

Read [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md) for transaction flows, data model and failure cases, and [docs/OPERATIONS.md](docs/OPERATIONS.md) for deployment, runbooks and k6 commands.

## Everyday commands

```powershell
docker compose ps
docker compose logs -f api worker web
docker compose restart api worker web
docker compose stop
docker compose down
# Destructive: removes persistent database and Redis volumes
docker compose down -v
```

## Ports

| Service | Host port | Purpose |
|---|---:|---|
| Web / Swagger | 18473 | User-facing app and same-origin API proxy |
| API | 18491 | Direct API access |
| PostgreSQL | 15439 | Bound to loopback by Compose |
| Redis | 16391 | Bound to loopback by Compose |

## Known limitations / production hardening

This is a professional portfolio reference, not a payment-ready or security-audited commercial system. Payment is simulated; no real card details are accepted. One hot sales row serializes reservations for a single drop. Rate limiting is IP-based. Metrics are process-local. Before public deployment, add TLS, secure cookie configuration, secrets management, proxy/network hardening, backups and restore drills, observability, security review and a real payment provider with its own compliance requirements.
