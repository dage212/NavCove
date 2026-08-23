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
  const [tables] = await pool.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_COMMENT AS comment
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME`,
    [database]
  );
  // information_schema.TABLE_ROWS 对 InnoDB 是估算值，且写入后不会立即刷新
  // （需要 ANALYZE TABLE 才更新），会误导用户。这里改用 SELECT COUNT(*) 取精确行数。
  // 视图等无法 COUNT 的对象，try/catch 兜底返回 null。
  const quotedDb = mysqlEscapeId(database);
  const counts = await Promise.all(tables.map(async (t) => {
    try {
      const [r] = await pool.query(`SELECT COUNT(*) AS c FROM ${quotedDb}.${mysqlEscapeId(t.name)}`);
      return r[0] ? Number(r[0].c) : 0;
    } catch (e) {
      return null; // 视图/出错：行数未知
    }
  }));
  return tables.map((t, i) => ({ ...t, rows: counts[i] }));
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

// 导出查询结果为 SQL（INSERT 语句）
// tableName 为可选目标表名（单表查询时由前端解析传入）；缺省用 query_result
async function exportQuerySql(connId, database, sql, tableName) {
  const pool = poolMgr.getPool(connId);
  let conn;
  try {
    conn = await pool.getConnection();
    if (database) await conn.changeUser({ database });
    const [rows] = await conn.query(sql);
    let out = '\ufeff';
    out += '-- SQL Dump: query result\n';
    out += `-- Generated at ${new Date().toISOString()}\n`;
    out += 'SET NAMES utf8mb4;\n';
    out += 'SET FOREIGN_KEY_CHECKS = 0;\n\n';
    if (!rows.length) {
      out += '-- 无数据\n';
      return out;
    }
    const fields = Object.keys(rows[0]);
    const colNames = fields.map((f) => mysqlEscapeId(f)).join(', ');
    const quotedTable = mysqlEscapeId(tableName || 'query_result');
    const columns = fields.map((name) => ({ name }));
    const maxRowsPerInsert = 100;
    for (let i = 0; i < rows.length; i += maxRowsPerInsert) {
      const chunk = rows.slice(i, i + maxRowsPerInsert);
      const valuesList = chunk.map((r) => rowToValuesList(columns, r)).join(',\n');
      out += `INSERT INTO ${quotedTable} (${colNames}) VALUES\n${valuesList};\n`;
    }
    out += '\nSET FOREIGN_KEY_CHECKS = 1;\n';
    return out;
  } finally {
    if (conn) conn.release();
  }
}

// 流式导出表数据为 CSV（大数据量方案）
// 返回一个可读流：BOM + CSV 行流，调用方直接 pipe 到 HTTP 响应
function exportTableCsvStream(connId, database, table, { limit } = {}) {
  // 取连接配置（同时校验连接是否存在）
  const meta = poolMgr.getMeta(connId);
  // 必须用 mysql2 回调版（非 /promise）：promise 版的 conn.query 返回 Promise，没有 .stream()
  const mysql = require('mysql2');
  const { PassThrough, Transform } = require('stream');
  const { format } = require('@fast-csv/format');

  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  let sql = `SELECT * FROM ${quotedDb}.${quotedTable}`;
  if (limit) sql += ` LIMIT ${Number(limit)}`;

  const out = new PassThrough();

  // 用独立 raw 连接做流式查询（不入池，查询结束即 end）
  const rawConn = mysql.createConnection({
    host: meta.host,
    port: meta.port || 3306,
    user: meta.user,
    password: meta.password == null ? '' : meta.password,
    database: database, // 直接连目标库，省去 changeUser
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true
  });

  let finished = false;
  function cleanup() {
    if (finished) return;
    finished = true;
    try { rawConn.end(); } catch (e) {}
  }

  // 连接级错误（如密码错误、连不上）会从 rawConn 的 'error' 事件抛出
  rawConn.on('error', (err) => {
    cleanup();
    out.destroy(err);
  });

  // BOM 用 Transform 注入到 CSV 第一块数据之前
  // 这样查询失败时（未产出任何行）不会提前写 BOM，Koa 仍可返回错误响应
  const bomInserter = new Transform({
    transform(chunk, enc, cb) {
      if (!this._bomDone) {
        this.push('\ufeff');
        this._bomDone = true;
      }
      this.push(chunk);
      cb();
    }
  });

  // mysql2 回调版：conn.query(sql) 同步返回 Query 对象，.stream() 返回行流
  const queryStream = rawConn.query(sql).stream();
  const csvStream = format({ headers: true });

  queryStream.on('error', (err) => {
    cleanup();
    // destroy 下游，传播错误
    csvStream.destroy(err);
  });
  csvStream.on('error', (err) => {
    cleanup();
    bomInserter.destroy(err);
  });
  bomInserter.on('error', (err) => {
    cleanup();
    out.destroy(err);
  });

  queryStream.pipe(csvStream).pipe(bomInserter).pipe(out);

  out.on('finish', cleanup);
  out.on('close', () => {
    try { queryStream.destroy(); } catch (e) {}
    cleanup();
  });

  return out;
}

// 导入 CSV 到指定表（内存版，仍保留用于兼容小文件文本导入）
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

  // 查询 datetime/timestamp/date 列，导入时对非标准日期格式做转换
  let dateCols = new Set();
  try {
    const [colRows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       AND DATA_TYPE IN ('datetime','timestamp','date')`,
      [database, table]
    );
    dateCols = new Set(colRows.map((r) => r.COLUMN_NAME));
  } catch (e) {}

  const colSql = columns.map(mysqlEscapeId).join(', ');
  let sql;
  if (replace) {
    const updateSql = columns.map((c) => `${mysqlEscapeId(c)}=VALUES(${mysqlEscapeId(c)})`).join(', ');
    sql = `INSERT INTO ${quotedDb}.${quotedTable} (${colSql}) VALUES ? ON DUPLICATE KEY UPDATE ${updateSql}`;
  } else {
    sql = `INSERT INTO ${quotedDb}.${quotedTable} (${colSql}) VALUES ?`;
  }
  const values = rows.map((r) => columns.map((c) => {
    const raw = (r[c] === '' || r[c] == null ? null : r[c]);
    if (raw != null && dateCols.has(c)) return normalizeDate(raw);
    return raw;
  }));
  const [res] = await pool.query(sql, [values]);
  return { inserted: res.affectedRows, columns, count: rows.length };
}

