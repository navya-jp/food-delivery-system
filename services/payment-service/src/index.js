/**
 * Payment Microservice with Simulated Gateway,
 * State Machine Circuit Breaker, Exponential Backoff, and Idempotency
 */

import express from '../../../shared/expressAdapter.js';
import cors from '../../../shared/corsAdapter.js';
import { db } from '../../../database/db.js';
import { eventBus } from '../../../shared/eventBus.js';
import { ORDER_STATUS, QUEUES, CIRCUIT_BREAKER_STATES } from '../../../shared/constants.js';
import { createLogger } from '../../../shared/logger.js';
import { startService } from '../../../shared/bootstrap.js';

const log = createLogger('payment-service');
const app = express();
const PORT = process.env.PORT_PAYMENT || 4005;

app.use(cors());
app.use(express.json());

// ========================================================
// FAULT TOLERANCE: CIRCUIT BREAKER IMPLEMENTATION
// ========================================================

class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'PaymentGatewayGateway';
    this.failureThreshold = options.failureThreshold || 3; // Trip after 3 consecutive errors
    this.resetTimeoutMs = options.resetTimeoutMs || 8000;  // 8s in OPEN before probing
    this.state = CIRCUIT_BREAKER_STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = Date.now();
    this.simulatedDownstreamError = false; // Flag to simulate external provider outage
  }

  async execute(actionFn, fallbackFn) {
    const now = Date.now();

    // 1. Check if Circuit is OPEN
    if (this.state === CIRCUIT_BREAKER_STATES.OPEN) {
      if (now > this.nextAttempt) {
        log.warn(`[Circuit Breaker: ${this.name}] Reset timeout elapsed. Transitioning to HALF_OPEN for trial probe`);
        this.state = CIRCUIT_BREAKER_STATES.HALF_OPEN;
      } else {
        const remainingWaitMs = this.nextAttempt - now;
        log.warn(`[Circuit Breaker: ${this.name}] Circuit is OPEN. Fast-failing with fallback. Reset in ${remainingWaitMs}ms`);
        return fallbackFn(new Error(`Circuit is OPEN. External service unavailable. Retry in ${Math.ceil(remainingWaitMs / 1000)}s`));
      }
    }

    // 2. Execute Action (in CLOSED or HALF_OPEN)
    try {
      if (this.simulatedDownstreamError) {
        throw new Error('Downstream Payment Provider 503 Service Unavailable (Simulated Outage)');
      }

      const result = await actionFn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      return fallbackFn(err);
    }
  }

  onSuccess() {
    this.failureCount = 0;
    if (this.state === CIRCUIT_BREAKER_STATES.HALF_OPEN) {
      log.info(`[Circuit Breaker: ${this.name}] Probe request succeeded! Resetting to CLOSED`);
      this.state = CIRCUIT_BREAKER_STATES.CLOSED;
    }
  }

  onFailure(err) {
    this.failureCount++;
    log.error(`[Circuit Breaker: ${this.name}] Action failed (${this.failureCount}/${this.failureThreshold}): ${err.message}`);

    if (this.state === CIRCUIT_BREAKER_STATES.HALF_OPEN || this.failureCount >= this.failureThreshold) {
      this.state = CIRCUIT_BREAKER_STATES.OPEN;
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
      log.error(`[Circuit Breaker: ${this.name}] Failure threshold reached! Circuit tripped to OPEN. Fast-failing next requests.`);
    }
  }

  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      nextAttemptAt: this.state === CIRCUIT_BREAKER_STATES.OPEN ? new Date(this.nextAttempt).toISOString() : null,
      simulatedDownstreamDown: this.simulatedDownstreamError
    };
  }

  toggleSimulation(down) {
    this.simulatedDownstreamError = down;
    if (down) {
      this.onFailure(new Error('Manual outage simulation triggered'));
    } else {
      this.state = CIRCUIT_BREAKER_STATES.CLOSED;
      this.failureCount = 0;
    }
    return this.getStatus();
  }

  reset() {
    this.state = CIRCUIT_BREAKER_STATES.CLOSED;
    this.failureCount = 0;
    this.simulatedDownstreamError = false;
    return this.getStatus();
  }
}

export const paymentCircuitBreaker = new CircuitBreaker();

