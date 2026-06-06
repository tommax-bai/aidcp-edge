const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aidcpEdge', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  pause: () => ipcRenderer.invoke('edge:pause'),
  resume: () => ipcRenderer.invoke('edge:resume'),
  relogin: () => ipcRenderer.invoke('auth:relogin'),
  onStatusUpdate: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status:update', listener);
    return () => ipcRenderer.removeListener('status:update', listener);
  },
});