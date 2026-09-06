const poolMgr = require('../db/pool');

function formatConnError(e, conn) {
  const host = conn.host || '127.0.0.1';
  const port = conn.port || 6379;
  const msg = e && (e.message || String(e));
  if (e.code === 'ECONNREFUSED' || /ECONNREFUSED|Connection is closed/i.test(msg)) {
    return `无法连接 ${host}:${port}，请确认 Redis 已启动并监听该端口`;
  }
  if (e.code === 'ETIMEDOUT' || /timed out/i.test(msg)) {
    return `连接 ${host}:${port} 超时，请检查主机、端口和防火墙`;
  }
  if (e.code === 'ENOTFOUND') {
    return `找不到主机 ${host}`;
  }
  if (/NOAUTH|WRONGPASS|invalid password|Authentication/i.test(msg)) {
    return '密码错误或需要密码';
  }
  return msg || '连接失败';
}

function buildClient(conn, lazyConnect = false) {
  const Redis = require('ioredis');
  return new Redis({
    host: conn.host || '127.0.0.1',
    port: Number(conn.port) || 6379,
    username: conn.user || undefined,
    password: conn.password || undefined,
    lazyConnect,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true
  });
}

function stringifyReply(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.toString();
  if (Array.isArray(v)) return v.map(stringifyReply);
  return String(v);
}

function pairsToRows(arr) {
  const rows = [];
  for (let i = 0; i < arr.length; i += 2) {
    rows.push({ field: stringifyReply(arr[i]), value: stringifyReply(arr[i + 1]) });
  }
  return rows;
}

function replyToResult(reply, command) {
  const cmd = String(command || '').toUpperCase();
  if (cmd === 'HGETALL' && Array.isArray(reply)) {
    const rows = pairsToRows(reply);
    return { type: 'select', fields: ['field', 'value'], rows, affected: rows.length };
  }
  if (reply && typeof reply === 'object' && !Buffer.isBuffer(reply) && !Array.isArray(reply)) {
    const rows = Object.entries(reply).map(([field, value]) => ({ field, value: stringifyReply(value) }));
    return { type: 'select', fields: ['field', 'value'], rows, affected: rows.length };
  }
  if (Array.isArray(reply)) {
    const rows = reply.map((value) => ({ value: stringifyReply(value) }));
    return { type: 'select', fields: ['value'], rows, affected: rows.length };
  }
  return {
    type: 'select',
    fields: ['value'],
    rows: [{ value: stringifyReply(reply) }],
    affected: 1
  };
}

function parseRedisCommand(line) {
  const args = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && i + 1 < line.length) {
        cur += line[++i];
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        args.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) args.push(cur);
  return args;
}

async function withDb(connId, database, fn) {
  const base = poolMgr.getPool(connId);
  const db = database === '' || database == null ? 0 : Number(database);
  const client = typeof base.duplicate === 'function' ? base.duplicate() : base;
  const cloned = client !== base;
  try {
    if (db) await client.select(db);
    return await fn(client);
  } finally {
    if (cloned) client.disconnect();
  }
}

async function testConnection(conn) {
  const client = buildClient(conn, true);
  try {
    await client.connect();
    await client.ping();
    const info = await client.info('server');
    const m = /redis_version:(\S+)/.exec(info || '');
    return { version: m ? m[1] : 'unknown' };
  } catch (e) {
    const err = new Error(formatConnError(e, conn));
    err.status = 400;
    throw err;
  } finally {
    client.disconnect();
  }
}

async function listDatabases(connId) {
  return withDb(connId, 0, async (client) => {
    let max = 16;
    try {
      const cfg = await client.config('GET', 'databases');
      const n = Number(Array.isArray(cfg) ? cfg[1] : cfg);
      if (n > 0) max = n;
    } catch (e) { /* 托管 Redis 可能禁用 CONFIG */ }
    const counts = {};
    try {
      const info = await client.info('keyspace');
      for (const line of String(info || '').split(/\r?\n/)) {
        const m = line.match(/^db(\d+):keys=(\d+)/);
        if (m) counts[m[1]] = Number(m[2]);
      }
    } catch (e) { /* ignore */ }
    return Array.from({ length: max }, (_, i) => ({
      name: String(i),
      rows: counts[String(i)] || 0
    }));
  });
}

