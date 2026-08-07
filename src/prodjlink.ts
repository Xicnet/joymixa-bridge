import * as dgram from 'dgram';
import * as os from 'os';
import { EventEmitter } from 'events';

/**
 * Pro DJ Link passive follow (v1) — receive-only listener for Pioneer/AlphaTheta
 * beat broadcasts, feeding the followed deck's effective tempo into the Link
 * session (spec: joymixa docs/specs/pro-dj-link-passive-follow.md, D1–D11).
 *
 * HARD INVARIANT (D8): this module never transmits on the Pioneer network.
 * There is no send() call anywhere in this file, and there must never be one —
 * we are a silent observer on a broadcast bus, incapable of colliding with a
 * player number or disrupting a live set.
 *
 * Wire format provenance: written from the published Deep Symmetry packet
 * analysis (https://djl-analysis.deepsymmetry.org/djl-analysis/beats.html) and
 * our own XDJ-700 captures — never from Beat Link source code (GPL-2.0 bridge
 * vs EPL-2.0 tooling; research doc § 6). Every offset below is verified on
 * hardware (research doc § 10, sessions 2026-08-05 / 2026-08-07).
 */

/** Beat packets: one 96-byte broadcast per beat, only while an analyzed track plays. */
const BEAT_PORT = 50001;
/** Announce/keep-alive packets: device presence, broadcast roughly every 2 s. */
const ANNOUNCE_PORT = 50000;

/** All Pro DJ Link packets open with the ASCII bytes "Qspt1WmJOL". */
const MAGIC = Buffer.from([0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c]);
const PACKET_TYPE_OFFSET = 0x0a;

const BEAT_PACKET_TYPE = 0x28;
const BEAT_PACKET_MIN_LENGTH = 0x60;
const BEAT_DEVICE_OFFSET = 0x21;
/** u32 BE; 0x00100000 = fader at 0%. The track's stored BPM is NOT what's playing. */
const BEAT_PITCH_OFFSET = 0x54;
const NEUTRAL_PITCH = 0x100000;
/** u16 BE, 100 × the track's stored BPM. */
const BEAT_BPM_OFFSET = 0x5a;
/** Cycles 1→4; parsed and exposed now, consumed by v2 phase-pinning. */
const BEAT_IN_BAR_OFFSET = 0x5c;

const KEEPALIVE_PACKET_TYPE = 0x06;
const KEEPALIVE_MIN_LENGTH = 0x36;
const KEEPALIVE_NAME_OFFSET = 0x0c;
const KEEPALIVE_NAME_LENGTH = 0x14;
const KEEPALIVE_DEVICE_OFFSET = 0x24;

/** Mixers announce as device 33; they never drive tempo (D2) but count for presence. */
export const MIXER_DEVICE_NUMBER = 33;

/** D4: forward to Link only when effective BPM moved this much. Gates call
 *  frequency only — the forwarded value is always the full-precision double. */
const SEND_THRESHOLD_BPM = 0.05;
/** D3: pause/CUE silence the wire instantly and are a normal every-song event,
 *  so "signal lost" only shows after this much beat silence. Tempo always holds. */
const SIGNAL_LOST_DEBOUNCE_MS = 5000;
/** Keep-alives arrive ~every 2 s; a device missing for this long has left. */
const DEVICE_PRESENCE_TIMEOUT_MS = 10_000;
const STATE_TICK_MS = 1000;
/** How long an enabled, silent listener waits before logging the link-local
 *  reception diagnosis (D6). */
const DEAF_SOCKET_HINT_AFTER_MS = 15_000;

export interface ProDjLinkDevice {
  number: number;
  /** ASCII device name from the keep-alive ("XDJ-700"); empty until one is seen. */
  name: string;
  address: string;
  lastSeen: number;
}

/** One parsed beat packet — exposed for v2 (phase-pinning) consumers. */
export interface ParsedBeat {
  device: number;
  rawBpm: number;
  /** Speed ratio; 1.0 = fader at 0%. */
  pitch: number;
  effectiveBpm: number;
  beatInBar: number;
}

