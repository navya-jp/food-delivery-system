# Live Demonstration Guide & Viva Preparation
## Food Delivery Order and Kitchen Management System
### Distributed Systems, System Design, Microservices and Fault Tolerance

This guide is scripted for a strict **10-minute live demonstration** in front of professors and evaluators, complete with exact PowerShell / curl commands, expected JSON responses, and 20 comprehensive viva examination questions with detailed answers.

---

## 10-Minute Scripted Demonstration Timeline

### [0:00 – 1:00] Architecture Introduction & Problem Statement
- **What to say:**
  > "Good morning, professors. Today I am presenting our distributed Food Delivery Order and Kitchen Management System. In high-volume food delivery platforms, monolithic architectures struggle with cascading failures, database lock contention, and uncoordinated retries. We have architected an independent distributed system comprising an Express reverse-proxy API Gateway with Redis Token Bucket rate limiting, seven domain microservices, PostgreSQL 16 persistence, Redis 7 Cache-Aside caching, RabbitMQ 3.13 asynchronous message brokering, dedicated background workers, and an active Circuit Breaker for downstream fault tolerance."
- **Visual Aid:** Open `http://localhost:8080/app` and switch to the **System Design** view to display the live component matrix.

---

### [1:00 – 2:00] Starting the System (Docker Compose or Local PowerShell)
- **Action:** Open Windows PowerShell terminal and start the complete application.
```powershell
# Option A: Start using Docker Compose
docker compose up --build -d

# (Local in-memory mode exists for development only: .\start-all.ps1 -Local. Use Docker for the demo.)
```
- **What to say:**
  > "The system is orchestrated with Docker Compose: PostgreSQL, Redis, RabbitMQ, a one-shot seeder, seven microservices, the API gateway, three worker containers and the frontend, all on one bridge network. Services find each other by Docker DNS name. Only the gateway publishes an API port. Run docker compose ps to show every service healthy."

---

### [2:00 – 3:00] API Gateway Routing & Reverse Proxy
- **Action:** Demonstrate that requests to the Gateway on Port 8080 route dynamically to backend microservices.
```powershell
# Query Restaurant Service through Gateway
curl.exe -s http://localhost:8080/api/restaurants | Select-String -Pattern "Gourmet Burger"

# Query Auth Service through Gateway
curl.exe -s http://localhost:8080/api/auth/demo-users
```
- **What to say:**
  > "Notice that the frontend only talks to Port 8080. The Gateway inspects incoming route prefixes—for example, routing `/api/restaurants/*` to the Restaurant Microservice on Port 4002 and `/api/auth/*` to the Auth Microservice on Port 4001—while automatically injecting an `X-Request-Id` for distributed correlation tracing."

---

### [3:00 – 4:00] Token Bucket Rate Limiter & HTTP 429
- **Action:** Fire a rapid burst of 25 requests from PowerShell or click **"Fire 25 Burst"** in the web UI.
```powershell
# PowerShell script to fire burst of 25 requests against capacity of 20
1..25 | ForEach-Object {
    $res = Invoke-WebRequest -Uri "http://localhost:8080/api/restaurants" -Headers @{"x-forwarded-for"="192.168.1.50"} -SkipHttpErrorCheck
    Write-Host "Request $_ -> HTTP Status: $($res.StatusCode)"
}
```
- **Expected Output:**
  - Requests 1 to 20: `HTTP 200 OK`
  - Requests 21 to 25: `HTTP 429 Too Many Requests`
  - JSON payload:
    ```json
    {
      "success": false,
      "message": "Rate limit exceeded. Too many requests, please slow down.",
      "limit": 20,
      "remaining": 0,
      "retryAfter": 1
    }
    ```
- **What to say:**
  > "The Gateway evaluates an atomic Redis Lua script implementing the Token Bucket algorithm. We configured a capacity of 20 tokens refilling at 5 tokens per second. The first 20 burst requests consume available tokens; immediately on the 21st request, the Gateway intercepts the traffic in 0.1ms and returns HTTP 429 with standard `Retry-After` headers, shielding our microservices and database from overload."

---

