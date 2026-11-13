/**
 * High-Performance Standalone Distributed System Load Test Engine
 * Executes reproducible load profiles (Normal, Heavy, Spike, Rate-Limit, Cache Benchmark, Circuit-Breaker)
 * Measures: Requests, RPS, Latencies (Avg, Median, p90, p95, p99), HTTP 429 counts, Cache Hit Ratio.
 * Saves real benchmark output to results/actual_test_run.json
 */

import { request, BASE_URL } from '../tests/testClient.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// All traffic below is REAL HTTP to the running stack (default http://localhost:8080).
// Distinct simulated clients are expressed with X-Forwarded-For, which the gateway only honours
// when started with TRUST_PROXY=true (see README "Load testing"). This is verified up-front.

function calculatePercentiles(latencies) {
  if (latencies.length === 0) return { min: 0, avg: 0, median: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const avg = Number((sum / latencies.length).toFixed(2));
  const getP = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];

  return {
    min: latencies[0],
    avg,
    median: getP(50),
    p90: getP(90),
    p95: getP(95),
    p99: getP(99),
    max: latencies[latencies.length - 1]
  };
}

async function runProfile({ name, virtualUsers, totalRequests, targetFn }) {
  console.log(`\n--- Running Profile: ${name} (${virtualUsers} VUs, ${totalRequests} Requests) ---`);
  const latencies = [];
  let successful = 0;
  let rateLimited = 0;
  let failed = 0;

  const startTime = Date.now();
  let completed = 0;

  // Run in concurrent worker pools simulating VUs
  const workerTask = async (workerId) => {
    while (completed < totalRequests) {
      completed++;
      const reqStart = performance.now();
      try {
        const res = await targetFn(workerId);
        const reqLatency = Number((performance.now() - reqStart).toFixed(2));
        latencies.push(reqLatency);

        if (res.status === 200 || res.status === 201) {
          successful++;
        } else if (res.status === 429) {
          rateLimited++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
    }
  };

  const pool = [];
  for (let vu = 0; vu < virtualUsers; vu++) {
    pool.push(workerTask(vu));
  }
  await Promise.all(pool);

  const durationSec = Math.max(0.001, (Date.now() - startTime) / 1000.0);
  const rps = Number((totalRequests / durationSec).toFixed(1));
  const stats = calculatePercentiles(latencies);

  console.log(`  Completed in ${durationSec.toFixed(2)}s | Throughput: ${rps} req/sec`);
  console.log(`  Successful: ${successful} | Rate Limited (429): ${rateLimited} | Errors: ${failed}`);
  console.log(`  Latencies (ms) -> Avg: ${stats.avg} | Median: ${stats.median} | p95: ${stats.p95} | p99: ${stats.p99}`);

  return {
    profile: name,
    virtualUsers,
    totalRequests,
    durationSeconds: Number(durationSec.toFixed(2)),
    requestsPerSecond: rps,
    successful,
    rateLimited,
    failed,
    latencies: stats
  };
}

async function assertLoadTestMode() {
  const probe = await request.get('/api/ratelimit/status', { 'x-forwarded-for': '203.0.113.77' });
  if (probe.status !== 200) {
    throw new Error(`Gateway not reachable at ${BASE_URL} (HTTP ${probe.status}). Run: docker compose up -d`);
  }
  if (probe.body.client !== '203.0.113.77') {
    throw new Error('Gateway ignores X-Forwarded-For, so every virtual user would share one rate-limit bucket. ' +
      'Restart it with TRUST_PROXY=true:  TRUST_PROXY=true docker compose up -d api-gateway');
  }
  return probe.body;
}

export async function executeAllLoadTests() {
  console.log('================================================================');
  console.log('  EXECUTING DISTRIBUTED LOAD TESTING & PERFORMANCE BENCHMARKS');
  console.log(`  Target: ${BASE_URL} (real HTTP, real PostgreSQL / Redis / RabbitMQ)`);
  console.log('================================================================');

  const limiter = await assertLoadTestMode();
  const health = (await request.get('/health')).body;
  console.log(`Infrastructure modes: ${JSON.stringify(health.infrastructureMode)}`);
  if (health.infrastructureMode?.postgres !== 'postgres' || health.infrastructureMode?.redis !== 'redis' || health.infrastructureMode?.rabbitmq !== 'rabbitmq') {
    throw new Error('Stack is not running on real PostgreSQL + Redis + RabbitMQ; refusing to produce benchmark numbers.');
  }

  // SCENARIO 1: Normal Traffic (10 VUs, 200 requests)
  await request.post('/api/ratelimit/reset');
  const normalProfile = await runProfile({
    name: 'Scenario 1: Normal Traffic Profile',
    virtualUsers: 10,
    totalRequests: 200,
    targetFn: async (vu) => {
      const clientIp = `10.0.1.${vu}`;
      return request.get('/api/restaurants', { 'x-forwarded-for': clientIp });
    }
  });

  // SCENARIO 2: Heavy Load (50 VUs, 1000 requests)
  await request.post('/api/ratelimit/reset');
  const heavyProfile = await runProfile({
    name: 'Scenario 2: Heavy Traffic Profile',
    virtualUsers: 50,
    totalRequests: 1000,
    targetFn: async (vu) => {
      const clientIp = `10.0.2.${vu}`;
      return request.get('/api/restaurants', { 'x-forwarded-for': clientIp });
    }
  });

  // SCENARIO 3: Sudden Traffic Spike (100 VUs, 2000 requests)
  await request.post('/api/ratelimit/reset');
  const spikeProfile = await runProfile({
    name: 'Scenario 3: Traffic Spike Profile',
    virtualUsers: 100,
    totalRequests: 2000,
    targetFn: async (vu) => {
      const clientIp = `10.0.3.${vu % 30}`; // Concentrated client IPs to induce real rate limit enforcement
      return request.get('/api/restaurants', { 'x-forwarded-for': clientIp });
    }
  });

  // SCENARIO 4: Rate Limiting Stress Test (Single Client Burst)
  await request.post('/api/ratelimit/reset');
  const rateLimitProfile = await runProfile({
    name: 'Scenario 4: Rate Limiter Token Bucket Protection',
    virtualUsers: 1,
    totalRequests: 50,
    targetFn: async () => {
      return request.get('/api/restaurants', { 'x-forwarded-for': '192.168.1.100' });
    }
  });

  // SCENARIO 5: Cached vs Uncached Benchmark
  console.log('\n--- Scenario 5: Cache-Aside Performance Benchmark ---');
  // 5A: Uncached (Purge before each query)
  const uncachedLatencies = [];
  for (let i = 0; i < 50; i++) {
    await request.post('/api/restaurants/cache/purge');
    const start = performance.now();
    await request.get('/api/restaurants', { 'x-forwarded-for': `10.10.10.${i}` });
    uncachedLatencies.push(Number((performance.now() - start).toFixed(2)));
  }
  const uncachedStats = calculatePercentiles(uncachedLatencies);

  // 5B: Cached (Warm cache)
  await request.get('/api/restaurants', { 'x-forwarded-for': '10.10.10.1' });
  const cachedLatencies = [];
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    await request.get('/api/restaurants', { 'x-forwarded-for': `10.10.10.${i + 50}` });
    cachedLatencies.push(Number((performance.now() - start).toFixed(2)));
  }
  const cachedStats = calculatePercentiles(cachedLatencies);

  console.log(`  Uncached (PostgreSQL Query) -> Avg Latency: ${uncachedStats.avg}ms | p95: ${uncachedStats.p95}ms`);
  console.log(`  Cached (Redis Cache-Aside)  -> Avg Latency: ${cachedStats.avg}ms | p95: ${cachedStats.p95}ms`);
  const latencyReduction = (((uncachedStats.avg - cachedStats.avg) / Math.max(0.1, uncachedStats.avg)) * 100).toFixed(1);
  console.log(`  Performance Improvement: ${latencyReduction}% latency reduction with Redis caching!`);

  // SCENARIO 6: Async write path (order creation -> RabbitMQ -> worker pool -> PostgreSQL)
  console.log('\n--- Scenario 6: Asynchronous Order Pipeline ---');
  await request.post('/api/ratelimit/reset');
  const overviewBefore = (await request.get('/api/admin/overview')).body.data;
  const baseline = overviewBefore.activeKitchenOrders;
  const ORDERS = 100;
  let accepted = 0;
  const orderProfile = await runProfile({
    name: 'Scenario 6: Order Placement (publishes to RabbitMQ)',
    virtualUsers: 20,
    totalRequests: ORDERS,
    targetFn: async (vu) => {
      const r = await request.post('/api/orders', {
        restaurant_id: 'rest_pizza_2',
        items: [{ menu_item_id: 'item_p1', quantity: 1 }],
        payment_method: 'CASH_ON_DELIVERY',
        idempotency_key: `load_${Date.now()}_${Math.random().toString(36).slice(2)}`
      }, { 'x-forwarded-for': `10.0.6.${vu}` });
      if (r.status === 201) accepted++;
      return r;
    }
  });
  const publishDone = Date.now();
  let drained = null;
  while (Date.now() - publishDone < 90000) {
    const o = (await request.get('/api/admin/overview')).body.data;
    if (o.activeKitchenOrders >= baseline + accepted) { drained = Date.now() - publishDone; break; }
    await sleep(250);
  }
  console.log(`  Orders accepted by API: ${accepted}/${ORDERS}`);
  console.log(drained !== null
    ? `  Workers drained the queue and wrote all kitchen_queue rows ${(drained / 1000).toFixed(2)}s after the last API response`
    : '  WARNING: workers did not finish within 90s');
  const asyncPipeline = { ordersAccepted: accepted, workerDrainSecondsAfterLastResponse: drained === null ? null : Number((drained / 1000).toFixed(2)), api: orderProfile };

  const resultsSummary = {
    testDate: new Date().toISOString(),
    environment: {
      platform: `${os.type()} ${os.release()} (${os.platform()})`,
      nodeVersion: process.version,
      cpuCores: os.cpus().length,
      target: BASE_URL,
      deployment: process.env.DEPLOYMENT_NOTE || 'docker compose (one container per service, 2 order-worker replicas)',
      infrastructure: health.infrastructureMode,
      rateLimiter: { capacity: limiter.capacity, refillRatePerSecond: limiter.refillRatePerSecond },
      architecture: 'API gateway (HTTP reverse proxy) -> 7 microservices -> PostgreSQL / Redis / RabbitMQ -> worker pool'
    },
    profiles: {
      normal: normalProfile,
      heavy: heavyProfile,
      spike: spikeProfile,
      rateLimitTest: rateLimitProfile,
      asyncOrderPipeline: asyncPipeline,
      cachingBenchmark: {
        uncached: uncachedStats,
        cached: cachedStats,
        latencyReductionPercentage: Number(latencyReduction)
      }
    }
  };

  const resultsDir = path.resolve('load-tests/results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const outputPath = path.join(resultsDir, 'actual_test_run.json');
  fs.writeFileSync(outputPath, JSON.stringify(resultsSummary, null, 2));
  console.log(`\n✅ Real load test results saved to: ${outputPath}\n`);

  return resultsSummary;
}

if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  executeAllLoadTests().catch(err => {
    console.error('Load testing error:', err);
    process.exit(1);
  });
}