// Exponential backoff retry helper
async function retryWithExponentialBackoff(operationFn, maxRetries = 3, baseDelayMs = 150) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await operationFn();
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 50;
      log.warn(`[Exponential Backoff] Attempt ${attempt} failed. Retrying in ${Math.round(delay)}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Health Check Endpoint
app.get('/health', async (req, res) => {
  const dbOk = await db.isHealthy();
  res.status(200).json({
    service: 'payment-service',
    status: dbOk ? 'healthy' : 'degraded',
    circuitBreaker: paymentCircuitBreaker.getStatus(),
    timestamp: new Date().toISOString()
  });
});

// Process Payment (Protected by Circuit Breaker & Idempotency)
app.post('/api/payments/process', async (req, res) => {
  const { orderId, amount, method = 'ONLINE_SIMULATED', idempotencyKey, forceFail = false } = req.body;

  if (!orderId || !amount) {
    return res.status(400).json({ success: false, message: 'orderId and amount are required' });
  }

  // IDEMPOTENCY CHECK
  if (idempotencyKey) {
    const existing = await db.findOne('payments', { idempotency_key: idempotencyKey });
    if (existing) {
      log.warn('Idempotent payment request intercepted. Returning cached payment', { idempotencyKey });
      return res.json({
        success: true,
        message: 'Payment already processed (Idempotent response)',
        data: existing
      });
    }
  }

  // Execute Payment using Circuit Breaker
  const result = await paymentCircuitBreaker.execute(
    // 1. Primary Action: Call downstream bank/gateway
    async () => {
      if (forceFail) {
        throw new Error('Simulated bank card decline (Insufficient funds or gateway timeout)');
      }

      // Simulate network operation with potential retry
      const paymentRecord = await retryWithExponentialBackoff(async () => {
        const txnRef = `TXN_SIM_${Date.now()}_${Math.random().toString(36).substring(7).toUpperCase()}`;

        // Save payment to DB
        const payment = await db.insert('payments', {
          order_id: orderId,
          idempotency_key: idempotencyKey || null,
          amount: Number(amount),
          currency: 'INR',
          method,
          status: 'COMPLETED',
          transaction_reference: txnRef
        });

        // Transition Order status to PAYMENT_CONFIRMED -> PLACED
        await db.update('orders', orderId, { status: ORDER_STATUS.PAYMENT_CONFIRMED });
        await db.insert('order_status_history', {
          order_id: orderId,
          from_status: ORDER_STATUS.PAYMENT_PENDING,
          to_status: ORDER_STATUS.PAYMENT_CONFIRMED,
          changed_by: 'payment_gateway',
          comments: `Payment confirmed. Ref: ${txnRef}`
        });

        // Paid orders go straight on to PLACED (kitchen routing is done by the order worker)
        await db.update('orders', orderId, { status: ORDER_STATUS.PLACED });
        await db.insert('order_status_history', {
          order_id: orderId,
          from_status: ORDER_STATUS.PAYMENT_CONFIRMED,
          to_status: ORDER_STATUS.PLACED,
          changed_by: 'payment_gateway',
          comments: 'Order placed after successful payment'
        });

        // Publish event to RabbitMQ
        await eventBus.publish(QUEUES.ORDER_STATUS_CHANGED, {
          orderId,
          fromStatus: ORDER_STATUS.PAYMENT_PENDING,
          toStatus: ORDER_STATUS.PLACED,
          paymentId: payment.id
        });

        return payment;
      });

      return {
        success: true,
        message: 'Payment processed successfully',
        circuitState: paymentCircuitBreaker.state,
        data: paymentRecord
      };
    },
    // 2. Fallback Action: Return graceful degradation response
    (error) => {
      log.error('Payment fallback executed due to circuit trip or failure:', { error: error.message });
      return {
        success: false,
        isFallback: true,
        circuitState: paymentCircuitBreaker.state,
        message: `Payment processing fallback: ${error.message}. Transaction logged for asynchronous reconciliation.`,
        error: error.message
      };
    }
  );

  const httpStatus = result.success ? 200 : (result.circuitState === CIRCUIT_BREAKER_STATES.OPEN ? 503 : 400);
  res.status(httpStatus).json(result);
});

// Circuit Breaker Controls for Live Evaluation & Viva Demonstration
app.get('/api/payments/circuit-breaker/status', (req, res) => {
  res.json({
    success: true,
    data: paymentCircuitBreaker.getStatus()
  });
});

app.post('/api/payments/circuit-breaker/toggle-failure', (req, res) => {
  const { down = true } = req.body;
  const status = paymentCircuitBreaker.toggleSimulation(down);
  res.json({
    success: true,
    message: down ? 'Simulated downstream payment provider failure ENABLED' : 'Simulated failure DISABLED (Service restored)',
    circuitBreaker: status
  });
});

app.post('/api/payments/circuit-breaker/reset', (req, res) => {
  const status = paymentCircuitBreaker.reset();
  res.json({
    success: true,
    message: 'Circuit breaker reset to CLOSED',
    circuitBreaker: status
  });
});

// Process Refund
app.post('/api/payments/refund', async (req, res) => {
  const { paymentId, amount, reason = 'Customer cancellation' } = req.body;
  try {
    const payment = await db.findById('payments', paymentId);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment record not found' });

    const refund = await db.insert('refunds', {
      payment_id: paymentId,
      amount: Number(amount || payment.amount),
      reason,
      status: 'PROCESSED'
    });

    await db.update('payments', paymentId, { status: 'REFUNDED' });
    await db.update('orders', payment.order_id, { status: ORDER_STATUS.REFUNDED });

    res.json({ success: true, message: 'Refund simulated successfully', data: refund });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default app;

if (process.env.STANDALONE_SERVICE === 'true') {
  startService({ name: 'payment-service', app, port: PORT, needs: { postgres: true, rabbitmq: true } });
}
