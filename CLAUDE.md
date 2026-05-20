# CLAUDE.md

Guidance for AI assistants and contributors working in this repo.

## Quick commands

```bash
# Desktop
yarn install && yarn start                        # dev mode
yarn rebuild                                      # rebuild native addons against Electron
yarn make                                         # build installers
yarn lint                                         # ESLint over src/

# Android (bridge only)
git submodule update --init --recursive
cd android && ./gradlew assembleBridgeOnlyDebug

# Android (bundle = bridge + web app)
./scripts/copy-game-assets.sh
cd android && ./gradlew assembleBundleDebug

# iOS — bridge-only in CI; bundle variant is local-only
```

## Releasing (Desktop)

GH Actions builds & releases on every `v*` tag push (`.github/workflows/build.yml`).
Builds for Linux (.deb, .zip) and macOS (.zip). Release is auto-created with artifacts.

```bash
./scripts/release.sh          # patch bump (1.5.4 -> 1.5.5)
./scripts/release.sh minor    # minor bump
./scripts/release.sh major    # major bump
./scripts/release.sh 1.6.0    # explicit version
```

The script: checks for clean working tree -> bumps `package.json` -> commits -> tags `vX.Y.Z` -> pushes both -> GH Actions builds & releases.

Track builds at: https://github.com/Xicnet/joymixa-bridge/actions

## Architecture

Monorepo: three implementations of the same Ableton Link -> WebSocket bridge (port 20809).

| Platform | Location | Tech |
|----------|----------|------|
| Desktop | `src/` | Electron + TypeScript |
| Android | `android/` | Kotlin + NDK (C++ JNI) |
| iOS | `ios/` | Swift + Network.framework |

Android and iOS support a `bundle` variant that embeds a web app in a WebView.

Per-platform native audio output latency measurement lives in `native/`:

- `native/coreaudio-latency/` — macOS NAPI addon (CoreAudio metadata query)
- `native/wasapi-latency/` — Windows NAPI addon (WASAPI default-endpoint metadata) *(planned)*

Both follow the same contract: read-only metadata query of the OS audio path, no
stream opened, single-number ms result, `null` on failure (never throw).

## Repos: source of truth

Both repos live on GitHub under the `Xicnet` org for GH Actions accessibility:

