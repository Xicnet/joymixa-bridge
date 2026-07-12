import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { BeatTick, BridgeApi, BridgeState } from './ipc-types';

const api: BridgeApi = {
  getState: () => ipcRenderer.invoke('get-state'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  onUpdate: (callback: (state: BridgeState | null) => void) => {
    const handler = (_event: IpcRendererEvent, state: BridgeState | null) => callback(state);
    ipcRenderer.on('bridge-update', handler);
    return () => ipcRenderer.removeListener('bridge-update', handler);
  },
  onBeatTick: (callback: (tick: BeatTick) => void) => {
    const handler = (_event: IpcRendererEvent, tick: BeatTick) => callback(tick);
    ipcRenderer.on('beat-tick', handler);
    return () => ipcRenderer.removeListener('beat-tick', handler);
  },
};

contextBridge.exposeInMainWorld('bridge', api);