function sizeCommand(pipe, type, key) {
  if (type === 'hash') pipe.hlen(key);
  else if (type === 'list') pipe.llen(key);
  else if (type === 'set') pipe.scard(key);
  else if (type === 'zset') pipe.zcard(key);
  else if (type === 'stream') pipe.xlen(key);
  else pipe.exists(key);
}

async function listTables(connId, database) {
  return withDb(connId, database, async (client) => {
    const keys = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'COUNT', 200);
      cursor = String(next);
      keys.push(...batch);
    } while (cursor !== '0' && keys.length < 2000);
    keys.sort();
    if (!keys.length) return [];
    const typePipe = client.pipeline();
    keys.forEach((k) => typePipe.type(k));
    const typeRes = await typePipe.exec();
    const sizePipe = client.pipeline();
    keys.forEach((name, i) => {
      const t = typeRes && typeRes[i] ? typeRes[i][1] : 'none';
      sizeCommand(sizePipe, t, name);
    });
    const sizeRes = await sizePipe.exec();
    return keys.map((name, i) => ({
      name,
      rows: sizeRes && sizeRes[i] && sizeRes[i][1] != null ? Number(sizeRes[i][1]) : 0
    }));
  });
}

function toRawText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

async function getTableData(connId, database, key) {
  return withDb(connId, database, async (client) => {
    const t = await client.type(key);
    if (t === 'none') return { total: 0, page: 1, size: 50, rows: [], raw: '', keyType: t };
    let rows = [];
    let native = null;
    if (t === 'string') {
      native = await client.get(key);
      rows = [{ type: t, field: key, value: native }];
    } else if (t === 'hash') {
      native = await client.hgetall(key);
      rows = Object.entries(native).map(([field, value]) => ({ type: t, field, value }));
    } else if (t === 'list') {
      native = await client.lrange(key, 0, -1);
      rows = native.slice(0, 200).map((value, index) => ({ type: t, index, value }));
    } else if (t === 'set') {
      native = await client.smembers(key);
      rows = native.map((value) => ({ type: t, value }));
    } else if (t === 'zset') {
      const arr = await client.zrange(key, 0, -1, 'WITHSCORES');
      native = [];
      for (let i = 0; i < arr.length; i += 2) {
        native.push({ member: arr[i], score: arr[i + 1] });
      }
      rows = native.slice(0, 200).map((item) => ({ type: t, ...item }));
    } else if (t === 'stream') {
      native = await client.xrange(key, '-', '+');
      rows = [{ type: t, value: `(${t})` }];
    } else {
      rows = [{ type: t, value: `(${t})` }];
    }
    return {
      total: t === 'list' || t === 'zset' ? (native ? native.length : rows.length) : rows.length,
      page: 1,
      size: rows.length || 50,
      rows,
      raw: toRawText(native),
      keyType: t
    };
  });
}

function col(field, pk) {
  return { Field: field, Type: 'string', Null: pk ? 'NO' : 'YES', Key: pk ? 'PRI' : '', Default: null, Extra: '' };
}

async function describeTable(connId, database, key) {
  return withDb(connId, database, async (client) => {
    const t = await client.type(key);
    if (t === 'none') return [];
    if (t === 'string') return [col('type'), col('field', true), col('value')];
    if (t === 'hash') return [col('type'), col('field', true), col('value')];
    if (t === 'list') return [col('type'), col('index', true), col('value')];
    if (t === 'set') return [col('type'), col('value', true)];
    if (t === 'zset') return [col('type'), col('member', true), col('score')];
    return [col('type', true), col('value')];
  });
}

