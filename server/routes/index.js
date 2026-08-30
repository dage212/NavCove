const Router = require('@koa/router');
const router = new Router({ prefix: '/api' });
const { v4: uuidv4 } = require('uuid');
const poolMgr = require('../db/pool');
const svc = require('../services/mysqlService');
const config = require('../config');

// SQLite 原生模块（better-sqlite3）体积大、加载慢。用 Proxy 延迟到首次访问数据库时才
// require，让健康检查/静态资源/登录态判断（session 在内存）不依赖它，缩短后端就绪时间。
let _db = null;
function ensureDb() {
  if (!_db) _db = require('../db/sqlite');
  return _db;
}
const db = new Proxy({}, {
  get(_t, prop) {
    const real = ensureDb();
    const v = real[prop];
    return typeof v === 'function' ? v.bind(real) : v;
  }
});

// 统一成功响应
function ok(data, msg = 'success') {
  return { code: 0, message: msg, data };
}

// 从 Authorization 头中解析出 session user，返回 null 表示未登录
function resolveSession(ctx) {
  const auth = ctx.request.header.authorization || ctx.query.token || ctx.request.body?.token;
  const token = (auth || '').replace(/^Bearer\s+/, '');
  if (!token) return null;
  const s = sessions.get(token);
  return s || null;
}

const sessions = new Map(); // token -> user info

// --- 操作日志辅助：从 ctx 解析用户 + 连接名，写入 operation_log ---
let _stmtConnName = null;
function getConnNameStmt() {
  if (!_stmtConnName) _stmtConnName = ensureDb().prepare('SELECT name FROM connections WHERE id = ?');
  return _stmtConnName;
}
function logOp(ctx, { connId, database, sqlText, sqlType, affected = 0, status = 'success', error = '' }) {
  try {
    const u = resolveSession(ctx);
    let connName = null;
    if (connId) { const c = getConnNameStmt().get(connId); connName = c ? c.name : null; }
    ensureDb().logOperation({
      userId: u?.id, username: u?.username,
      connId, connName, database,
      sqlText, sqlType, affected, status, error
    });
  } catch (e) { console.error('[logOp] failed:', e.message); }
}
// 包裹数据库操作：成功/失败都记日志，自动累加 inserted/updated/deleted/affected
// 优先使用 mysqlService 返回的完整 SQL（带实际参数值）作为日志 sqlText
async function withLog(ctx, opt, fn) {
  try {
    const res = await fn();
    const aff = ['inserted', 'updated', 'deleted', 'affected'].reduce((s, k) => s + (Number(res?.[k]) || 0), 0);
    logOp(ctx, { ...opt, sqlText: res?.sql || opt.sqlText, affected: aff, status: 'success' });
    return res;
  } catch (e) {
    logOp(ctx, { ...opt, status: 'error', error: e.message || String(e) });
    throw e;
  }
}

router.get('/health', (ctx) => {
  ctx.body = ok({ ok: true });
});

// --- 用户登录/登出（SQLite users 表 + 内存 Session）---
router.post('/auth/login', async (ctx) => {
  const { username, password } = ctx.request.body || {};
  if (!username) { ctx.status = 401; ctx.body = { code: 401, message: '请输入用户名' }; return; }
  const u = db.prepare('SELECT id, username, password, name FROM users WHERE username = ?').get(username);
  if (!u || u.password !== password) {
    ctx.status = 401;
    ctx.body = { code: 401, message: '用户名或密码错误' };
    return;
  }
  const token = uuidv4();
  sessions.set(token, { id: u.id, username: u.username, name: u.name, loginAt: Date.now() });
  ctx.body = ok({
    token,
    username: u.username,
    name: u.name
  }, '登录成功');
});

router.post('/auth/logout', async (ctx) => {
  const auth = ctx.request.header.authorization || ctx.request.body?.token;
  const token = (auth || '').replace(/^Bearer\s+/, '');
  if (token) sessions.delete(token);
  ctx.body = ok(null, '已退出');
});

router.get('/auth/me', async (ctx) => {
  const u = resolveSession(ctx);
  if (!u) { ctx.status = 401; ctx.body = { code: 401, message: '未登录' }; return; }
  ctx.body = ok({ username: u.username, name: u.name });
});

