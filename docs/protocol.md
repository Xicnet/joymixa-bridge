# Ableton Link WebSocket Bridge — Protocol Spec

A bridge application that exposes an [Ableton Link](https://ableton.github.io/link/)
session to browser clients over WebSocket. This spec is implementation-agnostic —
any platform (desktop, iOS, Android) can implement a conforming bridge.

The reference implementation is the Electron/TypeScript bridge in this repository.

---

## 1. Overview

```
┌──────────────┐   UDP multicast   ┌──────────────┐    WebSocket (JSON)     ┌─────────┐
│ Ableton Live │ <──────────────>  │    Bridge     │ <────────────────────> │ Browser │
│ or any Link  │   (Link protocol) │              │  ws://127.0.0.1:20809   │ client  │
│ peer         │                   └──────────────┘                         └─────────┘
└──────────────┘                         │
                                         ├──> client 1
                                         ├──> client 2
                                         └──> client N
```

The bridge:
1. Joins the Ableton Link mesh as a peer (tempo, beat, phase, start/stop sync)
2. Runs a WebSocket server on port **20809**, binding to **`127.0.0.1` (loopback only)** — the
   bridge is never reachable from the LAN
3. Broadcasts Link state to all connected WebSocket clients at a configurable rate
4. Accepts commands from clients to control the Link session
5. Relays arbitrary messages between clients

### `quantum` is not a time signature

Ableton Link has **no time-signature concept** — no meter, no bar count, nothing of the sort is
transmitted between peers. A Link session exposes a tempo, a beat timeline, a `phase`, a play flag
and a peer count. That is the whole model.

`quantum` is a **phase-alignment unit measured in beats**: `phase` is the position within the
current quantum, in `[0, quantum)`. It *defaults* to 4, which makes it look like "beats per bar" —
but it is neither an integer by contract nor a musical meter. A conforming implementation must
treat `quantum` as a live float read from the session, never as a hardcoded 4, and must not derive
a time signature from it.

---

## 2. Configuration

| Parameter    | Type   | Default | Description                                           |
|-------------|--------|---------|-------------------------------------------------------|
| `port`      | int    | 20809   | WebSocket server port (bound to `127.0.0.1`)          |
| `defaultBpm`| float  | 120     | Initial tempo when no Link peers exist                |
| `quantum`   | float  | 4       | Phase-alignment unit, in beats — **not** a time signature |
| `stateHz`   | int    | 100     | State broadcast frequency (times/second)              |

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
  "linkEnabled": true,
  "anchorTime": 60807.849,
  "measuredOutputLatency": 21.3,
  "latencyMethod": "alsa-delay(max=2048/48000@card0/pcm0p/sub0)",
  "latencyDiagnostics": "alsa-delay: device=card0/pcm0p/sub0 rate=48000 samples=20 min=1024(21.3ms) max=2048(42.7ms)",
  "jmxBeat": 2.5,
  "capabilities": ["set-link-enabled", "request-beat-at-time"]
}
```

| Field           | Type    | Description                                              |
|----------------|---------|----------------------------------------------------------|
| `tempo`        | float   | Current tempo in BPM, rounded to 2 decimal places        |
| `isPlaying`    | boolean | Link transport state                                     |
| `beat`         | float   | Current beat position on the Link timeline               |
| `phase`        | float   | Position within the current quantum, in `[0, quantum)`   |
| `quantum`      | float   | Phase-alignment unit, in beats (see §1) — **not** a time signature |
| `linkEnabled`  | boolean | Whether the bridge's Link session is enabled (from Link's own `isEnabled()`). `false` means the bridge is up but not on the mesh — no sync. |
| `anchorTime`   | float?  | Link-clock time (seconds) of `beat`, captured in the same atomic session-state snapshot. Clients extrapolate `beatAtTime` from the `(beat, anchorTime)` pair rather than from a bare BPM. Omitted only when no Link session exists. |
| `numPeers`     | int     | Number of Link peers (excluding self)                    |
| `numClients`   | int     | Number of connected WebSocket clients (including this one)|
| `nextBar0Delay`| float   | Milliseconds until the next quantum boundary (phase 0). The field name is legacy — see §5. |
| `measuredOutputLatency` | float? | Optional. Native OS audio output latency in milliseconds, measured by the bridge. See §5.2. Omitted if measurement is unavailable (unsupported platform, measurement failed). |
| `latencyMethod` | string | Compact description of the measurement method used, e.g. `alsa-delay(max=2048/48000@card0/pcm0p/sub0)`. Set to `"none"` when measurement is unavailable. |
| `latencyDiagnostics` | string? | Optional. Detailed diagnostic string for the latency measurement. Present only when `measuredOutputLatency` is present. Intended for remote debugging — clients may log it but should not parse it. |
| `jmxBeat`      | float?  | Optional. Application-level loop beat from first active client that reported one (see `loop-beat` command) |
| `capabilities` | string[]? | Optional. Commands this bridge understands beyond the original set, e.g. `"set-link-enabled"` when it supports being switched on and off remotely (see §4.8), and `"request-beat-at-time"` when it understands that command (see §4.5a). A client should send a listed command only when the bridge lists it: older bridges silently ignore commands they do not know (§7). Absent on older bridges. |

`numClients` includes the newly connected client.

`jmxBeat` is only present if at least one connected client has sent a `loop-beat` message.

### 3.2 `state` — periodic broadcast

Sent to all clients at `stateHz` frequency (default: 100 Hz, i.e. every 10 ms).

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
  "linkEnabled": true,
  "anchorTime": 60807.849,
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
  "quantum": 4,
  "ts": 1716998400000,
  "anchorTime": 60807.849
}
```

