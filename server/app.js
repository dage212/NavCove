const Koa = require('koa');
const json = require('koa-json');
const cors = require('@koa/cors');
const bodyParser = require('koa-bodyparser');
const path = require('path');
const koaStatic = require('koa-static');
const router = require('./routes');
const db = require('./db/sqlite');
const poolMgr = require('./db/pool');

const app = new Koa();

// 启动时从 SQLite 恢复连接池（避免 nodemon 重启后前端需要重新连接）
try {
  const conns = db.prepare('SELECT * FROM connections').all();
  for (const c of conns) {
    try {
      poolMgr.registerConnection(c.id, c);
      console.log(`[sqlAdmin] 恢复连接池: ${c.name} (${c.host}:${c.port})`);
    } catch (e) {
      console.error(`[sqlAdmin] 恢复连接 ${c.name} 失败:`, e.message);
    }
  }
} catch (e) {
  console.error('[sqlAdmin] 恢复连接池失败:', e.message);
}

app.use(cors());
app.use(bodyParser({ enableTypes: ['json', 'form', 'text'], jsonLimit: '50mb' }));
app.use(json());

// 全局错误处理
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    ctx.status = err.status || 500;
    ctx.body = {
      code: ctx.status,
      message: err.message || '服务器内部错误',
      detail: process.env.NODE_ENV === 'development' ? err.stack : undefined
    };
    ctx.app.emit('error', err, ctx);
  }
});

app.use(router.routes()).use(router.allowedMethods());

// 生产环境托管前端静态资源
const webDist = path.join(__dirname, '..', 'web', 'dist');
app.use(koaStatic(webDist));

// SPA 回退：非 API 路由返回 index.html
app.use(async (ctx) => {
  if (!ctx.path.startsWith('/api')) {
    try {
      ctx.type = 'html';
      ctx.body = require('fs').createReadStream(path.join(webDist, 'index.html'));
    } catch (e) {
      ctx.body = '前端未构建，请先在 web 目录执行 npm run build';
    }
  }
});

// 端口：支持动态分配（PORT=0）由 Electron 主进程读取
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  const addr = server.address();
  const actualPort = addr && typeof addr === 'object' ? addr.port : PORT;
  console.log(`[sqlAdmin] 服务已启动: http://localhost:${actualPort}`);
  // 通过 IPC 通知 Electron 主进程实际端口
  if (process.send) {
    process.send({ type: 'server-ready', port: actualPort });
  }
});

app.on('error', (err) => {
  console.error('[NavCove][error]', err.message);
});

// 捕获未处理的 Promise rejection 和同步异常，防止进程崩溃导致连接重置
process.on('unhandledRejection', (reason) => {
  console.error('[NavCove][unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[NavCove][uncaughtException]', err && err.stack ? err.stack : err);
});
