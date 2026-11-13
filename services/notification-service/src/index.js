/**
 * Notification Microservice
 * Consumes events, persists notifications, and simulates Multi-Channel dispatch (SMS, Email, Push)
 */

import express from '../../../shared/expressAdapter.js';
import cors from '../../../shared/corsAdapter.js';
import { db } from '../../../database/db.js';
import { createLogger } from '../../../shared/logger.js';
import { startService } from '../../../shared/bootstrap.js';

const log = createLogger('notification-service');
const app = express();
const PORT = process.env.PORT_NOTIFICATION || 4007;

app.use(cors());
app.use(express.json());

// Health Check Endpoint
app.get('/health', async (req, res) => {
  const dbOk = await db.isHealthy();
  res.status(200).json({
    service: 'notification-service',
    status: dbOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString()
  });
});

// Send Notification (called by Workers or internal services)
app.post('/api/notifications', async (req, res) => {
  const { userId, title, message, channel = 'IN_APP' } = req.body;

  try {
    const record = await db.insert('notifications', {
      user_id: userId,
      title,
      message,
      channel,
      is_read: false
    });

    log.info(`[Notification Sent] [Channel: ${channel}] To: ${userId} - ${title}`);
    res.status(201).json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get User Notifications
app.get('/api/notifications/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const list = await db.findMany('notifications', { user_id: userId });
  list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ success: true, count: list.length, data: list });
});

// Mark Notification as read
app.patch('/api/notifications/:id/read', async (req, res) => {
  const updated = await db.update('notifications', req.params.id, { is_read: true });
  res.json({ success: true, data: updated });
});

export default app;

if (process.env.STANDALONE_SERVICE === 'true') {
  startService({ name: 'notification-service', app, port: PORT, needs: { postgres: true } });
}
