const Database = require('better-sqlite3')
const config = require('./config')

const db = new Database(config.DB_PATH)

// Activar WAL para mejor rendimiento concurrente
db.pragma('journal_mode = WAL')

// Crear tablas
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    ip TEXT NOT NULL,
    origin TEXT,
    method TEXT,
    path TEXT,
    status INTEGER,
    response_time_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL UNIQUE,
    blocked_at TEXT DEFAULT (datetime('now')),
    reason TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_requests_ip_ts ON requests(ip, timestamp);
  CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(timestamp);
  CREATE INDEX IF NOT EXISTS idx_blocks_ip ON blocks(ip);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

// Migración: añadir columna cache_hit si no existe
try {
  db.exec(`ALTER TABLE requests ADD COLUMN cache_hit INTEGER DEFAULT 0`)
} catch (err) {
  if (!err.message.includes('duplicate column name')) throw err
}

// Prepared statements para rendimiento (queries fijas)
const stmts = {
  logRequest: db.prepare(`
    INSERT INTO requests (ip, origin, method, path, status, response_time_ms, cache_hit)
    VALUES (@ip, @origin, @method, @path, @status, @responseTime, @cacheHit)
  `),

  countByIp: db.prepare(`
    SELECT COUNT(*) AS count FROM requests
    WHERE ip = ? AND timestamp > datetime('now', ?)
  `),

  countGlobal: db.prepare(`
    SELECT COUNT(*) AS count FROM requests
    WHERE timestamp > datetime('now', ?)
  `),

  isBlocked: db.prepare(`
    SELECT 1 FROM blocks WHERE ip = ?
  `),

  blockIp: db.prepare(`
    INSERT OR IGNORE INTO blocks (ip, reason) VALUES (?, ?)
  `),

  unblockIp: db.prepare(`
    DELETE FROM blocks WHERE ip = ?
  `),

  getStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM requests) AS total_requests,
      (SELECT COUNT(DISTINCT ip) FROM requests) AS unique_ips,
      (SELECT COUNT(*) FROM blocks) AS blocked_ips
  `),

  getRecentRequests: db.prepare(`
    SELECT * FROM requests ORDER BY id DESC LIMIT ?
  `),

  getBlockedIps: db.prepare(`
    SELECT * FROM blocks ORDER BY blocked_at DESC
  `),

  getLastRequestId: db.prepare(`
    SELECT MAX(id) AS id FROM requests
  `),

  getRequestsAfterId: db.prepare(`
    SELECT * FROM requests WHERE id > ? ORDER BY id DESC LIMIT 50
  `),

  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  getAllSettings: db.prepare(`SELECT key, value FROM settings`),
  setSetting: db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`),
}

function windowToSqlite(ms) {
  return `-${Math.floor(ms / 1000)} seconds`
}

// Queries dinámicas para el dashboard (timeFilter viene validado desde server.js)
function queryCount(tf) {
  return db.prepare(`SELECT COUNT(*) AS count FROM requests WHERE ${tf}`).get().count
}

function queryAvgResponseTime(tf) {
  return db.prepare(`SELECT ROUND(AVG(response_time_ms)) AS avg_ms FROM requests WHERE ${tf}`).get().avg_ms || 0
}

function queryErrorCount(tf) {
  return db.prepare(`SELECT COUNT(*) AS count FROM requests WHERE status >= 400 AND ${tf}`).get().count
}

function queryByInterval(tf, groupFormat) {
  return db.prepare(`SELECT strftime('${groupFormat}', timestamp) AS label, COUNT(*) AS count FROM requests WHERE ${tf} GROUP BY label ORDER BY label`).all()
}

function queryTopIps(tf) {
  return db.prepare(`SELECT ip, COUNT(*) AS count FROM requests WHERE ${tf} GROUP BY ip ORDER BY count DESC LIMIT 10`).all()
}

function queryTopPaths(tf) {
  return db.prepare(`SELECT path, COUNT(*) AS count FROM requests WHERE ${tf} GROUP BY path ORDER BY count DESC LIMIT 10`).all()
}

function queryStatusBreakdown(tf) {
  return db.prepare(`SELECT status, COUNT(*) AS count FROM requests WHERE ${tf} GROUP BY status ORDER BY count DESC`).all()
}

function queryCacheHits(tf) {
  return db.prepare(`SELECT COUNT(*) AS count FROM requests WHERE cache_hit = 1 AND ${tf}`).get().count
}

function queryCacheMisses(tf) {
  return db.prepare(`SELECT COUNT(*) AS count FROM requests WHERE cache_hit = 0 AND ${tf}`).get().count
}

module.exports = {
  logRequest({ ip, origin, method, path, status, responseTime, cacheHit = 0 }) {
    stmts.logRequest.run({ ip, origin, method, path, status, responseTime, cacheHit })
  },

  getRequestCountByIp(ip, windowMs) {
    const row = stmts.countByIp.get(ip, windowToSqlite(windowMs))
    return row.count
  },

  getGlobalRequestCount(windowMs) {
    const row = stmts.countGlobal.get(windowToSqlite(windowMs))
    return row.count
  },

  isBlocked(ip) {
    return !!stmts.isBlocked.get(ip)
  },

  blockIp(ip, reason) {
    stmts.blockIp.run(ip, reason)
  },

  unblockIp(ip) {
    stmts.unblockIp.run(ip)
  },

  getStats() {
    return stmts.getStats.get()
  },

  getRecentRequests(limit = 50) {
    return stmts.getRecentRequests.all(limit)
  },

  getBlockedIps() {
    return stmts.getBlockedIps.all()
  },

  getDashboardData(timeFilter, groupFormat) {
    return {
      requests: queryCount(timeFilter),
      avgResponseTime: queryAvgResponseTime(timeFilter),
      errors: queryErrorCount(timeFilter),
      cacheHits: queryCacheHits(timeFilter),
      cacheMisses: queryCacheMisses(timeFilter),
      byInterval: queryByInterval(timeFilter, groupFormat),
      topIps: queryTopIps(timeFilter),
      topPaths: queryTopPaths(timeFilter),
      statusBreakdown: queryStatusBreakdown(timeFilter),
      blockedIps: stmts.getBlockedIps.all(),
      ...stmts.getStats.get(),
    }
  },

  getLastRequestId() {
    return stmts.getLastRequestId.get().id || 0
  },

  getRequestsAfterId(id) {
    return stmts.getRequestsAfterId.all(id)
  },

  getSetting(key) {
    const row = stmts.getSetting.get(key)
    return row ? row.value : null
  },

  getAllSettings() {
    const rows = stmts.getAllSettings.all()
    const result = {}
    for (const row of rows) result[row.key] = row.value
    return result
  },

  setSetting(key, value) {
    stmts.setSetting.run(key, value)
  },

  close() {
    db.close()
  },
}
