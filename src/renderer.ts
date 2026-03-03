import './index.css';

interface BridgeAPI {
  getState: () => Promise<any>;
  getLocalIP: () => Promise<string>;
  getPort: () => Promise<number>;
  getLogs: () => Promise<string>;
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

  // Copy Logs button
  const copyBtn = $('copy-logs-btn');
  copyBtn.addEventListener('click', async () => {
    const logs = await window.bridge.getLogs();
    await navigator.clipboard.writeText(logs);
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.textContent = 'Copy Logs';
      copyBtn.classList.remove('copied');
    }, 2000);
  });

  // Listen for live updates from main process
  window.bridge.onUpdate((updatedState) => {
    updateUI(updatedState);
  });
}

init();
