const Database = require('better-sqlite3');
const path = require('path');
const { dataDir } = require('../paths');

const dbPath = path.join(dataDir, 'app.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- 建表 ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'mysql',
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 3306,
    user TEXT NOT NULL,
    password TEXT NOT NULL DEFAULT '',
    user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    user_id INTEGER,
    username TEXT,
    conn_id TEXT,
    conn_name TEXT,
    database TEXT,
    sql_type TEXT,
    sql_text TEXT,
    affected INTEGER DEFAULT 0,
    status TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_oplog_created ON operation_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_oplog_user ON operation_log(username);
  CREATE INDEX IF NOT EXISTS idx_oplog_type ON operation_log(sql_type);
`);

// SQL 语句分类（取首条有效语句的首关键字）
function classifySql(sql) {
  if (!sql) return 'OTHER';
  const s = sql.trim().replace(/\/\*[\s\S]*?\*\/|--.*$/gm, '').trim().toUpperCase();
  if (!s) return 'OTHER';
  const m = s.match(/^(SELECT|INSERT|REPLACE|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|USE|SHOW|DESC|DESCRIBE)\b/);
  return m ? (m[1] === 'REPLACE' ? 'INSERT' : m[1] === 'DESCRIBE' ? 'DESC' : m[1]) : 'OTHER';
}

// 记录一条操作日志（同步写入，better-sqlite3 事务安全）
const stmtLog = db.prepare(`INSERT INTO operation_log
  (user_id, username, conn_id, conn_name, database, sql_type, sql_text, affected, status, error)
  VALUES (@userId, @username, @connId, @connName, @database, @sqlType, @sqlText, @affected, @status, @error)`);
function logOperation({ userId, username, connId, connName, database, sqlText, sqlType, affected = 0, status = 'success', error = '' }) {
  try {
    stmtLog.run({
      userId: userId || null,
      username: username || null,
      connId: connId || null,
      connName: connName || null,
      database: database || null,
      sqlType: sqlType || classifySql(sqlText),
      sqlText: (sqlText || '').slice(0, 65000),
      affected: Number(affected) || 0,
      status,
      error: (error || '').slice(0, 1000)
    });
  } catch (e) {
    console.error('[sqlite] logOperation failed:', e.message);
  }
}
db.logOperation = logOperation;
db.classifySql = classifySql;

// --- 初始化默认用户 ---
function initDefaultUser() {
  const exist = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (exist) return;
  db.prepare(
    'INSERT INTO users (username, password, name) VALUES (?, ?, ?)'
  ).run('admin', '123456', '管理员');
  console.log('[sqlite] 已初始化默认用户 admin / 123456');
}
initDefaultUser();

module.exports = db;
