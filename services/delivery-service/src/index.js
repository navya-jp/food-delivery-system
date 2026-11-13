/**
 * Delivery Management Microservice
 * Delivery Partner Registration, Availability, Intelligent Rider Assignment Algorithm,
 * Tracking, Pickup & Delivery Confirmation
 */

import express from '../../../shared/expressAdapter.js';
import cors from '../../../shared/corsAdapter.js';
import { db } from '../../../database/db.js';
import { eventBus } from '../../../shared/eventBus.js';
import { ORDER_STATUS, QUEUES } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logger.js';
import { startService } from '../../../shared/bootstrap.js';

const log = createLogger('delivery-service');
const app = express();
const PORT = process.env.PORT_DELIVERY || 4006;

app.use(cors());
app.use(express.json());

// Health Check Endpoint
app.get('/health', async (req, res) => {
  const dbOk = await db.isHealthy();
  res.status(200).json({
    service: 'delivery-service',
    status: dbOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString()
  });
});

/**
 * ALGORITHM 6: Delivery Partner Assignment Algorithm
 * Score = w1 * (1 - Dist/MaxDist) + w2 * (1 - ActiveDeliveries/MaxDeliveries) + w3 * (Rating/5.0)
 */
function findBestDeliveryPartner(partners, restLat, restLon) {
  const availablePartners = partners.filter(p => p.is_available && p.active_deliveries < 3);
  if (availablePartners.length === 0) return null;

  const w1 = 0.50; // Distance weight
  const w2 = 0.30; // Workload weight
  const w3 = 0.20; // Rating weight

  const scored = availablePartners.map(p => {
    const lat = p.current_latitude || 23.1250;
    const lon = p.current_longitude || 72.5400;

    // Approximate distance in KM
    const dLat = (lat - restLat) * 111.0;
    const dLon = (lon - restLon) * 102.0;
    const distanceKm = Math.sqrt(dLat * dLat + dLon * dLon);

    const normDistance = Math.max(0, 1.0 - (distanceKm / 15.0)); // within 15km
    const normWorkload = Math.max(0, 1.0 - (p.active_deliveries / 3.0));
    const normRating = (Number(p.rating) || 4.5) / 5.0;

    const totalScore = (w1 * normDistance) + (w2 * normWorkload) + (w3 * normRating);

    return {
      partner: p,
      distanceKm: Number(distanceKm.toFixed(2)),
      score: Number(totalScore.toFixed(4))
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

// 1. Assign Delivery Partner to an Order
app.post('/api/delivery/assign', async (req, res) => {
  const { orderId } = req.body;

  try {
    const order = await db.findById('orders', orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const restaurant = await db.findById('restaurants', order.restaurant_id);
    const restLat = restaurant ? restaurant.latitude : 23.1250;
    const restLon = restaurant ? restaurant.longitude : 72.5400;

    const allPartners = await db.findMany('delivery_partners');
    const bestCandidate = findBestDeliveryPartner(allPartners, restLat, restLon);

    if (!bestCandidate) {
      log.warn(`No delivery partners available for order ${orderId}`);
      return res.status(503).json({
        success: false,
        message: 'No delivery partners currently available in this delivery zone'
      });
    }

    const { partner, distanceKm, score } = bestCandidate;

    // Create Assignment
    const assignment = await db.insert('delivery_assignments', {
      order_id: orderId,
      partner_id: partner.id,
      status: 'ASSIGNED',
      distance_km: distanceKm
    });

    // Update Partner Active Count
    await db.update('delivery_partners', partner.id, {
      active_deliveries: (partner.active_deliveries || 0) + 1
    });

    // Update Order Status to RIDER_ASSIGNED
    await db.update('orders', orderId, { status: ORDER_STATUS.RIDER_ASSIGNED });

    await db.insert('order_status_history', {
      order_id: orderId,
      from_status: order.status,
      to_status: ORDER_STATUS.RIDER_ASSIGNED,
      changed_by: partner.id,
      comments: `Delivery partner assigned. Match score: ${score}, Estimated distance: ${distanceKm} km`
    });

    log.info(`Assigned delivery partner ${partner.id} to order ${orderId}`, { score, distanceKm });
    res.json({
      success: true,
      message: 'Delivery partner assigned successfully',
      data: { assignment, partner, distanceKm, matchScore: score }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Rider Confirms Pickup (Transitions order to PICKED_UP -> OUT_FOR_DELIVERY)
app.post('/api/delivery/:assignmentId/pickup', async (req, res) => {
  const { assignmentId } = req.params;

  try {
    const assignment = await db.findById('delivery_assignments', assignmentId);
    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found' });

    await db.update('delivery_assignments', assignmentId, {
      status: 'PICKED_UP',
      pickup_time: new Date().toISOString()
    });

    // Update order status to PICKED_UP and then OUT_FOR_DELIVERY
    await db.update('orders', assignment.order_id, { status: ORDER_STATUS.OUT_FOR_DELIVERY });

    await db.insert('order_status_history', {
      order_id: assignment.order_id,
      from_status: ORDER_STATUS.RIDER_ASSIGNED,
      to_status: ORDER_STATUS.OUT_FOR_DELIVERY,
      changed_by: assignment.partner_id,
      comments: 'Delivery partner picked up food package. Order is out for delivery.'
    });

    log.info(`Order ${assignment.order_id} is OUT_FOR_DELIVERY`);
    res.json({ success: true, message: 'Order picked up and out for delivery' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Rider Confirms Delivery (Transitions order to DELIVERED)
app.post('/api/delivery/:assignmentId/deliver', async (req, res) => {
  const { assignmentId } = req.params;

  try {
    const assignment = await db.findById('delivery_assignments', assignmentId);
    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found' });

    await db.update('delivery_assignments', assignmentId, {
      status: 'DELIVERED',
      delivery_time: new Date().toISOString()
    });

    // Free rider active count
    const partner = await db.findById('delivery_partners', assignment.partner_id);
    if (partner) {
      await db.update('delivery_partners', partner.id, {
        active_deliveries: Math.max(0, (partner.active_deliveries || 1) - 1)
      });
    }

    // Update order status to DELIVERED
    await db.update('orders', assignment.order_id, { status: ORDER_STATUS.DELIVERED });

    await db.insert('order_status_history', {
      order_id: assignment.order_id,
      from_status: ORDER_STATUS.OUT_FOR_DELIVERY,
      to_status: ORDER_STATUS.DELIVERED,
      changed_by: assignment.partner_id,
      comments: 'Order delivered safely to customer address.'
    });

    log.info(`Order ${assignment.order_id} DELIVERED successfully! Lifecycle completed.`);
    res.json({ success: true, message: 'Order marked delivered successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Delivery Dashboard: List active partner deliveries
app.get('/api/delivery/dashboard', async (req, res) => {
  const { partnerId = 'rider_alex_1' } = req.query;

  const partner = await db.findById('delivery_partners', partnerId);
  const assignments = await db.findMany('delivery_assignments', { partner_id: partnerId });

  const enrichedAssignments = [];
  for (const a of assignments) {
    const order = await db.findById('orders', a.order_id);
    const restaurant = order ? await db.findById('restaurants', order.restaurant_id) : null;
    const address = order ? await db.findById('addresses', order.delivery_address_id) : null;
    enrichedAssignments.push({
      ...a,
      order,
      restaurant,
      deliveryAddress: address
    });
  }

  res.json({
    success: true,
    data: {
      partner,
      assignments: enrichedAssignments
    }
  });
});

export default app;

if (process.env.STANDALONE_SERVICE === 'true') {
  startService({ name: 'delivery-service', app, port: PORT, needs: { postgres: true, rabbitmq: true } });
}
