# Food Delivery Order & Kitchen Management System

A microservice back end for a food-ordering platform, built for a System Design assignment. It demonstrates an API gateway with rate limiting, persistent storage, caching, asynchronous workers, fault tolerance, load testing and structured tracing.

The system runs as **one container per component** with Docker Compose. Everything stateful uses the real thing: **PostgreSQL** for data, **Redis** for the cache and the rate limiter, **RabbitMQ** for the task queue.

---

## Architecture

```
 Browser / curl / k6
        |
        v  :8080  (the only public API port)
 +--------------------------------------------------+
 |  API GATEWAY                                     |
 |  HTTP reverse proxy  |  token-bucket rate limiter|
 |  composite /health   |  X-Request-Id tracing     |
 +--------------------------------------------------+
        | HTTP over the internal Docker network
        v
 auth | restaurant | order | kitchen | payment | delivery | notification     (7 services)
   |        |           |        |         |         |            |
   +--------+-----------+--------+---------+---------+------------+--> PostgreSQL 16 (all data, ACID)
            |           +--------+---------+---------+---------------> RabbitMQ 3.13  (durable queues, DLQ)
            +--> Redis 7 (menu cache)                                       |
 gateway --> Redis 7 (token bucket, Lua script)                            v
                                                              order-worker x2, notification-worker
                                                              (consume queues, write to PostgreSQL)
```

Diagram image: `docs/diagrams/architecture_diagram.png`.

### How an order flows
1. `POST /api/orders` hits the **gateway**, which checks the rate limit in Redis and proxies the request to **order-service**.
2. order-service validates it and writes the order, its items and the status history to PostgreSQL in **one transaction**, publishes a message to RabbitMQ, and returns `201` straight away.
3. An **order-worker** (a pool of 2 competing consumers) takes the message, does the slow processing (about 0.6 s), creates the kitchen-queue row, records a `background_tasks` row and publishes a notification message.
4. The **notification-worker** stores the notification.
5. If a worker fails, the message is retried after 200, 400 and 800 ms, then moved to the dead-letter queue.

Every request carries an `X-Request-Id` that the gateway forwards to the services and into the logs.

---

## Requirements coverage (assignment sections 1, 2, 3)

| Requirement | Where |
| :--- | :--- |
| Shared repo + `docker-compose.yml` | `docker-compose.yml` (PostgreSQL, Redis, RabbitMQ, seeder, 7 services, gateway, 3 worker containers, frontend) |
| API gateway: inspects requests, routes, **rate limiter returning 429** | `api-gateway/src/index.js` (HTTP reverse proxy, token bucket as a Redis Lua script in `shared/redisClient.js`) |
| Health endpoint for each service node | `GET /health` probes every service over HTTP and PostgreSQL, Redis and RabbitMQ |
| Database + schema + migrations | `database/schema.sql` (23 tables), applied automatically on first start; `database/seed/seed.js` loads demo data |
| Caching layer | Redis cache-aside for restaurants/menus with invalidation on update (`services/restaurant-service`) |
| Async queue + separate worker pool | RabbitMQ (`shared/eventBus.js`), `workers/order-worker` (2 replicas), `workers/notification-worker` |
| Worker updates the database when done | order-worker writes `background_tasks`, `kitchen_queues`, `order_status_history` |
| Fault tolerance | Circuit breaker in `services/payment-service`; retries with exponential backoff + dead-letter queue in `shared/eventBus.js` |
| Load-testing script | `load-tests/runner.js` (Node, real HTTP) and `load-tests/k6/*.js` |
| Structured logging / tracing | `shared/logger.js` (JSON lines), `X-Request-Id` through gateway, services, queue messages and `request_logs` |
| README, load-test report, demo | this file, `Food_Delivery_Load_Test_Report.pdf`, `LIVE_DEMO_GUIDE.md` |

See `REQUIREMENTS_CHECKLIST.md` for the item-by-item verification steps.

---

## Run it

Prerequisites: Docker Desktop (Compose v2) and Node 18+ (only needed to run the tests from your machine).

```bash
docker compose up --build -d      # builds everything and starts the stack
docker compose ps                 # all services should become healthy
curl http://localhost:8080/health
```

The first start takes a minute: PostgreSQL applies `database/schema.sql`, a one-shot `db-seed` container loads the demo data, then the services start. Open the UI at http://localhost:3000 (or http://localhost:8080/app).

Stop and wipe all data: `docker compose down -v`.

### Local development without Docker (not the real infrastructure)
```bash
npm install
npm run start:local               # one Node process, in-memory stores
```
This mode sets `ALLOW_IN_MEMORY_FALLBACK=true` and runs the gateway, services and workers in a single process. `/health` shows `"in-memory"` for the three infrastructure pieces. It exists for quick development only; do not use it for the demo or for benchmarks. In Docker the fallback is disabled, so a service that cannot reach PostgreSQL, Redis or RabbitMQ keeps retrying and then exits instead of silently using memory.

### Ports

