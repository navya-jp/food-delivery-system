/**
 * Kitchen Management Microservice
 * Concurrency Control, Atomic Locking, Workload & Capacity Tracking,
 * Order Prioritization, and Preparation Time Estimation Algorithms
 */

import express from '../../../shared/expressAdapter.js';
import cors from '../../../shared/corsAdapter.js';
import { db } from '../../../database/db.js';
import { eventBus } from '../../../shared/eventBus.js';
import { ORDER_STATUS, QUEUES } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logger.js';
import { startService } from '../../../shared/bootstrap.js';

const log = createLogger('kitchen-service');
const app = express();
const PORT = process.env.PORT_KITCHEN || 4004;

app.use(cors());
app.use(express.json());

// Health Check Endpoint
app.get('/health', async (req, res) => {
  const dbOk = await db.isHealthy();
  res.status(200).json({
    service: 'kitchen-service',
    status: dbOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString()
  });
});

/**
 * ALGORITHM 5: Kitchen Order Prioritization
 * Weighted Score = (PriorityLevel * 100) + (WaitingMinutes * 2) - (PrepComplexityMin * 0.5)
 */
function prioritizeKitchenQueue(queueEntries) {
  const now = Date.now();
  return queueEntries.map(entry => {
    const waitingMinutes = Math.max(0, (now - new Date(entry.created_at).getTime()) / 60000);
    const priorityWeight = (entry.priority || 1) * 100;
    const score = priorityWeight + (waitingMinutes * 2.5);
    return {
      ...entry,
      priorityScore: Number(score.toFixed(2)),
      waitingMinutes: Math.round(waitingMinutes)
    };
  }).sort((a, b) => b.priorityScore - a.priorityScore);
}

/**
 * ALGORITHM 10: Preparation Time Estimation
 * TotalEstimatedTime = Max(item.prep_time) + (ActiveQueueCount / KitchenCookCapacity) * Buffer
 */
async function estimatePreparationTime(orderId, kitchenId) {
  const kitchen = await db.findById('kitchens', kitchenId);
  const orderItems = await db.findMany('order_items', { order_id: orderId });

  let maxItemPrepTime = 12;
  for (const oi of orderItems) {
    const menuItem = await db.findById('menu_items', oi.menu_item_id);
    if (menuItem && menuItem.prep_time_minutes > maxItemPrepTime) {
      maxItemPrepTime = menuItem.prep_time_minutes;
    }
  }

  const activeOrders = kitchen ? kitchen.current_active_orders : 2;
  const capacity = kitchen ? kitchen.capacity : 10;
  const backlogFactor = Math.max(0, (activeOrders / capacity) * 5);

  return Math.round(maxItemPrepTime + backlogFactor);
}