// --- 连接管理（持久化到 SQLite connections 表）---
// 连接详情脱敏（密码不返回明文，返回 maskedPassword 占位；需要回显时前端保留已输入的密码）
function sanitizeConn(row) {
  if (!row) return null;
  const { password, ...rest } = row;
  return rest;
}

// 获取默认连接配置：优先用最近保存的一条；否则用 config.js 默认值
router.get('/connection/default', (ctx) => {
  const row = db.prepare(
    'SELECT * FROM connections ORDER BY updated_at DESC LIMIT 1'
  ).get();
  if (row) {
    ctx.body = ok(sanitizeConn(row));
    return;
  }
  ctx.body = ok(config.defaultConnection);
});

// 测试连接
router.post('/connection/test', async (ctx) => {
  const body = ctx.request.body || {};
  const res = await svc.testConnection(body);
  ctx.body = ok(res, '连接成功');
});

// 建立连接（创建池 + 持久化到 SQLite，返回 id）
router.post('/connection/connect', async (ctx) => {
  const body = ctx.request.body || {};
  await svc.testConnection(body);
  const id = body.id || uuidv4();
  poolMgr.registerConnection(id, body);
  const sess = resolveSession(ctx);

  const exist = db.prepare('SELECT id FROM connections WHERE id = ?').get(id);
  if (exist) {
    db.prepare(
      `UPDATE connections SET name=?, type=?, host=?, port=?, user=?, password=?,
       user_id=?, updated_at=datetime('now','localtime') WHERE id=?`
    ).run(
      body.name,
      body.type || 'mysql',
      body.host,
      Number(body.port) || 3306,
      body.user,
      body.password == null ? '' : body.password,
      sess ? sess.id : null,
      id
    );
  } else {
    db.prepare(
      `INSERT INTO connections (id, name, type, host, port, user, password, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      body.name,
      body.type || 'mysql',
      body.host,
      Number(body.port) || 3306,
      body.user,
      body.password == null ? '' : body.password,
      sess ? sess.id : null
    );
  }
  ctx.body = ok({ id, name: body.name }, '连接成功');
});

// 断开连接（同时从 SQLite 删除）
router.delete('/connection/:id', (ctx) => {
  const id = ctx.params.id;
  poolMgr.removeConnection(id);
  db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  ctx.body = ok(null, '已断开');
});

// 已保存的连接列表（所有保存过的连接）
router.get('/connection', (ctx) => {
  const rows = db.prepare(
    'SELECT * FROM connections ORDER BY updated_at DESC'
  ).all();
  ctx.body = ok(rows.map(sanitizeConn));
});

// 单个连接详情（用于回显表单；密码不返回，前端展示为占位）
router.get('/connection/:id', (ctx) => {
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(ctx.params.id);
  if (!row) { ctx.status = 404; ctx.body = { code: 404, message: '连接不存在' }; return; }
  ctx.body = ok(sanitizeConn(row));
});

// --- 数据库 / 表 ---
router.get('/databases', async (ctx) => {
  const { connId } = ctx.query;
  ctx.body = ok(await svc.listDatabases(connId));
});

router.get('/tables', async (ctx) => {
  const { connId, database } = ctx.query;
  ctx.body = ok(await svc.listTables(connId, database));
});

router.get('/table/columns', async (ctx) => {
  const { connId, database, table } = ctx.query;
  ctx.body = ok(await svc.describeTable(connId, database, table));
});

router.get('/table/data', async (ctx) => {
  const { connId, database, table, page, size, orderColumn, orderDir } = ctx.query;
  ctx.body = ok(await svc.getTableData(connId, database, table, {
    page: Number(page) || 1,
    size: Number(size) || 50,
    order: orderColumn ? { column: orderColumn, dir: orderDir } : undefined
  }));
});

// 批量保存表数据变更（事务）
router.post('/table/save', async (ctx) => {
  const { connId, database, table, changes } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database, sqlText: `SAVE \`${database}\`.\`${table}\``, sqlType: 'INSERT' },
    () => svc.saveTable(connId, database, table, changes || {}));
  ctx.body = ok(res, `保存完成：新增 ${res.inserted}，修改 ${res.updated}，删除 ${res.deleted}`);
});

