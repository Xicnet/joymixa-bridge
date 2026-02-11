import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bridge', {
  getState: () => ipcRenderer.invoke('get-state'),
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),
  getPort: () => ipcRenderer.invoke('get-port'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  onUpdate: (callback: (state: any) => void) => {
    const handler = (_event: any, state: any) => callback(state);
    ipcRenderer.on('bridge-update', handler);
    return () => ipcRenderer.removeListener('bridge-update', handler);
  },
});
