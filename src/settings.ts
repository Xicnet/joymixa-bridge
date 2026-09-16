import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Minimal persisted settings for the bridge.
 *
 * The bridge historically had no settings file — its one persisted toggle
 * ("Open at Login") rides the OS login-item store. The Pro DJ Link feature
 * needs real persistence (enable state + device override), so this is a tiny
 * JSON file in userData rather than a new dependency. Synchronous IO is fine:
 * the file is a few bytes, read once at startup and written on a menu click.
 */
export interface BridgeSettings {
  /** Pro DJ Link follow enabled (spec D9: default OFF). */
  proDjLinkEnabled: boolean;
  /** Followed player number, or null for automatic (lowest seen — spec D2). */
  proDjLinkDeviceOverride: number | null;
  /** Ableton Link enabled (default OFF — the bridge joins the mesh when the first instance votes On, spec T-C2). */
  linkEnabled: boolean;
}

const DEFAULTS: BridgeSettings = {
  proDjLinkEnabled: false,
  proDjLinkDeviceOverride: null,
  linkEnabled: false,
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * The single in-memory copy of the settings file.
 *
 * OWNERSHIP: this module owns it. Nothing else holds a snapshot.
 *
 * Two writers exist — the tray menu (Pro DJ Link) and a WebSocket client
 * (`set-link-enabled`, protocol § 4.8) — and they fire independently. When each
 * held its own copy and wrote the whole object back, whichever wrote second
 * silently reverted the other's field to the value it had read at startup. A
 * patch-based update against one shared copy removes that class of bug rather
 * than narrowing its window: callers say which field changed, never "write out
 * everything I think the settings are".
 */
let current: BridgeSettings | null = null;

/** Read the settings file into the module-owned copy. Called once, at app ready. */
export function loadSettings(): BridgeSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BridgeSettings>;
    current = { ...DEFAULTS, ...parsed };
  } catch {
    // Missing or unreadable file = first run; corrupt file = fall back to
    // defaults rather than refusing to start over a settings blob.
    current = { ...DEFAULTS };
  }
  return current;
}

/**
 * The current settings. Lazily loads on first use so a caller that runs before
 * `loadSettings()` (or a unit test) still gets a coherent object rather than null.
 * The returned object is the live copy — read from it, never mutate it; use
 * `updateSettings` to change a field.
 */
export function getSettings(): BridgeSettings {
  return current ?? loadSettings();
}

/**
 * Apply a partial change and persist it. The only supported way to write a
 * setting: the patch is merged into the shared copy, so a concurrent writer
 * touching a different field cannot be reverted.
 */
export function updateSettings(patch: Partial<BridgeSettings>): BridgeSettings {
  const next = { ...getSettings(), ...patch };
  current = next;
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + '\n', 'utf-8');
  } catch (e) {
    console.warn('[settings] failed to save:', (e as Error).message);
  }
  return next;
}
