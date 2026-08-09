const poolMgr = require('../db/pool');

// 测试连接（一次性连接，不入池）
async function testConnection(conn) {
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({
    host: conn.host,
    port: conn.port || 3306,
    user: conn.user,
    password: conn.password == null ? '' : conn.password,
    database: conn.database || undefined,
    connectTimeout: 5000
  });
  const [rows] = await connection.query('SELECT VERSION() AS version');
  await connection.end();
  return { version: rows[0] && rows[0].version };
}

// 获取所有数据库
async function listDatabases(connId) {
  const pool = poolMgr.getPool(connId);
  const [rows] = await pool.query(
    "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME"
  );
  return rows.map((r) => r.name);
}

// 获取库下所有表
async function listTables(connId, database) {
  const pool = poolMgr.getPool(connId);
  const [rows] = await pool.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS \`rows\`, ENGINE AS engine, TABLE_COMMENT AS comment
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME`,
    [database]
  );
  return rows;
}

// 获取表结构
async function describeTable(connId, database, table) {
  const pool = poolMgr.getPool(connId);
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME AS Field, COLUMN_TYPE AS Type, IS_NULLABLE AS \`Null\`,
       COLUMN_KEY AS \`Key\`, COLUMN_DEFAULT AS \`Default\`, EXTRA AS Extra, COLUMN_COMMENT AS Comment
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [database, table]
  );
  return cols;
}

// 获取表数据（分页）
async function getTableData(connId, database, table, { page = 1, size = 50, order } = {}) {
  const pool = poolMgr.getPool(connId);
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  const [[countRow]] = await pool.query(
    `SELECT COUNT(*) AS total FROM ${quotedDb}.${quotedTable}`
  );
  const total = countRow ? countRow.total : 0;
  const offset = (page - 1) * size;
  let sql = `SELECT * FROM ${quotedDb}.${quotedTable}`;
  const params = [];
  if (order && order.column) {
    sql += ` ORDER BY ${mysqlEscapeId(order.column)} ${order.dir === 'desc' ? 'DESC' : 'ASC'}`;
  }
  sql += ` LIMIT ? OFFSET ?`;
  params.push(Number(size), Number(offset));
  const [rows] = await pool.query(sql, params);
  return { total, page: Number(page), size: Number(size), rows };
}

// 执行任意 SQL（支持多语句，返回结构化结果）
async function executeSql(connId, database, sql) {
  const pool = poolMgr.getPool(connId);
  let conn;
  try {
    conn = await pool.getConnection();
    if (database) await conn.changeUser({ database });
    // 按分号切分（粗略），逐条执行
    const statements = splitSql(sql);
    const results = [];
    for (const stmt of statements) {
      const trimmed = stmt.trim().replace(/;$/, '').trim();
      if (!trimmed) continue;
      const [res] = await conn.query(trimmed);
      if (Array.isArray(res)) {
        // SELECT
        results.push({ type: 'select', rows: res, affected: res.length, fields: extractFields(res) });
      } else {
        // 写操作
        results.push({
          type: 'write',
          affected: res.affectedRows,
          insertId: res.insertId,
          changed: res.changedRows,
          warning: res.warningStatus
        });
      }
    }
    return results;
  } finally {
    if (conn) conn.release();
  }
}

// 导出表数据为 CSV 文本
async function exportTableCsv(connId, database, table, { limit } = {}) {
  const pool = poolMgr.getPool(connId);
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  let sql = `SELECT * FROM ${quotedDb}.${quotedTable}`;
  if (limit) sql += ` LIMIT ${Number(limit)}`;
  const [rows] = await pool.query(sql);
  return rowsToCsv(rows);
}

// 导出查询结果为 CSV 文本
async function exportQueryCsv(connId, database, sql) {
  const pool = poolMgr.getPool(connId);
  let conn;
  try {
    conn = await pool.getConnection();
    if (database) await conn.changeUser({ database });
    const [rows] = await conn.query(sql);
    return rowsToCsv(rows);
  } finally {
    if (conn) conn.release();
  }
}

// 导入 CSV 到指定表（返回插入行数）
async function importTableCsv(connId, database, table, csvText, { replace = false } = {}) {
  const { parse } = require('fast-csv');
  const pool = poolMgr.getPool(connId);
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);

  // 解析 CSV
  const rows = await new Promise((resolve, reject) => {
    const data = [];
    const stream = parse({ headers: true, ignoreEmpty: true })
      .on('error', reject)
      .on('data', (r) => data.push(r))
      .on('end', () => resolve(data));
    stream.write(csvText);
    stream.end();
  });

  if (!rows.length) return { inserted: 0 };

  const columns = Object.keys(rows[0]);
  const colSql = columns.map(mysqlEscapeId).join(', ');
  // mysql2 批量插入：VALUES ? 配合二维数组
  const sql = `${replace ? 'REPLACE' : 'INSERT'} INTO ${quotedDb}.${quotedTable} (${colSql}) VALUES ?`;
  const values = rows.map((r) => columns.map((c) => (r[c] === '' || r[c] == null ? null : r[c])));
  const [res] = await pool.query(sql, [values]);
  return { inserted: res.affectedRows, columns, count: rows.length };
}

// --- 工具函数 ---
function mysqlEscapeId(id) {
  if (id == null) throw new Error('标识符不能为空');
  return '`' + String(id).replace(/`/g, '``') + '`';
}

function splitSql(sql) {
  // 简单按分号切分，忽略字符串内的分号
  const result = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble && !inBack) { inSingle = !inSingle; buf += ch; continue; }
    if (ch === '"' && !inSingle && !inBack) { inDouble = !inDouble; buf += ch; continue; }
    if (ch === '`' && !inSingle && !inDouble) { inBack = !inBack; buf += ch; continue; }
    if (ch === ';' && !inSingle && !inDouble && !inBack) {
      result.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) result.push(buf);
  return result;
}

