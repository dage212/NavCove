const http = require('http');
const fs = require('fs');
const FormData = require('e:/SqlSecuriteClient/web/node_modules/form-data');

function req(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ hostname: 'localhost', port: 3000, path: '/api' + path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer ' + token }, timeout: 120000 }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); r.write(data); r.end();
  });
}

function uploadChunk(uploadId, index, buf, token) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('uploadId', uploadId);
    form.append('index', String(index));
    form.append('file', buf, { filename: 'chunk', contentType: 'application/octet-stream' });
    const headers = form.getHeaders();
    headers.Authorization = 'Bearer ' + token;
    const r = http.request({ hostname: 'localhost', port: 3000, path: '/api/import/upload/chunk', method: 'POST', headers, timeout: 120000 }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); form.pipe(r);
  });
}

(async () => {
  const connId = '2adc2ebf-4982-4a0d-bf32-b194faa2c84b';
  const db = 'test_db_new';
  const tbl = 'sentences';
  try {
    // 1. 登录
    const lr = await req('/auth/login', { username: 'admin', password: '123456' });
    const t = JSON.parse(lr.body).data.token;
    console.log('1. login OK');

    // 2. 清理旧缓存
    try {
      await new Promise((resolve, reject) => {
        const r = http.request({ hostname: 'localhost', port: 3000, path: '/api/import/upload/8f03016075ba5a090aa66edc5d73634f', method: 'DELETE', headers: { Authorization: 'Bearer ' + t } }, res => { res.on('end', () => resolve()); });
        r.on('error', reject); r.end();
      });
      console.log('2. cleaned old cache');
    } catch (e) { console.log('2. clean skip:', e.message); }

    // 3. 删除 5 行
    const delRes = await req('/query', { connId, database: db, sql: `DELETE FROM ${db}.${tbl} ORDER BY id DESC LIMIT 5` }, t);
    console.log('3. delete 5 rows:', delRes.status, delRes.body.slice(0, 150));

    // 4. init upload
    const csvPath = 'c:/Users/dage212/Desktop/sentences.csv';
    const fileSize = fs.statSync(csvPath).size;
    const chunkSize = 2 * 1024 * 1024;
    const initRes = await req('/import/upload/init', { fileName: 'sentences.csv', fileSize, chunkSize }, t);
    const initData = JSON.parse(initRes.body);
    const d = initData.data;
    console.log('4. init: need', d.needChunks.length, 'merged', d.merged, 'imported', d.imported);

    // 5. 上传切片
    for (const idx of d.needChunks) {
      const start = idx * chunkSize;
      const end = Math.min(start + chunkSize, fileSize);
      const buf = fs.readFileSync(csvPath).slice(start, end);
      const r = await uploadChunk(d.uploadId, idx, buf, t);
      console.log(`5. chunk ${idx}:`, r.status, r.body.slice(0, 100));
    }

    // 6. merge
    const mergeRes = await req('/import/upload/merge', { uploadId: d.uploadId, connId, database: db, table: tbl, replace: true, batchSize: 1000 }, t);
    console.log('6. merge:', mergeRes.status);
    console.log('   body:', mergeRes.body);

  } catch (e) {
    console.log('FATAL:', e.message);
    if (e.stack) console.log(e.stack);
  }
})();
