# FlashRush backend design (Phase 2)

## Source of truth

PostgreSQL owns inventory. `sales.reserved` and `sales.sold` are counters guarded by `CHECK (reserved >= 0 AND sold >= 0 AND reserved + sold <= total)`. Available stock is `total - reserved - sold`. Reservation rows are the ledger the counters must agree with; the reconciler recomputes the counters from them.

Redis is never in the stock path. It holds rate-limit buckets and BullMQ jobs only. Losing Redis loses neither inventory nor correctness.

## Lock order

Every transaction that touches both tables locks in the same order, so deadlocks cannot form a cycle:

1. idempotency row (insert)
2. advisory lock for session and sale (reserve only)
3. reservation row (`FOR UPDATE`) for checkout, cancel, expire
4. sales row (conditional `UPDATE`)

`reserve` takes the sales row and then inserts a new reservation nobody else can be waiting on. The retry wrapper also re-runs a transaction on `40001` and `40P01`.

## Reserve (one transaction)

1. Claim the idempotency key with `INSERT ... ON CONFLICT DO NOTHING`. A concurrent request with the same key blocks on the unique index until the first transaction ends.
2. Validate the quantity against the sale limit, take a per-session-per-sale advisory lock, and check the session's held and bought total.
3. `UPDATE sales SET reserved = reserved + q WHERE id = $1 AND <sale open> AND total - reserved - sold >= q`. Zero rows means sold out or not open. The row lock serialises competitors; the predicate is re-evaluated after a wait.
4. Insert the reservation with `expires_at = clock_timestamp() + hold_seconds` and an outbox row, store the response in the idempotency row, commit.

## Idempotency

The key row is inserted inside the business transaction, so:

- Same key racing: the second request waits, then sees the committed row and replays the stored response. The operation runs once.
- Business failure: the transaction rolls back, taking the key row with it. No record is ever stuck "in progress".
- Same key, different payload: the stored request hash differs and the API answers `422 IDEMPOTENCY_KEY_REUSED`.
- Client timeout then retry: the retry replays the stored response and sets `Idempotency-Replayed: true`.

Keys are scoped to the session and an operation (`reserve`, `checkout`). A repeated checkout with a different key finds the reservation already confirmed and returns the existing order, so a double click cannot create a second order. `orders.reservation_id` is `UNIQUE` as a last line of defence.

## State machine

`RESERVED` goes to `CONFIRMED`, `EXPIRED` or `CANCELLED`. The other three are terminal. A trigger rejects any update that leaves a terminal state, and a check constraint ties `resolved_at` to the status.

Checkout, cancel and expire all follow the same shape: lock the reservation row, read its status and `expires_at <= clock_timestamp()`, change the status, then adjust the counters, all in one transaction. Because the row lock serialises them and status is re-read under the lock, exactly one transition wins:

| First to lock | Second | Result |
|---|---|---|
| checkout (before expiry time) | expire | expire sees `CONFIRMED`, returns `ALREADY_RESOLVED`, releases nothing |
| expire (after expiry time) | checkout | checkout sees `EXPIRED`, returns `410`, confirms nothing |
| checkout | cancel | cancel returns `409 RESERVATION_ALREADY_CONFIRMED` |
| cancel | checkout | checkout returns `409 RESERVATION_CANCELLED` |
| cancel | expire | expire returns `ALREADY_RESOLVED` |
| expire | cancel | cancel returns `410` |

`expires_at` comparisons use `clock_timestamp()` (database wall clock at the moment of evaluation), not `now()`, which would be frozen at transaction start.

## Failed payments

A declined simulated payment records a `FAILED` attempt and leaves the reservation `RESERVED`. The user may retry until expiry. If they do not, expiry or cancellation releases the stock. A failure never confirms anything.

## Expiry and the outbox

Two independent paths release expired holds. Both call the same `expireReservation`, so duplicates are harmless.

1. Fast path: `reserve` writes an outbox row in its transaction. The relay locks pending rows with `FOR UPDATE SKIP LOCKED`, publishes a BullMQ delayed job with `jobId = expire-<reservationId>`, then marks the rows published, all in one transaction. Several relays never take the same row. A crash after publishing but before commit leaves the row pending, so it is published again; BullMQ ignores a second job with the same id, and even if it ran twice the handler is idempotent. Delivery is at least once. On a publish failure the batch is backed off exponentially (up to 60 seconds) and retried.
2. Safety net: the worker sweeps `status = 'RESERVED' AND expires_at <= now()` every `EXPIRY_SWEEP_INTERVAL_MS` and expires each row in its own transaction. After a restart it picks up everything overdue, so correctness never depends on Redis or BullMQ.

A job that fires slightly early gets `NOT_DUE` and BullMQ retries it with backoff (5 attempts); the sweeper covers anything left over.

## Reconciliation

For each sale, under `FOR UPDATE`, the reconciler recomputes `reserved` (sum of `RESERVED`), `sold` (sum of `CONFIRMED`) and compares the order total. It reports drift and an overcommit flag. Repair is explicit (admin endpoint) and refuses to touch an overcommitted sale. The worker runs a report-only pass every minute and stores the result for the metrics endpoint.

## Rate limiting versus concurrency control

Rate limiting (Redis token bucket, one Lua script, atomic) protects the service from request volume per client. It says nothing about stock. Concurrency control (the conditional `UPDATE` and row lock) guarantees stock is never oversold regardless of how many requests get through. If Redis is down the limiter fails open by default (`RATE_LIMIT_FAIL_MODE=closed` switches to 503); inventory stays correct either way.

