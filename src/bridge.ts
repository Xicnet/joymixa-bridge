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
  private readonly LOG_BUFFER_MAX = 500;

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
    return this.logBuffer.join('\n');
  }

  // ── Native audio output latency measurement ──

  /**
   * Measure OS audio output latency on Linux.
   * Returns milliseconds or null if measurement fails.
   *
   * Strategy:
   * 1. PipeWire metadata: parse clock.quantum and clock.rate → quantum/rate*1000
   *    This is the server-side buffer that Chrome's baseLatency doesn't include.
   * 2. Fallback: ALSA hw_params — read period_size and rate from /proc/asound/
   * 3. Returns null on non-Linux platforms (macOS/Windows not yet implemented).
   */
  private async measureAudioOutputLatency(): Promise<void> {
    if (process.platform !== 'linux') {
      this.measuredOutputLatency = null;
      this.latencyMethod = null;
      return;
    }

    // Try PipeWire metadata first (most accurate for PipeWire systems)
    try {
      const pw = await this.measureViaPipeWire();
      if (pw !== null) {
        this.measuredOutputLatency = pw.latencyMs;
        this.latencyMethod = pw.method;
        if (this.diagLog) {
          this.log(`[Bridge] Audio latency: platform=linux audioServer=pipewire measuredOutputLatency=${pw.latencyMs.toFixed(1)}ms method=${pw.method}`);
        }
        return;
      }
    } catch { /* fall through */ }

    // Fallback: ALSA hw_params
    try {
      const alsa = await this.measureViaAlsa();
      if (alsa !== null) {
        this.measuredOutputLatency = alsa.latencyMs;
        this.latencyMethod = alsa.method;
        if (this.diagLog) {
          this.log(`[Bridge] Audio latency: platform=linux audioServer=alsa measuredOutputLatency=${alsa.latencyMs.toFixed(1)}ms method=${alsa.method}`);
        }
        return;
      }
    } catch { /* fall through */ }

    // All methods failed
    if (this.diagLog) {
      this.log('[Bridge] Audio latency: measurement failed (no PipeWire/ALSA data)');
    }
    this.measuredOutputLatency = null;
    this.latencyMethod = null;
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
          const latencyMs = (quantum / rate) * 1000;
          resolve({ latencyMs, method: `pw-quantum(${quantum}/${rate})` });
        } else {
          resolve(null);
        }
      });
    });
  }

  /**
   * Read ALSA period_size and rate from /proc/asound/ for active playback streams.
   * Scans /proc/asound/card{N}/pcm{N}p/sub{N}/hw_params for the first active (non-closed) stream.
   */
  private async measureViaAlsa(): Promise<{ latencyMs: number; method: string } | null> {
    const asoundDir = '/proc/asound';
    let cards: string[];
    try {
      cards = (await readdir(asoundDir)).filter(d => d.startsWith('card'));
    } catch { return null; }

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
          const hwPath = path.join(subDir, sub, 'hw_params');
          try {
            const content = await readFile(hwPath, 'utf-8');
            if (content.trim() === 'closed') continue;

            const periodMatch = content.match(/period_size:\s*(\d+)/);
            const rateMatch = content.match(/rate:\s*(\d+)/);
            if (periodMatch && rateMatch) {
              const periodSize = parseInt(periodMatch[1], 10);
              const rate = parseInt(rateMatch[1], 10);
              if (periodSize > 0 && rate > 0) {
                const latencyMs = (periodSize / rate) * 1000;
                return { latencyMs, method: `alsa-period(${periodSize}/${rate})` };
              }
            }
          } catch { /* skip unreadable */ }
        }
      }
    }

    return null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Ableton Link
    this.link = new AbletonLink(this.config.defaultBpm);
    this.link.enable(true);
    this.link.enableStartStopSync(true);

    this.log(`[bridge] Link enabled. peers: ${this.link.getNumPeers()}`);

    if (this.diagLog) {
      this.log(`[Bridge] platform=${process.platform} arch=${process.arch} os=${os.release()} quantum=${this.config.quantum} defaultBpm=${this.config.defaultBpm} stateHz=${this.config.stateHz}`);
    }

    // Measure native audio output latency at startup + periodic refresh
    this.measureAudioOutputLatency();
    this.latencyRefreshInterval = setInterval(() => {
      this.measureAudioOutputLatency();
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
        ...(this.measuredOutputLatency !== null && { measuredOutputLatency: this.measuredOutputLatency }),
      };

      if (this.diagLog) {
        this.log(`[Bridge:hello] sending: tempo=${helloState.tempo.toFixed(2)} isPlaying=${helloState.isPlaying} beat=${helloState.beat.toFixed(3)} phase=${helloState.phase.toFixed(3)}/${helloState.quantum} nextBar0Delay=${helloState.nextBar0Delay.toFixed(1)}ms peers=${helloState.numPeers} clients=${this.clients.size}`);
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
        ...(this.measuredOutputLatency !== null && { measuredOutputLatency: this.measuredOutputLatency }),
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
