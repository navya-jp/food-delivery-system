/**
 * API Gateway - Reverse Proxy, Token Bucket Rate Limiter,
 * Composite Health Checks, and Structured Request Tracing
 */

import express from 'express';
import cors from '../../shared/corsAdapter.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { redisManager } from '../../shared/redisClient.js';
import { db } from '../../database/db.js';
import { eventBus } from '../../shared/eventBus.js';
import { createLogger } from '../../shared/logger.js';
import { startService } from '../../shared/bootstrap.js';

const log = createLogger('api-gateway');
const app = express();
const PORT = process.env.PORT_GATEWAY || 8080;
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || '15000', 10);

app.disable('x-powered-by');
app.use(cors());
// NOTE: no body parser here on purpose. The gateway streams request bodies straight
// through to the upstream service, so it never buffers or re-serialises payloads.

// Upstream service base URLs. When a URL is set the gateway is a true HTTP reverse proxy to
// that container. When it is NOT set (single-process dev mode: `node server.js`) the service
// app is mounted in-process instead.
const SERVICE_TARGETS = {
  auth: process.env.AUTH_SERVICE_URL || null,
  restaurant: process.env.RESTAURANT_SERVICE_URL || null,
  order: process.env.ORDER_SERVICE_URL || null,
  kitchen: process.env.KITCHEN_SERVICE_URL || null,
  payment: process.env.PAYMENT_SERVICE_URL || null,
  delivery: process.env.DELIVERY_SERVICE_URL || null,
  notification: process.env.NOTIFICATION_SERVICE_URL || null
};

const ROUTES = [
  ['/api/auth', 'auth', '../../services/auth-service/src/index.js'],
  ['/api/restaurants', 'restaurant', '../../services/restaurant-service/src/index.js'],
  ['/api/orders', 'order', '../../services/order-service/src/index.js'],
  ['/api/kitchen', 'kitchen', '../../services/kitchen-service/src/index.js'],
  ['/api/payments', 'payment', '../../services/payment-service/src/index.js'],
  ['/api/delivery', 'delivery', '../../services/delivery-service/src/index.js'],
  ['/api/notifications', 'notification', '../../services/notification-service/src/index.js']
];

const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function getClientId(req) {
  // X-Forwarded-For is client-controlled, so it is only honoured when explicitly trusted
  const raw = process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : (req.socket.remoteAddress || '127.0.0.1');
  return raw.replace(/^::ffff:/, '');
}

/** Real reverse proxy: streams the request to the upstream container and pipes the response back */
function proxyTo(name, baseUrl) {
  const target = new URL(baseUrl);
  return (req, res) => {
    req.targetService = `${name}-service`;
    const headers = {
      ...req.headers,
      host: target.host,
      'x-request-id': req.requestId,
      'x-correlation-id': req.requestId,
      'x-forwarded-for': getClientId(req)
    };
    const upstream = http.request({
      agent: upstreamAgent,
      hostname: target.hostname,
      port: target.port || 80,
      path: req.originalUrl,           // full original path + query, e.g. /api/orders/123?x=1
      method: req.method,
      headers,
      timeout: PROXY_TIMEOUT_MS
    }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (err) => {
      const timedOut = err.message === 'upstream timeout';
      log.error(`[Proxy] ${name}-service unreachable: ${err.message}`, { requestId: req.requestId });
      if (!res.headersSent) {
        res.status(timedOut ? 504 : 502).json({
          success: false,
          message: timedOut ? `${name}-service timed out` : `${name}-service unavailable`,
          requestId: req.requestId
        });
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  };
}

// ========================================================
// 1. TOKEN BUCKET RATE LIMITER MIDDLEWARE
// ========================================================

export const rateLimiterConfig = {
  capacity: parseInt(process.env.RATE_LIMIT_CAPACITY || '20', 10), // Max burst tokens
  refillRate: parseInt(process.env.RATE_LIMIT_REFILL_RATE || '5', 10), // Tokens per second
  windowSeconds: parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '60', 10)
};

export async function tokenBucketRateLimiter(req, res, next) {
  // Allow health check and demo toggle endpoints to bypass rate limits
  if (req.path === '/health' || req.path === '/api/ratelimit/status' || req.path === '/api/ratelimit/reset') {
    return next();
  }

  const clientId = getClientId(req);

  try {
    const rateCheck = await redisManager.consumeTokenBucket(
      clientId,
      rateLimiterConfig.capacity,
      rateLimiterConfig.refillRate,
      1
    );

    // Set standard rate limit headers
    res.setHeader('X-RateLimit-Limit', rateLimiterConfig.capacity);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, rateCheck.remaining));
    res.setHeader('X-RateLimit-Reset', rateCheck.retryAfter || 0);

    req.rateLimitResult = rateCheck.allowed ? 'ALLOWED' : 'BLOCKED';

    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', rateCheck.retryAfter || 5);
      log.warn(`[HTTP 429] Rate limit exceeded for client [${clientId}]`, {
        path: req.path,
        remaining: rateCheck.remaining,
        retryAfter: rateCheck.retryAfter
      });

      return res.status(429).json({
        success: false,
        message: 'Rate limit exceeded. Too many requests, please slow down.',
        limit: rateLimiterConfig.capacity,
        remaining: rateCheck.remaining,
        retryAfter: rateCheck.retryAfter || 5,
        timestamp: new Date().toISOString()
      });
    }

    next();
  } catch (err) {
    log.error('Rate limiting middleware error, failing open safely:', { error: err.message });
    next();
  }
}

