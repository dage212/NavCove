const poolMgr = require('../db/pool');

// 文件通道（copyTable）内部使用的 CSV 标记编码：
//   NULL      → \N
//   二进制    → \B + hex
//   以 \ 开头 → 前加一个 \ 转义（解码时去掉一个）
// 保证 NULL / 空串 / 首尾空格 / 二进制字节在导出→导入往返中无损
const CSV_NULL_MARK = '\\N';
const CSV_BLOB_MARK = '\\B';

// 编码探测：BOM 优先，其次严格 UTF-8 校验，失败退回 GBK（国内 Excel 导出的常见编码）
function detectTextEncoding(buf) {
  if (!buf || !buf.length) return 'utf8';
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf8';
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'utf-16be';
  try {
    const TD = globalThis.TextDecoder || require('util').TextDecoder;
    new TD('utf-8', { fatal: true }).decode(buf);
    return 'utf8';
  } catch (e) {
    return 'gbk';
  }
}

function formatConnError(e, conn) {
  const host = conn.host || '127.0.0.1';
  const port = conn.port || 3306;
  if (e.code === 'ECONNREFUSED') {
    return `无法连接 ${host}:${port}，请确认 MySQL 已启动并监听该端口`;
  }
  if (e.code === 'ETIMEDOUT' || e.code === 'PROTOCOL_CONNECTION_LOST') {
    return `连接 ${host}:${port} 超时，请检查主机、端口和防火墙`;
  }
  if (e.code === 'ENOTFOUND') {
    return `找不到主机 ${host}`;
  }
  if (e.code === 'ER_ACCESS_DENIED_ERROR') {
    return '用户名或密码错误';
  }
  return e.sqlMessage || e.message || '连接失败';
}

