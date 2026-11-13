/**
 * Shared process bootstrap: connects ONLY the infrastructure a process needs,
 * waits for it with retries, and fails loudly if it never becomes available
 * (Docker's restart policy then retries the container).
 */
import { pathToFileURL } from 'node:url';
import { db } from '../database/db.js';
import { redisManager } from './redisClient.js';
import { eventBus } from './eventBus.js';
import { createLogger } from './logger.js';

/** True when `moduleUrl` is the file executed directly via `node file.js` */
export function isMain(moduleUrl) {
  return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(process.argv[1]).href;
}

export async function connectInfra({ postgres = false, redis = false, rabbitmq = false } = {}) {
  if (postgres) await db.connect();
  if (redis) await redisManager.connect();
  if (rabbitmq) await eventBus.connect();
}

export async function startService({ name, app, port, needs = {} }) {
  const log = createLogger(name);
  try {
    await connectInfra(needs);
  } catch (err) {
    log.error(`Cannot start ${name}: ${err.message}`);
    process.exit(1);
  }
  const server = app.listen(port, () => log.info(`${name} listening on port ${port}`));
  const shutdown = () => {
    log.info(`${name} shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}