export type ProDjLinkStatus =
  | { kind: 'no-signal' }
  | { kind: 'no-beat-data'; player: number }
  | { kind: 'following'; player: number; bpm: number }
  | { kind: 'signal-lost'; heldBpm: number };

/**
 * Events:
 * - 'tempo' (effectiveBpm: number) — thresholded feed for link.setTempo (D4).
 * - 'beat' (beat: ParsedBeat) — every accepted beat packet, for v2.
 * - 'status' (status: ProDjLinkStatus) — on state-visible changes only.
 * - 'devices' (devices: ProDjLinkDevice[]) — presence roster changed.
 */
export class ProDjLinkListener extends EventEmitter {
  private beatSocket: dgram.Socket | null = null;
  private announceSocket: dgram.Socket | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private devices = new Map<number, ProDjLinkDevice>();
  private deviceOverride: number | null = null;
  private lastSentBpm: number | null = null;
  private lastBeatAt: number | null = null;
  private lastBeatDevice: number | null = null;
  private lastEffectiveBpm: number | null = null;
  private startedAt: number | null = null;
  private deafHintLogged = false;
  private status: ProDjLinkStatus = { kind: 'no-signal' };
  private readonly log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    super();
    this.log = log;
  }

  get running(): boolean {
    return this.beatSocket !== null;
  }

  getStatus(): ProDjLinkStatus {
    return this.status;
  }

  /** Present devices, sorted by player number. */
  getDevices(): ProDjLinkDevice[] {
    return [...this.devices.values()].sort((a, b) => a.number - b.number);
  }

  getDeviceOverride(): number | null {
    return this.deviceOverride;
  }

  /** D2: null = automatic (lowest player number seen). */
  setDeviceOverride(deviceNumber: number | null): void {
    this.deviceOverride = deviceNumber;
    this.log(`[prodjlink] follow override: ${deviceNumber === null ? 'automatic (lowest player)' : `player ${deviceNumber}`}`);
    this.refreshStatus();
  }

  start(): void {
    if (this.running) return;
    this.startedAt = Date.now();
    this.deafHintLogged = false;
    this.beatSocket = this.openReceiveOnlySocket(BEAT_PORT, (buf) => this.onBeatPacket(buf));
    this.announceSocket = this.openReceiveOnlySocket(ANNOUNCE_PORT, (buf, rinfo) => this.onAnnouncePacket(buf, rinfo));
    this.tick = setInterval(() => this.onTick(), STATE_TICK_MS);
    this.log(`[prodjlink] listening (receive-only) on :${BEAT_PORT} beats + :${ANNOUNCE_PORT} presence; host link-local (169.254/16) address: ${this.hostHasLinkLocalAddress() ? 'yes' : 'no'}`);
  }

  /** Stops listening. Deliberately does NOT touch Link tempo — D3 holds the last
   *  tempo forever; disabling the feature must not yank the session's BPM. */
  stop(): void {
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
    this.beatSocket?.close();
    this.announceSocket?.close();
    this.beatSocket = null;
    this.announceSocket = null;
    this.devices.clear();
    this.lastSentBpm = null;
    this.lastBeatAt = null;
    this.lastBeatDevice = null;
    this.lastEffectiveBpm = null;
    this.startedAt = null;
    this.setStatus({ kind: 'no-signal' });
    this.log('[prodjlink] stopped');
  }

  private openReceiveOnlySocket(port: number, onMessage: (buf: Buffer, rinfo: dgram.RemoteInfo) => void): dgram.Socket {
    // reuseAddr: rekordbox or other Pro DJ Link software on this machine may
    // hold the same port; broadcast listeners coexist with SO_REUSEADDR.
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => {
      // D6.3: never fail silently. The tray status stays at "no signal"; the
      // diagnosis lives here in the log (Copy Diagnostics).
      this.log(`[prodjlink] socket :${port} error: ${err.message} — reception on this port is down`);
    });
    sock.on('message', onMessage);
    sock.bind(port);
    return sock;
  }

  private onBeatPacket(buf: Buffer): void {
    if (buf.length < BEAT_PACKET_MIN_LENGTH) return;
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return;
    if (buf[PACKET_TYPE_OFFSET] !== BEAT_PACKET_TYPE) return;

    const device = buf[BEAT_DEVICE_OFFSET];
    this.touchDevice(device, '', null);
    if (device === MIXER_DEVICE_NUMBER) return; // D2: mixers never drive tempo
    if (device !== this.followedDevice()) return;

    const rawBpm = buf.readUInt16BE(BEAT_BPM_OFFSET) / 100;
    const pitch = buf.readUInt32BE(BEAT_PITCH_OFFSET) / NEUTRAL_PITCH;
    const beatInBar = buf[BEAT_IN_BAR_OFFSET];
    const effectiveBpm = rawBpm * pitch; // full double — never rounded (D4/D5)

    this.lastBeatAt = Date.now();
    this.lastBeatDevice = device;
    this.lastEffectiveBpm = effectiveBpm;
    const beat: ParsedBeat = { device, rawBpm, pitch, effectiveBpm, beatInBar };
    this.emit('beat', beat);

    if (this.lastSentBpm === null || Math.abs(effectiveBpm - this.lastSentBpm) >= SEND_THRESHOLD_BPM) {
      this.lastSentBpm = effectiveBpm;
      this.log(`[prodjlink] player ${device}: effective ${effectiveBpm.toFixed(2)} BPM (raw ${rawBpm.toFixed(2)}, pitch ${((pitch - 1) * 100).toFixed(2)}%) → setTempo`);
      this.emit('tempo', effectiveBpm);
    }
    this.refreshStatus();
  }

  private onAnnouncePacket(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    if (buf.length < KEEPALIVE_MIN_LENGTH) return;
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return;
    if (buf[PACKET_TYPE_OFFSET] !== KEEPALIVE_PACKET_TYPE) return;

    const device = buf[KEEPALIVE_DEVICE_OFFSET];
    const name = buf
      .subarray(KEEPALIVE_NAME_OFFSET, KEEPALIVE_NAME_OFFSET + KEEPALIVE_NAME_LENGTH)
      .toString('ascii')
      .replace(/\0[\s\S]*$/, '');
    this.touchDevice(device, rinfo.address, name);
    this.refreshStatus();
  }

  /** D2: override wins; otherwise the lowest non-mixer device number seen. */
  private followedDevice(): number | null {
    if (this.deviceOverride !== null) return this.deviceOverride;
    let lowest: number | null = null;
    for (const n of this.devices.keys()) {
      if (n === MIXER_DEVICE_NUMBER) continue;
      if (lowest === null || n < lowest) lowest = n;
    }
    return lowest;
  }

  private touchDevice(number: number, address: string, name: string | null): void {
    const existing = this.devices.get(number);
    const isNew = !existing;
    const nameChanged = name !== null && name !== '' && existing?.name !== name;
    this.devices.set(number, {
      number,
      name: nameChanged ? (name as string) : existing?.name ?? '',
      address: address || existing?.address || '',
      lastSeen: Date.now(),
    });
    if (isNew || nameChanged) {
      const d = this.devices.get(number) as ProDjLinkDevice;
      this.log(`[prodjlink] device ${number}${d.name ? ` (${d.name})` : ''}${d.address ? ` at ${d.address}` : ''} present`);
      this.emit('devices', this.getDevices());
    }
  }

  private onTick(): void {
    this.pruneDevices();
    this.maybeLogDeafSocketHint();
    this.refreshStatus();
  }

  private pruneDevices(): void {
    const now = Date.now();
    let changed = false;
    for (const [number, device] of this.devices) {
      if (now - device.lastSeen > DEVICE_PRESENCE_TIMEOUT_MS) {
        this.devices.delete(number);
        this.log(`[prodjlink] device ${number}${device.name ? ` (${device.name})` : ''} gone (no keep-alive for ${DEVICE_PRESENCE_TIMEOUT_MS / 1000} s)`);
        changed = true;
      }
    }
    if (changed) this.emit('devices', this.getDevices());
  }

  /**
   * D6 — the link-local gotcha, detection-only by decision (2026-08-07, review):
   * no privileged network reconfiguration on any platform. A deck on a
   * self-assigned 169.254.x address broadcasts to 169.254.255.255, which this
   * socket cannot receive unless the host also holds a 169.254/16 address on
   * that interface (hardware-verified, research doc § 10). We cannot see those
   * packets from userspace, so the honest move is to log the diagnosis once.
   */
  private maybeLogDeafSocketHint(): void {
    if (this.deafHintLogged || this.startedAt === null) return;
    if (this.lastBeatAt !== null || this.devices.size > 0) return;
    if (Date.now() - this.startedAt < DEAF_SOCKET_HINT_AFTER_MS) return;
    if (this.hostHasLinkLocalAddress()) return;
    this.deafHintLogged = true;
    this.log(`[prodjlink] no Pro DJ Link packets after ${DEAF_SOCKET_HINT_AFTER_MS / 1000} s and this host holds no 169.254/16 address — a deck on a self-assigned 169.254.x address (common when direct-wired without a router) broadcasts to 169.254.255.255, which this socket cannot receive. Wiring deck and computer through a router with DHCP avoids this.`);
  }

  private hostHasLinkLocalAddress(): boolean {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && a.address.startsWith('169.254.')) return true;
      }
    }
    return false;
  }

  private refreshStatus(): void {
    this.setStatus(this.computeStatus());
  }

  private computeStatus(): ProDjLinkStatus {
    if (this.lastBeatAt !== null && this.lastEffectiveBpm !== null) {
      if (Date.now() - this.lastBeatAt < SIGNAL_LOST_DEBOUNCE_MS) {
        return { kind: 'following', player: this.lastBeatDevice as number, bpm: this.lastEffectiveBpm };
      }
      // D3: hold forever, never auto-revert. lastSentBpm is what Link holds.
      return { kind: 'signal-lost', heldBpm: this.lastSentBpm ?? this.lastEffectiveBpm };
    }
    const followed = this.followedDevice();
    if (followed !== null && this.devices.has(followed)) {
      return { kind: 'no-beat-data', player: followed };
    }
    return { kind: 'no-signal' };
  }

  private setStatus(next: ProDjLinkStatus): void {
    if (!statusChanged(this.status, next)) return;
    if (next.kind !== this.status.kind) {
      this.log(`[prodjlink] status: ${describeStatus(next)}`);
    }
    this.status = next;
    this.emit('status', next);
  }
}

/** Change detection at display precision: a 'following' status only counts as
 *  changed when the 2-decimal BPM the tray shows would change. */
function statusChanged(a: ProDjLinkStatus, b: ProDjLinkStatus): boolean {
  if (a.kind !== b.kind) return true;
  if (a.kind === 'following' && b.kind === 'following') {
    return a.player !== b.player || a.bpm.toFixed(2) !== b.bpm.toFixed(2);
  }
  if (a.kind === 'no-beat-data' && b.kind === 'no-beat-data') {
    return a.player !== b.player;
  }
  if (a.kind === 'signal-lost' && b.kind === 'signal-lost') {
    return a.heldBpm.toFixed(2) !== b.heldBpm.toFixed(2);
  }
  return false;
}

function describeStatus(s: ProDjLinkStatus): string {
  switch (s.kind) {
    case 'following': return `following player ${s.player} at ${s.bpm.toFixed(2)} BPM`;
    case 'no-beat-data': return `player ${s.player} present, no beat data`;
    case 'signal-lost': return `signal lost, holding ${s.heldBpm.toFixed(2)} BPM`;
    case 'no-signal': return 'no signal';
  }
}
