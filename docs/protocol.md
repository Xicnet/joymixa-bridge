# Ableton Link WebSocket Bridge — Protocol Spec

A bridge application that exposes an [Ableton Link](https://ableton.github.io/link/)
session to browser clients over WebSocket. This spec is implementation-agnostic —
any platform (desktop, iOS, Android) can implement a conforming bridge.

The reference implementation is the Electron/TypeScript bridge in this repository.

---

## 1. Overview

```
┌──────────────┐   UDP multicast   ┌──────────────┐   WebSocket (JSON)   ┌─────────┐
│ Ableton Live │ <──────────────>  │    Bridge     │ <──────────────────> │ Browser │
│ or any Link  │   (Link protocol) │              │    ws://host:20809   │ client  │
│ peer         │                   └──────────────┘                      └─────────┘
└──────────────┘                         │
                                         ├──> client 1
                                         ├──> client 2
                                         └──> client N
```

The bridge:
1. Joins the Ableton Link mesh as a peer (tempo, beat, phase, start/stop sync)
2. Runs a WebSocket server on port **20809**, binding to `0.0.0.0` (all interfaces)
3. Broadcasts Link state to all connected WebSocket clients at a configurable rate
4. Accepts commands from clients to control the Link session
5. Relays arbitrary messages between clients

---

## 2. Configuration

| Parameter    | Type   | Default | Description                              |
|-------------|--------|---------|------------------------------------------|
| `port`      | int    | 20809   | WebSocket server port                    |
| `defaultBpm`| float  | 120     | Initial tempo when no Link peers exist   |
| `quantum`   | int    | 4       | Musical quantum (beats per bar)          |
| `stateHz`   | int    | 20      | State broadcast frequency (times/second) |

---

## 3. Server → Client Messages

All messages are JSON objects with a `type` field.

### 3.1 `hello` — sent once on connection

Sent immediately when a client connects. Contains a full state snapshot.

```json
{
  "type": "hello",
  "tempo": 120.0,
  "isPlaying": false,
  "beat": 0.0,
  "phase": 1.23,
  "quantum": 4,
  "numPeers": 1,
  "numClients": 2,
  "nextBar0Delay": 345.67,
  "measuredOutputLatency": 21.3,
  "latencyMethod": "alsa-delay(max=2048/48000@card0/pcm0p/sub0)",
  "latencyDiagnostics": "alsa-delay: device=card0/pcm0p/sub0 rate=48000 samples=20 min=1024(21.3ms) max=2048(42.7ms)",
  "jmxBeat": 2.5
}
```

| Field           | Type    | Description                                              |
|----------------|---------|----------------------------------------------------------|
| `tempo`        | float   | Current tempo in BPM, rounded to 2 decimal places        |
| `isPlaying`    | boolean | Link transport state                                     |
| `beat`         | float   | Current beat position on the Link timeline               |
| `phase`        | float   | Position within the current bar (0 to quantum)           |
| `quantum`      | int     | Beats per bar                                            |
| `numPeers`     | int     | Number of Link peers (excluding self)                    |
| `numClients`   | int     | Number of connected WebSocket clients (including this one)|
| `nextBar0Delay`| float   | Milliseconds until the next bar boundary (beat 0 of bar) |
| `measuredOutputLatency` | float? | Optional. Native OS audio output latency in milliseconds, measured by the bridge. See §5.2. Omitted if measurement is unavailable (unsupported platform, measurement failed). |
| `latencyMethod` | string | Compact description of the measurement method used, e.g. `alsa-delay(max=2048/48000@card0/pcm0p/sub0)`. Set to `"none"` when measurement is unavailable. |
| `latencyDiagnostics` | string? | Optional. Detailed diagnostic string for the latency measurement. Present only when `measuredOutputLatency` is present. Intended for remote debugging — clients may log it but should not parse it. |
| `jmxBeat`      | float?  | Optional. Application-level loop beat from first active client that reported one (see `loop-beat` command) |

`numClients` includes the newly connected client.

`jmxBeat` is only present if at least one connected client has sent a `loop-beat` message.

### 3.2 `state` — periodic broadcast

Sent to all clients at `stateHz` frequency (default: every 50ms).

```json
{
  "type": "state",
  "tempo": 120.0,
  "isPlaying": true,
  "beat": 45.67,
  "phase": 1.67,
  "quantum": 4,
  "numPeers": 1,
  "numClients": 3,
  "nextBar0Delay": 345.67,
  "measuredOutputLatency": 21.3,
  "latencyMethod": "alsa-delay(max=2048/48000@card0/pcm0p/sub0)",
  "latencyDiagnostics": "alsa-delay: device=card0/pcm0p/sub0 rate=48000 samples=20 min=1024(21.3ms) max=2048(42.7ms)",
  "jmxBeat": 2.5,
  "ts": 1708531200000
}
```

Same fields as `hello`, plus:

| Field | Type | Description                               |
|-------|------|-------------------------------------------|
| `ts`  | int  | Server timestamp (Unix epoch milliseconds)|

### 3.3 `tempo` — tempo change event

Broadcast when tempo changes (either from a Link peer or a client command).

```json
{
  "type": "tempo",
  "tempo": 128.0,
  "beat": 12.34,
  "phase": 0.34,
  "quantum": 4
}
```

When triggered by a Link peer callback, `tempo` is rounded to 2 decimal places.

When triggered by a client `set-tempo` command, `tempo` is the raw value read
back from Link after setting (Link may quantize it).

> **Note:** The `beat` and `phase` fields in `tempo` messages are captured
> at callback delivery time, not at the exact moment Link changed tempo.
> For precise timing, use the periodic `state` messages.

### 3.4 `playing` — transport state change

Broadcast when Link start/stop state changes.

```json
{
  "type": "playing",
  "isPlaying": true
}
```

### 3.5 `peers` — Link peer count change

Broadcast when the number of Link peers changes.

```json
{
  "type": "peers",
  "numPeers": 2
}
```

### 3.6 `relay` — forwarded client message

Broadcast to all clients **except** the original sender.

```json
{
  "type": "relay",
  "payload": { ... }
}
```

`payload` is the arbitrary JSON object from the sending client, forwarded as-is.

---

## 4. Client → Server Messages

### 4.1 `set-tempo`

Set the Link session tempo.

```json
{ "type": "set-tempo", "tempo": 128.0 }
```

**Validation:** `tempo` must be a finite number > 0. Invalid values are silently ignored.

**Side effect:** Bridge reads back the tempo from Link after setting and broadcasts
a `tempo` message to all clients (see 3.3).

### 4.2 `play`

Start the Link transport.

```json
{ "type": "play" }
```

### 4.3 `stop`

Stop the Link transport.

```json
{ "type": "stop" }
```

### 4.4 `request-quantized-start`

Request playback to start aligned to a bar boundary (beat 0). Sets beat to 0 at
the start-playing time, then starts transport.

```json
{ "type": "request-quantized-start", "quantum": 4 }
```

| Field     | Type  | Required | Description                              |
|-----------|-------|----------|------------------------------------------|
| `quantum` | int   | No       | Override quantum for alignment (defaults to bridge config) |

### 4.5 `force-beat-at-time`

Force a specific beat value at a specific time. This is the bridge's exposure of
Link's `forceBeatAtTime` method, intended for bridging an external clock source
into a Link session.

```json
{ "type": "force-beat-at-time", "beat": 0, "time": 1708531200000, "quantum": 4 }
```

> **Warning:** The official Ableton Link SDK designates `forceBeatAtTime` as
> dangerous. It unconditionally remaps the beat/time relationship for **all**
> peers in the session, causing beat discontinuities. Use only for bridging
> an external clock source into a Link session. Normal quantized launch
> should use `request-quantized-start` instead.

**Validation:** All three fields (`beat`, `time`, `quantum`) must be numbers.
Message is silently ignored if any field is missing or non-numeric.

### 4.6 `relay`

Send an arbitrary message to all other connected clients. The bridge does not
interpret the payload — it wraps it in a `relay` envelope and forwards it.

```json
{ "type": "relay", "payload": { "myKey": "myValue" } }
```

**Validation:** `payload` must be a non-null object. Invalid messages are silently ignored.

**Routing:** Sent to all clients except the sender.

### 4.7 `loop-beat`

Report the current application-level loop beat position. The bridge stores the
most recent value per client and includes it in `state` and `hello` broadcasts
as `jmxBeat`.

```json
{ "type": "loop-beat", "beat": 2.5 }
```

**Validation:** `beat` must be a number.

**Note:** When multiple clients send `loop-beat`, only the first connected client's
value (with an open connection) is used in broadcasts. This is intentional — it
represents the primary session's loop position.

---

## 5. Computed Fields

### `nextBar0Delay`

Milliseconds until the next bar-0 boundary on the Link timeline.

```
remainingBeats = quantum - phase
msPerBeat      = 60000 / tempo
nextBar0Delay  = remainingBeats * msPerBeat
```

This allows clients to schedule events aligned to bar boundaries without
needing direct Link access. A client can `setTimeout(callback, nextBar0Delay)`
to fire at the start of the next bar.

### `measuredOutputLatency`

Native OS audio output latency in milliseconds, measured by the bridge process.
Present in `hello` and `state` messages when the bridge can measure it; omitted
otherwise. The client uses this instead of the browser's unreliable
`AudioContext.outputLatency` for Link phase-alignment compensation.

**Linux:** Primary: samples ALSA delay field from `/proc/asound/` for RUNNING
streams (max-of-20 over 200ms). Fallback: ALSA `period_size × 2` from `hw_params`.
Last resort: PipeWire clock quantum × 2 via `pw-metadata`.

**macOS:** CoreAudio NAPI addon. Sums `kAudioDevicePropertyLatency +
kAudioStreamPropertyLatency + kAudioDevicePropertySafetyOffset + bufferFrameSize`
in frames, divided by sample rate.

**Windows:** WASAPI NAPI addon. Reads `GetDevicePeriod` × buffer multiplier (2×)
on the default render endpoint, with read-twice-take-max smoothing and
floor/cap sanity guards (20ms floor, 80ms cap, 400ms for Bluetooth hints).

Refreshed every 30 seconds to track dynamic buffer resizing.

### `tempo` rounding

Tempo values from Link are rounded to 2 decimal places:
```
tempo = round(rawTempo * 100) / 100
```

---

## 6. Connection Lifecycle

1. Client opens WebSocket to `ws://bridge-host:20809`
2. Bridge adds client to its set, sends `hello` with full state snapshot
3. Bridge sends periodic `state` messages at `stateHz` rate
4. Bridge sends `tempo`, `playing`, `peers` events as they occur
5. Client may send commands at any time
6. On disconnect, bridge removes client and cleans up any `loop-beat` state

---

## 7. Error Handling

- Malformed JSON from a client is silently dropped (logged server-side)
- Messages that are not JSON objects are silently dropped
- Unknown message types are silently ignored
- Invalid field values on known message types are silently ignored
- No error messages are sent back to clients

This is intentional — the bridge is a real-time musical sync tool where latency
matters more than error reporting. Clients should validate their own messages
before sending.

---

## 8. Message Type Summary

### Server → Client

| Type      | When                        | Key Fields                                  |
|-----------|-----------------------------|---------------------------------------------|
| `hello`   | On connect (once)           | Full state + `numClients` + optional `jmxBeat` |
| `state`   | Every 1/stateHz seconds     | Full state + `ts` + optional `jmxBeat`      |
| `tempo`   | Tempo changes               | `tempo`, `beat`, `phase`, `quantum`         |
| `playing` | Transport state changes     | `isPlaying`                                 |
| `peers`   | Link peer count changes     | `numPeers`                                  |
| `relay`   | Client sent a relay message | `payload` (arbitrary object)                |

### Client → Server

| Type                      | Effect                                     | Required Fields          |
|---------------------------|--------------------------------------------|--------------------------|
| `set-tempo`               | Change Link tempo                          | `tempo` (float > 0)      |
| `play`                    | Start transport                            | (none)                   |
| `stop`                    | Stop transport                             | (none)                   |
| `request-quantized-start` | Start aligned to bar boundary              | optional `quantum`       |
| `force-beat-at-time`      | Force beat alignment                       | `beat`, `time`, `quantum`|
| `relay`                   | Forward to other clients                   | `payload` (object)       |
| `loop-beat`               | Report loop position                       | `beat` (float)           |
