/**
 * Order Management Microservice
 * Full Lifecycle State Machine, Idempotency Management,
 * Database Transactions, and Asynchronous RabbitMQ Publishing
 */

import express from '../../../shared/expressAdapter.js';
import cors from '../../../shared/corsAdapter.js';
import { db } from '../../../database/db.js';
import { eventBus } from '../../../shared/eventBus.js';
import { ORDER_STATUS, VALID_ORDER_TRANSITIONS, QUEUES, PAYMENT_METHODS } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logger.js';
import { startService } from '../../../shared/bootstrap.js';

const log = createLogger('order-service');
const app = express();
const PORT = process.env.PORT_ORDER || 4003;

app.use(cors());
app.use(express.json());

// Health Check Endpoint
app.get('/health', async (req, res) => {
  const dbOk = await db.isHealthy();
  const mqOk = await eventBus.isHealthy();
  res.status(200).json({
    service: 'order-service',
    status: dbOk && mqOk ? 'healthy' : 'degraded',
    database: dbOk ? 'healthy' : 'down',
    messageBroker: mqOk ? 'healthy' : 'down',
    timestamp: new Date().toISOString()
  });
});

/**
 * ALGORITHM 8: Food Availability Validation
 */
async function validateFoodAvailability(items) {
  for (const item of items) {
    const menuItem = await db.findById('menu_items', item.menu_item_id);
    if (!menuItem) {
      throw new Error(`Menu item not found: ${item.menu_item_id}`);
    }
    if (!menuItem.is_available) {
      throw new Error(`Item "${menuItem.name}" is currently sold out / unavailable`);
    }
  }
}

/**
 * ALGORITHM 9: Order Price Calculation
 */
function calculateOrderTotals(itemsWithDetails, couponCode = null) {
  let subtotal = 0;
  for (const item of itemsWithDetails) {
    subtotal += item.price * item.quantity;
  }

  const tax = Number((subtotal * 0.05).toFixed(2)); // 5% GST/VAT
  const deliveryFee = subtotal > 500 ? 0.00 : 40.00; // Free delivery over 500
  let discount = 0.00;

  if (couponCode && couponCode.toUpperCase() === 'WELCOME50') {
    discount = Math.min(100.00, subtotal * 0.20); // 20% off up to 100
  }

  const totalAmount = Number((subtotal + tax + deliveryFee - discount).toFixed(2));

  return { subtotal, tax, deliveryFee, discount, totalAmount };
}

