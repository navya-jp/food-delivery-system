/**
 * Primary Unified Server Launcher
 * Initializes database, connects Redis & RabbitMQ, launches background workers,
 * and starts the API Gateway.
 */

import gatewayApp, { rateLimiterConfig } from './api-gateway/src/index.js';
import { db } from './database/db.js';
import { seedDatabase } from './database/seed/seed.js';
import { redisManager } from './shared/redisClient.js';
import { eventBus } from './shared/eventBus.js';
import { startOrderWorker } from './workers/order-worker/src/orderWorker.js';
import { startNotificationWorker } from './workers/notification-worker/src/notificationWorker.js';
import { createLogger } from './shared/logger.js';

const log = createLogger('server');
const PORT = process.env.PORT_GATEWAY || 8080;

async function bootstrap() {
  console.log('================================================================');
  console.log('  FOOD DELIVERY ORDER AND KITCHEN MANAGEMENT SYSTEM');
  console.log('  Distributed Systems & Microservices Architecture');
  console.log('================================================================');

  // 1. Initialize Database & Seed
  log.info('1. Initializing database and verifying schema...');
  await db.connect();
  const existingUsers = await db.findMany('users');
  if (existingUsers.length === 0) {
    log.info('Seeding database with initial demo data...');
    await seedDatabase();
  } else {
    log.info(`Database already populated with ${existingUsers.length} users.`);
  }

  // 2. Connect Redis
  log.info('2. Connecting to Redis cache and rate-limiter store...');
  await redisManager.connect();

  // 3. Connect RabbitMQ
  log.info('3. Connecting to RabbitMQ message broker...');
  await eventBus.connect();

  // 4. Start Background Workers
  log.info('4. Starting asynchronous background workers...');
  await startOrderWorker();
  await startNotificationWorker();

  // 5. Start API Gateway
  gatewayApp.listen(PORT, () => {
    console.log('================================================================');
    console.log(`🚀 API GATEWAY IS ONLINE AT: http://localhost:${PORT}`);
    console.log(`💚 Health Check Endpoint:     http://localhost:${PORT}/health`);
    console.log(`📊 Admin Overview:           http://localhost:${PORT}/api/admin/overview`);
    console.log(`🍔 Restaurants & Menu:       http://localhost:${PORT}/api/restaurants`);
    console.log(`📦 Orders API:               http://localhost:${PORT}/api/orders`);
    console.log(`🍳 Kitchen Queue API:        http://localhost:${PORT}/api/kitchen/dashboard`);
    console.log(`💳 Payments & CircuitBreak:  http://localhost:${PORT}/api/payments/circuit-breaker/status`);
    console.log(`🛵 Delivery Dispatch:        http://localhost:${PORT}/api/delivery/dashboard`);
    console.log(`⚡ Rate Limit Token Bucket:  Capacity: ${rateLimiterConfig.capacity}, Refill: ${rateLimiterConfig.refillRate}/sec`);
    console.log('================================================================');
    console.log('Demo Login Credentials:');
    console.log('  • Admin:      admin@fooddelivery.com     / admin123');
    console.log('  • Customer:   customer@fooddelivery.com  / customer123');
    console.log('  • Restaurant: owner@fooddelivery.com     / owner123');
    console.log('  • Kitchen:    kitchen@fooddelivery.com   / chef123');
    console.log('  • Delivery:   rider@fooddelivery.com     / rider123');
    console.log('================================================================');
  });
}

bootstrap().catch(err => {
  log.error('Fatal bootstrapping error:', { error: err.message, stack: err.stack });
  process.exit(1);
});
