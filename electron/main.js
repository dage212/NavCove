const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');
const http = require('http');

function bootLog(msg) {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'navcove-boot.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch (e) {}
}

bootLog(`main start packaged=${app.isPackaged} exec=${process.execPath}`);

// 开发态写到项目内；打包后必须用系统 userData（安装包目录只读）
if (!app.isPackaged) {
  app.setPath('userData', path.join(__dirname, '..', 'app-data'));
  app.setPath('logs', path.join(__dirname, '..', 'app-data', 'logs'));
}

let mainWindow = null;
let serverProcess = null;
let serverPort = 0;

function getDataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const serverEntry = path.join(__dirname, '..', 'server', 'app.js');
    const isDev = !app.isPackaged && process.env.NODE_ENV === 'development';
    let settled = false;
    let stderrBuf = '';

    const done = (err, port) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(port);
    };

    const env = {
      ...process.env,
      PORT: '0',
      NODE_ENV: isDev ? 'development' : 'production',
      NAVCOVE_DATA_DIR: getDataDir()
    };
    // 子进程跑 Node 脚本；若继承了 ELECTRON_RUN_AS_NODE 以外的 Electron 调试变量，清掉以免干扰
    delete env.ELECTRON_NO_ASAR;

    serverProcess = fork(serverEntry, [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    const onPort = (text) => {
      const m = String(text).match(/http:\/\/localhost:(\d+)/);
      if (m && !serverPort) {
        serverPort = parseInt(m[1], 10);
        done(null, serverPort);
      }
    };

    serverProcess.on('message', (msg) => {
      if (msg && msg.type === 'server-ready' && msg.port && !serverPort) {
        serverPort = Number(msg.port);
        done(null, serverPort);
      }
    });
    serverProcess.stdout.on('data', (raw) => {
      const text = raw.toString();
      process.stdout.write(`[server] ${text}`);
      onPort(text);
    });
    serverProcess.stderr.on('data', (raw) => {
      const text = raw.toString();
      stderrBuf += text;
      process.stderr.write(`[server:err] ${text}`);
      onPort(text);
    });
    serverProcess.on('exit', (code) => {
      console.log('[electron] server process exited, code=', code);
      if (!serverPort) {
        const hint = stderrBuf.trim().split('\n').slice(-8).join('\n');
        done(new Error(`后端进程退出 (code=${code})${hint ? '\n' + hint : ''}`));
      }
    });
    serverProcess.on('error', (err) => done(err));
    setTimeout(() => {
      if (!serverPort) done(new Error('后端启动超时'));
    }, 15000);
  });
}

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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const isDev = !app.isPackaged && process.env.NODE_ENV === 'development';
  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173/');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await waitForHttp(serverPort);
    await mainWindow.loadURL(`http://localhost:${serverPort}/`);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function killServer(signal) {
  if (!serverProcess) return;
  try { serverProcess.kill(signal); } catch (e) {}
  serverProcess = null;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    const isDev = !app.isPackaged && process.env.NODE_ENV === 'development';
    bootLog(`ready isDev=${isDev}`);
    if (!isDev) {
      await startServer();
      bootLog(`server port=${serverPort}`);
    }
    await createWindow();
    bootLog('window created');
  } catch (e) {
    bootLog(`start failed: ${e && e.stack ? e.stack : e}`);
    console.error('[electron] 启动失败:', e.message);
    dialog.showErrorBox('NavCove 启动失败', e.message || String(e));
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killServer('SIGTERM');
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  killServer('SIGTERM');
});

process.on('exit', () => {
  killServer('SIGKILL');
});