/**
 * 流式导入 CSV 文件（大数据量 + 断点续传文件合并后调用）
 * @param {string} connId  连接 ID
 * @param {string} database 目标库
 * @param {string} table   目标表
 * @param {string} filePath CSV 绝对路径（切片合并后的文件）
 * @param {object} opt
 * @param {boolean} opt.replace 是否 REPLACE 模式
 * @param {number} opt.batchSize 每批行数，默认 1000
 * @returns {Promise<{inserted:number,count:number,columns:string[]}>}
 */
async function importCsvFileStream(connId, database, table, filePath, { replace = false, batchSize = 1000 } = {}) {
  const pool = poolMgr.getPool(connId);
  // 查询 datetime/timestamp/date 列，导入时对非标准日期格式做转换（如 DD/MM/YYYY）
  let dateCols = new Set();
  try {
    const [colRows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       AND DATA_TYPE IN ('datetime','timestamp','date')`,
      [database, table]
    );
    dateCols = new Set(colRows.map((r) => r.COLUMN_NAME));
  } catch (e) {}
  // 临时文件日志
  const debugLog = (msg) => { try { require('fs').appendFileSync(require('path').join(__dirname, '..', 'data', 'uploads', 'debug.log'), new Date().toISOString() + ' [import] ' + msg + '\n'); } catch (e) {} };
  debugLog('importCsvFileStream start, filePath: ' + filePath + ', batchSize: ' + batchSize);

  // 测试连接池是否正常
  try {
    const [testRes] = await pool.query('SELECT 1 AS test');
    debugLog('pool.query SELECT 1 OK: ' + JSON.stringify(testRes));
  } catch (e) {
    debugLog('pool.query SELECT 1 FAILED: ' + e.message);
    throw e;
  }

  return new Promise((resolve, reject) => {
    const quotedDb = mysqlEscapeId(database);
    const quotedTable = mysqlEscapeId(table);
    const fs = require('fs');
    const { parse } = require('fast-csv');

    const parser = parse({ headers: true, ignoreEmpty: true, trim: true });
    const readStream = fs.createReadStream(filePath, 'utf8');

    let columns = null;
    let count = 0;          // 总行数
    let inserted = 0;       // 累计受影响行数
    let buffer = [];        // 当前批次缓存
    let activeTask = null;  // 当前正在执行的 INSERT Promise（串行防并发）
    let aborted = false;
    let parserEnded = false;
    let insertSql = null;

    function buildInsertSql(cols) {
      const colSql = cols.map(mysqlEscapeId).join(', ');
      if (replace) {
        // 使用 INSERT ... ON DUPLICATE KEY UPDATE 替代 REPLACE INTO
        // REPLACE 对每条已存在记录执行 DELETE+INSERT，大批量时极慢且易超时
        // ON DUPLICATE KEY UPDATE 原地更新，性能更优
        const updateSql = cols.map((c) => `${mysqlEscapeId(c)}=VALUES(${mysqlEscapeId(c)})`).join(', ');
        return `INSERT INTO ${quotedDb}.${quotedTable} (${colSql}) VALUES ? ON DUPLICATE KEY UPDATE ${updateSql}`;
      }
      return `INSERT INTO ${quotedDb}.${quotedTable} (${colSql}) VALUES ?`;
    }

    function flushBatch(releaseConn, conn) {
      if (!buffer.length) return Promise.resolve();
      const rows = buffer;
      buffer = [];
      const values = rows.map((r) => columns.map((c) => {
        const raw = (r[c] === '' || r[c] == null ? null : r[c]);
        // 对日期类型列做格式转换（CSV 常见 DD/MM/YYYY 等非标准格式）
        if (raw != null && dateCols.has(c)) return normalizeDate(raw);
        return raw;
      }));
      const sql = insertSql;
      debugLog('flushBatch start, rows: ' + rows.length + ', values dims: ' + values.length + 'x' + (values[0] ? values[0].length : 0));
      activeTask = (releaseConn && conn && conn.query)
        ? conn.query(sql, [values])
          .then(([res]) => { inserted += res.affectedRows; debugLog('flushBatch done, affected: ' + res.affectedRows + ', total inserted: ' + inserted); })
          .catch((e) => { debugLog('flushBatch CATCH(conn): ' + e.message + ' | code: ' + e.code + ' | sqlMessage: ' + e.sqlMessage); throw e; })
        : pool.query(sql, [values])
          .then(([res]) => { inserted += res.affectedRows; debugLog('flushBatch done, affected: ' + res.affectedRows + ', total inserted: ' + inserted); })
          .catch((e) => { debugLog('flushBatch CATCH(pool): ' + e.message + ' | code: ' + e.code + ' | sqlMessage: ' + e.sqlMessage); throw e; });
      return activeTask;
    }

    // 用独立连接以保证同一事务/同一会话（池里不同连接不影响）
    let sharedConn;
    let poolCleanup = null;

    parser.on('error', (err) => {
      debugLog('parser error: ' + err.message);
      aborted = true;
      reject(err);
    });

    parser.on('headers', (headers) => {
      columns = headers.map((h) => String(h).replace(/^\ufeff/, '')); // 兼容 BOM
      insertSql = buildInsertSql(columns);
      debugLog('headers: ' + columns.join(','));
    });

    parser.on('data', async (row) => {
      if (aborted) return;
      count++;
      buffer.push(row);
      if (buffer.length >= batchSize) {
        // 暂停流，等上一批写完
        parser.pause();
        debugLog('data paused at count: ' + count + ', buffer: ' + buffer.length);
        try {
          await flushBatch();
        } catch (e) {
          debugLog('flushBatch FAILED in data: ' + e.message);
          aborted = true;
          if (sharedConn) try { sharedConn.release(); } catch (e) {}
          reject(e);
          return;
        }
        parser.resume();
      }
    });

    parser.on('end', async () => {
      parserEnded = true;
      debugLog('parser end, count: ' + count + ', buffer remaining: ' + buffer.length);
      if (aborted) return;
      try {
        // flush 剩余
        if (buffer.length) await flushBatch();
        debugLog('import resolve, inserted: ' + inserted + ', count: ' + count);
        resolve({ inserted, count, columns: columns || [] });
      } catch (e) {
        debugLog('flushBatch FAILED in end: ' + e.message);
        aborted = true;
        reject(e);
      }
    });

    readStream.on('error', (err) => {
      debugLog('readStream error: ' + err.message);
      aborted = true;
      reject(err);
    });

    readStream.pipe(parser);
    debugLog('readStream.pipe(parser) done');
  });
}

// --- 工具函数 ---
function mysqlEscapeId(id) {
  if (id == null) throw new Error('标识符不能为空');
  return '`' + String(id).replace(/`/g, '``') + '`';
}

function splitSql(sql) {
  const result = [];
  let buf = '';
  let delimiter = ';';
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  let inLineComment = false;
  let inBlockComment = false;

  const pushStatement = () => {
    if (buf.trim()) result.push(buf.trim());
    buf = '';
  };

  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      buf += ch;
      i++;
      if (ch === '\n' || ch === '\r') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      buf += ch;
      i++;
      if (ch === '*' && next === '/') {
        buf += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (!inSingle && !inDouble && !inBack) {
      if ((ch === '-' && next === '-') || ch === '#') {
        inLineComment = true;
        buf += ch;
        i++;
        if (ch === '-') { buf += next; i++; }
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        buf += ch + next;
        i += 2;
        continue;
      }
      const atLineStart = i === 0 || sql[i - 1] === '\n';
      if (atLineStart) {
        const lineEnd = sql.indexOf('\n', i);
        const line = sql.slice(i, lineEnd < 0 ? sql.length : lineEnd);
        const delimiterMatch = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
        if (delimiterMatch) {
          delimiter = delimiterMatch[1];
          i += line.length;
          if (sql[i] === '\n') i++;
          continue;
        }
      }
    }
    if ((inSingle || inDouble) && ch === '\\') {
      buf += ch;
      if (next !== undefined) { buf += next; i += 2; } else i++;
      continue;
    }
    if (inSingle && ch === "'" && next === "'") {
      buf += "''";
      i += 2;
      continue;
    }
    if (inDouble && ch === '"' && next === '"') {
      buf += '""';
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble && !inBack) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBack) inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble) inBack = !inBack;
    if (!inSingle && !inDouble && !inBack && sql.startsWith(delimiter, i)) {
      pushStatement();
      i += delimiter.length;
      continue;
    }
    buf += ch;
    i++;
  }
  pushStatement();
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
    const sqls = [];

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
      sqls.push(`INSERT INTO ${quotedDb}.${quotedTable} (${colSql}) VALUES (${cols.map((c) => sqlStringLiteral(normalizeVal(ins.values[c]))).join(', ')})`);
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
      sqls.push(`UPDATE ${quotedDb}.${quotedTable} SET ${setCols.map((c) => `${mysqlEscapeId(c)} = ${sqlStringLiteral(normalizeVal(upd.values[c]))}`).join(', ')} WHERE ${pkCols.map((c) => `${mysqlEscapeId(c)} = ${sqlStringLiteral(upd.pk[c])}`).join(' AND ')}`);
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
      sqls.push(`DELETE FROM ${quotedDb}.${quotedTable} WHERE ${pkCols.map((c) => `${mysqlEscapeId(c)} = ${sqlStringLiteral(del.pk[c])}`).join(' AND ')}`);
    }
    await conn.commit();
    return { inserted, updated, deleted, sql: sqls.join('; ') };
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

/**
 * 转换 CSV 中的非标准日期格式到 MySQL 标准格式（YYYY-MM-DD HH:mm:ss）
 * 支持：
 *   DD/MM/YYYY            -> YYYY-MM-DD
 *   DD/MM/YYYY HH:mm:ss  -> YYYY-MM-DD HH:mm:ss
 *   DD-MM-YYYY HH:mm:ss  -> YYYY-MM-DD HH:mm:ss（欧洲格式）
 *   其它格式（含已是 YYYY-MM-DD 的）原样返回
 */
function normalizeDate(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return v;
  // DD/MM/YYYY 或 DD/MM/YYYY HH:mm:ss（分隔符 / 或 -）
  const m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{1,2}):(\d{1,2}))?$/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = m[3];
    const date = `${yyyy}-${mm}-${dd}`;
    if (m[4]) {
      const hh = m[4].padStart(2, '0');
      const mi = m[5].padStart(2, '0');
      const ss = m[6].padStart(2, '0');
      return `${date} ${hh}:${mi}:${ss}`;
    }
    return date;
  }
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
  if (!valueKeys.length) return { updated: 0, sql: '' };
  const setSql = valueKeys.map((c) => `${mysqlEscapeId(c)} = ?`).join(', ');
  const whereSql = pkKeys.map((c) => `${mysqlEscapeId(c)} = ?`).join(' AND ');
  const sql = `UPDATE ${quotedDb}.${quotedTable} SET ${setSql} WHERE ${whereSql} LIMIT 1`;
  const params = [...valueKeys.map((c) => normalizeVal(values[c])), ...pkKeys.map((c) => pk[c])];
  const [res] = await pool.query(sql, params);
  // 拼接带实际值的完整 SQL（用于审计日志）
  const setFull = valueKeys.map((c) => `${mysqlEscapeId(c)} = ${sqlStringLiteral(normalizeVal(values[c]))}`).join(', ');
  const whereFull = pkKeys.map((c) => `${mysqlEscapeId(c)} = ${sqlStringLiteral(pk[c])}`).join(' AND ');
  const fullSql = `UPDATE ${quotedDb}.${quotedTable} SET ${setFull} WHERE ${whereFull} LIMIT 1`;
  return { updated: res.affectedRows || 0, sql: fullSql };
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
  // 拼接带实际值的完整 SQL（用于审计日志）
  const valSql = keys.map((c) => sqlStringLiteral(normalizeVal(values[c]))).join(', ');
  const fullSql = `INSERT INTO ${quotedDb}.${quotedTable} (${colSql}) VALUES (${valSql})`;
  return { inserted: res.affectedRows || 0, insertId: res.insertId, sql: fullSql };
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
  // 拼接带实际值的完整 SQL（用于审计日志）
  const whereFull = pkKeys.map((c) => `${mysqlEscapeId(c)} = ${sqlStringLiteral(pk[c])}`).join(' AND ');
  const fullSql = `DELETE FROM ${quotedDb}.${quotedTable} WHERE ${whereFull} LIMIT 1`;
  return { deleted: res.affectedRows || 0, sql: fullSql };
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

// 查看库结构：SHOW CREATE DATABASE + 字符集 + 表列表
async function getDatabaseStructure(connId, database) {
  const pool = poolMgr.getPool(connId);
  const quotedDb = '`' + String(database).replace(/`/g, '') + '`';
  const [[createRow]] = await pool.query(`SHOW CREATE DATABASE ${quotedDb}`);
  const createSql = (createRow && (createRow['Create Database'] || createRow['Create Database'] || '')) || '';
  const info = await getDatabaseInfo(connId, database);
  const [tblRows] = await pool.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_COLLATION AS collation,
            TABLE_COMMENT AS comment, CREATE_OPTIONS AS createOptions
     FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [database]
  );
  return { createSql, charset: info?.charset || null, collation: info?.collation || null, tables: tblRows };
}

// 查看表结构：SHOW CREATE TABLE + 列详情 + 索引信息
async function getTableStructure(connId, database, table) {
  const pool = poolMgr.getPool(connId);
  const quotedDb = '`' + String(database).replace(/`/g, '') + '`';
  const quotedTbl = '`' + String(table).replace(/`/g, '') + '`';
  const [[createRow]] = await pool.query(`SHOW CREATE TABLE ${quotedDb}.${quotedTbl}`);
  const createSql = (createRow && (createRow['Create Table'] || createRow['Create View'] || '')) || '';
  const columns = await describeTable(connId, database, table);
  const [idxRows] = await pool.query(
    `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS columnName,
            INDEX_TYPE AS indexType, NULLABLE AS nullable, COMMENT AS comment
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [database, table]
  );
  return { createSql, columns, indexes: idxRows };
}

module.exports = {
  testConnection,
  listDatabases,
  listTables,
  describeTable,
  getTableData,
  executeSql,
  exportTableCsv,
  exportTableCsvStream,
  exportQueryCsv,
  exportQuerySql,
  importTableCsv,
  importCsvFileStream,
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
  getDatabaseInfo,
  getDatabaseStructure,
  getTableStructure,
  exportTableSqlStream,
  exportDatabaseSqlStream
};

// ======================================================
// SQL 导出（库级 / 表级，流式 + 可选项：schema/data）
// ======================================================

// 把任意字符串安全转成 SQL 字符串字面量（含 NULL 处理）
function sqlStringLiteral(val) {
  if (val === null || val === undefined) return 'NULL';
  if (val instanceof Buffer) {
    return '0x' + val.toString('hex');
  }
  if (typeof val === 'number' || typeof val === 'bigint' || typeof val === 'boolean') {
    if (Number.isNaN(val) || !isFinite(val)) return 'NULL';
    return String(val);
  }
  if (val instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    const s = val.getFullYear() + '-' + pad(val.getMonth() + 1) + '-' + pad(val.getDate()) +
      ' ' + pad(val.getHours()) + ':' + pad(val.getMinutes()) + ':' + pad(val.getSeconds());
    return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }
  // 字符串 / 其它
  let s = String(val);
  // 转义反斜杠 + 单引号 + 控制字符
  s = s.replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\u0000/g, '\\0')
    .replace(/\u0008/g, '\\b')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u001a/g, '\\Z');
  return "'" + s + "'";
}

