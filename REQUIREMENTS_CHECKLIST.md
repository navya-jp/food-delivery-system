# Requirements Verification Checklist

Each row says where the requirement is implemented and how to check it yourself on a running stack (`docker compose up --build -d`). `npm test` runs most of these checks automatically (48 checks, real HTTP + PostgreSQL).

## Section 1: Architecture, Docker setup and API gateway

| Requirement | Implementation | How to verify |
| :--- | :--- | :--- |
| Shared Git repository + base `docker-compose.yml` | `docker-compose.yml`; run `git init` / push to your shared remote (the repo itself is not part of the zip) | `docker compose config -q` |
| Lightweight reverse proxy / API gateway that routes requests | `api-gateway/src/index.js`: each `/api/<service>` prefix is streamed over HTTP to its own container (502/504 if the upstream is down) | `docker compose stop order-service` then `POST /api/orders` returns 502 while `GET /api/restaurants` still returns 200 |
| Rate limiter (token bucket) returning 429 | Redis Lua script (`shared/redisClient.js`), applied in the gateway to every request except `/health` | send 25 quick requests: about 20 succeed, the rest get `429` with `Retry-After`; `npm test` group 3 |
| Health endpoint for each service node | `GET /health` calls each service's `/health` over HTTP and checks PostgreSQL, Redis, RabbitMQ; returns 503 when anything is down | `curl localhost:8080/health`; stop a service and call it again |
| Deliverable: architecture diagram + data-flow sketch | `docs/diagrams/architecture_diagram.png`, README "How an order flows" | open the files |
| Deliverable: `docker compose up` starts gateway and service nodes | compose with health checks and dependency order | `docker compose ps` |

## Section 2: Persistence, caching and asynchronous workers

| Requirement | Implementation | How to verify |
| :--- | :--- | :--- |
| Persistent database storing transaction logs / requests | PostgreSQL 16; `database/schema.sql` (23 tables incl. `transaction_logs`, `request_logs`, `order_status_history`); all reads/writes go through `database/db.js` using SQL; order creation is one real transaction | `docker compose exec postgres psql -U postgres -d food_delivery_db -c "select count(*) from request_logs"` |
| Caching layer (Redis) for hot data / limiter counters | cache-aside for restaurants and menus, invalidated on update; token-bucket state in Redis | first `GET /api/restaurants` says `CACHE_MISS (DB)`, second says `CACHE_HIT`; `npm test` group 4 |
| Async task queue + separate worker pool | order-service publishes to RabbitMQ and returns 201; `order-worker` (2 replicas) and `notification-worker` consume | `docker compose logs -f order-worker` while placing an order |
| Worker updates the database on completion | writes `background_tasks` (COMPLETED), `kitchen_queues`, `order_status_history` | `select * from background_tasks` after placing an order; `npm test` group 6 |
| Deliverable: schema + migration scripts | `database/schema.sql` runs automatically on a fresh volume; `database/seed/seed.js` loads demo data (the `db-seed` container) | `docker compose logs db-seed` |
| Deliverable: updated compose with DB, cache, workers | `docker-compose.yml` | `docker compose ps` |

## Section 3: Fault tolerance, load testing and demonstration

| Requirement | Implementation | How to verify |
| :--- | :--- | :--- |
| At least one fault-tolerance mechanism | circuit breaker in `payment-service` (opens after 3 failures, 8 s reset, half-open probe); retries with exponential backoff (200/400/800 ms) then dead-letter queue for failed worker messages | `POST /api/payments/process` with `{"forceFail":true}` three times, then the circuit is OPEN and calls return 503; `npm test` group 5; RabbitMQ console shows `food_delivery.dead_letter` |
| Load-testing script | `load-tests/runner.js` (Node, real HTTP; 6 scenarios) and `load-tests/k6/*.js` | see README "Load testing" |
| Structured logging / metrics tracing a request | JSON logs with `requestId` forwarded gateway -> service -> queue -> worker; `request_logs` and `transaction_logs` tables; `/api/restaurants/cache/stats` | `docker compose logs api-gateway order-service order-worker` |
| Deliverable: clean repository with README | `README.md` | follow it from scratch |
| Deliverable: load-test report (2-3 pages) | `Food_Delivery_Load_Test_Report.pdf` (2 pages), generated from `load-tests/results/actual_test_run.json` | `npm run generate-docs` after a load test |
| Live demo (10 min): `docker compose up`, live load test, code walkthrough | `LIVE_DEMO_GUIDE.md` | rehearse it |

## Before you submit
- Re-run the load test on your own machine and regenerate the PDFs (`npm run generate-docs`); the numbers in the repo came from a different machine.
- Check `docker compose up --build` from a clean clone (`docker compose down -v` first).
- The work must be original ("from scratch"): do not reuse code from earlier courses or internships.
