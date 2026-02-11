import './index.css';

interface BridgeAPI {
  getState: () => Promise<any>;
  getLocalIP: () => Promise<string>;
  getPort: () => Promise<number>;
  closeWindow: () => Promise<void>;
  onUpdate: (callback: (state: any) => void) => () => void;
}

declare global {
  interface Window {
    bridge: BridgeAPI;
  }
}

const $ = (id: string) => document.getElementById(id)!;

function updateUI(state: any): void {
  if (!state) return;

  $('peer-count').textContent = String(state.numPeers);
  $('tempo').textContent = state.tempo.toFixed(1);
  $('transport').textContent = state.isPlaying ? 'Playing' : 'Stopped';
  $('client-count').textContent = String(state.numClients);

  const transportEl = $('transport');
  if (state.isPlaying) {
    transportEl.classList.add('playing');
  } else {
    transportEl.classList.remove('playing');
  }
}

async function init(): Promise<void> {
  // Close button
  $('close-btn').addEventListener('click', () => {
    window.bridge.closeWindow();
  });

  // Load initial state
  const state = await window.bridge.getState();
  updateUI(state);

  // Show connection URL
  const ip = await window.bridge.getLocalIP();
  const port = await window.bridge.getPort();
  $('ws-url').textContent = `ws://${ip}:${port}`;

  // Listen for live updates from main process
  window.bridge.onUpdate((updatedState) => {
    updateUI(updatedState);
  });
}

init();