When triggered by a Link peer callback, `tempo` is rounded to 2 decimal places.

When triggered by a client `set-tempo` command, `tempo` is the raw value read
back from Link after setting (Link may quantize it).

`ts` is the server timestamp (Unix epoch milliseconds) at broadcast time.
`anchorTime` is `timeAtBeat` (Link-clock seconds) for the captured `beat`, giving
clients a clock anchor to extrapolate `beatAtTime` rather than a bare bpm. Both
`ts` and `anchorTime` are present on every `tempo` message — from the Link peer
callback and from the `set-tempo` command path alike — captured in the same
atomic `getState()` snapshot as `beat` and `phase`.

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
{ "type": "set-tempo", "tempo": 128.0, "atTime": 60807.849 }
```

- `tempo`: BPM (> 0).
- `atTime` (optional): `hostTimeAtOutput` in Link-clock seconds (the bridge's
  `getCurrentTime()` / `clock().micros()/1e6` domain) at which the tempo change
  takes effect, shared across peers. Omitted ⇒ applied at the bridge's
  receive-time. Older bridges ignore the field (apply at receive-time).

**Validation:** `tempo` must be a finite number > 0. Invalid values are silently
ignored. `atTime` is applied only when it is a finite number > 0; otherwise the
change applies at receive-time.

**Side effect:** Bridge reads back the tempo from Link after setting and broadcasts
a `tempo` message to all OTHER clients (carrying `ts` + `anchorTime`, see 3.3).

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

Request playback to start aligned to a quantum boundary (phase 0). Sets beat to 0 at
the start-playing time, then starts transport.

```json
{ "type": "request-quantized-start", "quantum": 4 }
```

| Field     | Type  | Required | Description                              |
|-----------|-------|----------|------------------------------------------|
| `quantum` | float | No       | Override the phase-alignment unit, in beats (defaults to bridge config) |

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

### 4.5a `request-beat-at-time`

Ask Link to map a beat to a time, politely. This is the bridge's exposure of Link's
`requestBeatAtTime` method (the SDK's "quantized launch" call). Numbered `4.5a` so the
`4.6`–`4.8` citations in other documents keep pointing at the same entries.

```json
{ "type": "request-beat-at-time", "beat": 32, "time": 60807.849, "quantum": 4 }
```

| Field     | Type  | Required | Description                                                   |
|-----------|-------|----------|---------------------------------------------------------------|
| `beat`    | float | Yes      | The beat to map to `time`. Any finite number, including negative. |
| `time`    | float | Yes      | Link-clock **seconds** (the bridge's `getCurrentTime()` / `clock().micros()/1e6` domain, the same domain as `set-tempo`'s `atTime`), `> 0`. |
| `quantum` | float | No       | Phase-alignment unit, in beats, `> 0`. Defaults to the bridge config's quantum. |

**Validation:** `beat` and `time` must be finite numbers and `time` must be `> 0`.
`quantum`, when present, must be a finite number `> 0`; when absent it defaults to the
bridge's configured quantum (as `request-quantized-start` does). A message that fails
any of these is ignored (one line in the bridge log, nothing sent back, see §7). Note
the difference from `request-quantized-start`, where a non-numeric `quantum` falls back
to the default: here a present-but-invalid `quantum` voids the whole message.

**Side effect:** the bridge calls `requestBeatAtTime(beat, time, quantum)` on a session
state captured and committed through Link's application-thread pair
(`captureAppSessionState` / `commitAppSessionState`). It does not touch the transport
(play/stop state is unchanged) and sends no reply; clients see the result in the next
`state` broadcast, as after `force-beat-at-time`.

**What it does.** From `ableton/Link.hpp`, `requestBeatAtTime`:

> If no other peers are connected, then this instance is in a session by itself and is
> free to re-map the beat/time relationship whenever it pleases. In this case,
> beatAtTime(time, quantum) == beat after this method has been called.
>
> If there are other peers in the session, this instance should not abruptly re-map the
> beat/time relationship in the session because that would lead to beat discontinuities
> among the other peers. In this case, the given beat will be mapped to the next time
> value greater than the given time with the same phase as the given beat.

Whether peers exist is decided from the peer count at the moment the bridge handles the
message (`numPeers() > 0` when the session state is captured, `Link.ipp`).

**When to use which.**

- `request-beat-at-time`: a client that already plays on its own timeline and wants
  Link to adopt a given beat/time pair without disturbing anyone. Alone, the mapping
  takes effect at once; with peers, it waits for the next in-phase moment. The SDK:
  "The client only needs to invoke this method to achieve this behavior and should not
  need to explicitly check the number of peers."
- `request-quantized-start`: starts the transport on a quantum boundary and sets beat
  `0` there. Use it for "press play and join the bar", not to re-anchor a running timeline.
- `force-beat-at-time`: maps the beat to the time unconditionally and broadcasts it. The
  SDK: "DANGER: ... This is very anti-social behavior and should be avoided." Reserve it
  for bridging an external clock (see 4.5).

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

### 4.8 `set-link-enabled`

Cast this socket's follow vote for the bridge's Ableton Link session. Sent by every
instance on every connect (right after `hello`) and on every change of its vote.

```json
{ "type": "set-link-enabled", "enabled": false }
{ "type": "set-link-enabled", "enabled": true, "tempo": 128 }
```

**Validation:** `enabled` must be a boolean; invalid values are silently ignored.
`tempo` is optional and meaningful only with `enabled: true`: a finite number `> 0`,
the sender's current locked BPM — omitted when it is still `0`.

**Side effect — one vote per socket, OR'd:** the bridge keeps one vote per connected
socket (`Map<WebSocket, boolean>`). On receipt it stores the vote, computes
`want = OR(votes)`, and only if `want` differs from Link's current enabled state:
when enabling, and `tempo` is valid, `link.setTempo(tempo)` is applied **first** —
so the session brought onto the mesh already runs at the sender's tempo, since Link
resets the session on every enable and the fresh, younger session wins the merge
against any existing peer — then `link.enable(want)`, then the choice is **persisted**
to the settings file. When `want` already equals the current state, nothing is
applied and `tempo` is ignored (the session is already running). A socket closing
removes its vote and re-evaluates the same way — the last following socket
switching Off or disconnecting takes the bridge off the mesh.

The change surfaces to all connected clients (including the sender) through the
existing `linkEnabled` field on the next `state` broadcast — this command itself
sends **no reply**, consistent with §7.

**Bridge startup:** `link.enable(getSettings().linkEnabled)`, default `false`.

---

## 5. Computed Fields

### `nextBar0Delay`

Milliseconds until the next **quantum boundary** (phase 0) on the Link timeline.

> The name is legacy and misleading: Link has no bars (§1). It is kept because it is part of the
> shipped wire contract, which both the bridge and its clients depend on. Read it as
> `nextPhase0Delay`.

```
remainingBeats = quantum - phase
msPerBeat      = 60000 / tempo
nextBar0Delay  = remainingBeats * msPerBeat
```

This allows clients to schedule events aligned to the session's quantum boundaries without
needing direct Link access. A client can `setTimeout(callback, nextBar0Delay)`
to fire at the start of the next quantum.

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
| `hello`   | On connect (once)           | Full state + `numClients` + optional `jmxBeat` + optional `capabilities` |
| `state`   | Every 1/stateHz seconds     | Full state + `ts` + optional `jmxBeat`      |
| `tempo`   | Tempo changes               | `tempo`, `beat`, `phase`, `quantum`, `ts`, `anchorTime` |
| `playing` | Transport state changes     | `isPlaying`                                 |
| `peers`   | Link peer count changes     | `numPeers`                                  |
| `relay`   | Client sent a relay message | `payload` (arbitrary object)                |

### Client → Server

| Type                      | Effect                                     | Required Fields          |
|---------------------------|--------------------------------------------|--------------------------|
| `set-tempo`               | Change Link tempo                          | `tempo` (float > 0), optional `atTime` |
| `play`                    | Start transport                            | (none)                   |
| `stop`                    | Stop transport                             | (none)                   |
| `request-quantized-start` | Start aligned to a quantum boundary        | optional `quantum`       |
| `force-beat-at-time`      | Force beat alignment                       | `beat`, `time`, `quantum`|
| `request-beat-at-time`    | Map a beat to a time; quantized if peers   | `beat`, `time` (Link-clock seconds, > 0), optional `quantum` |
| `relay`                   | Forward to other clients                   | `payload` (object)       |
| `loop-beat`               | Report loop position                       | `beat` (float)           |
| `set-link-enabled`        | Follow vote (per socket); `enabled`, optional `tempo` | `enabled` (boolean), optional `tempo` (float > 0) |
