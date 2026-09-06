/**
 * Redis 连接 / 各数据类型 / 命令执行测试
 * 用法: node test-redis.js
 * 依赖: 后端 :3000 已启动，本机 Redis :6379
 */
const http = require('http');

const BASE = 'http://127.0.0.1:3000/api';
const TEST_DB = '15';
const PREFIX = 'navcove:test:';
const results = [];
let token = '';
let connId = '';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      timeout: 15000
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: buf, json });
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

async function query(sql, database = TEST_DB) {
  return post('/query', { connId, database, sql });
}

function firstRows(res) {
  return res.json?.data?.[0]?.rows || [];
}

async function run() {
  console.log('\n=== NavCove Redis 功能测试 ===\n');

  console.log('[1] 认证');
  try {
    const r = await post('/auth/login', { username: 'admin', password: '123456' });
    assert('登录', r.status === 200 && r.json?.code === 0, r.json?.message);
    token = r.json?.data?.token || '';
  } catch (e) {
    fail('登录', e.message);
    console.log('\n请先启动后端: nvm use 23.7.0 && npm run dev:server\n');
    printSummary();
    process.exit(1);
  }

  console.log('\n[2] 连接');
  const conn = { name: 'Redis 自动化测试', type: 'redis', host: '127.0.0.1', port: 6379, user: '', password: '' };
  try {
    const r = await post('/connection/test', conn);
    assert('测试连接', r.json?.code === 0 && r.json?.data?.version, `version=${r.json?.data?.version}`);

    const bad = await post('/connection/test', { ...conn, port: 6399 });
    assert('错误端口拒绝', bad.json?.code !== 0 && /无法连接/.test(bad.json?.message || ''), bad.json?.message);

    const r2 = await post('/connection/connect', conn);
    connId = r2.json?.data?.id || '';
    assert('建立连接', r2.json?.code === 0 && !!connId, connId);

    const r3 = await get('/connection');
    const saved = (r3.json?.data || []).some((c) => c.name === conn.name && c.type === 'redis');
    assert('已存连接含 type=redis', saved);
  } catch (e) { fail('连接', e.message); }

  if (!connId) {
    printSummary();
    process.exit(1);
  }

  console.log('\n[3] 库列表与隔离');
  try {
    const r = await get(`/databases?connId=${connId}`);
    const dbs = r.json?.data || [];
    assert('列出 16 个库', dbs.length === 16 && dbs[0] === '0' && dbs[15] === '15', `count=${dbs.length}`);

    await query('FLUSHDB');
    await query('SET ' + PREFIX + 'db15 only-in-15');
    const db15 = await get(`/tables?connId=${connId}&database=${TEST_DB}`);
    const db0 = await get(`/tables?connId=${connId}&database=0`);
    const names15 = (db15.json?.data || []).map((t) => t.name);
    const names0 = (db0.json?.data || []).map((t) => t.name);
    assert('DB 15 能看到测试 key', names15.includes(PREFIX + 'db15'), names15.join(','));
    assert('DB 0 看不到 DB 15 的 key', !names0.includes(PREFIX + 'db15'));
  } catch (e) { fail('库列表', e.message); }

  console.log('\n[4] 写入各类型 + 命令执行');
  try {
    await query('FLUSHDB');
    const seed = await query([
      `SET ${PREFIX}str hello`,
      `SET ${PREFIX}quoted "hello world"`,
      `HSET ${PREFIX}hash name Alice age 30`,
      `RPUSH ${PREFIX}list a b c`,
      `SADD ${PREFIX}set red green blue`,
      `ZADD ${PREFIX}zset 1 bronze 2 silver 3 gold`,
      `XADD ${PREFIX}stream * event ping`
    ].join('\n'));
    const seedOk = (seed.json?.data || []).every((x) => x.type !== 'error');
    assert('批量写入命令', seedOk && (seed.json?.data || []).length === 7, seed.json?.data?.map((x) => x.type).join(','));

    const comments = await query(`# 这是注释\n-- 也是注释\nPING`);
    assert('注释行被跳过', comments.json?.data?.length === 1 && comments.json?.data?.[0]?.rows?.[0]?.value === 'PONG', JSON.stringify(comments.json?.data));

    const quoted = await query(`GET ${PREFIX}quoted`);
    assert('带空格的 quoted SET/GET', firstRows(quoted)[0]?.value === 'hello world', JSON.stringify(firstRows(quoted)));

    const badCmd = await query('NOT_A_COMMAND foo');
    assert('非法命令返回 error', badCmd.json?.data?.[0]?.type === 'error', badCmd.json?.data?.[0]?.message);

    const getStr = await query(`GET ${PREFIX}str`);
    assert('GET string', firstRows(getStr)[0]?.value === 'hello', JSON.stringify(firstRows(getStr)));

    const hget = await query(`HGETALL ${PREFIX}hash`);
    const hmap = Object.fromEntries(firstRows(hget).map((r) => [r.field, r.value]));
    assert('HGETALL hash', hmap.name === 'Alice' && hmap.age === '30', JSON.stringify(firstRows(hget)));

    const lrange = await query(`LRANGE ${PREFIX}list 0 -1`);
    assert('LRANGE list', firstRows(lrange).map((r) => r.value).join(',') === 'a,b,c', JSON.stringify(firstRows(lrange)));
  } catch (e) { fail('命令执行', e.message); }

  console.log('\n[5] SCAN 列出 key');
  try {
    const r = await get(`/tables?connId=${connId}&database=${TEST_DB}`);
    const names = (r.json?.data || []).map((t) => t.name);
    const need = ['str', 'quoted', 'hash', 'list', 'set', 'zset', 'stream'].map((k) => PREFIX + k);
    const missing = need.filter((k) => !names.includes(k));
    assert('树节点列出全部测试 key', missing.length === 0, missing.length ? '缺少 ' + missing.join(',') : `共 ${names.length} 个`);
  } catch (e) { fail('列出 key', e.message); }

  console.log('\n[6] 点击 key 读各类型（/table/data）');
  try {
    const str = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(PREFIX + 'str')}`);
    assert('string 值', str.json?.data?.rows?.[0]?.type === 'string' && str.json?.data?.rows?.[0]?.value === 'hello', JSON.stringify(str.json?.data?.rows));

    const hash = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(PREFIX + 'hash')}`);
    const hrows = hash.json?.data?.rows || [];
    const hmap = Object.fromEntries(hrows.map((r) => [r.field, r.value]));
    assert('hash 字段', hrows[0]?.type === 'hash' && hmap.name === 'Alice' && hmap.age === '30', JSON.stringify(hrows));

    const list = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(PREFIX + 'list')}`);
    const lrows = list.json?.data?.rows || [];
    assert('list 顺序', lrows.map((r) => r.value).join(',') === 'a,b,c' && lrows[0]?.type === 'list', JSON.stringify(lrows));

    const set = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(PREFIX + 'set')}`);
    const srows = new Set((set.json?.data?.rows || []).map((r) => r.value));
    assert('set 成员', set.json?.data?.rows?.[0]?.type === 'set' && srows.has('red') && srows.has('green') && srows.has('blue'), JSON.stringify(set.json?.data?.rows));

    const zset = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(PREFIX + 'zset')}`);
    const zrows = zset.json?.data?.rows || [];
    assert('zset 成员与分数', zrows[0]?.type === 'zset' && zrows[0]?.member === 'bronze' && zrows[0]?.score === '1' && zrows[2]?.member === 'gold', JSON.stringify(zrows));

    const stream = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(PREFIX + 'stream')}`);
    assert('stream 回退显示类型', stream.json?.data?.rows?.[0]?.type === 'stream', JSON.stringify(stream.json?.data?.rows));

    const missing = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(PREFIX + 'nope')}`);
    assert('不存在的 key 返回空', missing.json?.data?.total === 0 && (missing.json?.data?.rows || []).length === 0, JSON.stringify(missing.json?.data));
  } catch (e) { fail('读取类型', e.message); }

  console.log('\n[7] 增删改');
  try {
    const created = await post('/table/create', {
      connId, database: TEST_DB, table: PREFIX + 'crud',
      columns: { redisType: 'hash', field: 'name', value: 'Tom' }
    });
    assert('新建 hash key', created.json?.code === 0, created.json?.message);

    const ins = await post('/table/row', {
      connId, database: TEST_DB, table: PREFIX + 'crud',
      values: { field: 'age', value: '18' }
    });
    assert('hash 新增 field', ins.json?.code === 0, ins.json?.message);

    const upd = await put('/table/row', {
      connId, database: TEST_DB, table: PREFIX + 'crud',
      pk: { field: 'name' }, values: { value: 'Jerry' }
    });
    assert('hash 修改 value', upd.json?.code === 0, upd.json?.message);

    const after = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(PREFIX + 'crud')}`);
    const map = Object.fromEntries((after.json?.data?.rows || []).map((r) => [r.field, r.value]));
    assert('修改后可读', map.name === 'Jerry' && map.age === '18', JSON.stringify(map));

    const rm = await del('/table/row', {
      connId, database: TEST_DB, table: PREFIX + 'crud', pk: { field: 'age' }
    });
    assert('hash 删除 field', rm.json?.code === 0, rm.json?.message);

    const ren = await post('/table/rename', {
      connId, database: TEST_DB, oldName: PREFIX + 'crud', newName: PREFIX + 'crud2'
    });
    assert('重命名 key', ren.json?.code === 0, ren.json?.message);

    const drop = await del('/table', { connId, database: TEST_DB, table: PREFIX + 'crud2' });
    assert('删除 key', drop.json?.code === 0, drop.json?.message);

    const strUpd = await put('/table/row', {
      connId, database: TEST_DB, table: PREFIX + 'str',
      pk: { field: PREFIX + 'str' }, values: { value: 'updated' }
    });
    assert('string 修改', strUpd.json?.code === 0);
    const strGet = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(PREFIX + 'str')}`);
    assert('string 修改后可读', strGet.json?.data?.rows?.[0]?.value === 'updated', JSON.stringify(strGet.json?.data?.rows));

    const listIns = await post('/table/row', {
      connId, database: TEST_DB, table: PREFIX + 'list', values: { value: 'd' }
    });
    assert('list 追加', listIns.json?.code === 0);
    const listUpd = await put('/table/row', {
      connId, database: TEST_DB, table: PREFIX + 'list',
      pk: { index: 0 }, values: { value: 'A' }
    });
    assert('list 改下标', listUpd.json?.code === 0);
    const listDel = await del('/table/row', {
      connId, database: TEST_DB, table: PREFIX + 'list', pk: { index: 1 }
    });
    assert('list 删下标', listDel.json?.code === 0);
    const listNow = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(PREFIX + 'list')}`);
    assert('list 结果', (listNow.json?.data?.rows || []).map((r) => r.value).join(',') === 'A,c,d', JSON.stringify(listNow.json?.data?.rows));

    const posKey = PREFIX + 'listpos';
    await query(`RPUSH ${posKey} a b c`);
    const headIns = await post('/table/row', {
      connId, database: TEST_DB, table: posKey, values: { value: 'H', index: 0 }
    });
    assert('list 插头部', headIns.json?.code === 0);
    const midIns = await post('/table/row', {
      connId, database: TEST_DB, table: posKey, values: { value: 'M', index: 2 }
    });
    assert('list 插下标', midIns.json?.code === 0);
    const posNow = await get(`/table/data?connId=${connId}&database=${TEST_DB}&table=${encodeURIComponent(posKey)}`);
    assert('list 按 index 插入', (posNow.json?.data?.rows || []).map((r) => r.value).join(',') === 'H,a,M,b,c', JSON.stringify(posNow.json?.data?.rows));
  } catch (e) { fail('增删改', e.message); }

  console.log('\n[8] 清理');
  try {
    const r = await query('FLUSHDB');
    assert('FLUSHDB 测试库', r.json?.code === 0 && r.json?.data?.[0]?.type !== 'error', r.json?.data?.[0]?.rows?.[0]?.value);
  } catch (e) { fail('清理', e.message); }

  printSummary();
}

function printSummary() {
  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok);
  console.log(`\n=== 结果: ${ok}/${results.length} 通过 ===`);
  if (bad.length) {
    console.log('失败项:');
    for (const r of bad) console.log(`  - ${r.name}: ${r.detail}`);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
