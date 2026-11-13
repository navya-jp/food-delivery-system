/**
 * Background Order Processing Worker
 * Subscribes to RabbitMQ queues, asynchronously processes order tasks,
 * routes to kitchen queues, updates PostgreSQL database, and handles retries/DLQ
 */

import { eventBus } from '../../../shared/eventBus.js';
import { db } from '../../../database/db.js';
import { QUEUES, ORDER_STATUS } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logger.js';
import { isMain, connectInfra } from '../../../shared/bootstrap.js';

const log = createLogger('order-worker');

export async function startOrderWorker() {
  log.info('Starting Background Order Worker service...');

  // Subscribe to ORDER_CREATED queue
  await eventBus.subscribe(QUEUES.ORDER_CREATED, async (data, { ack, nack }) => {
    const { orderId, userId, restaurantId, totalAmount, paymentMethod } = data;
    log.info(`[Worker:Order] Received task for Order: ${orderId}`, { totalAmount, paymentMethod });

    try {
      // 1. Record Background Task in Database
      const taskRecord = await db.insert('background_tasks', {
        task_name: 'PROCESS_NEW_ORDER',
        payload: data,
        status: 'PROCESSING'
      });

      // 2. Simulate Async Work (e.g. inventory verification, kitchen routing)
      await new Promise(r => setTimeout(r, 600));

      // 3. Update Database: Enqueue into Kitchen
      let kitchen = await db.findOne('kitchens', { restaurant_id: restaurantId });
      if (!kitchen) {
        kitchen = await db.insert('kitchens', {
          restaurant_id: restaurantId,
          capacity: 12,
          current_active_orders: 1,
          is_accepting_orders: true
        });
      }

      await db.insert('kitchen_queues', {
        kitchen_id: kitchen.id,
        order_id: orderId,
        priority: 1,
        progress_percentage: 0,
        status: 'WAITING'
      });

      // If COD or paid, transition order to PLACED
      const currentOrder = await db.findById('orders', orderId);
      if (currentOrder && currentOrder.status === ORDER_STATUS.CREATED) {
        await db.update('orders', orderId, { status: ORDER_STATUS.PLACED });
        await db.insert('order_status_history', {
          order_id: orderId,
          from_status: ORDER_STATUS.CREATED,
          to_status: ORDER_STATUS.PLACED,
          changed_by: 'background_order_worker',
          comments: 'Worker verified order and routed to kitchen queue'
        });
      }

      // 4. Update Background Task in Database to COMPLETED
      await db.update('background_tasks', taskRecord.id, {
        status: 'COMPLETED',
        processed_at: new Date().toISOString()
      });

      // 5. Emit Notification Task to Notification Queue
      await eventBus.publish(QUEUES.NOTIFICATIONS, {
        userId,
        title: 'Order Confirmed!',
        message: `Your order #${orderId.slice(-6)} of Rs. ${totalAmount} has been placed and received by the kitchen.`,
        channel: 'IN_APP'
      });

      log.info(`[Worker:Order] Finished processing task for Order: ${orderId}. Database updated.`);
      ack();
    } catch (err) {
      log.error(`[Worker:Order Error] Failed processing order ${orderId}:`, { error: err.message });
      nack(true); // Requeue with exponential backoff
    }
  });

  // Subscribe to DELIVERY_ASSIGNMENTS queue
  await eventBus.subscribe(QUEUES.DELIVERY_ASSIGNMENTS, async (data, { ack, nack }) => {
    const { orderId } = data;
    log.info(`[Worker:Delivery] Processing asynchronous rider auto-assignment for Order: ${orderId}`);

    try {
      // Find available delivery partner
      const partners = await db.findMany('delivery_partners', p => p.is_available && p.active_deliveries < 3);
      if (partners.length > 0) {
        const partner = partners[0];
        await db.insert('delivery_assignments', {
          order_id: orderId,
          partner_id: partner.id,
          status: 'ASSIGNED',
          distance_km: 2.5
        });

        await db.update('delivery_partners', partner.id, {
          active_deliveries: (partner.active_deliveries || 0) + 1
        });

        await db.update('orders', orderId, { status: ORDER_STATUS.RIDER_ASSIGNED });
        log.info(`[Worker:Delivery] Assigned Rider ${partner.id} to Order ${orderId}`);
      }
      ack();
    } catch (e) {
      nack(false);
    }
  });

  log.info('Order Worker active and listening to RabbitMQ queues.');
}

if (isMain(import.meta.url)) {
  // Standalone worker container: connect to real PostgreSQL + RabbitMQ, then consume
  (async () => {
    try {
      await connectInfra({ postgres: true, rabbitmq: true });
      await startOrderWorker();
    } catch (err) {
      log.error(`Cannot start order worker: ${err.message}`);
      process.exit(1);
    }
  })();
}