function extractFields(rows) {
  if (!rows || !rows.length) return [];
  return Object.keys(rows[0]);
}

function rowsToCsv(rows) {
  if (!rows || !rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\r\n');
}

// 批量保存表数据变更（事务执行 insert/update/delete）
// changes: { inserts: [{values}], updates: [{pk, values}], deletes: [{pk}] }
async function saveTable(connId, database, table, changes) {
  const pool = poolMgr.getPool(connId);
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  const { inserts = [], updates = [], deletes = [] } = changes || {};
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    let inserted = 0, updated = 0, deleted = 0;

    for (const ins of inserts) {
      const cols = Object.keys(ins.values || {});
      if (!cols.length) continue;
      const colSql = cols.map(mysqlEscapeId).join(', ');
      const ph = cols.map(() => '?').join(', ');
      const [r] = await conn.query(
        `INSERT INTO ${quotedDb}.${quotedTable} (${colSql}) VALUES (${ph})`,
        cols.map((c) => normalizeVal(ins.values[c]))
      );
      inserted += r.affectedRows;
    }
    for (const upd of updates) {
      const setCols = Object.keys(upd.values || {});
      const pkCols = Object.keys(upd.pk || {});
      if (!setCols.length || !pkCols.length) continue;
      const setSql = setCols.map((c) => `${mysqlEscapeId(c)} = ?`).join(', ');
      const whereSql = pkCols.map((c) => `${mysqlEscapeId(c)} = ?`).join(' AND ');
      const params = setCols.map((c) => normalizeVal(upd.values[c]))
        .concat(pkCols.map((c) => normalizeVal(upd.pk[c])));
      const [r] = await conn.query(
        `UPDATE ${quotedDb}.${quotedTable} SET ${setSql} WHERE ${whereSql}`,
        params
      );
      updated += r.affectedRows;
    }
    for (const del of deletes) {
      const pkCols = Object.keys(del.pk || {});
      if (!pkCols.length) continue;
      const whereSql = pkCols.map((c) => `${mysqlEscapeId(c)} = ?`).join(' AND ');
      const [r] = await conn.query(
        `DELETE FROM ${quotedDb}.${quotedTable} WHERE ${whereSql}`,
        pkCols.map((c) => normalizeVal(del.pk[c]))
      );
      deleted += r.affectedRows;
    }
    await conn.commit();
    return { inserted, updated, deleted };
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    throw e;
  } finally {
    if (conn) conn.release();
  }
}

