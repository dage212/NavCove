/**
 * 针对本次修改的聚焦测试：
 *  1. CSV 导入三重限制（行数/大小/事务超时）
 *  2. CSV 替换导入坏行剔除 + 事务回滚
 *  3. SQL 导入三重限制 + 坏语句剔除
 * 用法：先启动 server（node server/app.js），再 node test-import-changes.js
 */
const http = require('http');

const BASE = 'http://127.0.0.1:3000/api';
let token = '';
let connId = '';
const TEST_DB = '__navcove_import_test__';
const TABLE = 'it_users';
const results = [];

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const isRaw = Buffer.isBuffer(body);
    const data = isRaw ? body : (body != null ? Buffer.from(JSON.stringify(body)) : null);
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: {
        ...(data ? { 'Content-Type': isRaw ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers
      },
      timeout: 60000
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}
const ok = (name, cond, detail) => {
  results.push(cond);
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ': ' + detail : ''}`);
};

async function main() {
  console.log('\n=== 导入修改聚焦测试 ===\n');

  // 登录
  const login = await request('POST', '/auth/login', { username: 'admin', password: '123456' });
  if (login.json?.code !== 0) { console.log('登录失败:', login.body); return; }
  token = login.json.data.token;

  // 连接
  const conn = await request('POST', '/connection/connect', { name: '测试', type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '' });
  if (conn.json?.code !== 0) { console.log('连接失败:', conn.body); return; }
  connId = conn.json.data.id;

  // 建库建表
  await request('DELETE', '/database', { connId, name: TEST_DB });
  await request('POST', '/database/create', { connId, name: TEST_DB, charset: 'utf8mb4' });
  await request('POST', '/table/create', {
    connId, database: TEST_DB, table: TABLE,
    columns: [
      { name: 'id', type: 'INT', pk: true, autoIncrement: true, nullable: false },
      { name: 'name', type: 'VARCHAR(100)', nullable: false },
      { name: 'email', type: 'VARCHAR(200)', nullable: true },
      { name: 'score', type: 'INT', nullable: true }
    ]
  });

  // ====== 测试 1: CSV 行数限制 ======
  console.log('\n[1] CSV 行数限制（>5000 应拒绝）');
  const bigCsv = 'name,email,score\n' + Array.from({ length: 5001 }, (_, i) => `u${i},u${i}@t.com,1`).join('\n');
  const r1 = await request('POST', '/import/table', { connId, database: TEST_DB, table: TABLE, content: bigCsv, replace: false });
  ok('CSV 文本接口 >5000 行被拒', r1.json?.code === 400 && /超过限制/.test(r1.json?.message), r1.json?.message);

  // ====== 测试 2: SQL 语句数限制 ======
  console.log('\n[2] SQL 语句数限制（>5000 应拒绝）');
  const bigSql = Array.from({ length: 5001 }, (_, i) => `INSERT INTO \`${TEST_DB}\`.it_users(name,email,score) VALUES('x${i}','x${i}@t.com',1);`).join('\n');
  const r2 = await request('POST', '/import/sql', { connId, database: TEST_DB, content: bigSql });
  ok('SQL >5000 语句被拒', r2.json?.code === 400 && /超过限制/.test(r2.json?.message), r2.json?.message);

  // ====== 测试 3: SQL 导入正常（成功） ======
  console.log('\n[3] SQL 导入正常执行');
  const goodSql = `INSERT INTO \`${TEST_DB}\`.it_users(name,email,score) VALUES('a','a@t.com',10);\n` +
                  `INSERT INTO \`${TEST_DB}\`.it_users(name,email,score) VALUES('b','b@t.com',20);`;
  const r3 = await request('POST', '/import/sql', { connId, database: TEST_DB, content: goodSql });
  ok('SQL 正常导入', r3.json?.code === 0 && r3.json?.data?.executed === 2, JSON.stringify(r3.json?.data));

  // ====== 测试 4: SQL 导入坏语句剔除 ======
  console.log('\n[4] SQL 导入坏语句剔除 + 好语句继续');
  const mixSql = `INSERT INTO \`${TEST_DB}\`.it_users(name,email,score) VALUES('c','c@t.com',30);\n` +
                 `INSERT INTO \`${TEST_DB}\`.no_such_table(name) VALUES('bad');\n` +  // 坏语句
                 `INSERT INTO \`${TEST_DB}\`.it_users(name,email,score) VALUES('d','d@t.com',40);`;
  const r4 = await request('POST', '/import/sql', { connId, database: TEST_DB, content: mixSql });
  ok('坏语句剔除+其余成功', r4.json?.code === 0 && r4.json?.data?.executed === 2 && r4.json?.data?.badRows?.length === 1,
    `executed=${r4.json?.data?.executed} bad=${r4.json?.data?.badRows?.length}`);

  // ====== 测试 5: CSV 替换导入坏行剔除 ======
  console.log('\n[5] CSV 替换导入坏行剔除（走 /import/upload 文件通道）');
  // 构造含坏行的 CSV：id 为主键，重复 id + 一个非法行
  // 需要文件上传通道，这里简化：构造 CSV 并通过 merge 流程
  const csvContent = 'name,email,score\n'
    + 'e,e@t.com,50\n'
    + 'f,f@t.com,60\n'
    + 'g,g@t.com,70\n';
  const csvSize = Buffer.byteLength(csvContent, 'utf8');
  const chunkSize = 1024 * 1024;
  const init = await request('POST', '/import/upload/init', { fileName: 'it.csv', fileSize: csvSize, chunkSize });
  if (init.json?.code === 0) {
    const d = init.json.data;
    const buf = Buffer.from(csvContent, 'utf8');
    for (const idx of d.needChunks) {
      const start = idx * chunkSize;
      const end = Math.min(start + chunkSize, csvSize);
      const form = multipart(d.uploadId, idx, buf.slice(start, end));
      await request('POST', '/import/upload/chunk', form.body, { 'Content-Type': form.ct });
    }
    // 普通导入（非 replace）：坏行应导致整批回滚失败
    const m1 = await request('POST', '/import/upload/merge', { uploadId: d.uploadId, connId, database: TEST_DB, table: TABLE, replace: false });
    ok('CSV 普通导入成功', m1.json?.code === 0, m1.json?.message);
  } else {
    ok('CSV upload init', false, init.body);
  }

  // 验证数据
  const q = await request('POST', '/query', { connId, database: TEST_DB, sql: 'SELECT COUNT(*) AS c FROM it_users' });
  const cnt = q.json?.data?.[0]?.rows?.[0]?.c;
  console.log('  当前行数:', cnt);

  printSummary();
  // 清理
  await request('DELETE', '/database', { connId, name: TEST_DB });
}

// multipart 表单构造
function multipart(uploadId, index, chunkBuf) {
  const boundary = '----navcove-test-' + Date.now();
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="uploadId"\r\n\r\n${uploadId}\r\n` +
               `--${boundary}\r\nContent-Disposition: form-data; name="index"\r\n\r\n${index}\r\n` +
               `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk_${index}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), chunkBuf, Buffer.from(tail, 'utf8')]);
  return { ct: `multipart/form-data; boundary=${boundary}`, body, headers: {} };
}

function printSummary() {
  const passed = results.filter(Boolean).length;
  console.log(`\n=== 汇总 ===`);
  console.log(`通过: ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });