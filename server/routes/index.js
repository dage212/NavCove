const Router = require('@koa/router');
const router = new Router({ prefix: '/api' });
const { v4: uuidv4 } = require('uuid');
const poolMgr = require('../db/pool');
const svc = require('../services/mysqlService');
const config = require('../config');

// 统一成功响应
function ok(data, msg = 'success') {
  return { code: 0, message: msg, data };
}

// --- 用户登录/登出（简单内存 Session）---
// 默认账户：admin / 123456
const users = [{ username: 'admin', password: '123456', name: '管理员' }];
const sessions = new Map(); // token -> user info

router.post('/auth/login', async (ctx) => {
  const { username, password } = ctx.request.body || {};
  const u = users.find((x) => x.username === username && x.password === password);
  if (!u) {
    ctx.status = 401;
    ctx.body = { code: 401, message: '用户名或密码错误' };
    return;
  }
  const token = uuidv4();
  sessions.set(token, { username: u.username, name: u.name, loginAt: Date.now() });
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
  const auth = ctx.request.header.authorization || ctx.query.token;
  const token = (auth || '').replace(/^Bearer\s+/, '');
  const u = sessions.get(token);
  if (!u) { ctx.status = 401; ctx.body = { code: 401, message: '未登录' }; return; }
  ctx.body = ok({ username: u.username, name: u.name });
});

// --- 连接管理 ---
// 获取默认连接配置
router.get('/connection/default', (ctx) => {
  ctx.body = ok(config.defaultConnection);
});

// 测试连接
router.post('/connection/test', async (ctx) => {
  const body = ctx.request.body || {};
  const res = await svc.testConnection(body);
  ctx.body = ok(res, '连接成功');
});

// 建立连接（创建池并返回 id）
router.post('/connection/connect', async (ctx) => {
  const body = ctx.request.body || {};
  // 先测试连通性
  await svc.testConnection(body);
  const id = body.id || uuidv4();
  poolMgr.registerConnection(id, body);
  ctx.body = ok({ id, name: body.name }, '连接成功');
});

// 断开连接
router.delete('/connection/:id', (ctx) => {
  poolMgr.removeConnection(ctx.params.id);
  ctx.body = ok(null, '已断开');
});

// 已连接列表
router.get('/connection', (ctx) => {
  ctx.body = ok(poolMgr.listConnections());
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
// 导出表 CSV（返回文件流）
router.get('/export/table', async (ctx) => {
  const { connId, database, table, limit } = ctx.query;
  const csv = await svc.exportTableCsv(connId, database, table, { limit: limit ? Number(limit) : undefined });
  const filename = encodeURIComponent(`${database}_${table}.csv`);
  ctx.set('Content-Type', 'text/csv; charset=utf-8');
  ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
  // 加 BOM 便于 Excel 正确识别 UTF-8
  ctx.body = '\ufeff' + csv;
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

// 导入 CSV（文本内容上传）
router.post('/import/table', async (ctx) => {
  const { connId, database, table, content, replace } = ctx.request.body || {};
  const res = await svc.importTableCsv(connId, database, table, content, { replace });
  ctx.body = ok(res, `导入完成，影响 ${res.inserted} 行`);
});

module.exports = router;
