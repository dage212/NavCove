const Router = require('@koa/router');
const router = new Router({ prefix: '/api' });
const { v4: uuidv4 } = require('uuid');
const poolMgr = require('../db/pool');
const svc = require('../services/mysqlService');
const config = require('../config');
const db = require('../db/sqlite');

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
  const res = await svc.saveTable(connId, database, table, changes || {});
  ctx.body = ok(res, `保存完成：新增 ${res.inserted}，修改 ${res.updated}，删除 ${res.deleted}`);
});

// 单条 UPDATE
router.put('/table/row', async (ctx) => {
  const { connId, database, table, pk, values } = ctx.request.body || {};
  const res = await svc.updateRow(connId, database, table, pk, values);
  ctx.body = ok(res, res.updated ? '更新成功' : '无变化');
});

// 单条 INSERT
router.post('/table/row', async (ctx) => {
  const { connId, database, table, values } = ctx.request.body || {};
  const res = await svc.insertRow(connId, database, table, values);
  ctx.body = ok(res, `插入成功 ${res.inserted} 行`);
});

// 单条 DELETE
router.delete('/table/row', async (ctx) => {
  const { connId, database, table, pk } = ctx.request.body || {};
  const res = await svc.deleteRow(connId, database, table, pk);
  ctx.body = ok(res, `删除成功 ${res.deleted} 行`);
});

// 新建表
router.post('/table/create', async (ctx) => {
  const { connId, database, table, columns } = ctx.request.body || {};
  const res = await svc.createTable(connId, database, table, columns);
  ctx.body = ok(res, `表 ${table} 创建成功`);
});

// 删除表
router.delete('/table', async (ctx) => {
  const { connId, database, table } = ctx.request.body || {};
  const res = await svc.dropTable(connId, database, table);
  ctx.body = ok(res, `表 ${table} 已删除`);
});

// 清空表
router.post('/table/truncate', async (ctx) => {
  const { connId, database, table } = ctx.request.body || {};
  const res = await svc.truncateTable(connId, database, table);
  ctx.body = ok(res, `表 ${table} 已清空`);
});

// 复制表
router.post('/table/copy', async (ctx) => {
  const { connId, database, srcTable, destTable } = ctx.request.body || {};
  const res = await svc.copyTable(connId, database, srcTable, destTable);
  ctx.body = ok(res, `已复制为 ${destTable}`);
});

// 重命名表
router.post('/table/rename', async (ctx) => {
  const { connId, database, oldName, newName } = ctx.request.body || {};
  const res = await svc.renameTable(connId, database, oldName, newName);
  ctx.body = ok(res, `已重命名为 ${newName}`);
});

// 新建数据库
router.post('/database/create', async (ctx) => {
  const { connId, name, charset } = ctx.request.body || {};
  const res = await svc.createDatabase(connId, name, charset);
  ctx.body = ok(res, `数据库 ${name} 创建成功`);
});

// 删除数据库
router.delete('/database', async (ctx) => {
  const { connId, name } = ctx.request.body || {};
  const res = await svc.dropDatabase(connId, name);
  ctx.body = ok(res, `数据库 ${name} 已删除`);
});

// 编辑数据库（修改字符集）
router.post('/database/alter', async (ctx) => {
  const { connId, name, charset } = ctx.request.body || {};
  const res = await svc.alterDatabase(connId, name, charset);
  ctx.body = ok(res, `数据库 ${name} 字符集已更新`);
});

// 获取数据库信息（字符集）
router.get('/database/info', async (ctx) => {
  const { connId, name } = ctx.query;
  ctx.body = ok(await svc.getDatabaseInfo(connId, name));
});

// --- SQL 执行 ---
router.post('/query', async (ctx) => {
  const { connId, database, sql } = ctx.request.body || {};
  if (!sql || !sql.trim()) {
    ctx.body = ok([]);
    return;
  }
  const results = await svc.executeSql(connId, database, sql);
  ctx.body = ok(results);
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

// 导入 CSV（文本内容上传，仍保留兼容）
router.post('/import/table', async (ctx) => {
  const { connId, database, table, content, replace } = ctx.request.body || {};
  const res = await svc.importTableCsv(connId, database, table, content, { replace });
  ctx.body = ok(res, `导入完成，影响 ${res.inserted} 行`);
});

// ---- 切片上传 + 断点续传 + 流式导入 ----
const multer = require('@koa/multer');
const uploadSvc = require('../services/uploadService');
// @koa/multer 内存存储：切片存在内存 buffer，然后由我们写入磁盘
const storage = multer.memoryStorage();
const multerMem = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } }); // 单切片最大 200MB

// 1) 初始化（断点续传入口）
router.post('/import/upload/init', async (ctx) => {
  const { fileName, fileSize, chunkSize, fileHash } = ctx.request.body || {};
  const res = uploadSvc.initUpload({
    fileName: String(fileName || ''),
    fileSize: Number(fileSize),
    chunkSize: Number(chunkSize),
    fileHash: fileHash ? String(fileHash) : undefined
  });
  ctx.body = ok(res, '初始化成功');
});

// 2) 上传一个切片（multipart/form-data：file 是切片本体，uploadId + index + totalChunks 在 fields）
router.post('/import/upload/chunk', multerMem.single('file'), async (ctx) => {
  const { uploadId, index } = ctx.request.body || {};
  if (!ctx.file || !ctx.file.buffer) {
    ctx.status = 400; ctx.body = { code: 400, message: '缺少切片文件字段 file' }; return;
  }
  const res = uploadSvc.saveChunk({
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
      batchSize: batchSize ? Number(batchSize) : undefined
    })
    : null;
  const merged = await uploadSvc.mergeUpload({ uploadId, importFn });
  const msg = needImport
    ? `合并成功，导入完成，影响 ${(merged.imported && merged.imported.inserted) || 0} 行`
    : '合并成功';
  ctx.body = ok({
    mergedFilePath: merged.mergedFilePath,
    size: merged.size,
    imported: merged.imported || null
  }, msg);
});

// 4) 取消 + 清理
router.delete('/import/upload/:uploadId', (ctx) => {
  uploadSvc.cleanup(ctx.params.uploadId);
  ctx.body = ok(null, '已清理');
});

module.exports = router;
