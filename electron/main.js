const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');

// 彻底禁用原生菜单
Menu.setApplicationMenu(null);

// 在 app ready 之前把 userData 重定向到项目内目录，避免沙箱限制系统 AppData 写入
app.setPath('userData', path.join(__dirname, '..', 'app-data'));
app.setPath('logs', path.join(__dirname, '..', 'app-data', 'logs'));

let mainWindow = null;
let serverProcess = null;
let serverPort = 0;

// ============ 内嵌后端服务 ============
function startServer() {
  return new Promise((resolve, reject) => {
    const serverEntry = path.join(__dirname, '..', 'server', 'app.js');
    const isDev = process.env.NODE_ENV === 'development';
    // 让 server 动态分配端口（PORT=0），通过 stdout 读取实际端口
    serverProcess = fork(serverEntry, [], {
      env: { ...process.env, PORT: '0', NODE_ENV: isDev ? 'development' : 'production' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    const onData = (raw) => {
      const text = raw.toString();
      process.stdout.write(`[server] ${text}`);
      // 解析后端打印的端口（格式形如 "[NavCove] 服务已启动: http://localhost:xxxxx"）
      const m = text.match(/http:\/\/localhost:(\d+)/);
      if (m && !serverPort) {
        serverPort = parseInt(m[1], 10);
        resolve(serverPort);
      }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.stderr.on('data', (raw) => {
      const text = raw.toString();
      process.stderr.write(`[server:err] ${text}`);
      const m = text.match(/http:\/\/localhost:(\d+)/);
      if (m && !serverPort) {
        serverPort = parseInt(m[1], 10);
        resolve(serverPort);
      }
    });
    serverProcess.on('exit', (code) => {
      console.log('[electron] server process exited, code=', code);
    });
    serverProcess.on('error', reject);
    // 兜底：10s 后仍未拿到端口，则用固定端口探测
    setTimeout(() => {
      if (!serverPort) reject(new Error('后端启动超时'));
    }, 10000);
  });
}

// 等待后端 http 可访问
function waitForHttp(port, retries = 30) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const tryReq = () => {
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        count += 1;
        if (count >= retries) reject(new Error('后端健康检查失败'));
        else setTimeout(tryReq, 200);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        count += 1;
        if (count >= retries) reject(new Error('后端健康检查超时'));
        else setTimeout(tryReq, 200);
      });
    };
    tryReq();
  });
}

// ============ 窗口 ============
async function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'NavCove',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#F0F5FF',
    // macOS 用原生交通灯按钮（hiddenInset）；Windows/Linux 无框自定义按钮
    frame: isMac ? true : false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 窗口控制 IPC
  ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('win-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('win-close', () => mainWindow && mainWindow.close());
  ipcMain.handle('win-is-maximized', () => !!(mainWindow && mainWindow.isMaximized()));
  mainWindow.on('maximize', () => mainWindow.webContents.send('win-maximize-changed', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win-maximize-changed', false));

  // 外链在新窗口打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    // 开发模式：直接加载 Vite dev server
    await mainWindow.loadURL('http://localhost:5173/');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // 生产模式：加载后端静态托管的 dist
    await waitForHttp(serverPort);
    await mainWindow.loadURL(`http://localhost:${serverPort}/`);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============ 生命周期 ============
app.whenReady().then(async () => {
  try {
    const isDev = process.env.NODE_ENV === 'development';
    // 开发模式：后端由 concurrently 单独启动（npm run dev:server），这里不再 fork
    // 生产模式：内嵌 fork 后端
    if (!isDev) {
      await startServer();
    }
    await createWindow();
  } catch (e) {
    console.error('[electron] 启动失败:', e.message);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch (e) {}
    serverProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch (e) {}
    serverProcess = null;
  }
});

process.on('exit', () => {
  if (serverProcess) {
    try { serverProcess.kill('SIGKILL'); } catch (e) {}
  }
});