### [4:00 – 5:00] Composite Health Checks
- **Action:** Query the `/health` endpoint to inspect individual node health.
```powershell
curl.exe -s http://localhost:8080/health | ConvertFrom-Json | ConvertTo-Json -Depth 4
```
- **Expected Output:**
  ```json
  {
    "gateway": "healthy",
    "status": "healthy",
    "services": {
      "auth": "healthy",
      "restaurant": "healthy",
      "order": "healthy",
      "kitchen": "healthy",
      "payment": "healthy",
      "delivery": "healthy",
      "notification": "healthy"
    },
    "database": "healthy",
    "redis": "healthy",
    "rabbitmq": "healthy"
  }
  ```
- **What to say:**
  > "Unlike naive health checks that return a static string, our Gateway performs live active probing across all 7 downstream service nodes, PostgreSQL (`SELECT 1`), Redis (`PING`), and RabbitMQ. If any critical component goes down, the composite status reports `degraded` and HTTP 503."

---

### [5:00 – 6:00] Order Placement, ACID Transactions & Idempotency
- **Action:** Place a food order with an explicit Idempotency Key.
```powershell
$orderBody = @{
    user_id = "usr_customer_1"
    restaurant_id = "rest_burger_1"
    delivery_address_id = "addr_cust_1"
    items = @(
        @{ menu_item_id = "item_b1"; quantity = 2 },
        @{ menu_item_id = "item_b3"; quantity = 1 }
    )
    payment_method = "CASH_ON_DELIVERY"
    idempotency_key = "idem_live_demo_001"
} | ConvertTo-Json

# 1. First Submission (Creates Order)
curl.exe -s -X POST http://localhost:8080/api/orders -H "Content-Type: application/json" -d $orderBody

# 2. Immediate Duplicate Submission (Tests Idempotency)
curl.exe -s -X POST http://localhost:8080/api/orders -H "Content-Type: application/json" -d $orderBody
```
- **Expected Output:**
  - First call returns HTTP 201 with new order details.
  - Second call returns HTTP 200 with message `"Order already processed (Idempotent response)"` and the exact same order ID without charging or inserting duplicate rows!
- **What to say:**
  > "Order creation executes in an atomic PostgreSQL transaction. Notice that when we resubmit the exact same payload with the identical idempotency key—simulating a mobile network retry—the system intercepts it, avoids duplicate database insertions, and returns the cached order."

---

### [6:00 – 7:00] Redis Caching (Cache-Aside & Invalidation)
- **Action:** Demonstrate Cache MISS, Cache HIT, and automated cache invalidation upon menu updates.
```powershell
# 1. Purge Cache
curl.exe -s -X POST http://localhost:8080/api/restaurants/cache/purge

# 2. First Query -> Cache MISS (Reads from PostgreSQL)
curl.exe -s http://localhost:8080/api/restaurants | Select-String -Pattern "source"

# 3. Second Query -> Cache HIT (Served from Redis)
curl.exe -s http://localhost:8080/api/restaurants | Select-String -Pattern "source"

# 4. Update Price of item_b1 to 399.00 -> Triggers Invalidation
curl.exe -s -X PUT http://localhost:8080/api/restaurants/rest_burger_1/menu/item_b1 -H "Content-Type: application/json" -d '{\"price\": 399}'

# 5. Query Again -> Cache MISS (Re-populates fresh cache)
curl.exe -s http://localhost:8080/api/restaurants | Select-String -Pattern "source"
```
- **What to say:**
  > "Here we demonstrate the Cache-Aside pattern. The first query misses cache and reads from PostgreSQL. The second request is served from Redis without touching PostgreSQL (the response says CACHE_HIT). When a restaurant manager updates a menu price, the system executes an automated cache invalidation, ensuring stale data is never served to customers."

---

### [7:00 – 8:00] RabbitMQ Asynchronous Worker & Kitchen Atomic Locking
- **Action:** Show the background worker processing and kitchen queue concurrency lock.
```powershell
# 1. Query Kitchen Queue
curl.exe -s http://localhost:8080/api/kitchen/dashboard

# 2. Cook 1 acquires exclusive lock
curl.exe -s -X POST http://localhost:8080/api/kitchen/orders/ord_demo_1001/start-prep -H "Content-Type: application/json" -d '{\"cookId\":\"cook_1\",\"cookName\":\"Chef Gordon\"}'

# 3. Cook 2 attempts to cook the same order concurrently -> HTTP 409 Conflict!
curl.exe -s -X POST http://localhost:8080/api/kitchen/orders/ord_demo_1001/start-prep -H "Content-Type: application/json" -d '{\"cookId\":\"cook_2\",\"cookName\":\"Chef Ramsey\"}'
```
- **Expected Output:**
  - Cook 2 receives `HTTP 409 Conflict: Order is already being processed by cook: cook_1`.
