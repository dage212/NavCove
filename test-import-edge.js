/**
 * 全面补充验证：SQL 导入 & CSV 导入边界场景
 * 覆盖 test-sql-import.js 未覆盖的场景：编码(GBK/UTF-16/BOM)、日期归一化、
 * 空串→NULL、引号/逗号/换行字段、SQL DELIMITER、坏语句跨批次、超时兜底
 */
const svc = require('./server/services/mysqlService');
const poolMgr = require('./server/db/pool');

const CONN = { id: 'edge', name: 't', type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '' };
const DB = 'navcove_edge';
const TBL = 't_main';
const TBL2 = 't_dates';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? ' -> ' + detail : '')); }
}
async function count(pool, t) {
  const [r] = await pool.query('SELECT COUNT(*) c FROM `' + DB + '`.`' + t + '`');
  return Number(r[0].c);
}

async function setup() {
  poolMgr.registerConnection(CONN.id, CONN);
  const pool = poolMgr.getPool(CONN.id);
  await pool.query('DROP DATABASE IF EXISTS `' + DB + '`');
  await pool.query('CREATE DATABASE `' + DB + '` DEFAULT CHARACTER SET utf8mb4');
  await pool.query('CREATE TABLE `' + DB + '`.`' + TBL + '` (id INT PRIMARY KEY, name VARCHAR(200), note TEXT, val DECIMAL(10,2))');
  await pool.query('CREATE TABLE `' + DB + '`.`' + TBL2 + '` (id INT PRIMARY KEY, d DATE, dt DATETIME)');
  return pool;
}

function tmpCsv(content, encoding) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const f = path.join(os.tmpdir(), 'edge_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.csv');
  if (encoding === 'gbk') {
    const iconv = require('iconv-lite');
    fs.writeFileSync(f, iconv.encode(content, 'gbk'));
  } else {
    fs.writeFileSync(f, content, encoding || 'utf8');
  }
  return f;
}

