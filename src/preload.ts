import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bridge', {
  getState: () => ipcRenderer.invoke('get-state'),
  getPort: () => ipcRenderer.invoke('get-port'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  onUpdate: (callback: (state: any) => void) => {
    const handler = (_event: any, state: any) => callback(state);
    ipcRenderer.on('bridge-update', handler);
    return () => ipcRenderer.removeListener('bridge-update', handler);
  },
  onBeatTick: (callback: (tick: { phase: number; quantum: number; beat: number }) => void) => {
    const handler = (_event: any, tick: any) => callback(tick);
    ipcRenderer.on('beat-tick', handler);
    return () => ipcRenderer.removeListener('beat-tick', handler);
  },
});