function redisErr(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const LIST_INSERT_AT = `
local key = KEYS[1]
local idx = tonumber(ARGV[1])
local val = ARGV[2]
local marker = ARGV[3]
local len = redis.call('LLEN', key)
if not idx or idx < 0 then idx = 0 end
if idx == 0 then
  redis.call('LPUSH', key, val)
  return 1
end
if idx >= len then
  redis.call('RPUSH', key, val)
  return 1
end
local orig = redis.call('LINDEX', key, idx)
redis.call('LSET', key, idx, marker)
redis.call('LINSERT', key, 'BEFORE', marker, val)
redis.call('LSET', key, idx + 1, orig)
return 1
`;

async function listInsert(client, key, values) {
  const value = values.value == null ? '' : String(values.value);
  if (values.index == null || values.index === '') {
    await client.rpush(key, value);
    return;
  }
  const index = Number(values.index);
  if (!Number.isInteger(index) || index < 0) throw redisErr('插入下标必须是非负整数');
  const marker = `__navcove_ins_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
  await client.eval(LIST_INSERT_AT, 1, key, index, value, marker);
}

async function createTable(connId, database, key, spec) {
  const type = String((spec && (spec.redisType || spec.type)) || 'string').toLowerCase();
  const value = spec && spec.value != null ? String(spec.value) : '';
  const field = spec && spec.field != null ? String(spec.field) : 'field';
  const member = spec && spec.member != null ? String(spec.member) : value;
  const score = spec && spec.score != null ? Number(spec.score) : 0;
  if (!key) throw redisErr('key 名称不能为空');
  return withDb(connId, database, async (client) => {
    const exists = await client.exists(key);
    if (exists) throw redisErr(`key「${key}」已存在`);
    if (type === 'string') await client.set(key, value);
    else if (type === 'hash') await client.hset(key, field, value);
    else if (type === 'list') await client.rpush(key, value || '');
    else if (type === 'set') await client.sadd(key, value || 'member');
    else if (type === 'zset') await client.zadd(key, score, member || 'member');
    else throw redisErr('不支持的类型: ' + type);
    return { sql: `CREATE ${type.toUpperCase()} ${key}`, affected: 1 };
  });
}

async function insertRow(connId, database, key, values) {
  return withDb(connId, database, async (client) => {
    const t = await client.type(key);
    if (t === 'none') throw redisErr('key 不存在');
    if (t === 'string') throw redisErr('string 请直接修改值，或右键新建 key');
    if (t === 'hash') {
      const field = values.field;
      if (field == null || field === '') throw redisErr('请填写 field');
      if (await client.hexists(key, field)) throw redisErr(`field「${field}」已存在`);
      await client.hset(key, field, values.value == null ? '' : String(values.value));
    } else if (t === 'list') {
      await listInsert(client, key, values);
    } else if (t === 'set') {
      if (values.value == null || values.value === '') throw redisErr('请填写 value');
      await client.sadd(key, String(values.value));
    } else if (t === 'zset') {
      const member = values.member == null ? values.value : values.member;
      if (member == null || member === '') throw redisErr('请填写 member');
      await client.zadd(key, Number(values.score) || 0, String(member));
    } else {
      throw redisErr(`${t} 不支持在结果表中新增`);
    }
    return { inserted: 1, sql: `INSERT ${t} ${key}` };
  });
}

async function updateRow(connId, database, key, pk, values) {
  return withDb(connId, database, async (client) => {
    const t = await client.type(key);
    if (t === 'none') throw redisErr('key 不存在');
    if (t === 'string') {
      if (values.value == null) return { updated: 0, sql: `SET ${key}` };
      await client.set(key, String(values.value));
    } else if (t === 'hash') {
      const oldField = pk.field;
      if (oldField == null) throw redisErr('缺少 field');
      const newField = values.field != null ? String(values.field) : oldField;
      const nextVal = values.value != null ? String(values.value) : await client.hget(key, oldField);
      if (newField !== String(oldField)) {
        if (await client.hexists(key, newField)) throw redisErr(`field「${newField}」已存在`);
        await client.hset(key, newField, nextVal == null ? '' : nextVal);
        await client.hdel(key, oldField);
      } else {
        await client.hset(key, oldField, nextVal == null ? '' : nextVal);
      }
    } else if (t === 'list') {
      const index = Number(pk.index);
      if (!Number.isInteger(index)) throw redisErr('缺少 index');
      await client.lset(key, index, values.value == null ? '' : String(values.value));
    } else if (t === 'set') {
      const oldVal = pk.value;
      const newVal = values.value;
      if (newVal == null || String(newVal) === String(oldVal)) return { updated: 0, sql: `SADD ${key}` };
      await client.srem(key, oldVal);
      await client.sadd(key, String(newVal));
    } else if (t === 'zset') {
      const oldMember = pk.member;
      if (oldMember == null) throw redisErr('缺少 member');
      const member = values.member != null ? String(values.member) : String(oldMember);
      let score = values.score;
      if (score == null) {
        const cur = await client.zscore(key, oldMember);
        score = cur == null ? 0 : Number(cur);
      }
      if (member !== String(oldMember)) await client.zrem(key, oldMember);
      await client.zadd(key, Number(score) || 0, member);
    } else {
      throw redisErr(`${t} 不支持修改`);
    }
    return { updated: 1, sql: `UPDATE ${t} ${key}` };
  });
}

async function deleteRow(connId, database, key, pk) {
  return withDb(connId, database, async (client) => {
    const t = await client.type(key);
    if (t === 'none') throw redisErr('key 不存在');
    if (t === 'string') {
      await client.del(key);
    } else if (t === 'hash') {
      if (pk.field == null) throw redisErr('缺少 field');
      await client.hdel(key, pk.field);
    } else if (t === 'list') {
      const index = Number(pk.index);
      if (!Number.isInteger(index)) throw redisErr('缺少 index');
      const marker = `__navcove_del_${Date.now()}__`;
      await client.lset(key, index, marker);
      await client.lrem(key, 1, marker);
    } else if (t === 'set') {
      if (pk.value == null) throw redisErr('缺少 value');
      await client.srem(key, pk.value);
    } else if (t === 'zset') {
      if (pk.member == null) throw redisErr('缺少 member');
      await client.zrem(key, pk.member);
    } else {
      throw redisErr(`${t} 不支持删除成员`);
    }
    return { deleted: 1, sql: `DELETE ${t} ${key}` };
  });
}

async function dropTable(connId, database, key) {
  return withDb(connId, database, async (client) => {
    const n = await client.del(key);
    if (!n) throw redisErr(`key「${key}」不存在`);
    return { affected: n, sql: `DEL ${key}` };
  });
}

async function renameTable(connId, database, oldName, newName) {
  if (!newName) throw redisErr('新名称不能为空');
  return withDb(connId, database, async (client) => {
    const exists = await client.exists(newName);
    if (exists) throw redisErr(`key「${newName}」已存在`);
    await client.rename(oldName, newName);
    return { affected: 1, sql: `RENAME ${oldName} ${newName}` };
  });
}

async function truncateTable(connId, database, key) {
  return withDb(connId, database, async (client) => {
    const t = await client.type(key);
    if (t === 'none') throw redisErr('key 不存在');
    if (t === 'string') await client.set(key, '');
    else await client.del(key);
    return { affected: 1, sql: `TRUNCATE ${t} ${key}` };
  });
}

async function executeSql(connId, database, sql) {
  return withDb(connId, database, async (client) => {
    const lines = String(sql).replace(/^\ufeff/, '').split(/\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#') && !s.startsWith('--'));
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const args = parseRedisCommand(lines[i]);
      if (!args.length) continue;
      try {
        const reply = await client.call(args[0], ...args.slice(1));
        results.push({ ...replyToResult(reply, args[0]), index: i + 1 });
      } catch (e) {
        results.push({ type: 'error', index: i + 1, executed: i, message: e.message });
        break;
      }
    }
    return results;
  });
}

module.exports = {
  testConnection,
  listDatabases,
  listTables,
  getTableData,
  describeTable,
  createTable,
  insertRow,
  updateRow,
  deleteRow,
  dropTable,
  renameTable,
  truncateTable,
  executeSql,
  buildClient
};