| Component | URL |
| :--- | :--- |
| API gateway (public API) | http://localhost:8080 |
| Frontend (nginx, forwards `/api` to the gateway) | http://localhost:3000 |
| Health | http://localhost:8080/health |
| Admin metrics | http://localhost:8080/api/admin/overview |
| RabbitMQ console | http://localhost:15672 (guest / guest) |
| PostgreSQL | localhost:5432, db `food_delivery_db`, user `postgres` |
| Redis | localhost:6379 |

The seven services listen only on the internal Docker network; reach them through the gateway.

### Demo accounts
| Role | Email | Password |
| :--- | :--- | :--- |
| Admin | `admin@fooddelivery.com` | `admin123` |
| Customer | `customer@fooddelivery.com` | `customer123` |
| Restaurant owner | `owner@fooddelivery.com` | `owner123` |
| Kitchen | `kitchen@fooddelivery.com` | `chef123` |
| Delivery rider | `rider@fooddelivery.com` | `rider123` |

---

## Tests

The tests send real HTTP requests to the running stack and check the results directly in PostgreSQL.

```bash
docker compose up --build -d
npm install
npm test                          # 48 checks
```

They cover: routing through the gateway, composite health, the token bucket and 429 responses, cache miss/hit/invalidation, circuit breaker open/fast-fail/reset, idempotency (one row in PostgreSQL), the worker consuming the RabbitMQ message and writing to PostgreSQL, two cooks claiming one order at the same instant (exactly one wins, one gets 409), the full order lifecycle, and password hashing / login.

The test run reseeds the database, so run it on a development stack.

## Load testing

```bash
TRUST_PROXY=true docker compose up -d api-gateway     # lets virtual users act as different clients
node load-tests/runner.js                             # writes load-tests/results/actual_test_run.json
docker compose up -d api-gateway                      # back to the normal, secure setting
npm run generate-docs                                 # rebuilds the PDFs from the measured numbers
```

On Windows, `.\test-all.ps1` does all of this. The runner refuses to produce numbers unless PostgreSQL, Redis and RabbitMQ are the real services, and it checks that the gateway honours `X-Forwarded-For` (otherwise all virtual users would share one rate-limit bucket).

`TRUST_PROXY=true` makes the gateway believe the `X-Forwarded-For` header, which any client can forge. Use it only for load tests.

k6 scripts are in `load-tests/k6/` (`k6 run load-tests/k6/spike_load.js`).

### Example results

These come from `load-tests/results/actual_test_run.json`, measured on one 2-core machine that also ran the load generator, so treat them as indicative. Re-run on your own machine and regenerate the report before submitting it.

| Scenario (GET /api/restaurants) | VUs | Requests | Req/s | Avg | p95 | p99 | HTTP 429 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Normal traffic | 10 | 200 | 450 | 21.63 ms | 38.3 ms | 60.95 ms | 0 (0%) |
| Heavy traffic | 50 | 1,000 | 781 | 62.99 ms | 93.91 ms | 119.14 ms | 0 (0%) |
| Traffic spike | 100 | 2,000 | 1,582 | 62.63 ms | 138.47 ms | 180.2 ms | 1,220 (61%) |
| Single-client burst | 1 | 50 | 685 | 1.47 ms | 2.62 ms | 5.31 ms | 30 (60%) |

- Cache: miss (PostgreSQL) averaged 2.15 ms, hit (Redis) 2.02 ms. The difference is small for this tiny query; the cache matters more as load grows.
- Async pipeline: 100 of 100 orders accepted by the API (avg 83.18 ms); the workers had written all kitchen-queue rows 3.04 s after the last API response.

---

## Configuration

Docker Compose sets everything needed. Useful variables (see `.env.example`):

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `RATE_LIMIT_CAPACITY` / `RATE_LIMIT_REFILL_RATE` | 20 / 5 | token bucket size and refill per second, per client |
| `TRUST_PROXY` | false | trust `X-Forwarded-For` for client identity (load tests only) |
| `ALLOW_IN_MEMORY_FALLBACK` | false | allow in-memory stores (local development only) |
| `JWT_SECRET` | from `.env` | token signing key; change it |

---

## Repository layout

```
docker-compose.yml          the whole stack
api-gateway/                reverse proxy, rate limiter, health
services/                   auth, restaurant, order, kitchen, payment, delivery, notification
workers/                    order-worker, notification-worker
database/                   schema.sql, db.js (PostgreSQL access layer), seed/
shared/                     redisClient, eventBus (RabbitMQ), bootstrap, auth, logger, constants
frontend/                   single-page UI (index.html) + nginx config
tests/                      integration tests (real HTTP + PostgreSQL)
load-tests/                 runner.js, k6/, results/
docs/                       diagram + PDF generators
```

## Known limitations
- The order is committed to PostgreSQL and the RabbitMQ message is published right after. If the broker is down at that moment the order exists but is never processed (a transactional outbox would fix this; not implemented).
- Fault tolerance covers the payment circuit breaker and the queue retries / dead-letter queue. Plain gateway-to-service HTTP calls are not retried (a dead service gives a 502/504).
- Authentication issues signed tokens, but the other services do not enforce them yet.
- The gateway's rate limiter fails open if Redis errors (it falls back to a per-process bucket).
- Payment and notification providers are simulated.
