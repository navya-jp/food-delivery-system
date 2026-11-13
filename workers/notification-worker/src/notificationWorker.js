/**
 * Background Notification Worker
 * Consumes notification messages from RabbitMQ and updates PostgreSQL database
 */

import { eventBus } from '../../../shared/eventBus.js';
import { db } from '../../../database/db.js';
import { QUEUES } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logger.js';
import { isMain, connectInfra } from '../../../shared/bootstrap.js';

const log = createLogger('notification-worker');

export async function startNotificationWorker() {
  log.info('Starting Background Notification Worker service...');

  await eventBus.subscribe(QUEUES.NOTIFICATIONS, async (data, { ack, nack }) => {
    const { userId, title, message, channel = 'IN_APP' } = data;
    log.info(`[Worker:Notification] Processing notification for User: ${userId}`, { title, channel });

    try {
      // 1. Insert into persistent notifications table
      await db.insert('notifications', {
        user_id: userId,
        title,
        message,
        channel,
        is_read: false
      });

      // 2. Simulate external dispatch latency (e.g. Twilio / SendGrid)
      await new Promise(r => setTimeout(r, 200));

      log.info(`[Worker:Notification] Dispatched and recorded notification for ${userId}`);
      ack();
    } catch (err) {
      log.error('[Worker:Notification Error]', { error: err.message });
      nack(false); // Move to DLQ
    }
  });

  log.info('Notification Worker active and listening to RabbitMQ queues.');
}

if (isMain(import.meta.url)) {
  (async () => {
    try {
      await connectInfra({ postgres: true, rabbitmq: true });
      await startNotificationWorker();
    } catch (err) {
      log.error(`Cannot start notification worker: ${err.message}`);
      process.exit(1);
    }
  })();
}
