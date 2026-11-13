/**
 * Database Layer
 *  - PostgreSQL (pg) is the source of truth: every entity method below runs real SQL.
 *  - withTransaction() uses AsyncLocalStorage so that every db.* call made inside the
 *    callback automatically joins the same BEGIN/COMMIT transaction.
 *  - The in-memory store exists ONLY for no-Docker local development and is used solely
 *    when ALLOW_IN_MEMORY_FALLBACK=true. Otherwise a missing Postgres is a hard failure.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../shared/logger.js';

const log = createLogger('database');
const txStore = new AsyncLocalStorage();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class DatabaseManager {
  constructor() {
    this.pool = null;
    this.isPostgresConnected = false;
    this.mode = 'disconnected';      // 'postgres' | 'in-memory' | 'disconnected'
    this.columns = new Map();        // table -> Map(column -> data_type)
    this.allowFallback = () => process.env.ALLOW_IN_MEMORY_FALLBACK === 'true';

    // In-memory data store (local development fallback ONLY)
    this.tables = {
      users: new Map(),
      roles: new Map(),
      user_roles: new Map(),
      addresses: new Map(),
      restaurants: new Map(),
      restaurant_members: new Map(),
      menu_categories: new Map(),
      menu_items: new Map(),
      carts: new Map(),
      cart_items: new Map(),
      orders: new Map(),
      order_items: new Map(),
      order_status_history: new Map(),
      payments: new Map(),
      refunds: new Map(),
      kitchens: new Map(),
      kitchen_queues: new Map(),
      delivery_partners: new Map(),
      delivery_assignments: new Map(),
      notifications: new Map(),
      transaction_logs: new Map(),
      request_logs: new Map(),
      background_tasks: new Map()
    };
  }

  async connect(connectionString = process.env.DATABASE_URL, { retries = 30, delayMs = 2000 } = {}) {
    if (this.mode !== 'disconnected') return this.isPostgresConnected;
    const pgModule = await import('pg').catch(() => null);

    if (pgModule && connectionString) {
      const Pool = (pgModule.default || pgModule).Pool;
      const types = (pgModule.default || pgModule).types;
      // Return NUMERIC as numbers and timestamps as ISO strings (matches API contract)
      types.setTypeParser(1700, (v) => parseFloat(v));
      types.setTypeParser(20, (v) => parseInt(v, 10));
      types.setTypeParser(1184, (v) => new Date(v).toISOString());
      types.setTypeParser(1114, (v) => new Date(v + 'Z').toISOString());

      this.pool = new Pool({ connectionString, max: parseInt(process.env.PG_POOL_MAX || '20', 10) });
      this.pool.on('error', (e) => log.warn('Idle PostgreSQL client error', { error: e.message }));

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          await this.pool.query('SELECT 1');
          await this._loadColumns();
          this.isPostgresConnected = true;
          this.mode = 'postgres';
          log.info('Connected to PostgreSQL', { tables: this.columns.size });
          return true;
        } catch (err) {
          log.warn(`PostgreSQL not ready (attempt ${attempt}/${retries}): ${err.message}`);
          if (attempt < retries && !this.allowFallback()) await sleep(delayMs);
          else if (this.allowFallback()) break;
        }
      }
    }

    if (this.allowFallback()) {
      log.warn('ALLOW_IN_MEMORY_FALLBACK=true: using in-memory store (local development only, data is NOT shared or persisted)');
      this.mode = 'in-memory';
      return false;
    }
    throw new Error('PostgreSQL is unavailable (or `pg` / DATABASE_URL missing) and in-memory fallback is disabled');
  }

  async _loadColumns() {
    const { rows } = await this.pool.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`
    );
    this.columns.clear();
    for (const r of rows) {
      if (!this.columns.has(r.table_name)) this.columns.set(r.table_name, new Map());
      this.columns.get(r.table_name).set(r.column_name, r.data_type);
    }
    if (this.columns.size === 0) throw new Error('Database schema is empty (schema.sql has not been applied)');
  }

  async isHealthy() {
    if (this.mode === 'in-memory') return true;
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Executes on the active transaction client if inside withTransaction(), else the pool */
  _exec() {
    return txStore.getStore() || this.pool;
  }

  async query(text, params = []) {
    if (this.mode !== 'postgres') {
      throw new Error('Direct SQL query not supported in memory store; use entity operations.');
    }
    return this._exec().query(text, params);
  }

  /**
   * Real ACID transaction. Every db.* call made (directly or indirectly) inside workFn
   * runs on the same connection and is committed or rolled back together.
   */
  async withTransaction(workFn) {
    if (this.mode !== 'postgres') return workFn(this);
    if (txStore.getStore()) return workFn(this); // already inside a transaction (join it)

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStore.run(client, () => workFn(this));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------- helpers ----------
  _cols(table) {
    const cols = this.columns.get(table);
    if (!cols) throw new Error(`Unknown table: ${table}`);
    return cols;
  }

  _serialize(cols, col, value) {
    const type = cols.get(col);
    if ((type === 'jsonb' || type === 'json') && value !== null && value !== undefined && typeof value !== 'string') {
      return JSON.stringify(value);
    }
    if (type === 'jsonb' || type === 'json') return value === undefined ? null : JSON.stringify(value);
    return value === undefined ? null : value;
  }

  /** Build WHERE clause from an equality-filter object, e.g. { order_id: 'x', status: 'PLACED' } */
  _where(table, filter, startIdx = 1) {
    const cols = this._cols(table);
    const keys = Object.keys(filter);
    for (const k of keys) if (!cols.has(k)) throw new Error(`Unknown column ${table}.${k}`);
    const clause = keys.length ? 'WHERE ' + keys.map((k, i) => `"${k}" = $${startIdx + i}`).join(' AND ') : '';
    return { clause, params: keys.map(k => filter[k]) };
  }

  /**
   * Filter may be:
   *   - an object of equality conditions  -> executed in SQL (WHERE col = $n)
   *   - a predicate function              -> rows are loaded then filtered in JS
   */
  _inMemoryFilter(filter) {
    if (typeof filter === 'function') return filter;
    return (row) => Object.entries(filter).every(([k, v]) => row[k] === v);
  }

  // --- Entity Access Methods ---

  getTable(name) {
    if (!this.tables[name]) this.tables[name] = new Map();
    return this.tables[name];
  }

  async insert(table, record) {
    const id = record.id || `id_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const now = new Date().toISOString();
    const fullRecord = { ...record, id, created_at: record.created_at || now, updated_at: now };

    if (this.mode !== 'postgres') {
      this.getTable(table).set(id, fullRecord);
      return fullRecord;
    }

    const cols = this._cols(table);
    const keys = Object.keys(fullRecord).filter(k => cols.has(k));
    const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
    const { rows } = await this._exec().query(sql, keys.map(k => this._serialize(cols, k, fullRecord[k])));
    return rows[0];
  }

  async findById(table, id) {
    if (this.mode !== 'postgres') return this.getTable(table).get(id) || null;
    const { rows } = await this._exec().query(`SELECT * FROM "${table}" WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  async findOne(table, filter) {
    const rows = await this.findMany(table, filter, { limit: 1 });
    return rows[0] || null;
  }

  async findMany(table, filter = () => true, { limit = null, orderBy = null } = {}) {
    if (this.mode !== 'postgres') {
      const pred = this._inMemoryFilter(filter);
      const results = [];
      for (const item of this.getTable(table).values()) if (pred(item)) results.push(item);
      return limit ? results.slice(0, limit) : results;
    }

    const cols = this._cols(table);
    const order = orderBy && cols.has(orderBy) ? ` ORDER BY "${orderBy}"` : '';
    if (typeof filter === 'function') {
      const { rows } = await this._exec().query(`SELECT * FROM "${table}"${order}`);
      const out = rows.filter(filter);
      return limit ? out.slice(0, limit) : out;
    }
    const { clause, params } = this._where(table, filter);
    const lim = limit ? ` LIMIT ${parseInt(limit, 10)}` : '';
    const { rows } = await this._exec().query(`SELECT * FROM "${table}" ${clause}${order}${lim}`, params);
    return rows;
  }

  async update(table, id, updates) {
    if (this.mode !== 'postgres') {
      const tableMap = this.getTable(table);
      const existing = tableMap.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
      tableMap.set(id, updated);
      return updated;
    }

    const cols = this._cols(table);
    const data = { ...updates };
    if (cols.has('updated_at')) data.updated_at = new Date().toISOString();
    delete data.id;
    const keys = Object.keys(data).filter(k => cols.has(k));
    if (keys.length === 0) return this.findById(table, id);
    const sql = `UPDATE "${table}" SET ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`;
    const { rows } = await this._exec().query(sql, [...keys.map(k => this._serialize(cols, k, data[k])), id]);
    return rows[0] || null;
  }

  /**
   * Compare-and-set update: applies `updates` only if the row still satisfies the condition.
   * In PostgreSQL this is ONE atomic statement (UPDATE ... WHERE id=$n AND <condition>),
   * so concurrent callers cannot both win. Returns the updated row, or null if the condition failed.
   *   sqlCondition: SQL using $1..$k placeholders for `condParams` (e.g. "locked_by IS NULL OR locked_until < NOW()")
   *   predicate:    equivalent JS check, used by the in-memory store
   */
  async updateIf(table, id, updates, { sqlCondition, condParams = [], predicate }) {
    if (this.mode !== 'postgres') {
      const row = this.getTable(table).get(id);
      if (!row || !predicate(row)) return null;
      return this.update(table, id, updates);
    }
    const cols = this._cols(table);
    const data = { ...updates };
    if (cols.has('updated_at')) data.updated_at = new Date().toISOString();
    const keys = Object.keys(data).filter(k => cols.has(k));
    const base = condParams.length;
    const sql = `UPDATE "${table}" SET ${keys.map((k, i) => `"${k}" = $${base + i + 1}`).join(', ')} ` +
                `WHERE id = $${base + keys.length + 1} AND (${sqlCondition}) RETURNING *`;
    const { rows } = await this._exec().query(
      sql, [...condParams, ...keys.map(k => this._serialize(cols, k, data[k])), id]
    );
    return rows[0] || null;
  }

  async delete(table, id) {
    if (this.mode !== 'postgres') return this.getTable(table).delete(id);
    const { rowCount } = await this._exec().query(`DELETE FROM "${table}" WHERE id = $1`, [id]);
    return rowCount > 0;
  }

  /** Remove all rows from the given tables (used by seed / tests) */
  async truncateAll() {
    if (this.mode !== 'postgres') {
      for (const m of Object.values(this.tables)) m.clear();
      return;
    }
    const names = [...this.columns.keys()].map(t => `"${t}"`).join(', ');
    await this.pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  }

  async close() {
    if (this.pool) await this.pool.end().catch(() => {});
    this.pool = null; this.isPostgresConnected = false; this.mode = 'disconnected';
  }

  /**
   * Log transaction state changes
   */
  async logTransaction({ correlationId, entityType, entityId, action, oldState, newState, performedBy }) {
    return this.insert('transaction_logs', {
      correlation_id: correlationId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      old_state: oldState,
      new_state: newState,
      performed_by: performedBy
    });
  }

  /**
   * Record HTTP request log (always on the pool, never inside a caller's transaction)
   */
  async logRequest({ requestId, method, path, clientIp, statusCode, latencyMs, serviceRouted }) {
    return txStore.exit(() => this.insert('request_logs', {
      request_id: requestId,
      method,
      path,
      client_ip: clientIp,
      status_code: statusCode,
      latency_ms: latencyMs,
      service_routed: serviceRouted
    }));
  }
}

export const db = new DatabaseManager();