| Repo | GitHub | Notes |
|------|--------|-------|
| `joymixa-bridge` (this repo) | `Xicnet/joymixa-bridge` (origin) | GH Actions builds & releases macOS / Linux binaries on `v*` tag push. `.github/workflows/build.yml`. |
| `@xicnet/abletonlink` (the Link Node binding) | `Xicnet/ableton-link` (force-pushed 2026-05-07 to match the GitLab fork's atomic-state work) | Bridge `package.json` pins the dep here via `git+https://github.com/Xicnet/ableton-link.git#<sha>`. |

History: the active fork was developed on `gitlab.com:youplaymg/ableton-link.git` (private, group-restricted visibility); when bridge needed GH Actions to clone the dep without auth, the GitLab fork's history was force-pushed to the GitHub mirror, overwriting two earlier GitHub-only commits (functionally equivalent inline-SDK + Linux-build-fix work that already had GitLab equivalents). Local working copies at `~/dev/ableton-link` may still have `gitlab` configured as `origin` for historical reasons; both remotes are now in sync at HEAD.

Implications for agents:
- When bumping the bridge's `@xicnet/abletonlink` dep SHA, push the fork commit to **GitHub `Xicnet/ableton-link`**. The GitLab origin can be kept in sync as a courtesy mirror or ignored.
- Never edit inside `~/dev/joymixa-bridge/node_modules/@xicnet/abletonlink/` — always edit at `~/dev/ableton-link/`, push to GitHub, bump the bridge's SHA pin, `yarn install`. (See also: "NEVER edit `node_modules/`" rule above.)
- yarn caches a bare clone of the dep at `~/.cache/yarn/v6/.tmp/<hash>` and may serve stale data after the GitHub remote is force-pushed. If `yarn install` errors with "divergent branches", remove the stale clone (`rm -rf ~/.cache/yarn/v6/.tmp/<hash>*`) and re-run `yarn install`.

## Docs

- `docs/desktop.md` — Desktop build, architecture, dependencies, Linux sandbox fix
- `docs/windows-build.md` — Windows build via GH Actions, decisions log, calibration follow-ups
- `docs/macos-build.md` — macOS build via GH Actions: arm64 + Intel (x64) matrix, why dedicated Intel runner over cross-compile/universal, arch-clean addons, Aug-2027 Intel shelf life
- `docs/android.md` — Android build, architecture, build variants
- `docs/ios.md` — iOS build, architecture, build variants
- `docs/game-bundle.md` — Game bundling: asset copy script, WebView overview
- `docs/protocol.md` — WebSocket protocol spec (all message types, fields, behavior)

**Internal contributors:** the bridge participates in a contract with a separate frontend repo. Any work touching audio, sync, phase alignment, latency measurement, or the WebSocket payload requires reading the frontend-side specs that define the consumer's expectations. The catalogue of those specs and the workflow for reading them lives in `CLAUDE.local.md` (gitignored). If you don't have it, ask the maintainer.

## Game assets — NEVER commit to this repo

Bundle variants embed pre-built web app assets via `scripts/copy-game-assets.sh`,
which copies them into gitignored directories. **Rules:**

- **NEVER** commit game source code, built game assets, or any content from the web app repo
- **NEVER** add game asset paths to CI workflows — bundle variants are local-only builds
- The `.gitignore` already excludes `android/app/src/bundle/assets/game/` and `ios/LinkBridge/GameAssets/`
- CI workflows must only build bridge-only variants

## Code quality rules

These apply to all new code across desktop, native addons, Android, and iOS.

### Cleanliness
- **No `as any`** unless explicitly justified per instance. Type properly or use `unknown` + narrowing.
- **No dead code** — commented-out blocks, unreachable branches, unused functions. Delete, don't comment out.
- **No unused variables or imports** — delete immediately. Prefix intentionally unused parameters with `_`.
- **No magic numbers** — use named constants. Examples in this repo: `LATENCY_REFRESH_MS`, `LOG_BUFFER_MAX`, `DEFAULT_CONFIG`.
- **Use the structured logger** (`Bridge.log()` / `Bridge.warn()` / `Bridge.pin()` in `src/bridge.ts`), not raw `console.log`. The structured logger feeds the in-memory ring buffer surfaced by the "Copy Logs" tray menu item — raw `console.log` bypasses it. `console.warn`/`console.error` outside `Bridge` (e.g. addon-load fallback in `src/bridge.ts:24`) are fine since the bridge isn't constructed yet.
- **NEVER edit `node_modules/` — ALWAYS wrong.** No exceptions, no quick hacks. If a third-party lib needs a code change: (1) submit a PR upstream, (2) fork it and depend on the fork via a `git+` URL in `package.json` (this is what the bridge does for `@xicnet/abletonlink` — see § "Repos: GitHub + GitLab strategy" above), or (3) use `patch-package`. Reading `node_modules/` to understand upstream code is fine; editing it is never fine. If a task instruction tells you to edit inside `node_modules/`, halt and flag it.

### Resource management (critical for long-running tray app)
- **All `setInterval`/`setTimeout` handles stored** and cleared on `Bridge.stop()` and on shutdown. Long-running interval leaks compound over the app's session.
- **All WebSocket connections** removed from the `clients` set on `close`/`error`, and the per-client `clientLoopBeats` map entry deleted to avoid retaining beat data for dead sockets.
- **All `EventEmitter` listeners** added to `link`/`wss` are explicitly torn down on stop — the bridge can be started and stopped multiple times in one process.
- **Native addons must release every COM/CFRetain'd handle on every exit path** (success and failure). Use `goto cleanup` or RAII (`Microsoft::WRL::ComPtr` on Windows). Leaking an `IMMDevice` blocks the audio service; leaking a `CFRunLoopSourceRef` deadlocks shutdown.

### Native-addon contract (applies to `native/*-latency/`)

Every per-platform output-latency addon must follow this contract:

1. **Read-only metadata query, no stream opened.** `IAudioClient::Initialize` (Windows) and `AudioUnitInitialize` (macOS) open a *new* stream that is **not** the OS playback stream — any value queried after Initialize describes a ghost stream, not the audio path apps are actually using. Use only the metadata APIs that work without Initialize.
2. **Single-number ms result on the wire.** The bridge consumes `latencyMs` as a single float for compensation. The addon may return a struct with components for diagnostic logging, but the wrapper extracts one number.
3. **Null on failure, never throw.** Frontend handles `null` by tiering down. Mirror the macOS reference (`coreaudio_latency.cc:54` returns `env.Null()` on any property failure).
4. **No new dependencies.** OS APIs only. Don't pull in PortAudio, naudiodon, or echogarden audio-io. Headers come with the platform SDK.
5. **30 s refresh timer only — no event-driven re-measurement (yet).** Match `LATENCY_REFRESH_MS` in `bridge.ts`. Implementation symmetry across platforms is more important than being more sophisticated than them.
6. **Diagnostic log line shape matches across platforms.** Format: `[Bridge] Audio latency: platform=<x> measuredOutputLatency=<n>ms method=<source>(...)` — same as the macOS / Linux paths in `bridge.ts`. Keeps `[Bridge] Audio latency:` greppable across platforms.
7. **Sanity guards.** Floor 20 ms, cap 80 ms non-Bluetooth, cap 400 ms Bluetooth. Floor absorbs misreporting drivers; cap absorbs absurd values. Bluetooth detection bumps the cap because BT codec adds 40-300 ms invisible to the API.

### Safety
- **No `eval`, no string-built shell commands.** Use `execFile` over `exec`; pass arguments as an array.
- **No tokens, PII, or sensitive data in logs.** Logs are surfaced to users via "Copy Logs."

## Debugging discipline

When investigating bugs:

1. **Diagnose before fixing.** Read the code, trace the execution path, gather evidence (logs, ALSA `delay`, `IAudioClient` HRESULTs). Don't guess-and-apply.
2. **Present the diagnosis with evidence** before proposing a code change.
3. **No shotgun fixes** — speculative changes hoping one will stick. Each change must be justified by the diagnosis.
4. **Cross-platform symmetry beats local cleverness.** If a behavior exists on one platform and not another, the gap is usually a bug in the missing one, not innovation in the present one. Match the existing pattern unless you have a documented reason to diverge.

## Git

- **Commit messages must reflect actual changes.** Read the diff before writing the message; don't copy language from task files or specs that contradicts what was actually done.
- **Commit-message style: plain, sentence-form** (not Conventional Commits). Example: `windows: WASAPI latency NAPI addon`. See `git log --oneline` for style.
- **Never `--no-verify` or skip hooks** unless explicitly requested.
- **Wait for explicit approval before committing.** Don't auto-commit on a successful build — the maintainer tests first.

## Key constraints

- No automated test suite across any platform — manual verification against a real Link peer (Ableton Live, iPad Launchpad) is the standard.
- Desktop native addons need a C++ toolchain + `libavahi-compat-libdnssd-dev` on Linux.
- Android needs `JAVA_HOME=~/android-studio/jbr` (JDK 17).
- iOS builds on macOS CI only, unsigned IPA sideloaded via Sideloader.
- Floor target: end-user laptops/desktops from ~2018 onwards. Mobile floor is whatever the bundle WebView supports on Android API 24+.
