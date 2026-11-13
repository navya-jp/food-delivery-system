/**
 * Structured JSON Logger for Microservices & API Gateway
 */

class Logger {
  constructor(serviceName = 'system') {
    this.serviceName = serviceName;
  }

  formatMessage(level, message, meta = {}) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      service: this.serviceName,
      level: level.toUpperCase(),
      message,
      correlationId: meta.requestId || meta.correlationId || null,
      ...meta
    });
  }

  info(message, meta = {}) {
    console.log(this.formatMessage('info', message, meta));
  }

  warn(message, meta = {}) {
    console.warn(this.formatMessage('warn', message, meta));
  }

  error(message, meta = {}) {
    console.error(this.formatMessage('error', message, meta));
  }

  debug(message, meta = {}) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(this.formatMessage('debug', message, meta));
    }
  }

  child(serviceName) {
    return new Logger(serviceName);
  }
}

export const logger = new Logger('root');
export const createLogger = (name) => new Logger(name);