// 测试连接（一次性连接，不入池）
async function testConnection(conn) {
  const mysql = require('mysql2/promise');
  let connection;
  try {
    connection = await mysql.createConnection({
      host: conn.host,
      port: conn.port || 3306,
      user: conn.user,
      password: conn.password == null ? '' : conn.password,
      database: conn.database || undefined,
      connectTimeout: 5000
    });
    const [rows] = await connection.query('SELECT VERSION() AS version');
    return { version: rows[0] && rows[0].version };
  } catch (e) {
    const err = new Error(formatConnError(e, conn));
    err.status = 400;
    throw err;
  } finally {
    if (connection) await connection.end().catch(() => {});
  }
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
// 逐条执行并在首条出错时停止：把错误作为结果项返回（含语句序号），而不是整段 400 中断，
// 让前端能看到“已执行 N 条、第 M 条失败”的准确信息
async function executeSql(connId, database, sql) {
  const pool = poolMgr.getPool(connId);
  let conn;
  const results = [];
  try {
    conn = await pool.getConnection();
    if (database) await conn.changeUser({ database });
    // 剥离 UTF-8 BOM（Windows 导出的 dump 常见），避免首条语句报 1064
    const statements = splitSql(String(sql).replace(/^\ufeff/, ''));
    for (let i = 0; i < statements.length; i++) {
      const trimmed = statements[i].trim().replace(/;$/, '').trim();
      if (!trimmed) continue;
      try {
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
      } catch (e) {
        // 记录失败语句序号后停止（后续语句依赖前面的结果，继续执行不安全）
        results.push({
          type: 'error',
          index: i + 1,
          executed: results.length,
          message: e.message || String(e),
          errno: e.errno,
          sqlState: e.sqlState
        });
        break;
      }
    }
    return results;
  } finally {
    if (conn) conn.release();
  }
}

// 导入 SQL 文件（文本内容版，与 CSV 导入同样的三重限制 + 分批事务 + 坏语句剔除）
// 约束：语句数 ≤ maxStatements（默认 5000）、内容 < maxFileSize（默认 20MB）、单事务执行时间 ≤ maxTransactionTime（默认 5s）
// 超过任一限制则报错提示用户拆分文件。每批一个事务（默认 500 条/批，串行执行）。
// 批内某条语句失败 → 回滚该批 → 二分定位坏语句剔除 → 好语句重跑继续；整批全坏则停止并记录。
// 注意：MySQL 中 DDL（CREATE/ALTER/DROP 等）会隐式提交事务，无法通过回滚撤销，属引擎固有限制。
async function importSqlText(connId, database, sqlText, {
  batchSize = 500, maxStatements = 5000, maxFileSize = 20 * 1024 * 1024,
  maxTransactionTime = 5000, skipErrorRows = true
} = {}) {
  const pool = poolMgr.getPool(connId);
  const sql = String(sqlText || '').replace(/^\ufeff/, '');

  // 限制预检
  const size = Buffer.byteLength(sql, 'utf8');
  if (size > maxFileSize) {
    const err = new Error(`文件大小 ${(size / (1024 * 1024)).toFixed(1)}MB 超过限制（${(maxFileSize / (1024 * 1024)).toFixed(0)}MB），请拆分文件后重试`);
    err.status = 400;
    throw err;
  }
  const statements = splitSql(sql).map((s) => s.trim().replace(/;$/, '').trim()).filter(Boolean);
  if (statements.length > maxStatements) {
    const err = new Error(`SQL 语句数 ${statements.length} 超过限制（${maxStatements} 条），请拆分文件后重试`);
    err.status = 400;
    throw err;
  }

  const conn = await pool.getConnection();
  let connDestroyed = false; // 超时后需销毁连接
  const executed = []; // 已成功语句 { index, sql }
  const badStatements = []; // 被剔除的坏语句 { index, sql, error }

  // 单条语句 + 超时保护执行
  function runWithTimeout(stmt) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const err = new Error(`语句执行超时（>${(maxTransactionTime / 1000).toFixed(1)}s），请拆分文件后重试`);
        err.timeout = true;
        reject(err);
      }, maxTransactionTime);
      conn.query(stmt).then(([res]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res);
      }).catch((e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // 在事务内执行一组语句；全部成功 commit，任一条失败 rollback
  async function execInTx(stmtSqls) {
    await conn.beginTransaction();
    try {
      for (const stmt of stmtSqls) await runWithTimeout(stmt);
      await conn.commit();
      return { ok: true };
    } catch (e) {
      await conn.rollback().catch(() => {});
      return { ok: false, error: e };
    }
  }

  // 二分定位坏语句：事务内试跑，失败则回滚并二分；返回 { good, bad }，good/bad 均带 { index, sql }
  async function isolateBad(stmts) {
    if (!stmts.length) return { good: [], bad: [] };
    const r = await execInTx(stmts.map((s) => s.sql));
    if (r.ok) return { good: stmts, bad: [] };
    if (r.error.timeout) throw r.error;
    if (stmts.length === 1) {
      return {
        good: [],
        bad: [{ index: stmts[0].index, sql: stmts[0].sql, error: r.error.sqlMessage || r.error.message }]
      };
    }
    const mid = Math.floor(stmts.length / 2);
    const left = await isolateBad(stmts.slice(0, mid));
    const right = await isolateBad(stmts.slice(mid));
    return { good: [...left.good, ...right.good], bad: [...left.bad, ...right.bad] };
  }

  try {
    if (database) await conn.changeUser({ database });

    // 分批串行执行
    for (let i = 0; i < statements.length; i += batchSize) {
      const batch = statements.slice(i, i + batchSize).map((s, j) => ({ index: i + j + 1, sql: s }));
      let r;
      try {
        r = await execInTx(batch.map((s) => s.sql));
      } catch (e) {
        connDestroyed = true; // beginTransaction 异常时连接可能已不可用
        throw e;
      }
      if (r.ok) {
        executed.push(...batch);
        continue;
      }
      if (r.error.timeout) { connDestroyed = true; throw r.error; }

      if (skipErrorRows) {
        // 剔除坏语句：回滚当前批后二分定位，好语句重跑入库（isolateBad 内部已提交），继续后续批次
        const iso = await isolateBad(batch);
        if (iso.bad.length) badStatements.push(...iso.bad);
        // 整批都有问题 → 停止导入
        if (iso.good.length === 0 && iso.bad.length === batch.length) {
          const err = new Error(`当前批次 ${batch.length} 条语句全部执行失败，已停止导入并记录错误数据`);
          err.badStatements = badStatements;
          err.status = 400;
          throw err;
        }
        executed.push(...iso.good);
      } else {
        throw r.error;
      }
    }

    return {
      executed: executed.length,
      total: statements.length,
      affected: executed.length,
      badRows: badStatements.length ? badStatements : undefined
    };
  } finally {
    if (conn) {
      if (connDestroyed) {
        try { conn.destroy(); } catch (e) {}
      } else {
        conn.release();
      }
    }
  }
}

// 导出表数据为 CSV 文本
async function exportTableCsv(connId, database, table, { limit } = {}) {  const pool = poolMgr.getPool(connId);
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

/**
 * 流式导出表数据为服务器本地 CSV 文件（copyTable 文件通道用）
 * 普通一致性 SELECT（不加锁），并发读写互不阻塞；流式写入磁盘，不占内存
 * @returns {Promise<{rows:number, columns:string[]}>} rows 为导出的数据行数，columns 为写入的列名（已排除生成列）
 */
async function dumpTableCsvFile(connId, database, table, filePath, { limit } = {}) {
  const meta = poolMgr.getMeta(connId);
  const mysql = require('mysql2');
  const fs = require('fs');
  const { format } = require('@fast-csv/format');

  // 排除生成列：INSERT 不允许显式写 GENERATED 列，CSV 里也不应包含它们
  // 注意：information_schema 结果字段名是大写（COLUMN_NAME），与 importCsvFileStream 里一致
  const pool = poolMgr.getPool(connId);
  const [cols] = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND extra NOT LIKE '%GENERATED%'
     ORDER BY ordinal_position`,
    [database, table]
  );
  const columns = cols.map((c) => c.COLUMN_NAME);
  if (!columns.length) {
    // 无可导出列（如仅有生成列），写一个空 CSV 文件保持一致
    fs.writeFileSync(filePath, '\ufeff');
    return { rows: 0, columns };
  }
  const colList = columns.map(mysqlEscapeId).join(', ');
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);
  let sql = `SELECT ${colList} FROM ${quotedDb}.${quotedTable}`;
  if (limit) sql += ` LIMIT ${Number(limit)}`;

  return new Promise((resolve, reject) => {
    const rawConn = mysql.createConnection({
      host: meta.host,
      port: meta.port || 3306,
      user: meta.user,
      password: meta.password == null ? '' : meta.password,
      database,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true
    });

    const out = fs.createWriteStream(filePath);
    let finished = false;
    let rows = 0;

    function cleanup() {
      if (finished) return;
      finished = true;
      try { rawConn.end(); } catch (e) {}
    }

    rawConn.on('error', (err) => {
      cleanup();
      out.destroy();
      reject(err);
    });

    rawConn.connect((err) => {
      if (err) {
        cleanup();
        out.destroy();
        reject(err);
        return;
      }
      const queryStream = rawConn.query(sql).stream();
      // 标记编码：NULL → \N，二进制 → \B+hex，以 \ 开头 → 前加 \ 转义（与 importCsvFileStream 的 encoded 模式对应）
      const csvStream = format({
        headers: true,
        transform: (row) => {
          for (const k of Object.keys(row)) {
            const v = row[k];
            if (v === null || v === undefined) row[k] = CSV_NULL_MARK;
            else if (Buffer.isBuffer(v)) row[k] = CSV_BLOB_MARK + v.toString('hex');
            else {
              const s = String(v);
              if (s.startsWith('\\')) row[k] = '\\' + s;
            }
          }
          return row;
        }
      });
      queryStream.on('data', () => { rows += 1; });
      queryStream.on('error', (e) => {
        cleanup();
        csvStream.destroy();
        out.destroy();
        reject(e);
      });
      csvStream.on('error', (e) => {
        cleanup();
        out.destroy();
        reject(e);
      });
      out.on('error', (e) => {
        cleanup();
        reject(e);
      });
      out.on('finish', () => {
        cleanup();
        resolve({ rows, columns });
      });
      // BOM 开头（fast-csv 导入时可兼容），再流式写入
      out.write('\ufeff');
      csvStream.pipe(out);
      queryStream.pipe(csvStream);
    });
  });
}

// 导入 CSV 到指定表（内存版，仍保留用于兼容小文件文本导入）
// 限制：行数 ≤ maxRows（默认 5000）、内容 < maxFileSize（默认 20MB）、单事务执行时间 ≤ maxTransactionTime（默认 5s）
async function importTableCsv(connId, database, table, csvText, {
  replace = false, maxRows = 5000, maxFileSize = 20 * 1024 * 1024, maxTransactionTime = 5000
} = {}) {
  const { parse } = require('fast-csv');
  const pool = poolMgr.getPool(connId);
  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);

  // 限制预检：内容大小
  const size = Buffer.byteLength(String(csvText || ''), 'utf8');
  if (size > maxFileSize) {
    const err = new Error(`文件大小 ${(size / (1024 * 1024)).toFixed(1)}MB 超过限制（${(maxFileSize / (1024 * 1024)).toFixed(0)}MB），请拆分文件后重试`);
    err.status = 400;
    throw err;
  }

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

  // 限制预检：行数
  if (rows.length > maxRows) {
    const err = new Error(`数据行数 ${rows.length} 超过限制（${maxRows} 行），请拆分文件后重试`);
    err.status = 400;
    throw err;
  }

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

  // 单事务 + 超时保护执行
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let done = false;
    const timer = setTimeout(() => { done = true; }, maxTransactionTime);
    let res;
    try {
      [res] = await conn.query(sql, [values]);
    } catch (e) {
      res = null;
    }
    clearTimeout(timer);
    if (done) {
      await conn.rollback().catch(() => {});
      const err = new Error(`事务执行超时（>${(maxTransactionTime / 1000).toFixed(1)}s），请拆分文件后重试`);
      err.status = 400;
      throw err;
    }
    await conn.commit();
    return { inserted: res.affectedRows, columns, count: rows.length };
  } catch (e) {
    if (e.status === 400) throw e;
    await conn.rollback().catch(() => {});
    // 整批失败：若非超时，直接抛出（原 1000 条内事务回滚语义；超限制已由行数/大小预检拦截）
    throw e;
  } finally {
    conn.release();
  }
}

// 统计 CSV 文件中的数据行数（快速预检用）：按换行符估算，忽略引号内换行的精确性
function countCsvRows(filePath) {
  const fs = require('fs');
  const stat = fs.statSync(filePath);
  if (!stat.size) return 0;
  const buf = Buffer.alloc(Math.min(stat.size, 25 * 1024 * 1024));
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  let newlines = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0A) newlines++;
  if (newlines === 0) return buf.length > 0 ? 1 : 0; // 只有表头一行（无换行）
  const endsWithNewline = buf[buf.length - 1] === 0x0A;
  const totalLines = endsWithNewline ? newlines : newlines + 1;
  return Math.max(0, totalLines - 1); // 减去表头行
}

/**
 * 流式导入 CSV 文件（大数据量 + 断点续传文件合并后调用）
 * 约束：行数 ≤ maxRows（默认 5000）、文件 < maxFileSize（默认 20MB）、单事务执行时间 ≤ maxTransactionTime（默认 5s）
 * 超过任一限制则报错提示用户拆分文件。每个批次一个事务（默认 500 行/批，事务串行执行不并行）。
 * 导入模式遇到单批失败：回滚该批，逐行二分定位坏行并剔除，好行重新入库后继续；若整批全部失败则终止并记录坏行。
 * @param {string} connId  连接 ID
 * @param {string} database 目标库
 * @param {string} table   目标表
 * @param {string} filePath CSV 绝对路径（切片合并后的文件）
 * @param {object} opt
 * @param {boolean} opt.replace 是否 REPLACE 模式
 * @param {number} opt.batchSize 每批行数，默认 500
 * @param {number} opt.maxRows 最大行数，默认 5000
 * @param {number} opt.maxFileSize 最大文件字节数，默认 20MB
 * @param {number} opt.maxTransactionTime 单事务最大毫秒数，默认 5000
 * @param {boolean} opt.skipErrorRows 遇到坏行是否剔除后继续（默认 false；replace 模式建议 true）
 * @param {boolean} opt.skipLimits 是否跳过行数/大小预检（内部 copyTable 使用）
 * @returns {Promise<{inserted:number,count:number,columns:string[],badRows?:Array}>}
 */
async function importCsvFileStream(connId, database, table, filePath, {
  replace = false, batchSize = 500, encoded = false, trim = true,
  maxRows = 5000, maxFileSize = 20 * 1024 * 1024, maxTransactionTime = 5000,
  skipErrorRows = false, skipLimits = false
} = {}) {
  const pool = poolMgr.getPool(connId);
  const fs = require('fs');
  const path = require('path');
  const { parse } = require('fast-csv');
  const debugLog = (msg) => { try { require('fs').appendFileSync(path.join(__dirname, '..', 'data', 'uploads', 'debug.log'), new Date().toISOString() + ' [import] ' + msg + '\n'); } catch (e) {} };
  debugLog(`importCsvFileStream start, filePath: ${filePath}, batchSize: ${batchSize}, replace: ${replace}, skipLimits: ${skipLimits}`);

  // 限制预检（copyTable 内部通道跳过）
  if (!skipLimits) {
    const stat = fs.statSync(filePath);
    if (stat.size > maxFileSize) {
      const err = new Error(`文件大小 ${(stat.size / (1024 * 1024)).toFixed(1)}MB 超过限制（${(maxFileSize / (1024 * 1024)).toFixed(0)}MB），请拆分文件后重试`);
      err.status = 400;
      throw err;
    }
    const rows = countCsvRows(filePath);
    if (rows > maxRows) {
      const err = new Error(`数据行数 ${rows} 超过限制（${maxRows} 行），请拆分文件后重试`);
      err.status = 400;
      throw err;
    }
    debugLog(`limits OK: rows≈${rows}, size=${stat.size}`);
  }

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

  const quotedDb = mysqlEscapeId(database);
  const quotedTable = mysqlEscapeId(table);

  // 编码探测：读文件头判断 UTF-8/GBK/UTF-16（Excel 导出的 GBK CSV 很常见），非 UTF-8 用 iconv 转码
  let encoding = 'utf8';
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(4096);
    const { bytesRead } = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    encoding = detectTextEncoding(head.subarray(0, bytesRead));
  } catch (e) {}
  debugLog('encoding detected: ' + encoding);

  const parser = parse({ headers: true, ignoreEmpty: true, trim });

  // columns 在 Promise 内部赋值，但 isolateBadRows / buildInsertSql 在外部闭包使用，需提升到函数作用域
  let columns = null;

  // 编码探测 → 读取流
  let readStream;
  if (encoding === 'utf8') {
    readStream = fs.createReadStream(filePath, 'utf8');
  } else {
    const iconv = require('iconv-lite');
    readStream = fs.createReadStream(filePath).pipe(iconv.decodeStream(encoding));
  }

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

  function normalizeValue(raw, col) {
    if (encoded) {
      // copyTable 文件通道：解码 dumpTableCsvFile 的标记编码（\N→NULL、\B+hex→二进制、\\x→\x）
      if (raw === CSV_NULL_MARK) return null;
      if (typeof raw === 'string' && raw.startsWith(CSV_BLOB_MARK)) return Buffer.from(raw.slice(CSV_BLOB_MARK.length), 'hex');
      if (typeof raw === 'string' && raw.startsWith('\\')) return raw.slice(1);
    } else {
      // 用户导入 CSV 的既有语义：空串视为 NULL
      raw = (raw === '' || raw == null ? null : raw);
    }
    // 对日期类型列做格式转换（CSV 常见 DD/MM/YYYY 等非标准格式）
    if (raw != null && dateCols.has(col)) return normalizeDate(raw);
    return raw;
  }

  // 单个事务 + 超时保护执行（超时由调用方销毁连接，防止悬挂查询污染连接池）
  function runWithTimeout(conn, sql, values) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const err = new Error(`事务执行超时（>${(maxTransactionTime / 1000).toFixed(1)}s），请拆分文件后重试`);
        err.timeout = true;
        reject(err);
      }, maxTransactionTime);
      conn.query(sql, [values]).then(([res]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res);
      }).catch((e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // 二分定位坏行：在事务内尝试插入，失败则回滚并二分，逐行定位坏行
  // 返回 { goodRows, badRows, goodValues, affected }
  // 注意：超时由 runWithTimeout 标记，调用方需销毁连接；本函数不销毁连接
  async function isolateBadRows(conn, sql, rows) {
    if (!rows.length) return { goodRows: [], badRows: [], goodValues: [], affected: 0 };
    const values = rows.map((r) => columns.map((c) => normalizeValue(r[c], c)));
    await conn.beginTransaction();
    try {
      const res = await runWithTimeout(conn, sql, values);
      await conn.commit();
      debugLog(`isolateBadRows OK: ${rows.length} rows`);
      return { goodRows: rows, badRows: [], goodValues: values, affected: res.affectedRows };
    } catch (e) {
      await conn.rollback().catch(() => {});
      if (e.timeout) throw e; // 超时上抛，由调用方销毁连接
      if (rows.length === 1) {
        debugLog(`isolateBadRows BAD row: ${e.sqlMessage || e.message}`);
        return { goodRows: [], badRows: [{ row: rows[0], error: e.sqlMessage || e.message }], goodValues: [], affected: 0 };
      }
      const mid = Math.floor(rows.length / 2);
      const left = await isolateBadRows(conn, sql, rows.slice(0, mid));
      const right = await isolateBadRows(conn, sql, rows.slice(mid));
      return {
        goodRows: [...left.goodRows, ...right.goodRows],
        badRows: [...left.badRows, ...right.badRows],
        goodValues: [...left.goodValues, ...right.goodValues],
        affected: (left.affected || 0) + (right.affected || 0)
      };
    }
  }

  return new Promise((resolve, reject) => {
    let count = 0;          // 总行数
    let inserted = 0;       // 累计受影响行数
    let buffer = [];        // 当前批次缓存
    let aborted = false;
    let insertSql = null;
    let badRows = [];       // 记录被剔除的坏行
    let processing = false; // 串行标记：同一时刻只执行一个事务
    let flushPromise = null; // 在途批次的 Promise（end 事件需等待它，防止最后一批被跳过）

    // 每批一个事务：begin → 执行（带超时）→ commit；失败则回滚
    // 返回本批的 Promise（保存在 flushPromise，供 end 事件在“行数为 batchSize 整数倍、
    // 最后一批由 data 事件触发”时等待该批完成，否则 resolve 会漏掉最后一批且连接残留）
    function flushBatch() {
      if (!buffer.length || processing) return Promise.resolve();
      processing = true;
      const rows = buffer;
      buffer = [];
      flushPromise = (async () => {
        let conn = null;
        let connDestroyed = false; // 超时后需销毁连接，不能放回池
        debugLog(`flushBatch start, rows: ${rows.length}`);
        try {
          const values = rows.map((r) => columns.map((c) => normalizeValue(r[c], c)));
          conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            const res = await runWithTimeout(conn, insertSql, values);
            await conn.commit();
            inserted += res.affectedRows;
            debugLog(`flushBatch done, affected: ${res.affectedRows}, total inserted: ${inserted}`);
          } catch (e) {
            if (e.timeout) {
              // 超时：查询仍在连接上悬挂，销毁连接防止污染连接池
              connDestroyed = true;
              throw e;
            }
            await conn.rollback().catch(() => {});
            debugLog(`flushBatch FAILED: ${e.sqlMessage || e.message} | code: ${e.code}`);

            if (skipErrorRows) {
              // 剔除坏行：回滚当前批后二分定位，好行重新入库，继续后续批次
              try {
                const iso = await isolateBadRows(conn, insertSql, rows);
                if (iso.badRows.length) {
                  badRows.push(...iso.badRows);
                  debugLog(`isolated bad rows: ${iso.badRows.length}, good rows: ${iso.goodRows.length}`);
                }
                // 整批都有问题 → 停止导入
                if (iso.goodRows.length === 0 && iso.badRows.length === rows.length) {
                  const err = new Error(`当前批次 ${rows.length} 行全部导入失败，已停止导入并记录错误数据`);
                  err.badRows = badRows;
                  err.status = 400;
                  throw err;
                }
                inserted += iso.affected || 0;
              } catch (e2) {
                if (e2.timeout) connDestroyed = true;
                throw e2;
              }
            } else {
              throw e;
            }
          }
        } finally {
          if (conn) {
            if (connDestroyed) {
              try { conn.destroy(); } catch (e) {}
            } else {
              conn.release();
            }
          }
          processing = false;
          flushPromise = null;
        }
      })();
      return flushPromise;
    }

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
        // 暂停流，等上一批写完（串行，不并行）
        parser.pause();
        debugLog('data paused at count: ' + count + ', buffer: ' + buffer.length);
        try {
          await flushBatch();
        } catch (e) {
          debugLog('flushBatch FAILED in data: ' + e.message);
          aborted = true;
          reject(e);
          return;
        }
        parser.resume();
      }
    });

    parser.on('end', async () => {
      debugLog('parser end, count: ' + count + ', buffer remaining: ' + buffer.length);
      if (aborted) return;
      try {
        // 竞态修复：行数为 batchSize 整数倍时，最后一批由 data 事件触发、仍在执行中，
        // end 先到且 buffer 已被该批取走（buffer.length=0）。必须先等待在途批次完成，
        // 否则 resolve 的 inserted 会漏掉最后一批、连接/事务残留，导致数据丢失或后续操作被阻塞。
        if (processing && flushPromise) await flushPromise;
        if (buffer.length) await flushBatch();
        debugLog('import resolve, inserted: ' + inserted + ', count: ' + count + ', badRows: ' + badRows.length);
        resolve({ inserted, count, columns: columns || [], badRows: badRows.length ? badRows : undefined });
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

// 复制表（结构 + 数据）——文件通道方案
// 流程：源表流式导出为本地临时 CSV（普通一致性 SELECT，不锁源表，不阻塞并发读写）
//       → CREATE TABLE dest LIKE src → 分批复导入 dest。
//       任一步失败即回滚：删除目标表 + 清理临时文件（分批复导入非单事务，失败时可能有部分批次已提交）。
async function copyTable(connId, database, srcTable, destTable) {
  const pool = poolMgr.getPool(connId);
  if (!destTable) throw new Error('新表名不能为空');
  const quotedDb = mysqlEscapeId(database);
  const quotedSrc = mysqlEscapeId(srcTable);
  const quotedDest = mysqlEscapeId(destTable);

  // 目标表已存在时提前给出明确错误，而不是落到 MySQL 的 “already exists”
  const [exist] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [database, destTable]
  );
  if (exist[0].n > 0) {
    const err = new Error(`目标表 ${destTable} 已存在`);
    err.status = 400;
    throw err;
  }

  // 临时 CSV 放系统临时目录，用完即删
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navcove-copy-'));
  const csvFile = path.join(tmpDir, 'data.csv');

  try {
    await pool.query(`CREATE TABLE ${quotedDb}.${quotedDest} LIKE ${quotedDb}.${quotedSrc}`);
    // 源表流式导出 CSV（内部已排除生成列，避免导入时报 3105）
    await dumpTableCsvFile(connId, database, srcTable, csvFile);
    // 分批复导入目标表（每批独立事务；encoded 模式无损还原 NULL/空串/二进制）
    // skipLimits=true：表复制不适用导入的行数/大小限制，避免大表复制被误拦截
    const res = await importCsvFileStream(connId, database, destTable, csvFile, { batchSize: 2000, encoded: true, trim: false, skipLimits: true });
    return { copied: res.inserted, affected: res.inserted, count: res.count };
  } catch (e) {
    // 回滚：删除目标表，避免留下复制了一半的表
    await pool.query(`DROP TABLE IF EXISTS ${quotedDb}.${quotedDest}`).catch(() => {});
    throw e;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
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
  importSqlText,
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
