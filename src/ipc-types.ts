/**
 * The typed contract between the main process, the preload bridge, and the renderer.
 *
 * This module must stay free of runtime imports. The preload and renderer are separate
 * webpack bundles from the main process, so importing `bridge.ts` here to reach
 * `BridgeState` would drag the native Link addon, `ws` and `fs` into the renderer bundle.
 * Re-exporting the type with `import type` erases at compile time, keeping `bridge.ts` the
 * single source of truth for the state shape without pulling any of it across the boundary.
 */
import type { BridgeState } from './bridge';

export type { BridgeState };

/** Payload of the `beat-tick` channel — the 100 Hz phase feed that drives the phase bar. */
export interface BeatTick {
  phase: number;
  quantum: number;
  beat: number;
}

/**
 * The surface `preload.ts` exposes on `window.bridge`.
 *
 * `getState()` and the `bridge-update` channel can both yield `null`: the main process
 * sends `bridge?.getState()`, which is undefined before the Bridge exists or after a fatal
 * startup failure. The renderer must handle that, so the type says so rather than lying
 * with a non-nullable `BridgeState`.
 */
export interface BridgeApi {
  getState: () => Promise<BridgeState | null>;
  closeWindow: () => Promise<void>;
  /** Returns an unsubscribe function. */
  onUpdate: (callback: (state: BridgeState | null) => void) => () => void;
  /** Returns an unsubscribe function. */
  onBeatTick: (callback: (tick: BeatTick) => void) => () => void;
}