// 单条 UPDATE
router.put('/table/row', async (ctx) => {
  const { connId, database, table, pk, values } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database, sqlText: `UPDATE \`${database}\`.\`${table}\` SET ...`, sqlType: 'UPDATE' },
    () => svc.updateRow(connId, database, table, pk, values));
  ctx.body = ok(res, res.updated ? '更新成功' : '无变化');
});

// 单条 INSERT
router.post('/table/row', async (ctx) => {
  const { connId, database, table, values } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database, sqlText: `INSERT INTO \`${database}\`.\`${table}\` (...)`, sqlType: 'INSERT' },
    () => svc.insertRow(connId, database, table, values));
  ctx.body = ok(res, `插入成功 ${res.inserted} 行`);
});

// 单条 DELETE
router.delete('/table/row', async (ctx) => {
  const { connId, database, table, pk } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database, sqlText: `DELETE FROM \`${database}\`.\`${table}\` WHERE ...`, sqlType: 'DELETE' },
    () => svc.deleteRow(connId, database, table, pk));
  ctx.body = ok(res, `删除成功 ${res.deleted} 行`);
});

// 新建表
router.post('/table/create', async (ctx) => {
  const { connId, database, table, columns } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database, sqlText: `CREATE TABLE \`${database}\`.\`${table}\``, sqlType: 'CREATE' },
    () => svc.createTable(connId, database, table, columns));
  ctx.body = ok(res, `表 ${table} 创建成功`);
});

// 删除表
router.delete('/table', async (ctx) => {
  const { connId, database, table } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database, sqlText: `DROP TABLE \`${database}\`.\`${table}\``, sqlType: 'DROP' },
    () => svc.dropTable(connId, database, table));
  ctx.body = ok(res, `表 ${table} 已删除`);
});

// 清空表
router.post('/table/truncate', async (ctx) => {
  const { connId, database, table } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database, sqlText: `TRUNCATE TABLE \`${database}\`.\`${table}\``, sqlType: 'TRUNCATE' },
    () => svc.truncateTable(connId, database, table));
  ctx.body = ok(res, `表 ${table} 已清空`);
});

// 复制表
router.post('/table/copy', async (ctx) => {
  const { connId, database, srcTable, destTable } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database, sqlText: `COPY TABLE \`${database}\`.\`${srcTable}\` -> \`${destTable}\``, sqlType: 'CREATE' },
    () => svc.copyTable(connId, database, srcTable, destTable));
  ctx.body = ok(res, `已复制为 ${destTable}`);
});

// 重命名表
router.post('/table/rename', async (ctx) => {
  const { connId, database, oldName, newName } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database, sqlText: `RENAME TABLE \`${database}\`.\`${oldName}\` -> \`${newName}\``, sqlType: 'ALTER' },
    () => svc.renameTable(connId, database, oldName, newName));
  ctx.body = ok(res, `已重命名为 ${newName}`);
});

// 新建数据库
router.post('/database/create', async (ctx) => {
  const { connId, name, charset } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database: name, sqlText: `CREATE DATABASE \`${name}\``, sqlType: 'CREATE' },
    () => svc.createDatabase(connId, name, charset));
  ctx.body = ok(res, `数据库 ${name} 创建成功`);
});

// 删除数据库
router.delete('/database', async (ctx) => {
  const { connId, name } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database: name, sqlText: `DROP DATABASE \`${name}\``, sqlType: 'DROP' },
    () => svc.dropDatabase(connId, name));
  ctx.body = ok(res, `数据库 ${name} 已删除`);
});

// 编辑数据库（修改字符集）
router.post('/database/alter', async (ctx) => {
  const { connId, name, charset } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database: name, sqlText: `ALTER DATABASE \`${name}\` CHARACTER SET ${charset || '?'}`, sqlType: 'ALTER' },
    () => svc.alterDatabase(connId, name, charset));
  ctx.body = ok(res, `数据库 ${name} 字符集已更新`);
});

// 获取数据库信息（字符集）
router.get('/database/info', async (ctx) => {
  const { connId, name } = ctx.query;
  ctx.body = ok(await svc.getDatabaseInfo(connId, name));
});

// 查看库结构
router.get('/database/structure', async (ctx) => {
  const { connId, database } = ctx.query;
  ctx.body = ok(await svc.getDatabaseStructure(connId, database));
});

