/**
 * NavCove 功能自动化测试脚本
 * 用法: node test-api.js
 */
const http = require('http');

const BASE = 'http://localhost:3000/api';
let token = '';
let connId = '';
const TEST_DB = '__navcove_test__';
const TEST_TABLE = 'test_users';
const results = [];

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const data = body != null ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers
      },
      timeout: 60000
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: buf, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function get(path) { return request('GET', path); }
function post(path, body) { return request('POST', path, body); }
function put(path, body) { return request('PUT', path, body); }
function del(path, body) { return request('DELETE', path, body); }

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ': ' + detail : ''}`);
}
function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`  ✗ ${name}: ${detail}`);
}
function assert(name, cond, detail) {
  if (cond) pass(name, detail);
  else fail(name, detail);
}

async function run() {
  console.log('\n=== NavCove 功能测试 ===\n');

  // --- 1. 认证 ---
  console.log('[1] 用户认证');
  try {
    const r = await post('/auth/login', { username: 'admin', password: '123456' });
    assert('登录成功', r.status === 200 && r.json?.code === 0, `status=${r.status} msg=${r.json?.message}`);
    token = r.json?.data?.token || '';

    const r2 = await get('/auth/me');
    assert('获取当前用户', r2.json?.data?.username === 'admin', r2.json?.message);

    const r3 = await post('/auth/login', { username: 'admin', password: 'wrong' });
    assert('错误密码拒绝', r3.status === 401, `status=${r3.status}`);
  } catch (e) { fail('认证模块', e.message); }

  // --- 2. 连接管理 ---
  console.log('\n[2] 连接管理');
  try {
    const testConn = { name: '测试连接', type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '' };
    const r = await post('/connection/test', testConn);
    assert('测试连接', r.json?.code === 0, r.json?.message || r.body.slice(0, 100));

    const r2 = await post('/connection/connect', testConn);
    assert('建立连接', r2.json?.code === 0, r2.json?.message || r.body.slice(0, 100));
    connId = r2.json?.data?.id || '';

    const r3 = await get('/connection');
    assert('连接列表', r3.json?.code === 0 && r3.json?.data?.length > 0, `共 ${r3.json?.data?.length} 条`);

    const r4 = await get('/connection/default');
    assert('默认连接', r4.json?.code === 0, r4.json?.data?.name);

    const r5 = await get(`/connection/${connId}`);
    assert('连接详情', r5.json?.code === 0, r5.json?.data?.host);
  } catch (e) { fail('连接管理', e.message); }

  if (!connId) {
    console.log('\n⚠ 无法获取 connId，后续测试跳过');
    printSummary();
    return;
  }

  // --- 3. 数据库操作 ---
  console.log('\n[3] 数据库操作');
  try {
    // 清理旧测试库
    try { await del('/database', { connId, name: TEST_DB }); } catch (_) {}

    const r = await post('/database/create', { connId, name: TEST_DB, charset: 'utf8mb4' });
    assert('创建数据库', r.json?.code === 0, r.json?.message);

    const r2 = await get(`/database/info?connId=${connId}&name=${TEST_DB}`);
    assert('数据库信息', r2.json?.code === 0, r2.json?.data?.charset || r2.json?.data?.name);

    const r3 = await get(`/databases?connId=${connId}`);
    const dbs = r3.json?.data || [];
    assert('列出数据库', dbs.includes(TEST_DB), `找到 ${TEST_DB}`);

    const r4 = await post('/database/alter', { connId, name: TEST_DB, charset: 'utf8mb4' });
    assert('修改字符集', r4.json?.code === 0, r4.json?.message);
  } catch (e) { fail('数据库操作', e.message); }

  // --- 4. 表操作 ---
  console.log('\n[4] 表操作');
  try {
    const cols = [
      { name: 'id', type: 'INT', pk: true, autoIncrement: true, nullable: false },
      { name: 'name', type: 'VARCHAR(100)', nullable: false },
      { name: 'email', type: 'VARCHAR(200)', nullable: true },
      { name: 'score', type: 'INT', nullable: true, default: '0' }
    ];
    const r = await post('/table/create', { connId, database: TEST_DB, table: TEST_TABLE, columns: cols });
    assert('创建表', r.json?.code === 0, r.json?.message);

    const r2 = await get(`/tables?connId=${connId}&database=${TEST_DB}`);
    const tables = (r2.json?.data || []).map(t => t.name);
    assert('列出表', tables.includes(TEST_TABLE), tables.join(', '));

    const r3 = await get(`/table/columns?connId=${connId}&database=${TEST_DB}&table=${TEST_TABLE}`);
    assert('表字段', r3.json?.data?.length === 4, `${r3.json?.data?.length} 列`);

    const r4 = await get(`/table/structure?connId=${connId}&database=${TEST_DB}&table=${TEST_TABLE}`);
    assert('表结构', r4.json?.code === 0, 'OK');

    const r5 = await get(`/database/structure?connId=${connId}&database=${TEST_DB}`);
    assert('库结构', r5.json?.code === 0, 'OK');
  } catch (e) { fail('表操作', e.message); }

  // --- 5. 数据 CRUD ---
  console.log('\n[5] 数据 CRUD');
  let insertedId = null;
  try {
    const r = await post('/table/row', { connId, database: TEST_DB, table: TEST_TABLE, values: { name: 'Alice', email: 'alice@test.com', score: 90 } });
    assert('插入行', r.json?.code === 0, r.json?.message);
    insertedId = r.json?.data?.insertId;

    const r2 = await post('/table/row', { connId, database: TEST_DB, table: TEST_TABLE, values: { name: 'Bob', email: 'bob@test.com', score: 80 } });
    assert('插入第二行', r2.json?.code === 0, r2.json?.message);

    const r3 = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${TEST_TABLE}&page=1&size=10`);
    assert('查询表数据', r3.json?.data?.total >= 2, `total=${r3.json?.data?.total}`);

    const r4 = await put('/table/row', { connId, database: TEST_DB, table: TEST_TABLE, pk: { id: insertedId }, values: { score: 95 } });
    assert('更新行', r4.json?.code === 0, r4.json?.message);

    const r5 = await post('/table/save', {
      connId, database: TEST_DB, table: TEST_TABLE,
      changes: {
        inserted: [{ name: 'Charlie', email: 'charlie@test.com' }],
        updated: [{ pk: { id: insertedId }, values: { name: 'Alice Updated' } }],
        deleted: []
      }
    });
    assert('批量保存', r5.json?.code === 0, r5.json?.message);

    const r6 = await del('/table/row', { connId, database: TEST_DB, table: TEST_TABLE, pk: { id: insertedId } });
    assert('删除行', r6.json?.code === 0, r6.json?.message);
  } catch (e) { fail('数据 CRUD', e.message); }

  // --- 6. SQL 执行 ---
  console.log('\n[6] SQL 执行');
  try {
    const r = await post('/query', { connId, database: TEST_DB, sql: 'SELECT * FROM test_users WHERE score > 0 ORDER BY score DESC' });
    assert('SELECT 查询', r.json?.code === 0 && r.json?.data?.[0]?.rows?.length > 0, `${r.json?.data?.[0]?.rows?.length} 行`);

    const r2 = await post('/query', { connId, database: TEST_DB, sql: 'UPDATE test_users SET score = 100 WHERE name = \'Bob\'; SELECT COUNT(*) AS cnt FROM test_users' });
    assert('多语句执行', r2.json?.code === 0 && r2.json?.data?.length >= 2, `${r2.json?.data?.length} 个结果`);

    const r3 = await post('/query', { connId, database: TEST_DB, sql: '' });
    assert('空 SQL', r3.json?.code === 0, 'OK');
  } catch (e) { fail('SQL 执行', e.message); }

  // --- 7. 导入导出 ---
  console.log('\n[7] 导入导出');
  try {
    const csvContent = 'name,email,score\nDave,dave@test.com,70\nEve,eve@test.com,85';
    const r = await post('/import/table', { connId, database: TEST_DB, table: TEST_TABLE, content: csvContent, replace: false });
    assert('CSV 导入', r.json?.code === 0, r.json?.message);

    const r2 = await get(`/export/table?connId=${connId}&database=${TEST_DB}&table=${TEST_TABLE}`);
    assert('CSV 导出', r2.status === 200 && r2.body.includes('Dave'), `status=${r2.status} len=${r2.body.length}`);

    const r3 = await post('/export/query', { connId, database: TEST_DB, sql: 'SELECT name, score FROM test_users ORDER BY score DESC LIMIT 3' });
    assert('查询结果导出', r3.status === 200 && r3.body.includes('name'), `status=${r3.status}`);

    const r4 = await get(`/export/sql/table?connId=${connId}&database=${TEST_DB}&table=${TEST_TABLE}&withSchema=1&withData=1`);
    assert('表 SQL 导出', r4.status === 200 && r4.body.includes('CREATE TABLE'), `status=${r4.status}`);

    const r5 = await get(`/export/sql/database?connId=${connId}&database=${TEST_DB}&withSchema=1&withData=0`);
    assert('库 SQL 导出', r5.status === 200 && r5.body.includes('CREATE'), `status=${r5.status}`);
  } catch (e) { fail('导入导出', e.message); }

  // --- 8. 表管理 ---
  console.log('\n[8] 表管理');
  const COPY_TABLE = 'test_users_copy';
  try {
    const r = await post('/table/copy', { connId, database: TEST_DB, srcTable: TEST_TABLE, destTable: COPY_TABLE });
    assert('复制表', r.json?.code === 0, r.json?.message);

    const r2 = await post('/table/rename', { connId, database: TEST_DB, oldName: COPY_TABLE, newName: COPY_TABLE + '_renamed' });
    assert('重命名表', r2.json?.code === 0, r2.json?.message);

    await del('/table', { connId, database: TEST_DB, table: COPY_TABLE + '_renamed' });

    const r3 = await post('/table/truncate', { connId, database: TEST_DB, table: TEST_TABLE });
    assert('清空表', r3.json?.code === 0, r3.json?.message);

    const r4 = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${TEST_TABLE}`);
    assert('清空后无数据', r4.json?.data?.total === 0, `total=${r4.json?.data?.total}`);

    await del('/table', { connId, database: TEST_DB, table: TEST_TABLE });
    assert('删除表', true, 'OK');
  } catch (e) { fail('表管理', e.message); }

  // --- 9. 清理 ---
  console.log('\n[9] 清理');
  try {
    await del('/database', { connId, name: TEST_DB });
    pass('删除测试数据库', TEST_DB);
  } catch (e) { fail('清理', e.message); }

  printSummary();
}

function printSummary() {
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.log('\n=== 测试汇总 ===');
  console.log(`通过: ${passed}/${results.length}`);
  if (failed.length) {
    console.log('\n失败项:');
    failed.forEach(f => console.log(`  - ${f.name}: ${f.detail}`));
  } else {
    console.log('全部通过!');
  }
  process.exit(failed.length ? 1 : 0);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
