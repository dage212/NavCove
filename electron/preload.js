const { contextBridge, ipcRenderer } = require('electron');

// 窗口控制 + 桌面版标识
contextBridge.exposeInMainWorld('navcove', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node
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
    }
  }
});
