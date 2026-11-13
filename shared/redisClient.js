/**
 * Redis Client & Token Bucket Rate Limiter with In-Memory Resilient Fallback
 */

import { createLogger } from './logger.js';

const log = createLogger('redis-client');

// Atomic Token Bucket Lua Script for Redis
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2]) -- tokens per second
local requested = tonumber(ARGV[3])
local now = tonumber(ARGV[4]) -- epoch milliseconds

local data = redis.call('HMGET', key, 'tokens', 'last_updated')
local tokens = tonumber(data[1])
local last_updated = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_updated = now
else
  local delta = math.max(0, (now - last_updated) / 1000.0)
  tokens = math.min(capacity, tokens + delta * refill_rate)
  last_updated = now
end

if tokens >= requested then
  tokens = tokens - requested
  redis.call('HMSET', key, 'tokens', tokens, 'last_updated', last_updated)
  redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) * 2)
  return {1, math.floor(tokens), 0} -- allowed=1, remaining, retryAfter=0
else
  local missing = requested - tokens
  local wait_seconds = math.ceil(missing / refill_rate)
  return {0, math.floor(tokens), wait_seconds} -- allowed=0, remaining, retryAfter
end
`;

class RedisManager {
  constructor() {
    this.isConnected = false;
    this.mode = 'disconnected'; // 'redis' | 'in-memory' | 'disconnected'
    this.client = null;
    this.inMemoryCache = new Map();
    this.inMemoryBuckets = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0
    };
  }

  async connect(redisUrl = process.env.REDIS_URL || 'redis://localhost:6379', { retries = 30, delayMs = 2000 } = {}) {
    if (this.mode !== 'disconnected') return this.isConnected;
    const allowFallback = process.env.ALLOW_IN_MEMORY_FALLBACK === 'true';
    const redisModule = await import('redis').catch(() => null);

    if (redisModule && redisModule.createClient) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        let client;
        try {
          client = redisModule.createClient({
            url: redisUrl,
            socket: { reconnectStrategy: (n) => Math.min(n * 200, 3000) }
          });
          client.on('error', (err) => {
            if (this.isConnected) log.warn('Redis connection issue:', { error: err.message });
            this.isConnected = false;
          });
          client.on('ready', () => { this.isConnected = true; });
          client.on('end', () => { this.isConnected = false; });
          // connect() with no server would retry forever; race it against a short timeout
          await Promise.race([
            client.connect(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 3000))
          ]);
          await client.ping();
          this.client = client;
          this.isConnected = true;
          this.mode = 'redis';
          log.info('Redis connected successfully', { url: redisUrl });
          return true;
        } catch (err) {
          try { await client?.disconnect(); } catch (e) { /* ignore */ }
          log.warn(`Redis not ready (attempt ${attempt}/${retries}): ${err.message}`);
          if (allowFallback) break;
          if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }

    if (allowFallback) {
      log.warn('ALLOW_IN_MEMORY_FALLBACK=true: using in-memory cache/limiter (local development only)');
      this.mode = 'in-memory';
      this.isConnected = false;
      return false;
    }
    throw new Error('Redis is unavailable (or `redis` package missing) and in-memory fallback is disabled');
  }

  async isHealthy() {
    if (this.mode === 'in-memory') return true;
    if (this.client && this.isConnected) {
      try {
        return (await this.client.ping()) === 'PONG';
      } catch (err) {
        return false;
      }
    }
    return false;
  }

  /**
   * Token Bucket Rate Limiting Evaluation
   * @param {string} clientId Identifier (IP or User ID)
   * @param {number} capacity Maximum burst tokens (default 20)
   * @param {number} refillRate Tokens added per second (default 5)
   * @param {number} requested Cost in tokens (default 1)
   */
  async consumeTokenBucket(clientId, capacity = 20, refillRate = 5, requested = 1) {
    const key = `ratelimit:token_bucket:${clientId}`;
    const now = Date.now();

    if (this.isConnected && this.client) {
      try {
        const result = await this.client.eval(TOKEN_BUCKET_LUA, {
          keys: [key],
          arguments: [
            capacity.toString(),
            refillRate.toString(),
            requested.toString(),
            now.toString()
          ]
        });
        return {
          allowed: result[0] === 1,
          remaining: result[1],
          retryAfter: result[2]
        };
      } catch (err) {
        log.warn('Redis Lua rate-limit error, failing over to local bucket:', { error: err.message });
      }
    }

    // In-memory atomic Token Bucket fallback
    let bucket = this.inMemoryBuckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastUpdated: now };
      this.inMemoryBuckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsedSeconds = Math.max(0, (now - bucket.lastUpdated) / 1000.0);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillRate);
    bucket.lastUpdated = now;

    if (bucket.tokens >= requested) {
      bucket.tokens -= requested;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfter: 0
      };
    } else {
      const missing = requested - bucket.tokens;
      const retryAfter = Math.ceil(missing / refillRate);
      return {
        allowed: false,
        remaining: Math.floor(bucket.tokens),
        retryAfter
      };
    }
  }

  /**
   * Cache-Aside get
   */
  async get(key) {
    if (this.isConnected && this.client) {
      try {
        const val = await this.client.get(key);
        if (val !== null) {
          this.stats.hits++;
          return JSON.parse(val);
        }
        this.stats.misses++;
        return null;
      } catch (e) {
        // fallback
      }
    }

    const item = this.inMemoryCache.get(key);
    if (!item) {
      this.stats.misses++;
      return null;
    }

    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.inMemoryCache.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return item.data;
  }

  /**
   * Cache-Aside set with TTL
   */
  async set(key, value, ttlSeconds = 300) {
    this.stats.sets++;
    if (this.isConnected && this.client) {
      try {
        await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
        return true;
      } catch (e) {
        // fallback
      }
    }

    this.inMemoryCache.set(key, {
      data: value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null
    });
    return true;
  }

  /**
   * Invalidate cache by key or prefix pattern
   */
  async invalidate(patternOrKey) {
    this.stats.invalidations++;
    if (this.isConnected && this.client) {
      try {
        if (patternOrKey.includes('*')) {
          const keys = await this.client.keys(patternOrKey);
          if (keys.length > 0) {
            await this.client.del(keys);
          }
        } else {
          await this.client.del(patternOrKey);
        }
      } catch (e) {
        // fallback
      }
    }

    if (patternOrKey.includes('*')) {
      const prefix = patternOrKey.replace('*', '');
      for (const k of this.inMemoryCache.keys()) {
        if (k.startsWith(prefix)) {
          this.inMemoryCache.delete(k);
        }
      }
      for (const k of this.inMemoryBuckets.keys()) {
        if (k.startsWith(prefix)) {
          this.inMemoryBuckets.delete(k);
        }
      }
    } else {
      this.inMemoryCache.delete(patternOrKey);
      this.inMemoryBuckets.delete(patternOrKey);
    }
    return true;
  }

  getMetrics() {
    const total = this.stats.hits + this.stats.misses;
    const hitRatio = total > 0 ? (this.stats.hits / total).toFixed(4) : 0;
    return {
      connected: this.isConnected,
      mode: this.mode,
      ...this.stats,
      totalQueries: total,
      hitRatio: Number(hitRatio),
      cachedKeysCount: this.inMemoryCache.size
    };
  }
}

export const redisManager = new RedisManager();
