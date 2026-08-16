const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const dbPath = path.join(DB_DIR, 'app.db');
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
`);

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