async function main() {
  const pool = await setup();

  // ========== SQL 导入 ==========
  console.log('\n=== SQL: DELIMITER + 存储过程/触发器（多语句分隔符） ===');
  {
    const sql = [
      `CREATE TABLE \`${DB}\`.\`trig_log\` (msg VARCHAR(100));`,
      `DELIMITER //`,
      `CREATE TRIGGER \`${DB}\`.\`t_ai\` AFTER INSERT ON \`${DB}\`.\`${TBL}\` FOR EACH ROW BEGIN INSERT INTO \`${DB}\`.\`trig_log\` VALUES ('inserted'); END//`,
      `DELIMITER ;`,
      `INSERT INTO \`${DB}\`.\`${TBL}\` VALUES (1,'with, comma','line1\nline2',12.50);`,
      `INSERT INTO \`${DB}\`.\`${TBL}\` VALUES (2,'q''uote','a"b',0);`
    ].join('\n');
    const res = await svc.importSqlText(CONN.id, DB, sql);
    check('executed = 4（建表+触发器+2 INSERT）', res.executed === 4, JSON.stringify(res));
    check('无 badRows', !res.badRows, JSON.stringify(res.badRows));
    const cnt = await count(pool, TBL);
    check('主表 2 行', cnt === 2, 'cnt=' + cnt);
    const [log] = await pool.query('SELECT COUNT(*) c FROM `' + DB + '`.`trig_log`');
    check('触发器已生效（2条日志）', Number(log[0].c) === 2, 'c=' + log[0].c);
    const [r1] = await pool.query('SELECT note, val FROM `' + DB + '`.`' + TBL + '` WHERE id=1');
    check('换行/逗号内容无损', r1[0].note === 'line1\nline2' && Number(r1[0].val) === 12.5, JSON.stringify(r1[0]));
    const [r2] = await pool.query('SELECT name FROM `' + DB + '`.`' + TBL + '` WHERE id=2');
    check("单引号转义正确 q''uote", r2[0].name === "q'uote", JSON.stringify(r2[0]));
  }

  console.log('\n=== SQL: 坏语句在批次中间 + 跨批次隔离 ===');
  {
    await pool.query('TRUNCATE TABLE `' + DB + '`.`' + TBL + '`');
    await pool.query('INSERT INTO `' + DB + '`.`' + TBL + '` VALUES (1,\'seed\',NULL,NULL)');
    // batchSize=3；坏语句放在第2条（id=1 重复），后续好语句应继续
    const sql = [
      'INSERT INTO `' + DB + '`.`' + TBL + '` VALUES (10,\'a\',NULL,NULL)',
      'INSERT INTO `' + DB + '`.`' + TBL + '` VALUES (1,\'dup\',NULL,NULL)',   // 坏
      'INSERT INTO `' + DB + '`.`' + TBL + '` VALUES (11,\'b\',NULL,NULL)',
      'INSERT INTO `' + DB + '`.`' + TBL + '` VALUES (12,\'c\',NULL,NULL)',
      'INSERT INTO `' + DB + '`.`' + TBL + '` VALUES (13,\'d\',NULL,NULL)'
    ].join(';\n');
    const res = await svc.importSqlText(CONN.id, DB, sql, { batchSize: 3 });
    check('executed = 4（坏语句被剔除）', res.executed === 4, 'executed=' + res.executed + ' ' + JSON.stringify(res));
    check('badRows 1 条', res.badRows && res.badRows.length === 1, JSON.stringify(res.badRows));
    const cnt = await count(pool, TBL);
    check('最终 5 行（seed,10,11,12,13）', cnt === 5, 'cnt=' + cnt);
  }

  console.log('\n=== SQL: UTF-8 BOM 前缀剥离 ===');
  {
    await pool.query('TRUNCATE TABLE `' + DB + '`.`' + TBL + '`');
    const sql = '\ufeffINSERT INTO `' + DB + '`.`' + TBL + '` VALUES (1,\'bom\'); INSERT INTO `' + DB + '`.`' + TBL + '` VALUES (2,\'bom2\');';
    const res = await svc.importSqlText(CONN.id, DB, sql);
    check('executed = 2（BOM 不报 1064）', res.executed === 2, JSON.stringify(res));
    const cnt = await count(pool, TBL);
    check('2 行入库', cnt === 2, 'cnt=' + cnt);
  }

  console.log('\n=== SQL: 全部坏语句（整批失败） ===');
  {
    await pool.query('TRUNCATE TABLE `' + DB + '`.`' + TBL + '`');
    let threw = false, msg = '';
    try {
      await svc.importSqlText(CONN.id, DB,
        'INSERT INTO `' + DB + '`.`no_such_table` VALUES (1); INSERT INTO `' + DB + '`.`no_such_table2` VALUES (2);');
    } catch (e) { threw = true; msg = e.message; }
    check('抛出整批失败错误', threw, msg);
    check('提示停止导入', threw && /停止导入/.test(msg), msg);
  }

  // ========== CSV 导入 ==========
  console.log('\n=== CSV: GBK 编码（Excel 导出常见） ===');
  {
    await pool.query('TRUNCATE TABLE `' + DB + '`.`' + TBL + '`');
    const f = tmpCsv('id,name\n1,张三\n2,李四\n', 'gbk');
    const res = await svc.importCsvFileStream(CONN.id, DB, TBL, f, {});
    require('fs').rmSync(f, { force: true });
    check('inserted=2', res.inserted === 2, 'inserted=' + res.inserted);
    const [rows] = await pool.query('SELECT name FROM `' + DB + '`.`' + TBL + '` ORDER BY id');
    check('中文解码正确（GBK→UTF-8）', rows[0].name === '张三' && rows[1].name === '李四', JSON.stringify(rows.map(r => r.name)));
  }

  console.log('\n=== CSV: UTF-8 BOM + 首列名含BOM ===');
  {
    await pool.query('TRUNCATE TABLE `' + DB + '`.`' + TBL + '`');
    const f = tmpCsv('\ufeffid,name\n1,ok\n2,ok2\n', 'utf8');
    const res = await svc.importCsvFileStream(CONN.id, DB, TBL, f, {});
    require('fs').rmSync(f, { force: true });
    check('count=2 / inserted=2', res.count === 2 && res.inserted === 2, JSON.stringify(res));
    const cnt = await count(pool, TBL);
    check('2 行入库', cnt === 2, 'cnt=' + cnt);
  }

  console.log('\n=== CSV: 日期归一化 DD/MM/YYYY 与空串→NULL ===');
  {
    await pool.query('TRUNCATE TABLE `' + DB + '`.`' + TBL2 + '`');
    // d 是 DATE 列，输入 05/08/2026（欧洲格式）应转成 2026-08-05；dt 输入空串→NULL
    const f = tmpCsv('id,d,dt\n1,05/08/2026,\n2,2026-01-02,2026-03-04 10:20:30\n', 'utf8');
    const res = await svc.importCsvFileStream(CONN.id, DB, TBL2, f, {});
    require('fs').rmSync(f, { force: true });
    check('inserted=2', res.inserted === 2, 'inserted=' + res.inserted);
    const [rows] = await pool.query('SELECT d, dt FROM `' + DB + '`.`' + TBL2 + '` ORDER BY id');
    check('DD/MM/YYYY→YYYY-MM-DD', rows[0].d === '2026-08-05', JSON.stringify(rows[0]));
    check('空串→NULL', rows[0].dt === null, JSON.stringify(rows[0]));
    check('标准日期原样', rows[1].d === '2026-01-02' && rows[1].dt === '2026-03-04 10:20:30', JSON.stringify(rows[1]));
  }

  console.log('\n=== CSV: 引号包裹含逗号/换行/双引号 ===');
  {
    await pool.query('TRUNCATE TABLE `' + DB + '`.`' + TBL + '`');
    // CSV: id,name,note 其中 note 带逗号+换行+双引号
    const f = tmpCsv('id,name,note\n1,"smith, john","line1\nline2 ""quoted"""\n', 'utf8');
    const res = await svc.importCsvFileStream(CONN.id, DB, TBL, f, {});
    require('fs').rmSync(f, { force: true });
    check('inserted=1', res.inserted === 1, 'inserted=' + res.inserted);
    const [r] = await pool.query('SELECT name, note FROM `' + DB + '`.`' + TBL + '` WHERE id=1');
    check('逗号字段正确', r[0].name === 'smith, john', JSON.stringify(r[0]));
    check('换行+双引号正确', r[0].note === 'line1\nline2 "quoted"', JSON.stringify(r[0]));
  }

  console.log('\n=== CSV: 首尾空格 trim ===');
  {
    await pool.query('TRUNCATE TABLE `' + DB + '`.`' + TBL + '`');
    const f = tmpCsv('id,name\n1,  padded  \n2,x\n', 'utf8');
    const res = await svc.importCsvFileStream(CONN.id, DB, TBL, f, { trim: true });
    require('fs').rmSync(f, { force: true });
    const [r] = await pool.query('SELECT name FROM `' + DB + '`.`' + TBL + '` WHERE id=1');
    check('trim=true 去除首尾空格', r[0].name === 'padded', JSON.stringify(r[0]));
  }

  console.log('\n=== CSV: 多批次整数倍（batchSize=4, 8行 = 2批） ===');
  {
    await pool.query('TRUNCATE TABLE `' + DB + '`.`' + TBL + '`');
    let csv = 'id,name\n';
    for (let i = 0; i < 8; i++) csv += i + ',n' + i + '\n';
    const f = tmpCsv(csv, 'utf8');
    const res = await svc.importCsvFileStream(CONN.id, DB, TBL, f, { batchSize: 4 });
    require('fs').rmSync(f, { force: true });
    check('inserted=8（最后一批未丢）', res.inserted === 8 && res.count === 8, 'inserted=' + res.inserted + ' count=' + res.count);
    const cnt = await count(pool, TBL);
    check('表中 8 行', cnt === 8, 'cnt=' + cnt);
  }

  // 清理
  await pool.query('DROP DATABASE IF EXISTS `' + DB + '`');
  poolMgr.removeConnection(CONN.id);
  console.log('\n===== 结果: ' + pass + ' 通过, ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); if (e.stack) console.error(e.stack); process.exit(2); });