// 1. Create Order (Atomically with Transaction & Idempotency Key)
app.post('/api/orders', async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || `req_${Date.now()}`;
  const idempotencyKey = req.headers['x-idempotency-key'] || req.body.idempotency_key;

  try {
    const {
      user_id = 'usr_customer_1',
      restaurant_id,
      delivery_address_id = 'addr_cust_1',
      items, // [{ menu_item_id, quantity, special_instructions }]
      payment_method = PAYMENT_METHODS.ONLINE_SIMULATED,
      special_instructions = '',
      coupon_code = null
    } = req.body;

    if (!restaurant_id || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid order payload: items and restaurant required' });
    }

    // IDEMPOTENCY CHECK: Prevent duplicate order placement
    if (idempotencyKey) {
      const existingOrder = await db.findOne('orders', { idempotency_key: idempotencyKey });
      if (existingOrder) {
        log.warn('Idempotent duplicate request intercepted. Returning cached order', {
          idempotencyKey,
          orderId: existingOrder.id
        });
        const orderItems = await db.findMany('order_items', { order_id: existingOrder.id });
        return res.status(200).json({
          success: true,
          message: 'Order already processed (Idempotent response)',
          data: { ...existingOrder, items: orderItems }
        });
      }
    }

    // 1. Validate food availability (Algorithm 8)
    await validateFoodAvailability(items);

    // 2. Fetch price details and compute totals (Algorithm 9)
    const itemsWithDetails = [];
    let maxPrepTime = 15;

    for (const it of items) {
      const menuItem = await db.findById('menu_items', it.menu_item_id);
      itemsWithDetails.push({
        menu_item_id: it.menu_item_id,
        name: menuItem.name,
        price: Number(menuItem.price),
        quantity: it.quantity,
        special_instructions: it.special_instructions || '',
        prep_time_minutes: menuItem.prep_time_minutes || 15
      });
      if (menuItem.prep_time_minutes > maxPrepTime) {
        maxPrepTime = menuItem.prep_time_minutes;
      }
    }

    const { subtotal, tax, deliveryFee, discount, totalAmount } = calculateOrderTotals(itemsWithDetails, coupon_code);

    // 3. Atomically create Order in Transaction
    const order = await db.withTransaction(async () => {
      const initialStatus = payment_method === PAYMENT_METHODS.CASH_ON_DELIVERY
        ? ORDER_STATUS.PLACED
        : ORDER_STATUS.PAYMENT_PENDING;

      const newOrder = await db.insert('orders', {
        id: `ord_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        idempotency_key: idempotencyKey || null,
        user_id,
        restaurant_id,
        delivery_address_id,
        subtotal,
        tax,
        delivery_fee: deliveryFee,
        discount,
        total_amount: totalAmount,
        payment_method,
        status: initialStatus,
        estimated_prep_time: maxPrepTime,
        special_instructions
      });

      // Insert Order Items
      for (const item of itemsWithDetails) {
        await db.insert('order_items', {
          order_id: newOrder.id,
          menu_item_id: item.menu_item_id,
          item_name: item.name,
          quantity: item.quantity,
          unit_price: item.price,
          total_price: Number((item.price * item.quantity).toFixed(2)),
          special_instructions: item.special_instructions
        });
      }

      // Record Order Status History
      await db.insert('order_status_history', {
        order_id: newOrder.id,
        from_status: null,
        to_status: initialStatus,
        changed_by: user_id,
        comments: 'Order created via checkout'
      });

      // Log transaction
      await db.logTransaction({
        correlationId,
        entityType: 'ORDER',
        entityId: newOrder.id,
        action: 'ORDER_CREATED',
        oldState: null,
        newState: newOrder,
        performedBy: user_id
      });

      return newOrder;
    });

    // 4. Asynchronous Queue Publishing: Push task to RabbitMQ
    await eventBus.publish(QUEUES.ORDER_CREATED, {
      orderId: order.id,
      userId: order.user_id,
      restaurantId: order.restaurant_id,
      totalAmount: order.total_amount,
      paymentMethod: order.payment_method,
      status: order.status
    }, { correlationId });

    log.info('Order placed successfully & event published to RabbitMQ', {
      orderId: order.id,
      totalAmount: order.total_amount,
      status: order.status
    });

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: {
        ...order,
        items: itemsWithDetails
      }
    });
  } catch (err) {
    log.error('Failed to create order:', { error: err.message });
    res.status(400).json({ success: false, message: err.message });
  }
});

// 2. Transition Order Status (Strict State Machine Matrix)
app.patch('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status: nextStatus, comments = '', changedBy = 'system' } = req.body;

  try {
    const order = await db.findById('orders', id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const currentStatus = order.status;
    const allowedNextStatuses = VALID_ORDER_TRANSITIONS[currentStatus] || [];

    // Enforce valid transitions
    if (!allowedNextStatuses.includes(nextStatus)) {
      return res.status(400).json({
        success: false,
        message: `Invalid state transition from [${currentStatus}] to [${nextStatus}]. Allowed transitions: [${allowedNextStatuses.join(', ')}]`
      });
    }

    // Atomically update order and record history
    const updated = await db.withTransaction(async () => {
      const updatedOrder = await db.update('orders', id, { status: nextStatus });

      await db.insert('order_status_history', {
        order_id: id,
        from_status: currentStatus,
        to_status: nextStatus,
        changed_by: changedBy,
        comments
      });

      await db.logTransaction({
        entityType: 'ORDER',
        entityId: id,
        action: `STATUS_CHANGE_${nextStatus}`,
        oldState: { status: currentStatus },
        newState: { status: nextStatus },
        performedBy: changedBy
      });

      return updatedOrder;
    });

    // Notify RabbitMQ of state transition
    await eventBus.publish(QUEUES.ORDER_STATUS_CHANGED, {
      orderId: id,
      fromStatus: currentStatus,
      toStatus: nextStatus,
      comments
    });

    log.info(`Order state transitioned: [${currentStatus}] -> [${nextStatus}]`, { orderId: id });
    res.json({
      success: true,
      message: `Order transitioned to ${nextStatus}`,
      data: updated
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Get Order Details & Tracking History
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await db.findById('orders', req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const items = await db.findMany('order_items', { order_id: order.id });
    const history = await db.findMany('order_status_history', { order_id: order.id });
    const restaurant = await db.findById('restaurants', order.restaurant_id);
    const address = await db.findById('addresses', order.delivery_address_id);
    const kitchenQueue = await db.findOne('kitchen_queues', { order_id: order.id });
    const deliveryAssignment = await db.findOne('delivery_assignments', { order_id: order.id });

    res.json({
      success: true,
      data: {
        ...order,
        restaurant,
        deliveryAddress: address,
        items,
        history,
        kitchenStatus: kitchenQueue ? kitchenQueue.status : null,
        deliveryStatus: deliveryAssignment ? deliveryAssignment.status : null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. List Orders (Customer order history or restaurant orders)
app.get('/api/orders', async (req, res) => {
  const { userId, restaurantId, status } = req.query;
  let orders = await db.findMany('orders', o => {
    if (userId && o.user_id !== userId) return false;
    if (restaurantId && o.restaurant_id !== restaurantId) return false;
    if (status && o.status !== status) return false;
    return true;
  });

  // Sort descending by creation date
  orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({ success: true, count: orders.length, data: orders });
});

export default app;

if (process.env.STANDALONE_SERVICE === 'true') {
  startService({ name: 'order-service', app, port: PORT, needs: { postgres: true, rabbitmq: true } });
}
