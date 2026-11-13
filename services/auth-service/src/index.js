/**
 * Authentication Microservice
 * Handles User registration, JWT Authentication, Roles, and Profiles
 */

import express from '../../../shared/expressAdapter.js';
import cors from '../../../shared/corsAdapter.js';
import { db } from '../../../database/db.js';
import { ROLES } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logger.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from '../../../shared/auth.js';
import { startService } from '../../../shared/bootstrap.js';

const log = createLogger('auth-service');
const app = express();
const PORT = process.env.PORT_AUTH || 4001;

app.use(cors());
app.use(express.json());

const generateToken = signToken;
export { verifyToken };

// Health Check Endpoint
app.get('/health', async (req, res) => {
  const dbOk = await db.isHealthy();
  res.status(200).json({
    service: 'auth-service',
    status: dbOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString()
  });
});

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    // Self-registration always creates a CUSTOMER; privileged roles must never be client-selectable
    const { name, email, password, phone } = req.body;
    const role = ROLES.CUSTOMER;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email and password are required' });
    }

    const existing = await db.findOne('users', u => u.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      return res.status(409).json({ success: false, message: 'User with this email already exists' });
    }

    const newUser = await db.withTransaction(async () => {
      const created = await db.insert('users', {
        name,
        email: email.toLowerCase(),
        password_hash: hashPassword(password),
        phone: phone || ''
      });
      await db.insert('user_roles', { user_id: created.id, role_id: `role_${role.toLowerCase()}` });
      return created;
    });

    const token = generateToken({ userId: newUser.id, email: newUser.email, role });

    log.info('User registered successfully', { userId: newUser.id, email: newUser.email, role });
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        token,
        user: { id: newUser.id, name: newUser.name, email: newUser.email, role, phone: newUser.phone }
      }
    });
  } catch (err) {
    log.error('Registration failed:', { error: err.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await db.findOne('users', u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const isMatch = verifyPassword(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const userRole = await db.findOne('user_roles', { user_id: user.id });
    const role = userRole ? userRole.role_id.replace('role_', '').toUpperCase() : ROLES.CUSTOMER;

    const token = generateToken({ userId: user.id, email: user.email, role });

    log.info('User logged in successfully', { userId: user.id, email: user.email, role });
    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: { id: user.id, name: user.name, email: user.email, role, phone: user.phone }
      }
    });
  } catch (err) {
    log.error('Login error:', { error: err.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get Current User Profile
app.get('/api/auth/profile', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Authorization header missing' });

  const token = authHeader.replace('Bearer ', '');
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ success: false, message: 'Invalid or expired token' });

  const user = await db.findById('users', decoded.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const addresses = await db.findMany('addresses', { user_id: user.id });

  res.status(200).json({
    success: true,
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: decoded.role,
      addresses
    }
  });
});

// Customer Addresses
app.get('/api/auth/addresses', async (req, res) => {
  const userId = req.query.userId || 'usr_customer_1';
  const addresses = await db.findMany('addresses', { user_id: userId });
  res.json({ success: true, data: addresses });
});

app.post('/api/auth/addresses', async (req, res) => {
  const { userId = 'usr_customer_1', title, street, city, postal_code, latitude, longitude } = req.body;
  const address = await db.insert('addresses', {
    user_id: userId,
    title: title || 'Home',
    street,
    city,
    postal_code,
    latitude: latitude || 23.1293,
    longitude: longitude || 72.5448,
    is_default: false
  });
  res.status(201).json({ success: true, data: address });
});

// Demo accounts endpoint for easy one-click testing
app.get('/api/auth/demo-users', async (req, res) => {
  const users = await db.findMany('users');
  const userRoles = await db.findMany('user_roles');
  const demoUsers = users.map(u => {
    const ur = userRoles.find(r => r.user_id === u.id);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: ur ? ur.role_id.replace('role_', '').toUpperCase() : 'CUSTOMER',
      demoPassword: 'any of: admin123, customer123, owner123, chef123, rider123'
    };
  });
  res.json({ success: true, data: demoUsers });
});

export default app;

if (process.env.STANDALONE_SERVICE === 'true') {
  startService({ name: 'auth-service', app, port: PORT, needs: { postgres: true } });
}