// 返回值转 INSERT 里的 (col1, col2, ...) 行
function rowToValuesList(columns, row) {
  const parts = [];
  for (const c of columns) {
    parts.push(sqlStringLiteral(row[c.name]));
  }
  return '(' + parts.join(', ') + ')';
}

/**
 * 流式导出单张表为 SQL 文件
 * @param {string} connId
 * @param {string} database
 * @param {string} table
 * @param {Object} opts
 * @param {boolean} opts.withSchema 导出建表 DDL
 * @param {boolean} opts.withData   导出数据 INSERT
 * @param {number} opts.maxRowsPerInsert 每个 INSERT 包含的行数（默认 100）
 * @returns {Readable} SQL 文本可读流（开头 UTF-8 BOM）
 */
function exportTableSqlStream(connId, database, table, opts = {}) {
  const meta = poolMgr.getMeta(connId);
  const { withSchema = true, withData = true, limit, maxRowsPerInsert = 100 } = opts;
  if (!withSchema && !withData) {
    const { PassThrough } = require('stream');
    const s = new PassThrough();
    s.end('\ufeff-- 未选择任何导出项（结构/数据）\n');
    return s;
  }
  const mysql = require('mysql2');
  const { PassThrough, Transform, Readable } = require('stream');

  // 头部写入 BOM + 注释；后续写入建表语句 / 数据语句
  const out = new PassThrough();
  let header = '\ufeff';
  header += `-- SQL Dump: \`${database}\`.\`${table}\`\n`;
  header += `-- Generated at ${new Date().toISOString()}\n`;
  header += `SET NAMES utf8mb4;\n`;
  header += `SET FOREIGN_KEY_CHECKS = 0;\n\n`;
  out.write(header);

  let rawConn = null;
  const metaPool = poolMgr.getPool(connId); // promise pool，用来跑 SHOW CREATE / SHOW COLUMNS 小查询
  const quotedDb = '`' + String(database).replace(/`/g, '') + '`';
  const quotedTbl = '`' + String(table).replace(/`/g, '') + '`';

  (async () => {
    try {
      // 1) 建表语句
      if (withSchema) {
        out.write(`-- Table structure for ${quotedDb}.${quotedTbl}\n`);
        out.write(`DROP TABLE IF EXISTS ${quotedDb}.${quotedTbl};\n`);
        const [[row]] = await metaPool.query(
          `SHOW CREATE TABLE ${quotedDb}.${quotedTbl}`
        );
        const ddl = (row && (row['Create Table'] || row['Create View'] || '')) || '';
        if (!ddl) throw new Error('无法获取 ' + table + ' 的建表语句');
        out.write(ddl + ';\n\n');
      }

      // 2) 数据 INSERT（流式）
      if (withData) {
        out.write(`-- Dumping data for ${quotedDb}.${quotedTbl}\n`);
        // 拿列定义（用于构造 INSERT 的列名顺序、值顺序）
        const cols = await describeTable(connId, database, table);
        if (!cols.length) {
          out.write(`-- 表无列定义，跳过数据\n\n`);
        } else {
          const colNames = cols.map((c) => '`' + String(c.Field).replace(/`/g, '') + '`');
          const columns = cols.map((c) => ({ name: c.Field }));
          const insertHead = `INSERT INTO ${quotedTbl} (${colNames.join(', ')}) VALUES\n`;

          // 开一条独立 mysql2 回调连接用于流式查询
          await new Promise((resolve, reject) => {
            rawConn = mysql.createConnection({
              host: meta.host, port: meta.port || 3306,
              user: meta.user, password: meta.password == null ? '' : String(meta.password),
              database, charset: 'utf8mb4'
            });
            rawConn.connect((err) => { if (err) reject(err); else resolve(); });
          });

          // 流式分页：每 maxRowsPerInsert 行写成一条独立的 INSERT 语句
          let rowBuffer = [];
          let anyData = false;

          function flushBuffer() {
            if (!rowBuffer.length) return true;
            // 每批输出完整的 INSERT 语句：INSERT INTO ... VALUES (..),(..),...;
            let ok = out.write(insertHead);
            ok = out.write(rowBuffer.join(',\n')) && ok;
            ok = out.write(';\n') && ok;
            anyData = true;
            rowBuffer = [];
            return ok;
          }

          await new Promise((resolve, reject) => {
            let dataSql = `SELECT * FROM ${quotedDb}.${quotedTbl}`;
            if (limit && limit > 0) dataSql += ` LIMIT ${Number(limit)}`;
            const queryStream = rawConn.query(dataSql).stream();
            queryStream.on('error', reject);
            // 注意：.stream() 返回的是 Readable，事件是 'data'/'end'/'error'
            // （'result' 是 Query 对象的事件，流式查询不会触发，会导致永远卡住）
            queryStream.on('data', (row) => {
              rowBuffer.push(rowToValuesList(columns, row));
              if (rowBuffer.length >= maxRowsPerInsert) {
                // 背压：暂停流，等 out 可写后再恢复
                queryStream.pause();
                const canContinue = flushBuffer();
                if (canContinue) {
                  queryStream.resume();
                } else {
                  out.once('drain', () => queryStream.resume());
                }
              }
            });
            queryStream.on('end', () => {
              // 先 flush 最后一小段
              try {
                flushBuffer();
                if (anyData) out.write('\n');
                else out.write(`-- 表无数据\n\n`);
                resolve();
              } catch (e) { reject(e); }
            });
          });
        }
      }

      out.write(`SET FOREIGN_KEY_CHECKS = 1;\n`);
      out.write(`-- Dump completed: ${quotedDb}.${quotedTbl}\n`);
      out.end();
    } catch (err) {
      out.destroy(err);
    } finally {
      if (rawConn) { try { rawConn.end(() => {}); } catch (e) {} rawConn = null; }
    }
  })();

  return out;
}

/**
 * 流式导出整库 SQL（顺序：CREATE DATABASE → 逐表 exportTableSqlStream）
 */
function exportDatabaseSqlStream(connId, database, opts = {}) {
  const { withSchema = true, withData = true, limit, maxRowsPerInsert = 100 } = opts;
  const meta = poolMgr.getMeta(connId);
  const { Readable, PassThrough } = require('stream');

  if (!withSchema && !withData) {
    const s = new PassThrough();
    s.end('\ufeff-- 未选择任何导出项（结构/数据）\n');
    return s;
  }

  const out = new PassThrough();
  const quotedDb = '`' + String(database).replace(/`/g, '') + '`';

  (async () => {
    try {
      out.write('\ufeff');
      out.write(`-- SQL Dump: Database ${quotedDb}\n`);
      out.write(`-- Generated at ${new Date().toISOString()}\n`);
      out.write(`SET NAMES utf8mb4;\n`);
      out.write(`SET FOREIGN_KEY_CHECKS = 0;\n\n`);

      // CREATE DATABASE 语句（仅 withSchema 时导出）
      if (withSchema) {
        out.write(`-- Database structure for ${quotedDb}\n`);
        out.write(`CREATE DATABASE /*!32312 IF NOT EXISTS*/ ${quotedDb} /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\n`);
        out.write(`USE ${quotedDb};\n\n`);
      }

      // 拉库下表列表
      const pool = poolMgr.getPool(connId);
      const [tblRows] = await pool.query(
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [database]
      );
      const tableNames = tblRows.map((r) => r.name);

      out.write(`-- Tables: ${tableNames.length || 0}\n\n`);

      // 串行逐表（避免流式开多条连接）；把每张表的 SQL 流 pipe 进去
      for (let i = 0; i < tableNames.length; i++) {
        const tbl = tableNames[i];
        out.write(`-- ========== [${i + 1}/${tableNames.length}] ${quotedDb}.\`${tbl}\` ==========\n`);
        const tableStream = exportTableSqlStream(connId, database, tbl, { withSchema, withData, limit, maxRowsPerInsert });
        // 表里的 BOM / 头注释会重复，这里在 pipe 前剥掉第一行 BOM 及开头的 "SET NAMES/FOREIGN_KEY_CHECKS"
        // 简单做法：先读 tableStream 到 buffer，然后写（除第一张外）；否则 BOM 重复会导致导入异常
        const chunks = [];
        await new Promise((resolve, reject) => {
          tableStream.on('error', reject);
          tableStream.on('data', (c) => chunks.push(c));
          tableStream.on('end', resolve);
        });
        let text = Buffer.concat(chunks).toString('utf8');
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        // 去掉通用头（第二、三段注释 + SET NAMES + SET FOREIGN_KEY_CHECKS）
        text = text.replace(/^-- SQL Dump: [^\n]*\n/, '');
        text = text.replace(/^-- Generated at [^\n]*\n/, '');
        text = text.replace(/^SET NAMES utf8mb4;\n/, '');
        text = text.replace(/^SET FOREIGN_KEY_CHECKS = 0;\n\n?/, '');
        // 去掉尾部的 SET FOREIGN_KEY_CHECKS=1 + Dump completed（最后统一加一次）
        text = text.replace(/\nSET FOREIGN_KEY_CHECKS = 1;\n-- Dump completed: [^\n]*\n?$/, '\n');
        out.write(text);
      }

      out.write(`\nSET FOREIGN_KEY_CHECKS = 1;\n`);
      out.write(`-- Dump completed: database ${quotedDb}\n`);
      out.end();
    } catch (err) {
      out.destroy(err);
    }
  })();

  return out;
}