- **What to say:**
  > "When the customer placed their order, the API Gateway published an event to RabbitMQ and returned immediately without blocking. The background Order Worker consumed the message and enrolled it in the kitchen queue. To prevent two kitchen staff members from preparing the same food order simultaneously, we enforce atomic concurrency locking with an expiration TTL."

---

### [8:00 – 9:00] Circuit Breaker & Graceful Failure Handling
- **Action:** Trip the Payment Circuit Breaker by simulating downstream bank failures.
```powershell
# 1. Check Circuit State (Initially CLOSED)
curl.exe -s http://localhost:8080/api/payments/circuit-breaker/status

# 2. Fire 3 failed payment attempts (Trips to OPEN)
1..3 | ForEach-Object {
    curl.exe -s -X POST http://localhost:8080/api/payments/process -H "Content-Type: application/json" -d '{\"orderId\":\"ord_demo_1001\",\"amount\":500,\"forceFail\":true}'
}

# 3. Check Circuit State (Now OPEN)
curl.exe -s http://localhost:8080/api/payments/circuit-breaker/status

# 4. Next Payment Attempt -> Fast-Fails with Fallback Response in 0ms!
curl.exe -s -X POST http://localhost:8080/api/payments/process -H "Content-Type: application/json" -d '{\"orderId\":\"ord_demo_1001\",\"amount\":500}'
```
- **Expected Output:**
  - Returns `HTTP 503` with fallback message:
    `"Payment processing fallback: Circuit is OPEN. External service unavailable. Retry in 8s."`
- **What to say:**
  > "Here is our fault-tolerance mechanism. Rather than allowing failing downstream bank gateways to tie up API Gateway worker threads, the Circuit Breaker trips to OPEN after 3 consecutive failures. Subsequent calls fail immediately in 0 milliseconds with a structured fallback response. After an 8-second reset timeout, it transitions to HALF_OPEN to safely probe downstream recovery."

---

### [9:00 – 10:00] Automated Test Suite & Load Test Execution
- **Action:** Run the automated integration test suite and load-test runner in the terminal.
```powershell
node tests/run-tests.js
node load-tests/runner.js
```
- **What to say:**
  > "In summary, our test suite runs 48 automated checks over real HTTP against the real PostgreSQL, Redis and RabbitMQ, all passing. In our load test, normal traffic averaged 21.63 ms and heavy traffic 62.99 ms at 781 requests per second. In the 100-user spike the token bucket rejected 1,220 of 2,000 requests with HTTP 429 and there were no server errors. All architecture documentation and empirical benchmark reports are compiled in the submitted PDF deliverables."

---

## 20 Viva Examination Questions & Answers

#### Q1: What is the primary role of an API Gateway in a microservices architecture?
**Answer:** The API Gateway is the single public entry point for client requests. It decouples client applications from internal microservices, handles reverse-proxy routing, enforces cross-cutting concerns (Token Bucket rate limiting, CORS, authentication verification), aggregates composite health checks, and injects correlation IDs (`X-Request-Id`) for distributed tracing.

#### Q2: How does the Token Bucket rate limiting algorithm work, and what are its time and space complexities?
**Answer:** The Token Bucket algorithm maintains a bucket with a fixed capacity $C$ that continuously refills at rate $r$ tokens per second. When a request arrives, the algorithm calculates tokens added during the elapsed time $\Delta t = (t_{\text{now}} - t_{\text{last}})$, caps tokens at $C$, and decrements 1 token if available (HTTP 200). If empty, the request is rejected with HTTP 429. Time complexity is $O(1)$ constant time via an atomic Redis Lua script; space complexity is $O(U)$ where $U$ is the number of active client IP keys in Redis.

