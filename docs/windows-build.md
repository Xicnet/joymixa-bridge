# Windows Build (GitHub Actions)

The Windows desktop bridge is built on `windows-latest` GitHub Actions runners. There
is no local build path — the maintainer's dev machine is Linux. All Windows
verification happens against artifacts produced by CI.

## Triggering a build

Two paths:

1. **Manual dispatch** (testing without releasing) — Actions tab → "Build & Release"
   workflow → "Run workflow" → pick branch → Run. Artifacts are produced; no Release
   is created. Use this for every Windows test before tagging a release.

2. **Tag push** (release) — `./scripts/release.sh` bumps `package.json`, commits,
   tags `vX.Y.Z`, pushes. CI builds all three platforms and creates a GitHub Release
   with the artifacts attached.

## Downloading artifacts

After the workflow run completes:

- Manual dispatch: Actions → run page → scroll to "Artifacts" → download
  `dist-windows-latest`. Contains both:
  - `Joymixa Bridge-X.Y.Z Setup.exe` (Squirrel installer — installs to `%LocalAppData%`)
  - `joymixa-bridge-win32-x64-X.Y.Z.zip` (portable, no installer — unzip and run
    `joymixa-bridge.exe`)
- Tag push: same artifacts plus a GitHub Release with both files attached at the
  repo's Releases page.

The portable `.zip` is useful for testing without going through SmartScreen and
without modifying the registry. Squirrel is the recommended end-user path.

## First-run on Windows

1. **SmartScreen prompt** — both the installer and the portable `.exe` are unsigned.
   Windows shows "Windows protected your PC". Click **More info → Run anyway**.
   Code signing is on the roadmap; the Beta channel ships unsigned.

2. **Bonjour service** — required for Ableton Link mDNS peer discovery. If iTunes
   is installed, Bonjour is already there. Otherwise install Apple's standalone
   "Bonjour Print Services for Windows."

3. **Verify audio latency measurement** — right-click the tray icon → Copy Diagnostics. Look for:

   ```
   [Bridge] Audio latency: platform=win32 measuredOutputLatency=21.3ms method=wasapi(period=10.00ms×2@48000Hz)
   ```

   Healthy ranges: 20–40 ms on internal speakers / wired output, 100–300 ms on
   Bluetooth. If you see `measurement failed` or values outside those ranges, file
   an issue with the full Copy Diagnostics output.

## Architecture decisions captured at build time

These are the rationales for what's in the build, not derivable from reading the
diff. Cross-reference the spec
(`~/dev/joymixa/docs/specs/bridge-native-latency-measurement.md § Windows`) for the
authoritative version.

### Why a NAPI native addon (and not `winax`, `node-ffi`, PortAudio)

The macOS sibling (`native/coreaudio-latency/`) established the pattern:
read-only metadata query of OS audio properties via a thin C++ NAPI addon, no
runtime dependencies on the user's machine, ships compiled `.node` binary inside
the Electron bundle. Windows mirrors that — `native/wasapi-latency/` queries
WASAPI's `IAudioClient::GetMixFormat` + `GetDevicePeriod` on the default render
endpoint, returns a single `latencyMs` number with diagnostic component fields.

### Why no `IAudioClient::Initialize` call

`Initialize(SHARED, ...)` opens a *new* shared-mode stream separate from the
browser's. Any latency we'd query post-Initialize (`GetStreamLatency`,
`GetBufferSize`) would describe our ghost stream, not the audio path apps actually
use. `GetMixFormat` and `GetDevicePeriod` both work pre-Initialize, so we use
those exclusively. This matches the macOS pattern of reading device-level
properties without opening an AudioUnit.

### Why `× 2` buffer multiplier

Mirrors Linux's PipeWire double-buffer rationale: the OS audio path
double-buffers (one period being filled, one being consumed), so real pipeline
latency ≥ 2× the scheduling period. Confirmed against Chrome's documented WASAPI
budget of `~10 ms engine + ~5 ms stream + ~20 ms buffer ≈ 35 ms` in
`media/audio/win/audio_low_latency_output_win.h`.

### Why read twice + max smoothing

Linux samples 20× and takes max because PipeWire delay genuinely oscillates.
macOS reads once because values are static. Windows is between: device period is
static per device, but can change across calls if the system mixer reconfigures.
Read twice with ~50 ms gap; if values differ by >5 %, log it; use the max.
Cheap insurance, matches the cross-platform "if it can oscillate, max-of-N" rule.

### Why floor 20 ms / cap 80 ms (400 ms with BT hint)

