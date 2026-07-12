import './index.css';
import type { BridgeApi, BridgeState } from './ipc-types';

declare global {
  interface Window {
    bridge: BridgeApi;
  }
}

const $ = (id: string) => document.getElementById(id)!;

function updateUI(state: BridgeState | null): void {
  if (!state) return;

  // Ableton's Link UI guidelines mandate the words "Enabled"/"Disabled" for the state
  // readout. It was previously a hardcoded "Active" in the markup that nothing ever
  // wrote to — so a bridge with a dead Link session still showed a green badge.
  const linkEl = $('link-status');
  linkEl.textContent = state.linkEnabled ? 'Enabled' : 'Disabled';
  linkEl.classList.toggle('badge-active', state.linkEnabled);
  linkEl.classList.toggle('badge-inactive', !state.linkEnabled);

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
