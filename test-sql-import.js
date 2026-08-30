/**
 * 聚焦测试：只测 importSqlText / importCsvFileStream 的服务层函数
 * 不依赖 HTTP 层 / sqlite，直接用 mysqlService 注册连接池连本地 MySQL。
 * 用法：node test-sql-import.js
 */
const svc = require('./server/services/mysqlService');
const poolMgr = require('./server/db/pool');

const CONN = {
  id: 'test-conn',
  name: 'test',
  type: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: ''
};

const DB = 'navcove_test';
const TBL = 't_sql_import';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

async function setup() {
  poolMgr.registerConnection(CONN.id, CONN);
  const pool = poolMgr.getPool(CONN.id);
  await pool.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await pool.query(`CREATE DATABASE \`${DB}\` DEFAULT CHARACTER SET utf8mb4`);
  await pool.query(`CREATE TABLE \`${DB}\`.\`${TBL}\` (id INT PRIMARY KEY, name VARCHAR(100))`);
}

async function main() {
  await setup();

  // ---- importSqlText ----
  section('importSqlText: 正常多条 INSERT');
  {
    const res = await svc.importSqlText(CONN.id, DB,
      `INSERT INTO \`${TBL}\` VALUES (1,'a'); INSERT INTO \`${TBL}\` VALUES (2,'b');`);
    check('executed = 2', res.executed === 2, JSON.stringify(res));
    check('total = 2', res.total === 2);
    check('无 badRows', !res.badRows, JSON.stringify(res.badRows));
    const [rows] = await poolMgr.getPool(CONN.id).query(`SELECT COUNT(*) n FROM \`${DB}\`.\`${TBL}\``);
    check('表中实际 2 行', Number(rows[0].n) === 2, 'n=' + rows[0].n);
  }

  section('importSqlText: 坏语句剔除后好语句入库');
  {
    await poolMgr.getPool(CONN.id).query(`TRUNCATE \`${DB}\`.\`${TBL}\``);
    // 先插入 id=1 作为种子，后续 INSERT (1,'dup') 触发重复主键 → 被剔除
    await poolMgr.getPool(CONN.id).query(`INSERT INTO \`${DB}\`.\`${TBL}\` VALUES (1,'seed')`);
    const res = await svc.importSqlText(CONN.id, DB,
      `INSERT INTO \`${DB}\`.\`${TBL}\` VALUES (3,'ok'); INSERT INTO \`${DB}\`.\`${TBL}\` VALUES (1,'dup'); INSERT INTO \`${DB}\`.\`${TBL}\` VALUES (4,'ok2');`);
    check('executed>=2', res.executed >= 2, JSON.stringify(res));
    check('badRows 存在', !!res.badRows && res.badRows.length >= 1, JSON.stringify(res.badRows));
    const [rows] = await poolMgr.getPool(CONN.id).query(`SELECT COUNT(*) n FROM \`${DB}\`.\`${TBL}\``);
    check('好语句已入库 (3行: seed+3+4)', Number(rows[0].n) === 3, 'n=' + rows[0].n + ' (seed,3,4 应入库)');
    const [idList] = await poolMgr.getPool(CONN.id).query(`SELECT id FROM \`${DB}\`.\`${TBL}\` ORDER BY id`);
    check('入库的是 1,3,4', JSON.stringify(idList.map(r=>r.id)) === JSON.stringify([1,3,4]), JSON.stringify(idList));
  }

  section('importSqlText: 语句数超限(>5000)');
  {
    const many = Array.from({length:5001}, (_,i)=>`SELECT ${i};`).join('\n');
    let threw = false, msg = '';
    try { await svc.importSqlText(CONN.id, DB, many); } catch (e) { threw = true; msg = e.message; }
    check('抛出限制错误', threw, msg);
    check('提示拆分文件', threw && /拆分/.test(msg), msg);
  }

  section('importSqlText: 空内容');
  {
    let threw = false;
    try { const r = await svc.importSqlText(CONN.id, DB, ''); check('空内容返回 executed=0', r.executed === 0); }
    catch (e) { threw = true; console.log('  空内容抛错:', e.message); }
    if (!threw) check('空内容不抛错', true);
  }

  section('importSqlText: 含 DDL 前缀语句');
  {
    await poolMgr.getPool(CONN.id).query(`TRUNCATE \`${DB}\`.\`${TBL}\``);
    const res = await svc.importSqlText(CONN.id, DB,
      `CREATE TABLE \`${DB}\`.\`${TBL}_x\` (id INT); INSERT INTO \`${DB}\`.\`${TBL}\` VALUES (10,'ddl');`);
    check('executed>=2 (DDL+DML)', res.executed >= 2, JSON.stringify(res));
    const [rows] = await poolMgr.getPool(CONN.id).query(`SELECT COUNT(*) n FROM \`${DB}\`.\`${TBL}\``);
    check('DML 已入库', Number(rows[0].n) === 1, 'n=' + rows[0].n);
  }

  // ---- importCsvFileStream 限制 ----
  section('importCsvFileStream: 文件过大(>20MB) 预检');
  {
    const fs = require('fs'), os = require('os'), path = require('path');
    const f = path.join(os.tmpdir(), 'navcove_big_' + Date.now() + '.csv');
    fs.writeFileSync(f, 'a,b\n' + '1,2\n'.repeat(1000000));
    let threw = false, msg = '';
    try { await svc.importCsvFileStream(CONN.id, DB, TBL, f, {}); } catch (e) { threw = true; msg = e.message; }
    fs.rmSync(f, {force:true});
    check('抛出文件大小限制', threw, msg);
    check('提示拆分文件', threw && /拆分/.test(msg), msg);
  }

  section('importCsvFileStream: 行数超限(>5000)');
  {
    const fs = require('fs'), os = require('os'), path = require('path');
    const f = path.join(os.tmpdir(), 'navcove_rows_' + Date.now() + '.csv');
    let csv = 'id,name\n';
    for (let i = 0; i < 5001; i++) csv += `${i},n${i}\n`;
    fs.writeFileSync(f, csv);
    let threw = false, msg = '';
    try { await svc.importCsvFileStream(CONN.id, DB, TBL, f, {}); } catch (e) { threw = true; msg = e.message; }
    fs.rmSync(f, {force:true});
    check('抛出语句数限制', threw, msg);
    check('提示拆分文件', threw && /拆分/.test(msg), msg);
  }

  section('importCsvFileStream: 正常 100 行导入');
  {
    await poolMgr.getPool(CONN.id).query(`TRUNCATE \`${DB}\`.\`${TBL}\``);
    const fs = require('fs'), os = require('os'), path = require('path');
    const f = path.join(os.tmpdir(), 'navcove_ok_' + Date.now() + '.csv');
    let csv = 'id,name\n';
    for (let i = 0; i < 100; i++) csv += `${i},n${i}\n`;
    fs.writeFileSync(f, csv);
    const res = await svc.importCsvFileStream(CONN.id, DB, TBL, f, {});
    fs.rmSync(f, {force:true});
    check('count=100', res.count === 100, 'count=' + res.count);
    check('inserted=100', res.inserted === 100, 'inserted=' + res.inserted);
    const [rows] = await poolMgr.getPool(CONN.id).query(`SELECT COUNT(*) n FROM \`${DB}\`.\`${TBL}\``);
    check('表中实际 100 行', Number(rows[0].n) === 100, 'n=' + rows[0].n);
  }

  section('importCsvFileStream: 批次整数倍时最后一批不丢失（回归测试）');
  {
    await poolMgr.getPool(CONN.id).query(`TRUNCATE \`${DB}\`.\`${TBL}\``);
    const fs = require('fs'), os = require('os'), path = require('path');
    const f = path.join(os.tmpdir(), 'navcove_multi_' + Date.now() + '.csv');
    // 12 行 + batchSize=3 → 恰好 4 批，此前会因 end 事件竞态丢掉最后一批
    let csv = 'id,name\n';
    for (let i = 0; i < 12; i++) csv += `${i},n${i}\n`;
    fs.writeFileSync(f, csv);
    const res = await svc.importCsvFileStream(CONN.id, DB, TBL, f, { batchSize: 3 });
    fs.rmSync(f, {force:true});
    check('count=12', res.count === 12, 'count=' + res.count);
    check('inserted=12（最后一批未丢失）', res.inserted === 12, 'inserted=' + res.inserted);
    const [rows] = await poolMgr.getPool(CONN.id).query(`SELECT COUNT(*) n FROM \`${DB}\`.\`${TBL}\``);
    check('表中实际 12 行', Number(rows[0].n) === 12, 'n=' + rows[0].n);
  }

  section('importCsvFileStream: replace 模式坏行剔除');
  {
    await poolMgr.getPool(CONN.id).query(`TRUNCATE \`${DB}\`.\`${TBL}\``);
    // 预先插入 id=5 (作为冲突主键), CSV 里 id=5 会触发 ON DUPLICATE 更新(不算坏),再用非法 id=abc 触发坏行
    const fs = require('fs'), os = require('os'), path = require('path');
    const f = path.join(os.tmpdir(), 'navcove_rep_' + Date.now() + '.csv');
    // 造坏行：id 传非数字 'x' 插入 INT 列会失败
    fs.writeFileSync(f, 'id,name\n1,ok\nx,bad\n2,ok2\n');
    const res = await svc.importCsvFileStream(CONN.id, DB, TBL, f, { replace: true, skipErrorRows: true });
    fs.rmSync(f, {force:true});
    check('badRows 存在', !!res.badRows && res.badRows.length === 1, JSON.stringify(res.badRows));
    const [rows] = await poolMgr.getPool(CONN.id).query(`SELECT COUNT(*) n FROM \`${DB}\`.\`${TBL}\``);
    check('好行入库(1,2)', Number(rows[0].n) === 2, 'n=' + rows[0].n);
  }

  // 清理
  await poolMgr.getPool(CONN.id).query(`DROP DATABASE IF EXISTS \`${DB}\``);
  poolMgr.removeConnection(CONN.id);

  console.log(`\n\n===== 结果: ${pass} 通过, ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(2);
});