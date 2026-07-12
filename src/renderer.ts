import './index.css';

interface BridgeAPI {
  getState: () => Promise<any>;
  getPort: () => Promise<number>;
  getLogs: () => Promise<string>;
  closeWindow: () => Promise<void>;
  onUpdate: (callback: (state: any) => void) => () => void;
  onBeatTick: (callback: (tick: { phase: number; quantum: number; beat: number }) => void) => () => void;
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

  // While the transport is stopped the phase bar is a count-in: it shows where
  // the Link timeline is, and therefore when a start would actually land. Ableton
  // shows the same thing (Live's Arrangement Position progress bar appears only
  // while stopped) and recommends the affordance for quantized launching.
  $('phase').classList.toggle('waiting', !state.isPlaying);
}

async function init(): Promise<void> {
  // Close button
  $('close-btn').addEventListener('click', () => {
    window.bridge.closeWindow();
  });

  // Load initial state
  const state = await window.bridge.getState();
  updateUI(state);

  // Show connection URL — always loopback (the browser connects over 127.0.0.1).
  const port = await window.bridge.getPort();
  $('ws-url').textContent = `ws://127.0.0.1:${port}`;

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

  initPhaseBar();
}

/**
 * Phase bar.
 *
 * Ableton Link exposes no time signature — only a `quantum` (a phase-alignment
 * unit, measured in beats) and a `phase` in [0, quantum). So the bar renders
 * `phase / quantum` as a fill that wraps at the boundary, and derives its tick
 * marks from the live quantum. A fixed 4-LED row assumed 4/4 and could not
 * represent a non-integer quantum (a 3.5-beat loop) at all.
 *
 * The bridge ticks at stateHz (100Hz), which is far above display refresh, so
 * the tick handler only stores the latest phase; a rAF loop does the DOM writes.
 */
function initPhaseBar(): void {
  const fillEl = $('phase-fill');
  const ticksEl = $('phase-ticks');
  const beatEl = $('phase-beat');
  const quantumEl = $('phase-quantum');
  const phaseEl = $('phase');

  let phase = 0;
  let quantum = 0;
  let renderedQuantum = -1;
  let renderedBeat = -1;

  window.bridge.onBeatTick((tick) => {
    phase = tick.phase;
    quantum = tick.quantum;
  });

  const render = (): void => {
    if (quantum > 0) {
      // Rebuild the beat dividers only when the quantum itself changes.
      if (quantum !== renderedQuantum) {
        renderedQuantum = quantum;
        // Dividers sit *between* beats, so beat 0's would land on the bar's own
        // left edge and be invisible. Draw the interior ones only: beats 1..n-1.
        // A non-integer quantum (a 3.5-beat loop) leaves a short final segment,
        // which is correct — position each divider by its true fraction rather
        // than assuming the bar divides evenly.
        const dividers = Math.ceil(quantum) - 1;
        ticksEl.replaceChildren(
          ...Array.from({ length: Math.max(0, dividers) }, (_, i) => {
            const tick = document.createElement('span');
            tick.className = 'phase-tick';
            tick.style.left = `${((i + 1) / quantum) * 100}%`;
            return tick;
          }),
        );
        quantumEl.textContent = `/ ${formatQuantum(quantum)} beats`;
      }

      fillEl.style.transform = `scaleX(${phase / quantum})`;

      const beat = Math.floor(phase) + 1;
      if (beat !== renderedBeat) {
        renderedBeat = beat;
        beatEl.textContent = String(beat);
        phaseEl.classList.toggle('downbeat', beat === 1);
      }
    }
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);
}

/** Trim the trailing zeros a non-integer quantum would otherwise show (3.5, not 3.50). */
function formatQuantum(quantum: number): string {
  return Number.isInteger(quantum) ? String(quantum) : String(Number(quantum.toFixed(2)));
}

init();
