const { contextBridge, ipcRenderer } = require('electron');

// 窗口控制 + 桌面版标识
contextBridge.exposeInMainWorld('navcove', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onProgress: (cb) => {
      const handler = (_, percent) => cb(percent);
      ipcRenderer.on('updater:progress', handler);
      return () => ipcRenderer.removeListener('updater:progress', handler);
    }
  },
  window: {
    minimize: () => ipcRenderer.send('win-minimize'),
    maximize: () => ipcRenderer.send('win-maximize'),
    close: () => ipcRenderer.send('win-close'),
    isMaximized: () => ipcRenderer.invoke('win-is-maximized'),
    onMaximizeChange: (cb) => {
      const handler = (_, val) => cb(val);
      ipcRenderer.on('win-maximize-changed', handler);
      return () => ipcRenderer.removeListener('win-maximize-changed', handler);
    },
    isFullscreen: () => ipcRenderer.invoke('win-is-fullscreen'),
    onFullscreenChange: (cb) => {
      const handler = (_, val) => cb(val);
      ipcRenderer.on('win-fullscreen-changed', handler);
      return () => ipcRenderer.removeListener('win-fullscreen-changed', handler);
    }
  }
});