// 查看表结构
router.get('/table/structure', async (ctx) => {
  const { connId, database, table } = ctx.query;
  ctx.body = ok(await svc.getTableStructure(connId, database, table));
});

// --- SQL 执行 ---
router.post('/query', async (ctx) => {
  const { connId, database, sql } = ctx.request.body || {};
  if (!sql || !sql.trim()) {
    ctx.body = ok([]);
    return;
  }
  try {
    const results = await svc.executeSql(connId, database, sql);
    const affected = results.reduce((s, r) => s + (r.type !== 'select' && r.type !== 'error' ? (r.affected || 0) : 0), 0);
    const errRes = results.find(r => r.type === 'error');
    logOp(ctx, { connId, database, sqlText: sql, affected, status: errRes ? 'partial' : 'success', error: errRes ? (errRes.message || '') : '' });
    ctx.body = ok(results);
  } catch (e) {
    logOp(ctx, { connId, database, sqlText: sql, status: 'error', error: e.message || String(e) });
    throw e;
  }
});

// --- 导入导出 ---
// 导出表 CSV（流式响应，支持大数据量；前端用 <a href=该链接 download> 触发）
router.get('/export/table', async (ctx) => {
  const { connId, database, table, limit } = ctx.query;
  const stream = svc.exportTableCsvStream(connId, database, table, { limit: limit ? Number(limit) : undefined });
  const filename = encodeURIComponent(`${database}_${table}.csv`);
  ctx.set('Content-Type', 'text/csv; charset=utf-8');
  ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
  // 流式传输时禁用 bodyParser 缓冲，由 Koa 直接 pipe 到响应
  ctx.body = stream;
});

// 导出 SQL 查询结果 CSV
router.post('/export/query', async (ctx) => {
  const { connId, database, sql } = ctx.request.body || {};
  const csv = await svc.exportQueryCsv(connId, database, sql);
  const filename = encodeURIComponent(`query_result.csv`);
  ctx.set('Content-Type', 'text/csv; charset=utf-8');
  ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
  ctx.body = '\ufeff' + csv;
});

// 导出 SQL 查询结果为 SQL 文件（INSERT 语句）
router.post('/export/query/sql', async (ctx) => {
  const { connId, database, sql, table } = ctx.request.body || {};
  const out = await svc.exportQuerySql(connId, database, sql, table);
  const filename = encodeURIComponent(`${table || 'query_result'}.sql`);
  ctx.set('Content-Type', 'application/sql; charset=utf-8');
  ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
  ctx.body = out;
});

// 导出单表 SQL（支持 schema/data 两个复选）
router.get('/export/sql/table', async (ctx) => {
  const { connId, database, table } = ctx.query;
  const withSchema = ctx.query.withSchema !== '0' && ctx.query.withSchema !== 'false';
  const withData = ctx.query.withData !== '0' && ctx.query.withData !== 'false';
  const opts = { withSchema, withData };
  const limit = Number(ctx.query.limit);
  if (Number.isFinite(limit) && limit > 0) opts.limit = limit;
  const stream = svc.exportTableSqlStream(connId, database, table, opts);
  const filename = encodeURIComponent(`${database}_${table}.sql`);
  ctx.set('Content-Type', 'application/sql; charset=utf-8');
  ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
  ctx.body = stream;
});

// 导出整库 SQL
router.get('/export/sql/database', async (ctx) => {
  const { connId, database } = ctx.query;
  const withSchema = ctx.query.withSchema !== '0' && ctx.query.withSchema !== 'false';
  const withData = ctx.query.withData !== '0' && ctx.query.withData !== 'false';
  const opts = { withSchema, withData };
  const limit = Number(ctx.query.limit);
  if (Number.isFinite(limit) && limit > 0) opts.limit = limit;
  const stream = svc.exportDatabaseSqlStream(connId, database, opts);
  const filename = encodeURIComponent(`${database}.sql`);
  ctx.set('Content-Type', 'application/sql; charset=utf-8');
  ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
  ctx.body = stream;
});

