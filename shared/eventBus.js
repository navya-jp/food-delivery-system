/**
 * RabbitMQ Event Bus with Dead-Letter Queues, Acknowledgments,
 * Exponential Backoff Retries, and Resilient Async Dispatcher
 */

import { createLogger } from './logger.js';
import { QUEUES, EXCHANGES } from './constants.js';

const log = createLogger('event-bus');

class EventBus {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.isConnected = false;
    this.mode = 'disconnected'; // 'rabbitmq' | 'in-memory' | 'disconnected'
    this.reconnecting = false;
    this.subscribers = new Map();
    this.localQueue = [];
    this.dlqMessages = [];
  }

  async connect(rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672', { retries = 30, delayMs = 2000 } = {}) {
    if (this.mode !== 'disconnected') return this.isConnected;
    this.url = rabbitmqUrl;
    const allowFallback = process.env.ALLOW_IN_MEMORY_FALLBACK === 'true';
    const amqp = await import('amqplib').catch(() => null);
    this.amqp = amqp;

    if (amqp && amqp.connect) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          await this._openConnection();
          this.mode = 'rabbitmq';
          return true;
        } catch (err) {
          log.warn(`RabbitMQ not ready (attempt ${attempt}/${retries}): ${err.message}`);
          if (allowFallback) break;
          if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }

    if (allowFallback) {
      log.warn('ALLOW_IN_MEMORY_FALLBACK=true: using in-process queue (local development only; no cross-container delivery)');
      this.mode = 'in-memory';
      this.isConnected = false;
      return false;
    }
    throw new Error('RabbitMQ is unavailable (or `amqplib` missing) and in-memory fallback is disabled');
  }

  async _openConnection() {
    this.connection = await this.amqp.connect(this.url);
    this.channel = await this.connection.createChannel();

    // Dead Letter Exchange & Queue
    await this.channel.assertExchange(EXCHANGES.DEAD_LETTER, 'direct', { durable: true });
    await this.channel.assertQueue(QUEUES.DEAD_LETTER_QUEUE, { durable: true });
    await this.channel.bindQueue(QUEUES.DEAD_LETTER_QUEUE, EXCHANGES.DEAD_LETTER, 'dead_letter_key');

    // Main durable queues, each dead-lettering into the DLQ
    for (const queueName of Object.values(QUEUES)) {
      if (queueName !== QUEUES.DEAD_LETTER_QUEUE) {
        await this.channel.assertQueue(queueName, {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': EXCHANGES.DEAD_LETTER,
            'x-dead-letter-routing-key': 'dead_letter_key'
          }
        });
      }
    }

    this.isConnected = true;
    log.info('RabbitMQ connected successfully', { url: this.url.replace(/\/\/.*@/, '//***@') });

    this.connection.on('error', (err) => {
      log.warn('RabbitMQ connection error:', { error: err.message });
    });
    this.connection.on('close', () => {
      log.warn('RabbitMQ connection closed; reconnecting...');
      this.isConnected = false;
      this._scheduleReconnect();
    });

    // (Re)bind every registered consumer
    for (const [queue, handlers] of this.subscribers.entries()) {
      for (const handler of handlers) await this._bindRabbitConsumer(queue, handler);
    }
  }

  _scheduleReconnect() {
    if (this.reconnecting || this.mode !== 'rabbitmq') return;
    this.reconnecting = true;
    const tryOnce = async (delay) => {
      try {
        await this._openConnection();
        this.reconnecting = false;
      } catch (err) {
        log.warn(`RabbitMQ reconnect failed: ${err.message}`);
        setTimeout(() => tryOnce(Math.min(delay * 2, 10000)), delay);
      }
    };
    setTimeout(() => tryOnce(1000), 1000);
  }

  async isHealthy() {
    if (this.mode === 'in-memory') return true;
    return Boolean(this.isConnected && this.channel);
  }

  /**
   * Publish an event to a queue with persistent delivery
   */
  async publish(queueName, message, options = {}) {
    const payload = {
      messageId: options.messageId || `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      correlationId: options.correlationId || null,
      timestamp: new Date().toISOString(),
      retryCount: options.retryCount || 0,
      data: message
    };

    log.info(`[Broker] Publishing message to queue [${queueName}]`, {
      messageId: payload.messageId,
      queue: queueName,
      correlationId: payload.correlationId
    });

    if (this.isConnected && this.channel) {
      try {
        const buffer = Buffer.from(JSON.stringify(payload));
        return this.channel.sendToQueue(queueName, buffer, {
          persistent: true,
          messageId: payload.messageId,
          correlationId: payload.correlationId,
          headers: { retryCount: payload.retryCount }
        });
      } catch (err) {
        log.error('Failed to publish message via RabbitMQ channel:', { error: err.message });
      }
    }

    if (this.mode === 'rabbitmq') {
      // Never silently divert to an in-process queue that no other container can read
      throw new Error('Message broker unavailable; message not published');
    }

    // In-process delivery (local development mode only)
    const handlers = this.subscribers.get(queueName) || [];
    if (handlers.length > 0) {
      // Async dispatch on next tick (decoupling publisher from consumer)
      setImmediate(async () => {
        for (const handler of handlers) {
          try {
            await handler(payload.data, {
              ack: () => log.info(`[Ack] Message acknowledged [${payload.messageId}]`),
              nack: (requeue = false) => this._handleLocalNack(queueName, payload, handler, requeue)
            });
          } catch (handlerErr) {
            log.error(`[Worker Error] Processing failure on queue ${queueName}:`, {
              messageId: payload.messageId,
              error: handlerErr.message
            });
            await this._handleLocalNack(queueName, payload, handler, true);
          }
        }
      });
    } else {
      this.localQueue.push({ queueName, payload });
    }

    return true;
  }

  /**
   * Subscribe a consumer handler to a queue
   */
  async subscribe(queueName, handler) {
    if (!this.subscribers.has(queueName)) {
      this.subscribers.set(queueName, []);
    }
    this.subscribers.get(queueName).push(handler);

    log.info(`[Consumer] Subscribed handler to queue [${queueName}]`);

    if (this.isConnected && this.channel) {
      await this._bindRabbitConsumer(queueName, handler);
    }

    // Process queued offline messages
    const pending = this.localQueue.filter(item => item.queueName === queueName);
    this.localQueue = this.localQueue.filter(item => item.queueName !== queueName);
    for (const item of pending) {
      setImmediate(() => handler(item.payload.data, {
        ack: () => log.info(`[Ack] Buffered message acked [${item.payload.messageId}]`),
        nack: () => log.warn(`[Nack] Buffered message nacked [${item.payload.messageId}]`)
      }));
    }
  }

  async _bindRabbitConsumer(queueName, handler) {
    const MAX_RETRIES = 3;
    try {
      await this.channel.prefetch(parseInt(process.env.WORKER_PREFETCH || '10', 10));
      await this.channel.consume(queueName, async (msg) => {
        if (!msg) return;
        let settled = false;
        const channel = this.channel;
        const settle = (fn) => { if (!settled) { settled = true; try { fn(); } catch (e) { log.warn('Ack/Nack failed', { error: e.message }); } } };
        let content;
        try {
          content = JSON.parse(msg.content.toString());
        } catch (e) {
          return settle(() => channel.nack(msg, false, false)); // unparseable -> DLQ
        }

        try {
          await handler(content.data, {
            ack: () => settle(() => channel.ack(msg)),
            nack: (requeue = false) => {
              const retry = (content.retryCount || 0) + 1;
              if (requeue && retry <= MAX_RETRIES) {
                // Retry with exponential backoff: republish a copy after 200ms, 400ms, 800ms...
                const backoffMs = Math.min(5000, 200 * Math.pow(2, retry - 1));
                log.warn(`[Retry] ${queueName} attempt ${retry}/${MAX_RETRIES} in ${backoffMs}ms`, { messageId: content.messageId });
                settle(() => channel.ack(msg));
                setTimeout(() => {
                  this.publish(queueName, content.data, {
                    messageId: content.messageId, correlationId: content.correlationId, retryCount: retry
                  }).catch(() => {});
                }, backoffMs);
              } else {
                log.error(`[DLQ] Message ${content.messageId} dead-lettered from ${queueName}`);
                settle(() => channel.nack(msg, false, false)); // broker routes to DLQ
              }
            }
          });
        } catch (consumerErr) {
          log.error('Consumer execution failed in RabbitMQ:', { error: consumerErr.message });
          settle(() => channel.nack(msg, false, false)); // Route to DLQ
        }
      });
    } catch (e) {
      log.warn(`Could not bind consumer for ${queueName}:`, { error: e.message });
    }
  }

  async _handleLocalNack(queueName, payload, handler, requeue) {
    const maxRetries = 3;
    payload.retryCount = (payload.retryCount || 0) + 1;

    if (requeue && payload.retryCount <= maxRetries) {
      // Exponential backoff delay: 200ms, 400ms, 800ms
      const backoffMs = Math.min(2000, 200 * Math.pow(2, payload.retryCount - 1));
      log.warn(`[Retry] Retrying task on [${queueName}], attempt ${payload.retryCount}/${maxRetries} after ${backoffMs}ms`);
      setTimeout(async () => {
        try {
          await handler(payload.data, {
            ack: () => log.info(`[Ack] Message acknowledged on retry [${payload.messageId}]`),
            nack: () => this._handleLocalNack(queueName, payload, handler, false)
          });
        } catch (e) {
          this._handleLocalNack(queueName, payload, handler, true);
        }
      }, backoffMs);
    } else {
      log.error(`[DLQ] Max retries exhausted for message [${payload.messageId}]. Moving to Dead Letter Queue.`);
      this.dlqMessages.push({
        ...payload,
        failedAt: new Date().toISOString(),
        originalQueue: queueName
      });
    }
  }

  getDLQMessages() {
    return this.dlqMessages;
  }
}

export const eventBus = new EventBus();