// 1. Get Kitchen Dashboard Data (Queue, Active Orders, Workload & Capacity)
app.get('/api/kitchen/dashboard', async (req, res) => {
  const { restaurantId } = req.query;

  try {
    // With ?restaurantId= show that restaurant's kitchen. Without it (the demo "Kitchen" tab)
    // show every kitchen together, so orders for any restaurant appear.
    const kitchens = restaurantId
      ? await db.findMany('kitchens', { restaurant_id: restaurantId })
      : await db.findMany('kitchens');
    const totalCapacity = kitchens.reduce((sum, k) => sum + (k.capacity || 0), 0);
    const activeKitchen = restaurantId
      ? (kitchens[0] || { capacity: 12, current_active_orders: 0 })
      : { ...(kitchens[0] || {}), id: undefined, capacity: totalCapacity || 12, current_active_orders: kitchens.reduce((sum, k) => sum + (k.current_active_orders || 0), 0) };

    // Fetch kitchen queue entries
    const kitchenIds = new Set(kitchens.map(k => k.id));
    const queue = (await db.findMany('kitchen_queues')).filter(kq => kitchenIds.has(kq.kitchen_id));

    // Populate order details & items
    const enrichedQueue = [];
    for (const entry of queue) {
      const order = await db.findById('orders', entry.order_id);
      if (order && order.status !== ORDER_STATUS.DELIVERED && order.status !== ORDER_STATUS.CANCELLED) {
        const items = await db.findMany('order_items', { order_id: order.id });
        enrichedQueue.push({
          ...entry,
          order,
          items
        });
      }
    }

    // Apply Prioritization Algorithm (Algorithm 5)
    const prioritized = prioritizeKitchenQueue(enrichedQueue);

    const pendingCount = prioritized.filter(q => q.status === 'WAITING').length;
    const preparingCount = prioritized.filter(q => q.status === 'PREPARING').length;
    const readyCount = prioritized.filter(q => q.status === 'READY').length;

    res.json({
      success: true,
      data: {
        kitchen: activeKitchen,
        workloadPercentage: Math.min(100, Math.round((preparingCount / (activeKitchen.capacity || 10)) * 100)),
        capacity: activeKitchen.capacity || 12,
        activeOrdersCount: preparingCount,
        stats: {
          pending: pendingCount,
          preparing: preparingCount,
          ready: readyCount,
          totalInQueue: prioritized.length
        },
        queue: prioritized
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Accept Order into Kitchen Queue
app.post('/api/kitchen/orders/:orderId/accept', async (req, res) => {
  const { orderId } = req.params;
  const { priority = 1, cookName = 'Chef Gordon' } = req.body;

  try {
    const order = await db.findById('orders', orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    let kitchen = await db.findOne('kitchens', { restaurant_id: order.restaurant_id });
    if (!kitchen) {
      kitchen = await db.insert('kitchens', {
        restaurant_id: order.restaurant_id,
        capacity: 12,
        current_active_orders: 1,
        is_accepting_orders: true
      });
    }

    const estimatedTime = await estimatePreparationTime(orderId, kitchen.id);

    // Check if already in queue
    let queueEntry = await db.findOne('kitchen_queues', { order_id: orderId });
    if (!queueEntry) {
      queueEntry = await db.insert('kitchen_queues', {
        kitchen_id: kitchen.id,
        order_id: orderId,
        priority: Number(priority),
        progress_percentage: 0,
        assigned_cook: cookName,
        status: 'WAITING'
      });
    }

    // Update order status to RESTAURANT_ACCEPTED
    await db.update('orders', orderId, {
      status: ORDER_STATUS.RESTAURANT_ACCEPTED,
      estimated_prep_time: estimatedTime
    });

    await db.insert('order_status_history', {
      order_id: orderId,
      from_status: order.status,
      to_status: ORDER_STATUS.RESTAURANT_ACCEPTED,
      changed_by: cookName,
      comments: `Order accepted by kitchen. Estimated preparation time: ${estimatedTime} mins`
    });

    log.info('Kitchen accepted order', { orderId, estimatedTime });
    res.json({
      success: true,
      message: 'Order accepted into kitchen queue',
      data: { queueEntry, estimatedTime }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Start Preparation with Atomic Concurrency Lock
// Prevents two kitchen workers from claiming or cooking the same order simultaneously!
app.post('/api/kitchen/orders/:orderId/start-prep', async (req, res) => {
  const { orderId } = req.params;
  const { cookId = 'cook_1', cookName = 'Chef Gordon' } = req.body;

  try {
    const queueEntry = await db.findOne('kitchen_queues', { order_id: orderId });
    if (!queueEntry) {
      return res.status(404).json({ success: false, message: 'Order not present in kitchen queue' });
    }

    const now = Date.now();

    // ATOMIC LOCK: one compare-and-set UPDATE. It succeeds only if the order is unlocked,
    // already held by this same cook, or the previous lock has expired. Two concurrent
    // cooks can never both pass this check (no read-then-write race).
    const lockDurationMs = 15 * 60 * 1000;
    const lockedUntil = new Date(now + lockDurationMs).toISOString();

    const updatedQueue = await db.updateIf('kitchen_queues', queueEntry.id, {
      status: 'PREPARING',
      locked_by: cookId,
      locked_until: lockedUntil,
      assigned_cook: cookName,
      progress_percentage: 15,
      started_at: new Date().toISOString()
    }, {
      sqlCondition: 'locked_by IS NULL OR locked_by = $1 OR locked_until IS NULL OR locked_until < NOW()',
      condParams: [cookId],
      predicate: (row) => !row.locked_by || row.locked_by === cookId ||
        !row.locked_until || new Date(row.locked_until).getTime() <= now
    });

    if (!updatedQueue) {
      const current = await db.findById('kitchen_queues', queueEntry.id);
      log.warn(`[Concurrency Conflict] Order ${orderId} already locked by ${current?.locked_by}`);
      return res.status(409).json({
        success: false,
        message: `Order is already being processed by cook: ${current?.locked_by}`,
        lockedBy: current?.locked_by,
        lockedUntil: current?.locked_until
      });
    }

    // Update order status to PREPARING
    await db.update('orders', orderId, { status: ORDER_STATUS.PREPARING });

    await db.insert('order_status_history', {
      order_id: orderId,
      from_status: ORDER_STATUS.RESTAURANT_ACCEPTED,
      to_status: ORDER_STATUS.PREPARING,
      changed_by: cookName,
      comments: `Cook ${cookName} acquired atomic lock and started food preparation.`
    });

    log.info(`[Atomic Lock Acquired] Cook ${cookName} locked order ${orderId}`, { lockedUntil });
    res.json({
      success: true,
      message: 'Preparation started and order locked exclusively',
      data: updatedQueue
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Update Preparation Progress (e.g., 25%, 50%, 75%, 100%)
app.patch('/api/kitchen/orders/:orderId/progress', async (req, res) => {
  const { orderId } = req.params;
  const { progress } = req.body;

  try {
    const queueEntry = await db.findOne('kitchen_queues', { order_id: orderId });
    if (!queueEntry) return res.status(404).json({ success: false, message: 'Queue item not found' });

    const newProgress = Math.min(100, Math.max(0, Number(progress)));
    const updated = await db.update('kitchen_queues', queueEntry.id, {
      progress_percentage: newProgress
    });

    res.json({ success: true, message: `Progress updated to ${newProgress}%`, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Mark Order Ready for Pickup
app.post('/api/kitchen/orders/:orderId/mark-ready', async (req, res) => {
  const { orderId } = req.params;

  try {
    const queueEntry = await db.findOne('kitchen_queues', { order_id: orderId });
    if (!queueEntry) return res.status(404).json({ success: false, message: 'Queue item not found' });

    // Release lock and mark READY
    const updated = await db.update('kitchen_queues', queueEntry.id, {
      status: 'READY',
      progress_percentage: 100,
      locked_by: null,
      locked_until: null,
      completed_at: new Date().toISOString()
    });

    // Update order status to READY_FOR_PICKUP
    await db.update('orders', orderId, { status: ORDER_STATUS.READY_FOR_PICKUP });

    await db.insert('order_status_history', {
      order_id: orderId,
      from_status: ORDER_STATUS.PREPARING,
      to_status: ORDER_STATUS.READY_FOR_PICKUP,
      changed_by: queueEntry.assigned_cook || 'Kitchen',
      comments: 'Order cooked and packaged. Ready for rider pickup.'
    });

    // Publish event for Delivery assignment
    await eventBus.publish(QUEUES.DELIVERY_ASSIGNMENTS, {
      orderId,
      restaurantId: queueEntry.kitchen_id
    });

    log.info(`Order ${orderId} marked READY_FOR_PICKUP. Delivery assignment dispatched.`);
    res.json({
      success: true,
      message: 'Order marked ready for pickup',
      data: updated
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default app;

if (process.env.STANDALONE_SERVICE === 'true') {
  startService({ name: 'kitchen-service', app, port: PORT, needs: { postgres: true, rabbitmq: true } });
}