// 导入 CSV（文本内容上传，仍保留兼容）
router.post('/import/table', async (ctx) => {
  const { connId, database, table, content, replace } = ctx.request.body || {};
  const res = await withLog(ctx, { connId, database, sqlText: `IMPORT CSV INTO \`${database}\`.\`${table}\` (${replace ? 'REPLACE' : 'INSERT'})`, sqlType: 'INSERT' },
    () => svc.importTableCsv(connId, database, table, content, { replace }));
  ctx.body = ok(res, `导入完成，影响 ${res.inserted} 行`);
});

// 导入 SQL 文件（文本内容上传，与 CSV 导入同样的限制 + 分批事务 + 坏语句剔除）
router.post('/import/sql', async (ctx) => {
  const { connId, database, content } = ctx.request.body || {};
  if (!content || !String(content).trim()) {
    ctx.status = 400; ctx.body = { code: 400, message: 'SQL 内容不能为空' }; return;
  }
  try {
    const res = await withLog(ctx, { connId, database, sqlText: `IMPORT SQL INTO \`${database || ''}\``, sqlType: 'INSERT' },
      () => svc.importSqlText(connId, database, content));
    ctx.body = ok(res, `SQL 导入完成：共 ${res.total} 条语句，成功 ${res.executed} 条${res.badRows && res.badRows.length ? `，剔除错误 ${res.badRows.length} 条` : ''}`);
  } catch (e) {
    // SQL 导入的“全批失败”同样返回 badStatements 供前端提示
    const body = { code: e.status || 500, message: e.message || 'SQL 导入失败' };
    if (e.badStatements && e.badStatements.length) { body.badStatements = e.badStatements; }
    if (e.badRows && e.badRows.length) { body.badRows = e.badRows; }
    ctx.status = e.status || 500;
    ctx.body = body;
  }
});

// ---- 切片上传 + 断点续传 + 流式导入 ----
// multer 依赖链较长、上传服务平时用不到，都改为懒加载，避免拖慢后端启动
let _multerMem = null;
function getMulterMem() {
  if (!_multerMem) {
    const multer = require('@koa/multer');
    // @koa/multer 内存存储：切片存在内存 buffer，然后由我们写入磁盘
    const storage = multer.memoryStorage();
    _multerMem = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } }); // 单切片最大 200MB
  }
  return _multerMem;
}
let _uploadSvc = null;
function getUploadSvc() {
  if (!_uploadSvc) _uploadSvc = require('../services/uploadService');
  return _uploadSvc;
}

// 1) 初始化（断点续传入口）
router.post('/import/upload/init', async (ctx) => {
  const { fileName, fileSize, chunkSize, fileHash } = ctx.request.body || {};
  const res = getUploadSvc().initUpload({
    fileName: String(fileName || ''),
    fileSize: Number(fileSize),
    chunkSize: Number(chunkSize),
    fileHash: fileHash ? String(fileHash) : undefined
  });
  ctx.body = ok(res, '初始化成功');
});

// 2) 上传一个切片（multipart/form-data：file 是切片本体，uploadId + index + totalChunks 在 fields）
router.post('/import/upload/chunk', async (ctx, next) => {
  return getMulterMem().single('file')(ctx, next);
}, async (ctx) => {
  const { uploadId, index } = ctx.request.body || {};
  if (!ctx.file || !ctx.file.buffer) {
    ctx.status = 400; ctx.body = { code: 400, message: '缺少切片文件字段 file' }; return;
  }
  const res = getUploadSvc().saveChunk({
    uploadId: String(uploadId || ''),
    index: Number(index),
    buffer: ctx.file.buffer
  });
  ctx.body = ok(res, `切片 ${index} 已保存`);
});