// 提交值规范化：空串转 null
function normalizeVal(v) {
  if (v === '' || v == null) return null;
  return v;
}

// 单条 UPDATE（按主键条件，values 是字段名→值）
async function updateRow(connId, database, table, pk, values) {
  const pool = poolMgr.getPool(connId);
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  const pkKeys = Object.keys(pk || {});
  const valueKeys = Object.keys(values || {});
  if (!pkKeys.length) throw new Error('主键不能为空，无法定位更新的行');
  if (!valueKeys.length) return { updated: 0 };
  const setSql = valueKeys.map((c) => `${mysqlEscapeId(c)} = ?`).join(', ');
  const whereSql = pkKeys.map((c) => `${mysqlEscapeId(c)} = ?`).join(' AND ');
  const sql = `UPDATE ${quotedDb}.${quotedTable} SET ${setSql} WHERE ${whereSql} LIMIT 1`;
  const params = [...valueKeys.map((c) => normalizeVal(values[c])), ...pkKeys.map((c) => pk[c])];
  const [res] = await pool.query(sql, params);
  return { updated: res.affectedRows || 0 };
}

// 单条 INSERT（values 是字段名→值）
async function insertRow(connId, database, table, values) {
  const pool = poolMgr.getPool(connId);
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  const keys = Object.keys(values || {});
  if (!keys.length) throw new Error('插入值不能为空');
  const colSql = keys.map(mysqlEscapeId).join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const params = keys.map((c) => normalizeVal(values[c]));
  const sql = `INSERT INTO ${quotedDb}.${quotedTable} (${colSql}) VALUES (${placeholders})`;
  const [res] = await pool.query(sql, params);
  return { inserted: res.affectedRows || 0, insertId: res.insertId };
}

// 单条 DELETE（按主键条件）
async function deleteRow(connId, database, table, pk) {
  const pool = poolMgr.getPool(connId);
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  const pkKeys = Object.keys(pk || {});
  if (!pkKeys.length) throw new Error('主键不能为空，无法定位删除的行');
  const whereSql = pkKeys.map((c) => `${mysqlEscapeId(c)} = ?`).join(' AND ');
  const sql = `DELETE FROM ${quotedDb}.${quotedTable} WHERE ${whereSql} LIMIT 1`;
  const params = pkKeys.map((c) => pk[c]);
  const [res] = await pool.query(sql, params);
  return { deleted: res.affectedRows || 0 };
}

