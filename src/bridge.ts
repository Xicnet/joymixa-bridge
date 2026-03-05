import { AbletonLink } from '@ktamas77/abletonlink';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { readFile, readdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface BridgeConfig {
  port: number;
  defaultBpm: number;
  quantum: number;
  stateHz: number;
}

export interface BridgeState {
  tempo: number;
  isPlaying: boolean;
  beat: number;
  phase: number;
  quantum: number;
  numPeers: number;
  numClients: number;
  nextBar0Delay: number; // ms until next bar-0 boundary (from Link timeline)
}

const DEFAULT_CONFIG: BridgeConfig = {
  port: 20809,
  defaultBpm: 120,
  quantum: 4,
  stateHz: 20,
};

export class Bridge extends EventEmitter {
  private config: BridgeConfig;
  private link: AbletonLink | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private clientLoopBeats = new Map<WebSocket, number>();
  private stateInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  // Phase-alignment diagnostics — set false before release builds.
  private diagLog = true;

  // Native audio output latency measurement (ms)
  private measuredOutputLatency: number | null = null;
  private latencyMethod: string | null = null;
  private latencyRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly LATENCY_REFRESH_MS = 30_000;

  // In-memory log ring buffer for "Copy Logs" feature
  private logBuffer: string[] = [];
  private readonly LOG_BUFFER_MAX = 2000;
  // Pinned lines survive ring buffer eviction (platform info, latency result)
  private pinnedLines: string[] = [];

  constructor(config?: Partial<BridgeConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(msg);
    this.logBuffer.push(line);
    if (this.logBuffer.length > this.LOG_BUFFER_MAX) this.logBuffer.shift();
  }

  private warn(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    console.warn(msg);
    this.logBuffer.push(line);
    if (this.logBuffer.length > this.LOG_BUFFER_MAX) this.logBuffer.shift();
  }

  public getLogs(): string {
    if (this.pinnedLines.length === 0) return this.logBuffer.join('\n');
    return this.pinnedLines.join('\n') + '\n---\n' + this.logBuffer.join('\n');
  }

  private pin(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    this.pinnedLines.push(line);
  }

  // ── Native audio output latency measurement ──

  /**
   * Measure OS audio output latency natively.
   * Returns milliseconds or null if measurement fails.
   *
   * Platform strategies:
   * - Linux: Sample ALSA /proc/asound delay field (primary), hw_params ×2 (fallback),
   *   PipeWire quantum ×2 (last resort). See docs/research/linux-audio-pipeline-latency.md
   * - macOS: CoreAudio property query via swift subprocess
   *   (kAudioDevicePropertyLatency + kAudioStreamPropertyLatency
   *    + kAudioDevicePropertySafetyOffset + bufferFrameSize) / sampleRate
   * - Windows: not yet implemented
   */
  private async measureAudioOutputLatency(): Promise<void> {
    const platform = process.platform;

    if (platform === 'linux') {
      await this.measureAudioOutputLatencyLinux();
    } else if (platform === 'darwin') {
      await this.measureAudioOutputLatencyMac();
    } else {
      this.measuredOutputLatency = null;
      this.latencyMethod = null;
    }
  }

  private async measureAudioOutputLatencyLinux(): Promise<void> {
    // Primary: sample ALSA delay field from /proc/asound (direct measurement)
    // This works with any audio server (PipeWire, PulseAudio, JACK, bare ALSA).
    // See docs/research/linux-audio-pipeline-latency.md for full analysis.
    try {
      const alsaDelay = await this.measureViaAlsaDelay();
      if (alsaDelay !== null) {
        this.measuredOutputLatency = alsaDelay.latencyMs;
        this.latencyMethod = alsaDelay.method;
        const msg = `[Bridge] Audio latency: platform=linux measuredOutputLatency=${alsaDelay.latencyMs.toFixed(1)}ms method=${alsaDelay.method}`;
        this.log(msg);
        this.pin(msg);

        // Cross-check with PipeWire if available (log only, doesn't change result)
        this.crossCheckPipeWire(alsaDelay.latencyMs);
        return;
      }
    } catch { /* fall through */ }

    // Fallback: ALSA hw_params with ×2 period heuristic
    // Used when no playback stream is RUNNING (audio server suspended the device).
    // The ×2 factor accounts for PipeWire's target-fill + write-quantum model.
    try {
      const alsaHw = await this.measureViaAlsaHwParams();
      if (alsaHw !== null) {
        this.measuredOutputLatency = alsaHw.latencyMs;
        this.latencyMethod = alsaHw.method;
        const msg = `[Bridge] Audio latency: platform=linux measuredOutputLatency=${alsaHw.latencyMs.toFixed(1)}ms method=${alsaHw.method} (fallback: no RUNNING stream)`;
        this.log(msg);
        this.pin(msg);
        return;
      }
    } catch { /* fall through */ }

    // Last resort: PipeWire quantum (requires pw-metadata CLI)
    try {
      const pw = await this.measureViaPipeWire();
      if (pw !== null) {
        this.measuredOutputLatency = pw.latencyMs;
        this.latencyMethod = pw.method;
        const msg = `[Bridge] Audio latency: platform=linux measuredOutputLatency=${pw.latencyMs.toFixed(1)}ms method=${pw.method} (fallback: no ALSA data)`;
        this.log(msg);
        this.pin(msg);
        return;
      }
    } catch { /* fall through */ }

    // All methods failed
    const msg = '[Bridge] Audio latency: measurement failed (no ALSA/PipeWire data)';
    this.log(msg);
    this.pin(msg);
    this.measuredOutputLatency = null;
    this.latencyMethod = null;
  }

  private async measureAudioOutputLatencyMac(): Promise<void> {
    try {
      const result = await this.measureViaCoreAudio();
      if (result !== null) {
        this.measuredOutputLatency = result.latencyMs;
        this.latencyMethod = result.method;
        const msg = `[Bridge] Audio latency: platform=darwin measuredOutputLatency=${result.latencyMs.toFixed(1)}ms method=${result.method}`;
        this.log(msg);
        this.pin(msg);
        return;
      }
    } catch (e) {
      const msg = `[Bridge] Audio latency: macOS CoreAudio exception: ${e}`;
      this.log(msg);
      this.pin(msg);
    }

    const msg = '[Bridge] Audio latency: macOS CoreAudio measurement failed — using fallback (none)';
    this.log(msg);
    this.pin(msg);
    this.measuredOutputLatency = null;
    this.latencyMethod = null;
  }

  /**
   * Query macOS CoreAudio for default output device latency.
   * Spawns a small Swift script that queries:
   * - kAudioDevicePropertyLatency (device frames)
   * - kAudioStreamPropertyLatency (stream frames)
   * - kAudioDevicePropertySafetyOffset (safety frames)
   * - kAudioDevicePropertyBufferFrameSize (buffer frames)
   * - kAudioDevicePropertyNominalSampleRate
   * Total latency = (device + stream + safety + buffer) / sampleRate * 1000
   */
  private measureViaCoreAudio(): Promise<{ latencyMs: number; method: string } | null> {
    const swiftCode = `
import CoreAudio
import Foundation

var defaultDeviceID = AudioObjectID(kAudioObjectSystemObject)
var deviceID = AudioDeviceID(0)
var size = UInt32(MemoryLayout<AudioDeviceID>.size)

// Get default output device
var addr = AudioObjectPropertyAddress(
  mSelector: kAudioHardwarePropertyDefaultOutputDevice,
  mScope: kAudioObjectPropertyScopeGlobal,
  mElement: kAudioObjectPropertyElementMain
)
guard AudioObjectGetPropertyData(defaultDeviceID, &addr, 0, nil, &size, &deviceID) == noErr else {
  fputs("ERR: no default output device\\n", stderr)
  exit(1)
}

// Device latency (frames)
var deviceLatency = UInt32(0)
size = UInt32(MemoryLayout<UInt32>.size)
addr.mSelector = kAudioDevicePropertyLatency
addr.mScope = kAudioDevicePropertyScopeOutput
guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &deviceLatency) == noErr else {
  fputs("ERR: device latency\\n", stderr)
  exit(1)
}

// Safety offset (frames)
var safetyOffset = UInt32(0)
size = UInt32(MemoryLayout<UInt32>.size)
addr.mSelector = kAudioDevicePropertySafetyOffset
guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &safetyOffset) == noErr else {
  fputs("ERR: safety offset\\n", stderr)
  exit(1)
}

// Buffer frame size
var bufferFrames = UInt32(0)
size = UInt32(MemoryLayout<UInt32>.size)
addr.mSelector = kAudioDevicePropertyBufferFrameSize
addr.mScope = kAudioObjectPropertyScopeGlobal
guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &bufferFrames) == noErr else {
  fputs("ERR: buffer frame size\\n", stderr)
  exit(1)
}

// Sample rate
var sampleRate = Float64(0)
size = UInt32(MemoryLayout<Float64>.size)
addr.mSelector = kAudioDevicePropertyNominalSampleRate
guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &sampleRate) == noErr else {
  fputs("ERR: sample rate\\n", stderr)
  exit(1)
}

// Stream latency — get first output stream
addr.mSelector = kAudioDevicePropertyStreams
addr.mScope = kAudioDevicePropertyScopeOutput
var streamSize = UInt32(0)
guard AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &streamSize) == noErr,
      streamSize >= UInt32(MemoryLayout<AudioStreamID>.size) else {
  // No streams — use 0 for stream latency
  let totalFrames = Double(deviceLatency + safetyOffset + bufferFrames)
  let latencyMs = (totalFrames / sampleRate) * 1000.0
  print(String(format: "%.2f %.0f %u %u 0 %u", latencyMs, sampleRate, deviceLatency, safetyOffset, bufferFrames))
  exit(0)
}

let streamCount = Int(streamSize) / MemoryLayout<AudioStreamID>.size
var streamIDs = [AudioStreamID](repeating: 0, count: streamCount)
guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &streamSize, &streamIDs) == noErr else {
  let totalFrames = Double(deviceLatency + safetyOffset + bufferFrames)
  let latencyMs = (totalFrames / sampleRate) * 1000.0
  print(String(format: "%.2f %.0f %u %u 0 %u", latencyMs, sampleRate, deviceLatency, safetyOffset, bufferFrames))
  exit(0)
}

var streamLatency = UInt32(0)
size = UInt32(MemoryLayout<UInt32>.size)
var streamAddr = AudioObjectPropertyAddress(
  mSelector: kAudioStreamPropertyLatency,
  mScope: kAudioObjectPropertyScopeGlobal,
  mElement: kAudioObjectPropertyElementMain
)
if AudioObjectGetPropertyData(streamIDs[0], &streamAddr, 0, nil, &size, &streamLatency) != noErr {
  streamLatency = 0
}

let totalFrames = Double(deviceLatency + streamLatency + safetyOffset + bufferFrames)
let latencyMs = (totalFrames / sampleRate) * 1000.0
print(String(format: "%.2f %.0f %u %u %u %u", latencyMs, sampleRate, deviceLatency, safetyOffset, streamLatency, bufferFrames))
`;

    return new Promise((resolve) => {
      execFile('swift', ['-e', swiftCode], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err || !stdout) {
          const detail = stderr?.trim() || err?.message || 'no output';
          const msg = `[Bridge] CoreAudio swift failed: ${detail}`;
          this.log(msg);
          this.pin(msg);
          resolve(null);
          return;
        }

        // Output format: "latencyMs sampleRate deviceLatency safetyOffset streamLatency bufferFrames"
        const parts = stdout.trim().split(/\s+/);
        if (parts.length < 6) { resolve(null); return; }

        const latencyMs = parseFloat(parts[0]);
        const sampleRate = parseFloat(parts[1]);
        const deviceLat = parseInt(parts[2], 10);
        const safetyOff = parseInt(parts[3], 10);
        const streamLat = parseInt(parts[4], 10);
        const bufFrames = parseInt(parts[5], 10);

        if (isNaN(latencyMs) || latencyMs <= 0) { resolve(null); return; }

        const method = `coreaudio(dev=${deviceLat}+stream=${streamLat}+safety=${safetyOff}+buf=${bufFrames}@${sampleRate}Hz)`;

        if (this.diagLog) {
          this.log(`[Bridge] CoreAudio detail: deviceLatency=${deviceLat} streamLatency=${streamLat} safetyOffset=${safetyOff} bufferFrames=${bufFrames} sampleRate=${sampleRate} → ${latencyMs.toFixed(2)}ms`);
        }

        resolve({ latencyMs, method });
      });
    });
  }

  /**
   * Query PipeWire settings metadata for clock quantum and rate.
   * `pw-metadata -n settings` outputs lines like:
   *   update: id:0 key:'clock.quantum' value:'1024' type:''
   *   update: id:0 key:'clock.rate' value:'48000' type:''
   */
  private measureViaPipeWire(): Promise<{ latencyMs: number; method: string } | null> {
    return new Promise((resolve) => {
      execFile('pw-metadata', ['-n', 'settings'], { timeout: 2000 }, (err, stdout) => {
        if (err || !stdout) { resolve(null); return; }

        let quantum: number | null = null;
        let rate: number | null = null;

        for (const line of stdout.split('\n')) {
          // Prefer force-quantum (active override), fall back to clock.quantum (configured default)
          const qMatch = line.match(/key:'clock\.(?:force-)?quantum'\s+value:'(\d+)'/);
          if (qMatch) quantum = parseInt(qMatch[1], 10);
          const rMatch = line.match(/key:'clock\.(?:force-)?rate'\s+value:'(\d+)'/);
          if (rMatch) rate = parseInt(rMatch[1], 10);
        }

        if (quantum && rate && quantum > 0 && rate > 0) {
          // PipeWire double-buffers: one period being filled by the graph,
          // one being consumed by the ALSA sink. Real pipeline latency is ≥ 2× quantum.
          const latencyMs = (quantum / rate) * 1000 * 2;
          resolve({ latencyMs, method: `pw-quantum(${quantum}/${rate}×2)` });
        } else {
          resolve(null);
        }
      });
    });
  }

  /**
   * Cross-check: compare ALSA-measured latency with PipeWire quantum.
   * Log-only — does not change the measured value.
   */
  private crossCheckPipeWire(alsaLatencyMs: number): void {
    this.measureViaPipeWire().then(pw => {
      if (!pw) return;
      const diff = Math.abs(alsaLatencyMs - pw.latencyMs);
      const pct = (diff / alsaLatencyMs) * 100;
      if (pct > 20) {
        this.log(`[Bridge] Latency cross-check: ALSA=${alsaLatencyMs.toFixed(1)}ms vs PipeWire=${pw.latencyMs.toFixed(1)}ms — ${pct.toFixed(0)}% discrepancy`);
      } else if (this.diagLog) {
        this.log(`[Bridge] Latency cross-check: ALSA=${alsaLatencyMs.toFixed(1)}ms ≈ PipeWire=${pw.latencyMs.toFixed(1)}ms — consistent`);
      }
    }).catch(() => {
      if (this.diagLog) this.log('[Bridge] Latency cross-check: pw-metadata not available');
    });
  }

  /**
   * Find all ALSA playback substream paths under /proc/asound/.
   * Returns paths like '/proc/asound/card0/pcm0p/sub0'.
   */
  private async findAlsaPlaybackPaths(): Promise<string[]> {
    const asoundDir = '/proc/asound';
    const paths: string[] = [];
    let cards: string[];
    try {
      cards = (await readdir(asoundDir)).filter(d => d.startsWith('card'));
    } catch { return paths; }

    for (const card of cards) {
      let pcms: string[];
      try {
        pcms = (await readdir(path.join(asoundDir, card))).filter(d => /^pcm\d+p$/.test(d));
      } catch { continue; }

      for (const pcm of pcms) {
        const subDir = path.join(asoundDir, card, pcm);
        let subs: string[];
        try {
          subs = (await readdir(subDir)).filter(d => d.startsWith('sub'));
        } catch { continue; }

        for (const sub of subs) {
          paths.push(path.join(subDir, sub));
        }
      }
    }
    return paths;
  }

  /**
   * Sample the ALSA delay field from /proc/asound/.../status for RUNNING streams.
   *
   * The delay field reports actual frames in the playback buffer (appl_ptr - hw_ptr).
   * Under PipeWire, it oscillates between 1× and 2× quantum because PipeWire
   * maintains a 1-quantum target fill and writes 1 quantum per cycle.
   * The maximum delay is the correct compensation value.
   *
   * Takes ~20 samples over ~200ms, returns the maximum.
   * See docs/research/linux-audio-pipeline-latency.md for the full analysis.
   */
  private async measureViaAlsaDelay(): Promise<{ latencyMs: number; method: string } | null> {
    const subPaths = await this.findAlsaPlaybackPaths();
    if (subPaths.length === 0) return null;

    // Find the first RUNNING playback stream and get its rate
    let runningStatusPath: string | null = null;
    let rate = 0;
    let deviceId = '';

    for (const sub of subPaths) {
      try {
        const status = await readFile(path.join(sub, 'status'), 'utf-8');
        if (!status.startsWith('state: RUNNING')) continue;

        const hwContent = await readFile(path.join(sub, 'hw_params'), 'utf-8');
        const rateMatch = hwContent.match(/rate:\s*(\d+)/);
        if (!rateMatch) continue;

        rate = parseInt(rateMatch[1], 10);
        if (rate <= 0) continue;

        runningStatusPath = path.join(sub, 'status');
        // Extract card/pcm ID for logging (e.g. "card0/pcm0p/sub0")
        const parts = sub.split('/');
        deviceId = parts.slice(-3).join('/');
        break;
      } catch { continue; }
    }

    if (!runningStatusPath || rate <= 0) return null;

    // Sample the delay field ~20 times over ~200ms
    const SAMPLE_COUNT = 20;
    const SAMPLE_INTERVAL_MS = 10;
    const delays: number[] = [];

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      try {
        const status = await readFile(runningStatusPath, 'utf-8');
        const delayMatch = status.match(/delay\s*:\s*(\d+)/);
        if (delayMatch) {
          delays.push(parseInt(delayMatch[1], 10));
        }
      } catch { /* stream may have closed mid-sampling */ }

      if (i < SAMPLE_COUNT - 1) {
        await new Promise(r => setTimeout(r, SAMPLE_INTERVAL_MS));
      }
    }

    if (delays.length < 5) return null; // Not enough samples for reliable max

    const maxDelay = Math.max(...delays);
    const minDelay = Math.min(...delays);
    const latencyMs = (maxDelay / rate) * 1000;
    const minMs = (minDelay / rate) * 1000;

    if (this.diagLog) {
      const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
      this.log(`[Bridge] ALSA delay sampling: device=${deviceId} rate=${rate} samples=${delays.length} min=${minDelay}(${minMs.toFixed(1)}ms) max=${maxDelay}(${latencyMs.toFixed(1)}ms) mean=${(mean / rate * 1000).toFixed(1)}ms`);
    }

    return { latencyMs, method: `alsa-delay(max=${maxDelay}/${rate}@${deviceId})` };
  }

  /**
   * Fallback: read ALSA hw_params for period_size and rate.
   * Uses period_size × 2 as a heuristic for typical PipeWire/PulseAudio buffering.
   *
   * The ×2 factor comes from PipeWire's buffering model: target fill of 1 quantum
   * plus 1 quantum written per cycle = 2 quanta maximum pipeline delay.
   * This is a heuristic — the delay sampling method (measureViaAlsaDelay) is preferred.
   */
  private async measureViaAlsaHwParams(): Promise<{ latencyMs: number; method: string } | null> {
    const subPaths = await this.findAlsaPlaybackPaths();

    for (const sub of subPaths) {
      try {
        const content = await readFile(path.join(sub, 'hw_params'), 'utf-8');
        if (content.trim() === 'closed') continue;

        const periodMatch = content.match(/period_size:\s*(\d+)/);
        const rateMatch = content.match(/rate:\s*(\d+)/);
        const bufferMatch = content.match(/buffer_size:\s*(\d+)/);
        if (periodMatch && rateMatch) {
          const periodSize = parseInt(periodMatch[1], 10);
          const rate = parseInt(rateMatch[1], 10);
          const bufferSize = bufferMatch ? parseInt(bufferMatch[1], 10) : 0;
          if (periodSize > 0 && rate > 0) {
            const latencyMs = (periodSize * 2 / rate) * 1000;
            const parts = sub.split('/');
            const deviceId = parts.slice(-3).join('/');

            if (this.diagLog) {
              this.log(`[Bridge] ALSA hw_params: device=${deviceId} period=${periodSize} buffer=${bufferSize} rate=${rate} → ${latencyMs.toFixed(1)}ms (period×2)`);
            }

            return { latencyMs, method: `alsa-hwparams(${periodSize}×2/${rate}@${deviceId})` };
          }
        }
      } catch { continue; }
    }

    return null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Ableton Link
    this.link = new AbletonLink(this.config.defaultBpm);
    this.link.enable(true);
    this.link.enableStartStopSync(true);

    this.log(`[bridge] Link enabled. peers: ${this.link.getNumPeers()}`);

    {
      const platformInfo = `[Bridge] platform=${process.platform} arch=${process.arch} os=${os.release()} quantum=${this.config.quantum} defaultBpm=${this.config.defaultBpm} stateHz=${this.config.stateHz}`;
      this.log(platformInfo);
      this.pin(platformInfo);
    }

    // Measure native audio output latency BEFORE accepting clients.
    // On macOS the Swift subprocess may take 1-3s to compile+run.
    try {
      await this.measureAudioOutputLatency();
    } catch (e) {
      this.log(`[Bridge] latency measurement failed unexpectedly: ${e}`);
    }
    this.latencyRefreshInterval = setInterval(() => {
      this.measureAudioOutputLatency().catch(() => {});
    }, this.LATENCY_REFRESH_MS);

    // Link callbacks
    this.link.setTempoCallback((rawTempo: number) => {
      const tempo = Math.round(rawTempo * 100) / 100;
      const beat = this.link!.getBeat();
      const phase = this.link!.getPhase(this.config.quantum);
      this.log(`[bridge] tempo from Link: ${tempo}`);
      this.broadcast({ type: 'tempo', tempo, beat, phase, quantum: this.config.quantum });
      this.emit('tempo', tempo);
    });

    this.link.setStartStopCallback((isPlaying: boolean) => {
      this.log(`[bridge] start/stop from Link: ${isPlaying}`);
      this.broadcast({ type: 'playing', isPlaying });
      this.emit('playing', isPlaying);
    });

    this.link.setNumPeersCallback((num: number) => {
      this.log(`[bridge] peers changed: ${num}`);
      this.broadcast({ type: 'peers', numPeers: num });
      this.emit('peers', num);
    });

    // WebSocket server — listen on all interfaces for LAN access
    this.wss = new WebSocketServer({ host: '0.0.0.0', port: this.config.port });
    this.log(`[bridge] WebSocket listening on ws://0.0.0.0:${this.config.port}`);

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      this.log(`[bridge] client connected. clients: ${this.clients.size}`);
      this.emit('clients', this.clients.size);

      // Initial snapshot
      const jmxBeat = this.getJmxBeat();
      const helloState = this.getLinkState();
      const helloMsg = {
        type: 'hello',
        ...helloState,
        numClients: this.clients.size,
        ...(jmxBeat !== undefined && { jmxBeat }),
        ...(this.measuredOutputLatency !== null
          ? { measuredOutputLatency: this.measuredOutputLatency, latencyMethod: this.latencyMethod }
          : { latencyMethod: 'none' }),
      };

      if (this.diagLog) {
        this.log(`[Bridge:hello] sending: tempo=${helloState.tempo.toFixed(2)} isPlaying=${helloState.isPlaying} beat=${helloState.beat.toFixed(3)} phase=${helloState.phase.toFixed(3)}/${helloState.quantum} nextBar0Delay=${helloState.nextBar0Delay.toFixed(1)}ms peers=${helloState.numPeers} clients=${this.clients.size} measuredOutputLatency=${this.measuredOutputLatency?.toFixed(1) ?? 'none'}ms latencyMethod=${this.latencyMethod ?? 'none'}`);
      }

      ws.send(JSON.stringify(helloMsg));

      ws.on('message', (data: Buffer) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          this.warn('[bridge] JSON parse error');
          return;
        }

        if (!msg || typeof msg !== 'object') return;
        this.handleClientMessage(msg, ws);
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.clientLoopBeats.delete(ws);
        this.log(`[bridge] client disconnected. clients: ${this.clients.size}`);
        this.emit('clients', this.clients.size);
      });
    });

    // Periodic state broadcast
    this.stateInterval = setInterval(() => {
      const jmxBeat = this.getJmxBeat();
      const ts = Date.now();
      const linkState = this.getLinkState();
      this.broadcast({
        type: 'state',
        ...linkState,
        numClients: this.clients.size,
        ...(jmxBeat !== undefined && { jmxBeat }),
        ...(this.measuredOutputLatency !== null
          ? { measuredOutputLatency: this.measuredOutputLatency, latencyMethod: this.latencyMethod }
          : { latencyMethod: 'none' }),
        ts,
      });
      this.emit('tick', { phase: linkState.phase, quantum: linkState.quantum, beat: linkState.beat });
    }, 1000 / this.config.stateHz);

    this.emit('started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.stateInterval) {
      clearInterval(this.stateInterval);
      this.stateInterval = null;
    }

    if (this.latencyRefreshInterval) {
      clearInterval(this.latencyRefreshInterval);
      this.latencyRefreshInterval = null;
    }

    if (this.wss) {
      for (const ws of this.clients) {
        ws.close();
      }
      this.clients.clear();
      this.clientLoopBeats.clear();
      this.wss.close();
      this.wss = null;
    }

    if (this.link) {
      this.link.enable(false);
      this.link = null;
    }

    this.log('[bridge] stopped');
    this.emit('stopped');
  }

  getState(): BridgeState {
    return {
      ...this.getLinkState(),
      numClients: this.clients.size,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  private getLinkState(): Omit<BridgeState, 'numClients'> {
    if (!this.link) {
      return {
        tempo: this.config.defaultBpm,
        isPlaying: false,
        beat: 0,
        phase: 0,
        quantum: this.config.quantum,
        numPeers: 0,
        nextBar0Delay: 0,
      };
    }
    // Read all values once — each getter calls captureAppSessionState()
    // internally, so we minimise the number of calls and use the same
    // phase/tempo for both the state message and nextBar0Delay.
    const beat = this.link.getBeat();
    const quantum = this.config.quantum;
    const phase = this.link.getPhase(quantum);
    const tempo = this.link.getTempo();
    const remainingBeats = quantum - phase;
    const msPerBeat = 60000 / tempo;
    const nextBar0Delay = remainingBeats * msPerBeat;

    if (this.diagLog) {
      this.log(`[Bridge:state] beat=${beat.toFixed(3)} phase=${phase.toFixed(3)}/${quantum} tempo=${tempo.toFixed(2)} remainingBeats=${remainingBeats.toFixed(3)} msPerBeat=${msPerBeat.toFixed(1)} nextBar0Delay=${nextBar0Delay.toFixed(1)}ms`);
    }

    // Range validation — always on (indicates bugs, not diagnostics)
    if (remainingBeats < 0) this.warn(`[Bridge] remainingBeats < 0: ${remainingBeats}`);
    if (remainingBeats > quantum) this.warn(`[Bridge] remainingBeats > quantum: ${remainingBeats} > ${quantum}`);
    if (nextBar0Delay > quantum * msPerBeat) this.warn(`[Bridge] nextBar0Delay exceeds bar: ${nextBar0Delay.toFixed(1)} > ${(quantum * msPerBeat).toFixed(1)}`);

    return {
      tempo: Math.round(tempo * 100) / 100,
      isPlaying: this.link.isPlaying(),
      beat,
      phase,
      quantum,
      numPeers: this.link.getNumPeers(),
      nextBar0Delay,
    };
  }

  private handleClientMessage(msg: any, sender: WebSocket): void {
    if (msg.type === 'relay' && msg.payload && typeof msg.payload === 'object') {
      // Forward payload to all OTHER clients (not back to sender)
      this.broadcastExcept(sender, { type: 'relay', payload: msg.payload });
      return;
    }

    // Joymixa loop-beat: store per-client, included in state broadcasts
    if (msg.type === 'loop-beat' && typeof msg.beat === 'number') {
      this.clientLoopBeats.set(sender, msg.beat);
      return;
    }

    if (!this.link) return;

    if (msg.type === 'set-tempo' && typeof msg.tempo === 'number' && isFinite(msg.tempo) && msg.tempo > 0) {
      this.log(`[Bridge:cmd] set-tempo tempo=${msg.tempo.toFixed(2)}`);
      this.link.setTempo(msg.tempo);
      const tempo = this.link.getTempo();
      const beat = this.link.getBeat();
      const phase = this.link.getPhase(this.config.quantum);
      this.broadcast({ type: 'tempo', tempo, beat, phase, quantum: this.config.quantum });
    }

    if (msg.type === 'play') {
      this.log('[Bridge:cmd] play');
      this.link.setIsPlaying(true);
    }

    if (msg.type === 'stop') {
      this.log('[Bridge:cmd] stop');
      this.link.setIsPlaying(false);
    }

    if (msg.type === 'request-quantized-start') {
      const quantum = typeof msg.quantum === 'number' ? msg.quantum : this.config.quantum;
      this.log(`[Bridge:cmd] request-quantized-start quantum=${quantum}`);
      this.link.requestBeatAtStartPlayingTime(0, quantum);
      this.link.setIsPlaying(true);
    }

    if (msg.type === 'force-beat-at-time') {
      const { beat, time, quantum } = msg;
      if (typeof beat === 'number' && typeof time === 'number' && typeof quantum === 'number') {
        this.log(`[Bridge:cmd] force-beat-at-time beat=${beat.toFixed(3)} time=${time} quantum=${quantum}`);
        this.link.forceBeatAtTime(beat, time, quantum);
      }
    }
  }

  private getJmxBeat(): number | undefined {
    for (const [ws, beat] of this.clientLoopBeats) {
      if (ws.readyState === WebSocket.OPEN) return beat;
    }
    return undefined;
  }

  private broadcast(obj: object): void {
    const msg = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  private broadcastExcept(sender: WebSocket, obj: object): void {
    const msg = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws !== sender && ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}
