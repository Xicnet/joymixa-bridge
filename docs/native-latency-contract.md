# Native output-latency addon contract

Every per-platform output-latency addon under `native/` (`coreaudio-latency`, `wasapi-latency`) follows
this contract. A new platform addon mirrors `native/coreaudio-latency/coreaudio_latency.cc` and swaps the
CoreAudio calls for the platform's equivalent; each difference should be justifiable in one sentence.

## The contract

1. **Read-only metadata query, no stream opened.** `IAudioClient::Initialize` (Windows) and
   `AudioUnitInitialize` (macOS) open a new stream that is not the OS playback stream: any value read after
   Initialize describes a ghost stream, not the audio path apps use. Use only the metadata APIs that work
   without Initialize (`GetMixFormat()`, `GetDevicePeriod()` on Windows; `kAudioDevicePropertyLatency` and
   siblings on macOS).
2. **Single-number ms result on the wire.** The bridge consumes `latencyMs` as one float for compensation.
   The addon may return a struct with components for diagnostic logging, but it composes the final value
   itself and the TypeScript wrapper extracts one number.
3. **Null on failure, never throw.** The frontend handles `null` by tiering down. Return `env.Null()` on any
   failed property query, as `coreaudio_latency.cc` does. Log the HRESULT / OSStatus before returning null so
   driver-specific failures can be diagnosed from user reports; do not swallow every error with a blanket
   `catch (...)`.
4. **No new dependencies.** OS APIs only; headers come with the platform SDK. No PortAudio, naudiodon or
   echogarden audio-io.
5. **30 s refresh timer only**, matching `LATENCY_REFRESH_MS` in `src/bridge.ts`. No event-driven
   re-measurement (for example `IMMNotificationClient::OnDefaultDeviceChanged`) yet: symmetry across
   platforms comes before sophistication.
6. **Diagnostic log line shape matches across platforms.**
   `[Bridge] Audio latency: platform=<x> measuredOutputLatency=<n>ms method=<source>(...)`, so
   `[Bridge] Audio latency:` stays greppable.
7. **Sanity guards.** Floor 20 ms (absorbs misreporting drivers), cap 80 ms non-Bluetooth, cap 400 ms
   Bluetooth (the BT codec adds 40-300 ms the API does not show). On Windows, Bluetooth is detected with
   `PKEY_AudioEndpoint_FormFactor`.

## Smoothing

Read twice with max smoothing where values can oscillate. Linux samples 20 times and takes the max because
PipeWire values oscillate (`measureViaAlsaDelay` in `src/bridge.ts`). macOS reads once because values are
static. Windows is in between: read twice about 50 ms apart, log if the values differ by more than 5 %, use
the max (`measureViaWasapi`).

## Resource lifetime (native code)

- Release every COM / CFRetain'd handle on every exit path, success and failure: `goto cleanup` or RAII
  (`Microsoft::WRL::ComPtr`). A leaked `IMMDevice` blocks the audio service; a leaked `CFRunLoopSourceRef`
  deadlocks shutdown.
- Windows COM init: match every `CoInitializeEx` with `CoUninitialize` on the path that called it. Tolerate
  `RPC_E_CHANGED_MODE` (do not init, do not uninit) and `S_FALSE` (do not init again, do uninit). Track it
  with a bool.
- `PROPVARIANT`: `PropVariantInit` before `GetValue`, `PropVariantClear` before exit.

## Adding an addon: one commit per step

1. Create `native/<x>-latency/{x_latency.cc,binding.gyp,package.json}`.
2. Add `"<x>-latency": "file:native/<x>-latency"` to `package.json` dependencies.
3. Add it to the `rebuild` script's `-w` list (comma-separated, one `-w` flag).
4. Add a try/require/null-fallback block in `src/bridge.ts` mirroring the existing addon loads, guarded by
   `process.platform`.
5. Add a `measureViaXxx()` method returning `{ latencyMs, method }` or null, mirroring `measureViaCoreAudio`.
6. Add the platform branch in the latency-measurement entry point.
7. Add the package to `NATIVE_MODULES` in `forge.config.ts` so webpack externalizes it. Without it the app
   runs in dev and crashes when packaged.
8. Add the platform to the CI matrix in `.github/workflows/build.yml`.

## Anti-patterns

- Calling `Initialize` and then `GetStreamLatency` "because it is more accurate": it is the ghost-stream value.
- Returning a struct that makes the TypeScript wrapper compose several components into the final ms value.
- Loading an addon without a platform guard: the `require()` fails in dev on the wrong OS before `Bridge` is
  constructed.