#### Q3: Why is Redis Lua scripting used instead of standard separate Redis GET and SET commands?
**Answer:** Standard GET and SET commands require multiple network round trips and are vulnerable to race conditions under concurrent traffic. A Lua script executes atomically within Redis's single-threaded event loop, guaranteeing that token calculation, decrement, and timestamp updates happen as an indivisible unit without lock contention or bypasses.

#### Q4: Explain the Cache-Aside pattern used in your Restaurant Service.
**Answer:** In the Cache-Aside (Lazy Loading) pattern, the application checks Redis first. On a Cache HIT, data is returned directly from Redis. On a Cache MISS, the application queries PostgreSQL, computes business logic/rankings, stores the serialized result in Redis with a 180-second TTL, and returns the response. When a menu item or price is updated, the service automatically deletes the relevant Redis keys (`cache:restaurant:*`) to invalidate stale data.

#### Q5: What is the difference between Cache-Aside and Write-Through caching?
**Answer:** In Cache-Aside, the application code coordinates both database reads and cache population lazily on demand. In Write-Through caching, the application writes data to the cache, and the cache synchronously writes to the database before acknowledging the write. Cache-Aside is more resilient because database writes succeed even if the cache is momentarily unavailable.

#### Q6: How does RabbitMQ decouple the Order Service from background processing?
**Answer:** When an order is placed, the Order Service performs initial validation, stores the record in PostgreSQL within a transaction, publishes an AMQP message to the `food_delivery.order.created` queue, and immediately returns HTTP 201 to the user. Background workers consume messages asynchronously, preventing slow operations (e.g. kitchen notification, email dispatch, rider matching) from blocking the API Gateway.

#### Q7: What is a Dead Letter Queue (DLQ) and how is it used in your system?
**Answer:** A Dead Letter Queue is a safety queue that captures messages that cannot be processed successfully after exceeding the maximum retry threshold (3 retries). In our system, when a consumer encounters an unrecoverable error, it nacks the message with `requeue=false`. RabbitMQ routes the message through the Dead Letter Exchange (`food_delivery.dlx`) to the DLQ (`food_delivery.dead_letter`) for audit and manual intervention.

#### Q8: Explain the three states of the Circuit Breaker pattern.
**Answer:**
1. **CLOSED:** Normal state. Requests pass through to downstream providers. Failures increment a failure counter.
2. **OPEN:** Tripped when consecutive failures exceed the threshold (3 errors). All incoming requests fail fast with an immediate fallback response in 0ms without calling the downstream provider.
3. **HALF_OPEN:** After a reset timeout (8 seconds), the breaker allows a single probe request. If the probe succeeds, the circuit resets to CLOSED; if it fails, it returns to OPEN for another timeout interval.

#### Q9: How do you achieve idempotency in order creation?
**Answer:** The client sends an `X-Idempotency-Key` (a unique UUID) with the checkout request. The Order Service checks the database for an existing order with that idempotency key. If found, it returns the existing order record with HTTP 200 without creating duplicate database rows or charging the payment gateway again. If not found, it inserts the key and order atomically inside a database transaction.

#### Q10: How do you prevent two kitchen cooks from preparing the same order simultaneously?
**Answer:** The Kitchen Service enforces an atomic concurrency lock. When a cook clicks "Start Prep", the system checks if `locked_by` is null or if `locked_until` has expired. If free, it atomically assigns the cook's ID and sets a 15-minute lock TTL. If a second cook attempts to claim the order while locked, the system detects the conflict and rejects the second request with HTTP 409 Conflict.

#### Q11: Explain your Delivery Partner Assignment algorithm (Algorithm 6).
**Answer:** The algorithm evaluates all online riders with less than 3 active deliveries. It computes a multi-criteria weighted score:
$$\text{Score} = w_1 \cdot \left(1 - \frac{\text{Distance}}{\text{MaxDistance}}\right) + w_2 \cdot \left(1 - \frac{\text{ActiveOrders}}{\text{MaxCapacity}}\right) + w_3 \cdot \left(\frac{\text{Rating}}{5.0}\right)$$
Weights ($w_1 = 0.50$, $w_2 = 0.30$, $w_3 = 0.20$) prioritize closer riders while balancing existing workload and customer ratings.

