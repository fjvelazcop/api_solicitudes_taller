/**
 * sqliteBridge.cjs
 *
 * Shim que expone una API compatible con `sqlite3` para que Sequelize
 * pueda utilizarla como `dialectModule` en cualquier versión de Node.js.
 *
 * Estrategia:
 *  1. Si `node:sqlite` está disponible (Node >= 22.5 con --experimental-sqlite
 *     o Node >= 23), se usa la implementación nativa (más rápida).
 *  2. Si NO está disponible (por ejemplo Node 20.x como en CI), se usa el
 *     paquete npm `sqlite3` (ya declarado en package.json).
 *
 * De este modo el proyecto es compatible con:
 *   - Node 20.x  → sqlite3 (npm)
 *   - Node 22.x  → node:sqlite (si está habilitado) o sqlite3 (fallback)
 *   - Node 23+   → node:sqlite
 */

'use strict';

const EventEmitter = require('events');

// --- Detección del backend disponible ------------------------------
let backend = null; // 'native' | 'npm'

let nativeSqlite = null;
try {
  // Solo disponible en Node >= 22.5 (experimental) o Node >= 23 (estable)
  nativeSqlite = require('node:sqlite');
  backend = 'native';
} catch (_) {
  backend = null;
}

let sqlite3 = null;
if (!backend) {
  try {
    sqlite3 = require('sqlite3');
    backend = 'npm';
  } catch (err) {
    throw new Error(
      '[sqliteBridge] No se pudo cargar `node:sqlite` ni el paquete `sqlite3`. ' +
        'Asegúrate de que `sqlite3` esté instalado (npm install) o usa Node >= 22.5 con --experimental-sqlite.'
    );
  }
}

console.log(`[sqliteBridge] Backend SQLite activo: ${backend}`);

// --- Helpers comunes ----------------------------------------------
function sanitizeValue(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'object' && !(val instanceof Uint8Array) && !Buffer.isBuffer(val)) {
    return JSON.stringify(val);
  }
  return val;
}

function normalizeParams(sql, params) {
  if (!params) return { sql, params: [] };

  if (Array.isArray(params)) {
    const normalizedSql = sql.replace(/\$(\d+)/g, '?');
    const sanitized = params.map(sanitizeValue);
    return { sql: normalizedSql, params: sanitized };
  } else if (typeof params === 'object') {
    const sanitized = {};
    for (const [k, v] of Object.entries(params)) {
      sanitized[k] = sanitizeValue(v);
    }
    return { sql, params: sanitized };
  }
  return { sql, params: [sanitizeValue(params)] };
}

// --- Wrapper sobre `sqlite3` (npm) --------------------------------
function createNpmDatabase(filename, mode, callback) {
  if (typeof mode === 'function') {
    callback = mode;
    mode = null;
  }
  return new sqlite3.Database(
    filename === ':memory:' ? ':memory:' : filename || ':memory:',
    (err) => {
      if (callback) callback(err);
    }
  );
}

// --- Wrapper sobre `node:sqlite` (nativo) -------------------------
class NativeDatabase extends EventEmitter {
  constructor(filename, mode, callback) {
    super();
    if (typeof mode === 'function') {
      callback = mode;
      mode = null;
    }
    try {
      this.db = new nativeSqlite.DatabaseSync(
        filename === ':memory:' ? ':memory:' : filename || ':memory:'
      );
      process.nextTick(() => {
        if (callback) callback(null);
        this.emit('open');
      });
    } catch (err) {
      process.nextTick(() => {
        if (callback) callback(err);
        this.emit('error', err);
      });
    }
  }

  close(callback) {
    try {
      if (this.db) this.db.close();
      if (callback) callback(null);
      this.emit('close');
    } catch (err) {
      if (callback) callback(err);
    }
  }

  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    try {
      const normalized = normalizeParams(sql, params);
      const stmt = this.db.prepare(normalized.sql);
      const result = Array.isArray(normalized.params)
        ? stmt.run(...normalized.params)
        : stmt.run(normalized.params);

      const ctx = {
        lastID: result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : 0,
        changes: result.changes !== undefined ? Number(result.changes) : 0,
      };
      if (callback) callback.call(ctx, null);
    } catch (err) {
      if (callback) callback(err);
      else throw err;
    }
    return this;
  }

  all(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    try {
      const normalized = normalizeParams(sql, params);
      const stmt = this.db.prepare(normalized.sql);
      const rows = Array.isArray(normalized.params)
        ? stmt.all(...normalized.params)
        : stmt.all(normalized.params);

      if (callback) callback(null, rows || []);
    } catch (err) {
      if (callback) callback(err, null);
      else throw err;
    }
    return this;
  }

  get(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    try {
      const normalized = normalizeParams(sql, params);
      const stmt = this.db.prepare(normalized.sql);
      const row = Array.isArray(normalized.params)
        ? stmt.get(...normalized.params)
        : stmt.get(normalized.params);

      if (callback) callback(null, row || null);
    } catch (err) {
      if (callback) callback(err, null);
      else throw err;
    }
    return this;
  }

  each(sql, params, callback, complete) {
    if (typeof params === 'function') {
      complete = callback;
      callback = params;
      params = [];
    }
    this.all(sql, params, (err, rows) => {
      if (err) {
        if (callback) callback(err);
        if (complete) complete(err, 0);
        return;
      }
      rows.forEach((r) => callback && callback(null, r));
      if (complete) complete(null, rows.length);
    });
    return this;
  }

  exec(sql, callback) {
    try {
      this.db.exec(sql);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
      else throw err;
    }
    return this;
  }

  serialize(fn) {
    if (fn) fn();
  }

  parallelize(fn) {
    if (fn) fn();
  }
}

// --- Selección del Database expuesto -------------------------------
let Database;
if (backend === 'native') {
  Database = NativeDatabase;
} else {
  Database = function (filename, mode, callback) {
    return createNpmDatabase(filename, mode, callback);
  };
}

module.exports = {
  Database,
  OPEN_READONLY: 1,
  OPEN_READWRITE: 2,
  OPEN_CREATE: 4,
  verbose: () => module.exports,
  // Útil para diagnóstico
  __backend: backend,
};