Per spec: floor absorbs misreporting drivers returning suspiciously small values;
cap absorbs absurd values from broken drivers. Bluetooth adds 40–300 ms of codec
latency invisible to WASAPI, so the cap raises to 400 ms when
`PKEY_AudioEndpoint_FormFactor` matches a headphone/headset-like form factor.
Over-compensating is worse than under-compensating for sync (audio arrives late
instead of early), so the caps are deliberately tight on the non-BT path.

### Why MTA COM apartment

WASAPI requires `CoInitializeEx` per thread. NAPI threads have no apartment by
default. We initialize MTA (`COINIT_MULTITHREADED`) per call, tolerate
`RPC_E_CHANGED_MODE` (another apartment already on this thread → proceed without
init/uninit) and `S_FALSE` (already MTA → skip init, balance with uninit).
Tracked with two bools so cleanup paths uninit only what they initialized.

### Why `goto cleanup` over RAII

The macOS sibling uses manual COM-style refcount handling without smart wrappers;
Windows mirrors that for symmetry. `Microsoft::WRL::ComPtr` would be cleaner but
introduces a dependency divergence from the macOS sibling for negligible benefit
on a function that fits in 100 lines. All locals are hoisted before the first
`goto` so MSVC accepts the jumps over (zero-) initialization.

### Both Squirrel `.exe` and portable `.zip` ship

The portable `.zip` exists for testing without installing — unzip, run, no
registry modifications, no SmartScreen "is this app trusted?" trail. Squirrel is
the recommended end-user path because it handles updates and start-menu
integration. The portable build is also useful for users on locked-down corporate
machines where they can't run installers.

## Flagged uncertainties (need real-hardware calibration)

These cannot be resolved without a Windows host running against an Ableton Link
peer (iPad Launchpad / Ableton Live). They land in `todo/windows-bridge/06`
(human-in-the-loop calibration).

### `PKEY_AudioEndpoint_FormFactor` Bluetooth heuristic

Current code treats form factors `[4, 5, 6, 8]` as BT-likely
(`Microphone=4, Headset=5, Handset=6, SPDIF=8` per `mmdeviceapi.h` — note this
list does *not* include `Headphones=3`, even though wired and BT headphones
share that form factor). The first calibration pass should:

1. Plug in a wired pair of headphones; note the reported `formFactor`.
2. Pair a Bluetooth headset; note the reported `formFactor`.
3. Adjust the heuristic if either reports a value not in the current list.

### `× 2` buffer multiplier

Spec note: "If calibration shows non-zero offset, tune the `× 2` multiplier or
add per-driver corrections — but only based on measurement, not theory."
Current value is the structural mirror of Linux. Drivers vary; calibration is
where this gets validated.

### `coreaudio-latency` rebuild on `windows-latest`

The `coreaudio-latency` source has `#ifdef __APPLE__` guards around the entire
function body, but its `binding.gyp` only defines an `OS=='mac'` block. On
`windows-latest`, `electron-rebuild -f -w ...,coreaudio-latency,...` will try to
compile a source file that becomes effectively empty (just the
`Init`/`getOutputLatency` returning `env.Null()`). This *should* compile to a
no-op `.node` cleanly, but the first CI run is what confirms it. If it fails,
the fix is to add an `OS=='win'` empty block to `coreaudio-latency/binding.gyp`.
Don't preemptively edit — wait for CI signal.

## Workflow file

`.github/workflows/build.yml` — matrix has `ubuntu-latest`, `macos-latest`,
`macos-15-intel` (see `docs/macos-build.md`), `windows-latest`. Triggers on `v*`
tag push (full release with GitHub Release)
or `workflow_dispatch` (manual, artifacts only, no Release). Re-run protocol:
on workflow failure, fix the cause and re-run; do not bypass with
`--no-frozen-lockfile` or `--no-verify`.

## Build prerequisites (CI runner — already pre-installed)

`windows-latest` ships with everything needed:

- Node.js (we pin to 20 via `actions/setup-node@v4`)
- Python 3 (for `node-gyp`)
- Visual Studio Build Tools with the Windows 10/11 SDK (for `mmdeviceapi.h`,
  `audioclient.h`, `propkey.h`)
- MSBuild

No Bonjour SDK needed at *build* time. Bonjour is a runtime requirement on the
end-user's machine for Link peer discovery; CI doesn't need it.

## Local Windows build (not the supported path, but documented for completeness)

If you have a Windows machine and want to skip CI:

```bash
# In a Windows terminal (cmd or pwsh)
git clone https://github.com/Xicnet/joymixa-bridge.git
cd joymixa-bridge
yarn install
yarn rebuild
yarn make --targets @electron-forge/maker-squirrel,@electron-forge/maker-zip
```

Output in `out/make/`. Requires VS Build Tools 2019+ with the Desktop C++ workload
and Windows 10/11 SDK component checked. After Electron updates, run
`yarn rebuild` to recompile against the new Node ABI.