#### Q12: Why is Exponential Backoff with Jitter preferred over immediate retries?
**Answer:** Immediate retries or fixed-interval retries cause the "thundering herd" problem, where thousands of failed clients retry simultaneously, overwhelming a recovering service. Exponential backoff exponentially increases delay ($t = \text{base} \cdot 2^{\text{attempt}}$), while randomized jitter disperses retry arrivals smoothly across time.

#### Q13: What ACID guarantees are maintained during order placement?
**Answer:**
- **Atomicity:** Order headers, line items, transaction logs, and initial status history are committed in a single database transaction; if any insert fails, all changes roll back.
- **Consistency:** Foreign key constraints and column checks (e.g. `quantity > 0`) ensure data validity.
- **Isolation:** Transaction isolation prevents dirty reads of uncommitted orders.
- **Durability:** Committed transactions are flushed to persistent PostgreSQL volume storage.

#### Q14: How does your system support graceful degradation if Redis fails?
**Answer:** If Redis becomes unreachable while running, `/health` reports it as down, the rate limiter degrades to a per-gateway local bucket and cache reads fall through to PostgreSQL, so the API keeps answering. At start-up in Docker there is no silent fallback: a container waits and retries until Redis is reachable.

#### Q15: What is the purpose of the `order_status_history` table?
**Answer:** It provides an immutable audit trail of every lifecycle transition from `CREATED` to `DELIVERED`. Each row records `order_id`, `from_status`, `to_status`, `changed_by`, `comments`, and an ISO timestamp. This supports dispute resolution, metrics calculation, and live tracking timelines for customers.

#### Q16: How do Docker Compose service names facilitate service discovery?
**Answer:** Docker Compose creates an internal DNS resolver on user-defined bridge networks. Each container can resolve peer containers by their service name (e.g. `http://order-service:4003` or `postgres:5432`), eliminating hardcoded IP addresses and allowing containers to be recreated with dynamic IP allocations without breaking configuration.

#### Q17: What was the observed impact of traffic spikes during your load tests?
**Answer:** Under our 100 VU traffic spike test (2000 requests), average latency went from 21.63 ms (normal load) to 62.63 ms. The token bucket rejected 1,220 requests with HTTP 429 in the gateway, so they never reached the services or PostgreSQL, and there were 0 server errors.

#### Q18: What is the Transactional Outbox pattern, and why is it relevant here?
**Answer:** In distributed systems, updating a database and publishing an event to a message broker are two distinct operations. If the broker is down after the DB commit, data becomes inconsistent. The Transactional Outbox pattern writes the outgoing event into an `outbox` table within the same database transaction. A background relay process then reads from the outbox and publishes to RabbitMQ with guaranteed at-least-once delivery.

#### Q19: Explain the difference between horizontal and vertical scaling for this architecture.
**Answer:**
- **Vertical scaling (scale up):** Adding more CPU and RAM to the host running the containers.
- **Horizontal scaling (scale out):** Running multiple replicas of stateless containers (e.g. 3 replicas of `order-service` and `kitchen-service`) behind a load balancer. Because our microservices are stateless and delegate state to PostgreSQL and Redis, they can be scaled horizontally without session stickiness issues.

#### Q20: How are correlation IDs used for distributed request tracing?
**Answer:** The API Gateway generates or captures `X-Request-Id` / `X-Correlation-Id` upon request receipt. This unique ID is injected into HTTP headers forwarded to microservices, passed as message metadata in RabbitMQ payloads, and included in every structured JSON log line. Operators can query log aggregators (e.g. Elasticsearch/Loki) by correlation ID to reconstruct the exact path and latency of an individual request through the Gateway, Microservice, Cache, Broker, Worker, and Database.

---

## Optional failure drills (strong for the demo)

```bash
# 1. Kill one service: the gateway answers 502 for its routes, other routes keep working
docker compose stop order-service
curl -i -X POST http://localhost:8080/api/orders -H "Content-Type: application/json" -d '{}'   # 502
curl http://localhost:8080/api/restaurants                                                       # still 200
curl http://localhost:8080/health                                                                # status "degraded", order "down"
docker compose start order-service

# 2. Show the worker pool: orders return immediately, workers finish later
docker compose logs -f order-worker

# 3. Look at the dead-letter queue and queues in the RabbitMQ console: http://localhost:15672 (guest / guest)
```
