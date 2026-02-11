import { AbletonLink } from '@ktamas77/abletonlink';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';

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

  constructor(config?: Partial<BridgeConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Ableton Link
    this.link = new AbletonLink(this.config.defaultBpm);
    this.link.enable(true);
    this.link.enableStartStopSync(true);

    console.log('[bridge] Link enabled. peers:', this.link.getNumPeers());

    // Link callbacks
    this.link.setTempoCallback((tempo: number) => {
      console.log('[bridge] tempo from Link:', tempo);
      this.broadcast({ type: 'tempo', tempo });
      this.emit('tempo', tempo);
    });

    this.link.setStartStopCallback((isPlaying: boolean) => {
      console.log('[bridge] start/stop from Link:', isPlaying);
      this.broadcast({ type: 'playing', isPlaying });
      this.emit('playing', isPlaying);
    });

    this.link.setNumPeersCallback((num: number) => {
      console.log('[bridge] peers changed:', num);
      this.broadcast({ type: 'peers', numPeers: num });
      this.emit('peers', num);
    });

    // WebSocket server — listen on all interfaces for LAN access
    this.wss = new WebSocketServer({ host: '0.0.0.0', port: this.config.port });
    console.log(`[bridge] WebSocket listening on ws://0.0.0.0:${this.config.port}`);

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      console.log('[bridge] client connected. clients:', this.clients.size);
      this.emit('clients', this.clients.size);

      // Initial snapshot
      const jmxBeat = this.getJmxBeat();
      ws.send(JSON.stringify({
        type: 'hello',
        ...this.getLinkState(),
        numClients: this.clients.size,
        ...(jmxBeat !== undefined && { jmxBeat }),
      }));

      ws.on('message', (data: Buffer) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          console.error('[bridge] JSON parse error');
          return;
        }

        if (!msg || typeof msg !== 'object') return;
        this.handleClientMessage(msg, ws);
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.clientLoopBeats.delete(ws);
        console.log('[bridge] client disconnected. clients:', this.clients.size);
        this.emit('clients', this.clients.size);
      });
    });

    // Periodic state broadcast
    this.stateInterval = setInterval(() => {
      const jmxBeat = this.getJmxBeat();
      this.broadcast({
        type: 'state',
        ...this.getLinkState(),
        numClients: this.clients.size,
        ...(jmxBeat !== undefined && { jmxBeat }),
      });
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

    console.log('[bridge] stopped');
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
      };
    }
    return {
      tempo: this.link.getTempo(),
      isPlaying: this.link.isPlaying(),
      beat: this.link.getBeat(),
      phase: this.link.getPhase(this.config.quantum),
      quantum: this.config.quantum,
      numPeers: this.link.getNumPeers(),
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
      console.log('[bridge] client set-tempo:', msg.tempo);
      this.link.setTempo(msg.tempo);
      this.broadcast({ type: 'tempo', tempo: this.link.getTempo() });
    }

    if (msg.type === 'play') {
      console.log('[bridge] client play');
      this.link.setIsPlaying(true);
    }

    if (msg.type === 'stop') {
      console.log('[bridge] client stop');
      this.link.setIsPlaying(false);
    }

    if (msg.type === 'request-quantized-start') {
      const quantum = typeof msg.quantum === 'number' ? msg.quantum : this.config.quantum;
      console.log('[bridge] client request-quantized-start. quantum:', quantum);
      this.link.requestBeatAtStartPlayingTime(0, quantum);
      this.link.setIsPlaying(true);
    }

    if (msg.type === 'force-beat-at-time') {
      const { beat, time, quantum } = msg;
      if (typeof beat === 'number' && typeof time === 'number' && typeof quantum === 'number') {
        console.log('[bridge] client force-beat-at-time:', beat, time, quantum);
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