// 新建表（columns: [{ name, type, nullable, pk, autoIncrement, comment }]）
async function createTable(connId, database, table, columns) {
  const pool = poolMgr.getPool(connId);
  if (!table) throw new Error('表名不能为空');
  if (!Array.isArray(columns) || !columns.length) throw new Error('字段不能为空');
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  const colDefs = columns.map((c) => {
    if (!c.name) throw new Error('字段名不能为空');
    if (!c.type) throw new Error('字段类型不能为空');
    let def = `${mysqlEscapeId(c.name)} ${c.type}`;
    def += (c.nullable === false || c.pk) ? ' NOT NULL' : ' NULL';
    if (c.autoIncrement) def += ' AUTO_INCREMENT';
    if (c.comment) def += ` COMMENT '${String(c.comment).replace(/'/g, "''")}'`;
    return def;
  });
  const pkCols = columns.filter((c) => c.pk).map((c) => mysqlEscapeId(c.name));
  let sql = `CREATE TABLE ${quotedDb}.${quotedTable} (\n  ${colDefs.join(',\n  ')}`;
  if (pkCols.length) sql += `,\n  PRIMARY KEY (${pkCols.join(', ')})`;
  sql += `\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
  await pool.query(sql);
  return { created: 1 };
}

// 删除表
async function dropTable(connId, database, table) {
  const pool = poolMgr.getPool(connId);
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  await pool.query(`DROP TABLE IF EXISTS ${quotedDb}.${quotedTable}`);
  return { dropped: 1 };
}

// 清空表
async function truncateTable(connId, database, table) {
  const pool = poolMgr.getPool(connId);
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  await pool.query(`TRUNCATE TABLE ${quotedDb}.${quotedTable}`);
  return { truncated: 1 };
}

// 复制表（结构 + 数据）
async function copyTable(connId, database, srcTable, destTable) {
  const pool = poolMgr.getPool(connId);
  if (!destTable) throw new Error('新表名不能为空');
  const quotedDb = mysqlEscapeId(database);
  const quotedSrc = mysqlEscapeId(srcTable);
  const quotedDest = mysqlEscapeId(destTable);
  await pool.query(`CREATE TABLE ${quotedDb}.${quotedDest} LIKE ${quotedDb}.${quotedSrc}`);
  await pool.query(`INSERT INTO ${quotedDb}.${quotedDest} SELECT * FROM ${quotedDb}.${quotedSrc}`);
  return { copied: 1 };
}

// 重命名表
async function renameTable(connId, database, oldName, newName) {
  const pool = poolMgr.getPool(connId);
  if (!newName) throw new Error('新表名不能为空');
  const quotedDb = mysqlEscapeId(database);
  const quotedOld = mysqlEscapeId(oldName);
  const quotedNew = mysqlEscapeId(newName);
  await pool.query(`RENAME TABLE ${quotedDb}.${quotedOld} TO ${quotedDb}.${quotedNew}`);
  return { renamed: 1 };
}

// 标识符白名单校验（用于字符集等非引号包裹的标识符）
function validateIdent(name) {
  if (!/^[A-Za-z0-9_]+$/.test(String(name))) throw new Error('标识符不合法');
  return String(name);
}

// 新建数据库
async function createDatabase(connId, name, charset) {
  const pool = poolMgr.getPool(connId);
  if (!name) throw new Error('数据库名不能为空');
  const quotedName = mysqlEscapeId(name);
  let sql = `CREATE DATABASE ${quotedName}`;
  if (charset) sql += ` CHARACTER SET ${validateIdent(charset)}`;
  await pool.query(sql);
  return { created: 1 };
}

// 删除数据库
async function dropDatabase(connId, name) {
  const pool = poolMgr.getPool(connId);
  if (!name) throw new Error('数据库名不能为空');
  const quotedName = mysqlEscapeId(name);
  await pool.query(`DROP DATABASE IF EXISTS ${quotedName}`);
  return { dropped: 1 };
}

// 编辑数据库（修改默认字符集）
async function alterDatabase(connId, name, charset) {
  const pool = poolMgr.getPool(connId);
  if (!charset) throw new Error('字符集不能为空');
  const quotedName = mysqlEscapeId(name);
  await pool.query(`ALTER DATABASE ${quotedName} CHARACTER SET ${validateIdent(charset)}`);
  return { altered: 1 };
}

// 获取数据库字符集信息
async function getDatabaseInfo(connId, name) {
  const pool = poolMgr.getPool(connId);
  const [rows] = await pool.query(
    `SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation
     FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
    [name]
  );
  return rows[0] || null;
}

module.exports = {
  testConnection,
  listDatabases,
  listTables,
  describeTable,
  getTableData,
  executeSql,
  exportTableCsv,
  exportQueryCsv,
  importTableCsv,
  saveTable,
  updateRow,
  insertRow,
  deleteRow,
  createTable,
  dropTable,
  truncateTable,
  copyTable,
  renameTable,
  createDatabase,
  dropDatabase,
  alterDatabase,
  getDatabaseInfo
};