// 3) 合并并（可选）导入数据库
router.post('/import/upload/merge', async (ctx) => {
  const { uploadId, connId, database, table, replace, batchSize } = ctx.request.body || {};
  if (!uploadId) { ctx.status = 400; ctx.body = { code: 400, message: '缺少 uploadId' }; return; }
  const needImport = !!(connId && database && table);
  const importFn = needImport
    ? async (mergedFile) => await svc.importCsvFileStream(connId, database, table, mergedFile, {
      replace: !!replace,
      batchSize: batchSize ? Number(batchSize) : undefined,
      // 替换导入：单批失败回滚后剔除坏行继续；普通导入遇错直接抛出
      skipErrorRows: !!replace
    })
    : null;
  const uploadSvc = getUploadSvc();
  try {
    const merged = await uploadSvc.mergeUpload({ uploadId, importFn });
    if (needImport) {
      logOp(ctx, { connId, database, sqlText: `IMPORT CSV (upload) INTO \`${database}\`.\`${table}\` (${replace ? 'REPLACE' : 'INSERT'})`, sqlType: 'INSERT', affected: (merged.imported && merged.imported.inserted) || 0, status: 'success' });
    }
    const msg = needImport
      ? `合并成功，导入完成，影响 ${(merged.imported && merged.imported.inserted) || 0} 行`
      : '合并成功';
    ctx.body = ok({
      mergedFilePath: merged.mergedFilePath,
      size: merged.size,
      imported: merged.imported || null
    }, msg);
  } catch (e) {
    if (needImport) {
      logOp(ctx, { connId, database, sqlText: `IMPORT CSV (upload) INTO \`${database}\`.\`${table}\` (${replace ? 'REPLACE' : 'INSERT'})`, sqlType: 'INSERT', status: 'error', error: e.sqlMessage || e.message || String(e) });
    }
    // 注意：这里不再 cleanup——mergeUpload 内部已处理（成功删缓存、失败保留 meta+合并文件供重试）。
    // 用户在界面上“继续导入”可复用已上传的数据，无需整文件重传。
    // 把数据库具体错误原因返回给前端
    // mysql2 错误对象包含 code(如 ER_DUP_ENTRY)、errno、sqlState、sqlMessage
    ctx.status = e.status || 500;
    const dbCode = e.code ? `[${e.code}] ` : '';
    const dbMsg = e.sqlMessage || e.message || '未知错误';
    ctx.body = {
      code: ctx.status,
      message: `导入失败：${dbCode}${dbMsg}${e.badRows && e.badRows.length ? `（已剔除 ${e.badRows.length} 行错误数据）` : ''}`,
      dbError: e.code ? {
        code: e.code,
        errno: e.errno,
        sqlState: e.sqlState,
        sqlMessage: e.sqlMessage
      } : undefined,
      badRows: e.badRows && e.badRows.length ? e.badRows : undefined
    };
  }
});

// 4) 取消 + 清理
router.delete('/import/upload/:uploadId', (ctx) => {
  getUploadSvc().cleanup(ctx.params.uploadId);
  ctx.body = ok(null, '已清理');
});

// --- 操作日志查询 ---
router.get('/logs', (ctx) => {
  const { startDate, endDate, username, sqlType, page = 1, size = 50, keyword } = ctx.query;
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(500, Math.max(1, Number(size) || 50));
  const where = [];
  const params = [];
  if (startDate) { where.push("created_at >= ?"); params.push(startDate + ' 00:00:00'); }
  if (endDate) { where.push("created_at <= ?"); params.push(endDate + ' 23:59:59'); }
  if (username) { where.push("username = ?"); params.push(username); }
  if (sqlType && sqlType !== 'NON_SELECT') { where.push("sql_type = ?"); params.push(sqlType); }
  if (sqlType === 'NON_SELECT') { where.push("sql_type != 'SELECT'"); }
  if (keyword) { where.push("(sql_text LIKE ? OR database LIKE ? OR conn_name LIKE ?)"); const kw = '%' + keyword + '%'; params.push(kw, kw, kw); }
  const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
  const total = db.prepare('SELECT COUNT(*) AS total FROM operation_log' + whereSql).get(...params).total;
  const rows = db.prepare('SELECT id, created_at, username, conn_name, database, sql_type, sql_text, affected, status, error FROM operation_log' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...params, s, (p - 1) * s);
  // 统计各类型计数（用于前端过滤标签）
  const stats = db.prepare("SELECT sql_type, COUNT(*) AS cnt FROM operation_log" + whereSql + " GROUP BY sql_type").all(...params);
  ctx.body = ok({ total, page: p, size: s, rows, stats });
});

// 日志用户列表（用于人员过滤下拉）
router.get('/logs/users', (ctx) => {
  const rows = db.prepare("SELECT DISTINCT username FROM operation_log WHERE username IS NOT NULL ORDER BY username").all();
  ctx.body = ok(rows.map(r => r.username));
});

module.exports = router;
