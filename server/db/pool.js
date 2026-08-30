const pools = new Map();
const connMeta = new Map(); // id -> 连接配置元信息

function buildPool(conn) {
  // 懒加载：mysql2 体积大，只在真正建连接池时加载，避免拖慢后端启动
  const mysql = require('mysql2/promise');
  return mysql.createPool({
    host: conn.host,
    port: conn.port || 3306,
    user: conn.user,
    password: conn.password == null ? '' : conn.password,
    database: conn.database || undefined,
    waitForConnections: true,
    connectionLimit: 8,
    queueLimit: 0,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    namedPlaceholders: false
  });
}

/**
 * 注册/更新一个连接（创建连接池）
 * @param {string} id 连接唯一 ID
 * @param {object} conn 连接配置
 */
function registerConnection(id, conn) {
  // 若已存在先关闭旧池
  removeConnection(id);
  pools.set(id, buildPool(conn));
  connMeta.set(id, { ...conn });
  return id;
}

function removeConnection(id) {
  const pool = pools.get(id);
  if (pool) {
    pool.end().catch(() => {});
    pools.delete(id);
  }
  connMeta.delete(id);
}

function getPool(id) {
  const pool = pools.get(id);
  if (!pool) {
    const err = new Error('连接不存在或已断开，请先连接数据库');
    err.status = 400;
    throw err;
  }
  return pool;
}

function getMeta(id) {
  return connMeta.get(id);
}

function listConnections() {
  return Array.from(connMeta.entries()).map(([id, v]) => ({ id, ...v, password: undefined }));
}

module.exports = { registerConnection, removeConnection, getPool, getMeta, listConnections };