// ========================================================
// 2. STRUCTURED REQUEST LOGGING & TRACING MIDDLEWARE
// ========================================================

app.use((req, res, next) => {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Correlation-Id', requestId);

  // Capture response finish
  res.on('finish', async () => {
    const latencyMs = Date.now() - start;
    const clientIp = getClientId(req);
    const targetService = req.targetService || 'gateway';

    log.info(`[Gateway] ${req.method} ${req.originalUrl || req.path} -> ${res.statusCode} (${latencyMs}ms)`, {
      requestId,
      method: req.method,
      path: req.originalUrl || req.path,
      clientIp,
      statusCode: res.statusCode,
      latencyMs,
      targetService,
      rateLimitResult: req.rateLimitResult || 'ALLOWED'
    });

    // Record in database request logs
    try {
      await db.logRequest({
        requestId,
        method: req.method,
        path: req.originalUrl || req.path,
        clientIp: String(clientIp),
        statusCode: res.statusCode,
        latencyMs,
        serviceRouted: targetService
      });
    } catch (e) {
      // ignore
    }
  });

  next();
});

// Apply Rate Limiter globally across the Gateway
app.use(tokenBucketRateLimiter);

// ========================================================
// 3. COMPOSITE HEALTH CHECK ENDPOINT (SECTION 1 REQUIREMENT)
// ========================================================

app.get('/health', async (req, res) => {
  const timestamp = new Date().toISOString();

  // 1. Probe every upstream service over HTTP (in parallel)
  const entries = Object.entries(SERVICE_TARGETS);
  const probes = await Promise.all(entries.map(async ([name, url]) => {
    if (!url) return [name, { status: 'healthy', mode: 'in-process' }];
    const t0 = Date.now();
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      return [name, { status: r.ok ? 'healthy' : 'degraded', mode: 'http', latencyMs: Date.now() - t0 }];
    } catch (err) {
      return [name, { status: 'down', mode: 'http', error: err.message }];
    }
  }));
  const serviceDetails = Object.fromEntries(probes);
  const serviceStatuses = Object.fromEntries(probes.map(([n, d]) => [n, d.status]));

  // 2. Probe infrastructure (real connectivity checks, no hard-coded answers)
  const [dbHealth, redisHealth, rabbitHealth] = await Promise.all([
    db.isHealthy(), redisManager.isHealthy(), eventBus.isHealthy()
  ]);

  const allServicesHealthy = Object.values(serviceStatuses).every(st => st === 'healthy');
  const isOverallHealthy = allServicesHealthy && dbHealth && redisHealth && rabbitHealth;

  res.status(isOverallHealthy ? 200 : 503).json({
    gateway: 'healthy',
    status: isOverallHealthy ? 'healthy' : 'degraded',
    timestamp,
    services: serviceStatuses,
    serviceDetails,
    database: dbHealth ? 'healthy' : 'down',
    redis: redisHealth ? 'healthy' : 'down',
    rabbitmq: rabbitHealth ? 'healthy' : 'down',
    infrastructureMode: { postgres: db.mode, redis: redisManager.mode, rabbitmq: eventBus.mode },
    rateLimiter: {
      type: 'Token Bucket',
      capacity: rateLimiterConfig.capacity,
      refillRate: rateLimiterConfig.refillRate
    }
  });
});

