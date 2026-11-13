/**
 * Comprehensive Automated Integration & Unit Test Suite
 * Tests API Gateway, Rate Limiting (HTTP 429), Composite Health Check,
 * Redis Cache-Aside & Invalidation, Database Transactions & Persistence,
 * Circuit Breaker Fault Tolerance, RabbitMQ Async Event Dispatch & Workers,
 * and Full Order-to-Delivery Lifecycle with Concurrency Locks & Idempotency.
 */

import { request, BASE_URL } from './testClient.js';
import { db } from '../database/db.js';
import { seedDatabase } from '../database/seed/seed.js';
import { ORDER_STATUS } from '../shared/constants.js';

// These tests run over REAL HTTP against a RUNNING stack (docker compose up) and verify
// results directly in PostgreSQL. Usage:  docker compose up -d  &&  npm test
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 10000, everyMs = 200 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, testName) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ PASS: ${testName}`);
  } else {
    failedTests++;
    console.error(`  ❌ FAIL: ${testName}`);
  }
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('  EXECUTING DISTRIBUTED SYSTEM AUTOMATED TEST SUITE');
  console.log('================================================================');
  const suiteStartTime = Date.now();

  console.log(`Target: ${BASE_URL}`);
  // Direct DB connection (same PostgreSQL the stack uses) to verify persistence and reset demo data
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres_password@localhost:5432/food_delivery_db';
  await db.connect();
  await seedDatabase();
  await request.post('/api/restaurants/cache/purge');
  await request.post('/api/payments/circuit-breaker/reset');

  // -------------------------------------------------------------
  // TEST GROUP 1: API GATEWAY & REVERSE PROXY ROUTING
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 1] API Gateway & Routing:');
  const rootRes = await request.get('/');
  assert(rootRes.status === 200 && rootRes.body.status === 'online', 'Gateway root endpoint returns online');

  const authDemoRes = await request.get('/api/auth/demo-users');
  assert(authDemoRes.status === 200 && authDemoRes.body.data.length >= 5, 'Gateway routes /api/auth/* to Auth Service');

  const restRes = await request.get('/api/restaurants');
  assert(restRes.status === 200 && restRes.body.data.length >= 4, 'Gateway routes /api/restaurants to Restaurant Service');

  // Authentication: real password hashing and signed tokens
  const goodLogin = await request.post('/api/auth/login', { email: 'admin@fooddelivery.com', password: 'admin123' });
  assert(goodLogin.status === 200 && !!goodLogin.body.data.token, 'Login with the correct password succeeds');
  const crossLogin = await request.post('/api/auth/login', { email: 'admin@fooddelivery.com', password: 'customer123' });
  assert(crossLogin.status === 401, "Another account's demo password is rejected");
  const regEmail = `new_${Date.now()}@example.com`;
  const reg = await request.post('/api/auth/register', { name: 'Test User', email: regEmail, password: 'S3cret-pass!' });
  assert(reg.status === 201 || reg.status === 200, 'Registration succeeds');
  const stored = await db.findOne('users', { email: regEmail });
  assert(stored && stored.password_hash !== 'S3cret-pass!' && stored.password_hash.startsWith('scrypt$'), 'Password is stored as a salted scrypt hash, not plaintext');
  const regLogin = await request.post('/api/auth/login', { email: regEmail, password: 'S3cret-pass!' });
  assert(regLogin.status === 200, 'Newly registered user can log in');

  // -------------------------------------------------------------
  // TEST GROUP 2: COMPOSITE HEALTH CHECK
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 2] Composite Health Check Endpoint:');
  const healthRes = await request.get('/health');
  assert(healthRes.status === 200, 'Health check returns HTTP 200');
  assert(healthRes.body.gateway === 'healthy', 'Gateway node reports healthy');
  assert(healthRes.body.services.auth === 'healthy', 'Auth microservice reports healthy');
  assert(healthRes.body.services.restaurant === 'healthy', 'Restaurant microservice reports healthy');
  assert(healthRes.body.services.order === 'healthy', 'Order microservice reports healthy');
  assert(healthRes.body.services.kitchen === 'healthy', 'Kitchen microservice reports healthy');
  assert(healthRes.body.services.payment === 'healthy', 'Payment microservice reports healthy');
  assert(healthRes.body.services.delivery === 'healthy', 'Delivery microservice reports healthy');
  assert(healthRes.body.services.notification === 'healthy', 'Notification microservice reports healthy');
  assert(healthRes.body.database === 'healthy', 'Database connection reports healthy');
  assert(healthRes.body.redis === 'healthy', 'Redis cache reports healthy');
  assert(healthRes.body.rabbitmq === 'healthy', 'RabbitMQ message broker reports healthy');

  // -------------------------------------------------------------
  // TEST GROUP 3: TOKEN BUCKET RATE LIMITING & HTTP 429
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 3] Token Bucket Rate Limiting:');
  // Reset rate limits for test client
  await request.post('/api/ratelimit/reset');
  const burstHeaders = {};
  const limiterInfo = await request.get('/api/ratelimit/status');
  const capacity = limiterInfo.body.capacity;

  let allowed = 0;
  let blocked = 0;
  let sample429 = null;

  for (let i = 0; i < capacity + 5; i++) {
    const res = await request.get('/api/restaurants', burstHeaders);
    if (res.status === 200) allowed++;
    if (res.status === 429) {
      blocked++;
      sample429 = res.body;
    }
  }

  assert(allowed >= capacity && allowed <= capacity + 2, `Burst capacity of ${capacity} enforced (allowed: ${allowed}; +refill during loop)`);
  assert(blocked >= 3, `Excess traffic returned HTTP 429 Too Many Requests (blocked: ${blocked})`);
  assert(sample429 && sample429.retryAfter >= 1, 'HTTP 429 carries a Retry-After value');
  assert(sample429 && sample429.success === false, 'HTTP 429 returns structured JSON payload');
  assert(sample429 && typeof sample429.retryAfter === 'number', 'HTTP 429 includes retryAfter duration');

  // -------------------------------------------------------------
  // TEST GROUP 4: REDIS CACHING (CACHE-ASIDE & INVALIDATION)
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 4] Redis Caching (Cache-Aside Pattern):');
  await request.post('/api/ratelimit/reset');
  await request.post('/api/restaurants/cache/purge');

  // 1. First request -> Cache MISS
  const missRes = await request.get('/api/restaurants');
  assert(missRes.body.source === 'CACHE_MISS (DB)', 'First query is a Cache MISS and reads from PostgreSQL');

  // 2. Second request -> Cache HIT
  const hitRes = await request.get('/api/restaurants');
  assert(hitRes.body.source === 'CACHE_HIT', 'Subsequent query is a Cache HIT served directly from Redis');

  // 3. Update menu item -> Cache Invalidation
  const updateRes = await request.put('/api/restaurants/rest_burger_1/menu/item_b1', { price: 369.00 });
  assert(updateRes.status === 200, 'Menu item updated in database');

  // 4. Query after invalidation -> Cache MISS again
  const postInvalidateRes = await request.get('/api/restaurants');
  assert(postInvalidateRes.body.source === 'CACHE_MISS (DB)', 'Cache was invalidated after update and re-queried database');

  // -------------------------------------------------------------
  // TEST GROUP 5: CIRCUIT BREAKER FAULT TOLERANCE
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 5] Circuit Breaker State Transitions & Fallback:');
  await request.post('/api/ratelimit/reset');
  await request.post('/api/payments/circuit-breaker/reset');
  const cbStart = await request.get('/api/payments/circuit-breaker/status');
  assert(cbStart.body.data.state === 'CLOSED', 'Circuit starts in CLOSED state');

  // Trigger consecutive failures up to threshold (3) through the gateway
  for (let i = 1; i <= 3; i++) {
    await request.post('/api/payments/process', { orderId: 'ord_demo_1001', amount: 400, forceFail: true });
  }
  const cbOpen = await request.get('/api/payments/circuit-breaker/status');
  assert(cbOpen.body.data.state === 'OPEN', 'Circuit tripped to OPEN state after 3 consecutive errors');

  // Attempt request while OPEN -> fast failure with fallback
  const fallbackRes = await request.post('/api/payments/process', { orderId: 'ord_demo_1001', amount: 400 });
  assert(fallbackRes.status === 503, 'Calls during OPEN state fast-fail with HTTP 503');
  assert(fallbackRes.body.circuitState === 'OPEN', 'Response reports circuitState: OPEN');
  assert(fallbackRes.body.isFallback === true, 'Graceful degradation fallback response executed');

  await request.post('/api/payments/circuit-breaker/reset');
  const cbReset = await request.get('/api/payments/circuit-breaker/status');
  assert(cbReset.body.data.state === 'CLOSED', 'Circuit breaker resets cleanly to CLOSED');

  // -------------------------------------------------------------
  // TEST GROUP 6: IDEMPOTENCY & DUPLICATE PREVENTION
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 6] Idempotency & Concurrency:');
  await request.post('/api/ratelimit/reset');
  const idemKey = `idem_test_${Date.now()}`;
  const orderPayload = {
    user_id: 'usr_customer_1',
    restaurant_id: 'rest_burger_1',
    delivery_address_id: 'addr_cust_1',
    items: [{ menu_item_id: 'item_b1', quantity: 1 }],
    payment_method: 'CASH_ON_DELIVERY',
    idempotency_key: idemKey
  };

  const firstOrder = await request.post('/api/orders', orderPayload);
  assert(firstOrder.status === 201, 'First order placement succeeded');

  const duplicateOrder = await request.post('/api/orders', orderPayload);
  assert(duplicateOrder.status === 200, 'Duplicate request returned HTTP 200 idempotent response');
  assert(duplicateOrder.body.data.id === firstOrder.body.data.id, 'Duplicate request returned identical order ID without re-creating');
  const dupCount = await db.findMany('orders', { idempotency_key: idemKey });
  assert(dupCount.length === 1, 'PostgreSQL holds exactly one order row for the idempotency key');

  // ASYNC WORKER: the API returned immediately; a separate worker container finishes the job
  const orderRow = await db.findById('orders', firstOrder.body.data.id);
  assert(orderRow !== null, 'Order persisted in PostgreSQL (not an in-memory map)');
  const task = await waitFor(async () => {
    const tasks = await db.findMany('background_tasks', t => t.payload && t.payload.orderId === firstOrder.body.data.id && t.status === 'COMPLETED');
    return tasks[0];
  });
  assert(!!task, 'Worker consumed the RabbitMQ message and marked background_task COMPLETED in PostgreSQL');
  const queued = await waitFor(async () => db.findOne('kitchen_queues', { order_id: firstOrder.body.data.id }));
  assert(!!queued, 'Worker created the kitchen_queues row for the order');

  // -------------------------------------------------------------
  // TEST GROUP 7: KITCHEN QUEUE CONCURRENCY LOCK
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 7] Kitchen Queue Atomic Concurrency Lock:');
  await request.post('/api/ratelimit/reset');
  const testOrderId = firstOrder.body.data.id;
  await request.post(`/api/kitchen/orders/${testOrderId}/accept`, { cookName: 'Chef Gordon' });

  // Two cooks claim the SAME order at the SAME instant. Exactly one must win.
  const [cook1Res, cook2Res] = await Promise.all([
    request.post(`/api/kitchen/orders/${testOrderId}/start-prep`, { cookId: 'cook_1', cookName: 'Chef Gordon' }),
    request.post(`/api/kitchen/orders/${testOrderId}/start-prep`, { cookId: 'cook_2', cookName: 'Chef Ramsey' })
  ]);
  const statuses = [cook1Res.status, cook2Res.status].sort();
  assert(statuses[0] === 200 && statuses[1] === 409, `Simultaneous claims: exactly one 200 and one 409 (got ${statuses})`);
  const winner = cook1Res.status === 200 ? 'cook_1' : 'cook_2';
  const lockRow = await db.findOne('kitchen_queues', { order_id: testOrderId });
  assert(lockRow.locked_by === winner, 'PostgreSQL lock owner matches the winning cook');

  // -------------------------------------------------------------
  // TEST GROUP 8: END-TO-END ORDER LIFECYCLE & WORKER UPDATES
  // -------------------------------------------------------------
  console.log('\n[TEST GROUP 8] Full Order Lifecycle & Status History:');
  await request.post('/api/ratelimit/reset');
  // Kitchen marks ready
  const readyRes = await request.post(`/api/kitchen/orders/${testOrderId}/mark-ready`);
  assert(readyRes.status === 200, 'Order marked ready for pickup');

  // Delivery assignment algorithm
  const assignRes = await request.post('/api/delivery/assign', { orderId: testOrderId });
  assert(assignRes.status === 200 && assignRes.body.data.assignment, 'Delivery partner assigned via multi-criteria algorithm');

  const assignmentId = assignRes.body.data.assignment.id;
  await request.post(`/api/delivery/${assignmentId}/pickup`);
  await request.post(`/api/delivery/${assignmentId}/deliver`);

  const completedOrder = await request.get(`/api/orders/${testOrderId}`);
  assert(completedOrder.body.data.status === ORDER_STATUS.DELIVERED, 'Order lifecycle reached final DELIVERED state');
  assert(completedOrder.body.data.history.length >= 6, 'All lifecycle state changes logged in order_status_history');

  // -------------------------------------------------------------
  // TEST SUMMARY
  // -------------------------------------------------------------
  const duration = Date.now() - suiteStartTime;
  console.log('\n================================================================');
  console.log(`TEST EXECUTION SUMMARY (${duration}ms)`);
  console.log(`Total Tests Run:  ${totalTests}`);
  console.log(`Passed:           ${passedTests}`);
  console.log(`Failed:           ${failedTests}`);
  console.log(`Pass Rate:        ${((passedTests / totalTests) * 100).toFixed(1)}%`);
  console.log('================================================================\n');

  await db.close();
  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