## Bottlenecks

All reservations for one sale serialise on one row. Throughput is bounded by transaction latency on that row. Options when that matters: shard inventory into buckets, or add a Redis admission gate in front of PostgreSQL. This project does not do either, and no throughput figure has been measured.

## What the tests assert (not yet executed)

Concurrent reservation counts, same-key races, failure leaves no stuck key, checkout/expire/cancel races (random and forced orderings), duplicate expiry, outbox concurrency, publish failure backoff, crash between publish and commit (backend terminated mid-relay), queue-down fallback, BullMQ end to end, reconciliation under load, token-bucket atomicity and fail-open/closed.

## Full-stack application (Phases 3–4)

The React + TypeScript client is a thin API consumer. It does not hold inventory state or seed demo records. On initial load it creates/reuses an anonymous session cookie, then reads `GET /sales` and `GET /bookings`. All writes include the CSRF header; reserve and checkout requests also include a fresh idempotency key. Nginx serves the built client and proxies `/api/v1`, `/api-docs` and `/openapi.json` to the API on the private Compose network.

The primary user journey is:

```text
Explore sales → inspect sale → choose quantity → POST reservation
       → countdown / held inventory → simulated checkout
       → confirmed order → booking history
```

The UI's countdown is a presentation aid. The API/database expiry timestamp is authoritative. When the countdown reaches zero the client re-reads reservation status; it cannot extend a hold. Payment is explicitly simulated and must not be mistaken for a payment integration.

## Database design overview

| Table | Responsibility | Important relationships / invariants |
|---|---|---|
| `sessions` | Anonymous browser sessions | Hashed token lookup; reservations belong to a session |
| `sales` | Sale definition and inventory counters | `reserved + sold <= total`; conditional updates serialize inventory allocation |
| `reservations` | Reservation ledger and state machine | References sale and session; terminal-state transition constraints; expiry timestamp |
| `orders` | Successful checkout record | One order per reservation (`UNIQUE reservation_id`) |
| `payment_attempts` | Simulated payment outcomes | Records success/decline attempts against a reservation |
| `idempotency_keys` | Replayable write outcomes | Unique scope/session/key and request hash prevent accidental duplicate effects |
| `outbox` | Durable asynchronous work intent | Unique dedupe key; created in the same transaction as reservation |
| `worker_status` | Worker heartbeat and reconciliation status | Allows readiness/operations endpoint to detect stale worker |

The migration in `database/migrations/001_init.sql` is the authoritative schema definition. The reservation ledger is the source used by reconciliation to validate the denormalized `sales.reserved` and `sales.sold` counters.

## Concurrency and consistency boundaries

- Inventory allocation is a conditional PostgreSQL `UPDATE`; the database row lock and predicate ensure two requests cannot both consume the same remaining units.
- A PostgreSQL advisory transaction lock serializes the per-session/per-sale purchase-limit check.
- Checkout, cancellation and expiry lock the reservation row before changing state and inventory counters. The first valid terminal transition wins.
- Idempotency key insertion and business work share one transaction. A crash before commit rolls back both; a committed response can be replayed after a client timeout.
- Redis token buckets protect request volume but are not a lock and are not consulted by inventory logic.

## Redis, BullMQ and transactional outbox

Redis has two roles: atomic Lua-backed rate-limit buckets and BullMQ's delayed-job transport. The outbox row is inserted in PostgreSQL with the reservation, so a Redis outage cannot erase the intent to expire a hold. The relay claims rows with `FOR UPDATE SKIP LOCKED`, publishes a deterministic job ID and marks the outbox row delivered in its transaction. A crash between publish and database commit can cause duplicate publication; deterministic job IDs reduce duplicate jobs and the expiry handler is idempotent regardless.

The worker's database sweeper independently finds overdue `RESERVED` rows. This is the recovery path for missed queue jobs, Redis downtime and worker restarts. Reconciliation periodically compares inventory counters with reservation state and can report drift; repair is an explicit administrative operation.

## Failure recovery matrix

| Failure | Expected behavior / recovery |
|---|---|
| Browser times out after reserve commit | Retry with the same idempotency key to replay the stored response |
| Redis unavailable | Rate limiter follows configured fail-open/fail-closed mode; PostgreSQL inventory remains authoritative |
| Worker stops during a hold | Reservation remains durable; worker sweeper expires overdue holds after recovery |
| Relay publishes then crashes before marking outbox row | Row may be published again; deterministic job ID and idempotent expiry tolerate duplicates |
| BullMQ delayed job is lost | Database sweeper eventually expires the overdue reservation |
| Two users request last tickets | Conditional inventory update lets only requests fitting remaining stock commit |
| Checkout races cancellation/expiry | Reservation row lock and state check allow one terminal transition |
| Inventory counters drift | Reconciliation reports ledger-derived discrepancy; explicit repair can correct safe cases |
| API process restarts | Durable state remains in PostgreSQL; process-local counters reset |

## Performance testing policy

The `k6/` scripts are executable workloads, not benchmark evidence. Run them against a dedicated active sale and record the environment and output. A single sale row is intentionally a serialization point; the scripts are intended to expose that bottleneck rather than imply a guaranteed requests-per-second figure. No load test was executed while preparing this project because Docker is not available in the authoring environment.