// Rate limiter status & burst test endpoint for Live Demo
app.get('/api/ratelimit/status', (req, res) => {
  res.json({
    success: true,
    client: getClientId(req),
    algorithm: 'Token Bucket (Redis Lua)',
    capacity: rateLimiterConfig.capacity,
    refillRatePerSecond: rateLimiterConfig.refillRate,
    timeWindowSeconds: rateLimiterConfig.windowSeconds
  });
});

app.post('/api/ratelimit/reset', async (req, res) => {
  await redisManager.invalidate('ratelimit:*');
  res.json({ success: true, message: 'Rate limit token buckets reset for all clients' });
});

// ========================================================
// 4. ADMIN ANALYTICS & OVERVIEW ENDPOINT
// ========================================================

app.get('/api/admin/overview', async (req, res) => {
  try {
    let data;
    if (db.mode === 'postgres') {
      const { rows: [r] } = await db.query(`
        SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM restaurants) AS restaurants,
          (SELECT COUNT(*) FROM orders) AS orders,
          (SELECT COALESCE(SUM(total_amount), 0) FROM orders) AS revenue,
          (SELECT COUNT(*) FROM orders WHERE status NOT IN ('DELIVERED','CANCELLED')) AS pending,
          (SELECT COUNT(*) FROM kitchen_queues WHERE status IN ('PREPARING','WAITING')) AS active_kitchen,
          (SELECT COUNT(*) FROM delivery_assignments) AS deliveries`);
      data = {
        totalUsers: r.users, totalRestaurants: r.restaurants, totalOrders: r.orders,
        totalRevenue: Number(Number(r.revenue).toFixed(2)), pendingOrders: r.pending,
        activeKitchenOrders: r.active_kitchen, deliveryAssignments: r.deliveries
      };
    } else {
      const orders = await db.findMany('orders');
      const kitchens = await db.findMany('kitchen_queues');
      data = {
        totalUsers: (await db.findMany('users')).length,
        totalRestaurants: (await db.findMany('restaurants')).length,
        totalOrders: orders.length,
        totalRevenue: Number(orders.reduce((t, o) => t + (Number(o.total_amount) || 0), 0).toFixed(2)),
        pendingOrders: orders.filter(o => o.status !== 'DELIVERED' && o.status !== 'CANCELLED').length,
        activeKitchenOrders: kitchens.filter(k => k.status === 'PREPARING' || k.status === 'WAITING').length,
        deliveryAssignments: (await db.findMany('delivery_assignments')).length
      };
    }
    res.json({ success: true, data: { ...data, systemHealth: 'healthy' } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ========================================================
// 5. REVERSE PROXY ROUTING (SECTION 1 REQUIREMENT)
// Each path prefix is forwarded over HTTP to its own service container.
// ========================================================

for (const [prefix, name, modulePath] of ROUTES) {
  const url = SERVICE_TARGETS[name];
  if (url) {
    app.use(prefix, proxyTo(name, url));
  } else {
    // Single-process dev mode only: mount the service app in-process
    const { default: serviceApp } = await import(modulePath);
    app.use(prefix, (req, res, next) => {
      req.targetService = `${name}-service`;
      req.url = req.originalUrl;   // Express strips the mount path; the service defines full paths
      serviceApp(req, res, next);
    });
  }
}

// Root Gateway route & Static Frontend Serving
const FRONTEND_HTML = path.resolve('frontend/index.html');
function serveFrontend(res) {
  if (!fs.existsSync(FRONTEND_HTML)) return false;
  res.setHeader('Content-Type', 'text/html');
  res.send(fs.readFileSync(FRONTEND_HTML, 'utf8'));
  return true;
}

app.get('/', (req, res) => {
  if (req.headers.accept && req.headers.accept.includes('text/html') && serveFrontend(res)) return;

  res.json({
    name: 'Food Delivery & Kitchen Management API Gateway',
    version: '1.0.0',
    status: 'online',
    frontend: '/app',
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      restaurants: '/api/restaurants',
      orders: '/api/orders',
      kitchen: '/api/kitchen',
      payments: '/api/payments',
      delivery: '/api/delivery',
      notifications: '/api/notifications',
      adminOverview: '/api/admin/overview',
      rateLimitStatus: '/api/ratelimit/status'
    }
  });
});

app.get('/app', (req, res) => {
  if (!serveFrontend(res)) res.redirect('/');
});

// Unknown routes -> JSON 404
app.use((req, res) => res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` }));

export default app;

if (process.env.STANDALONE_GATEWAY === 'true') {
  startService({
    name: 'api-gateway', app, port: PORT,
    needs: { postgres: true, redis: true, rabbitmq: true }
  });
}
