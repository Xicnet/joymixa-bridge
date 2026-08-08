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
}

const DEFAULTS: BridgeSettings = {
  proDjLinkEnabled: false,
  proDjLinkDeviceOverride: null,
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): BridgeSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BridgeSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    // Missing or unreadable file = first run; corrupt file = fall back to
    // defaults rather than refusing to start over a settings blob.
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: BridgeSettings): void {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  } catch (e) {
    console.warn('[settings] failed to save:', (e as Error).message);
  }
}
