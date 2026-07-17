# macOS Build (GitHub Actions)

The macOS desktop bridge is built on GitHub Actions runners. There is no local
build path — the maintainer's dev machine is Linux. All macOS verification
happens against artifacts produced by CI.

Two macOS slices are built, one per architecture, from two matrix entries:

| Matrix `os` | Runner arch | Artifacts | Runs on |
|-------------|-------------|-----------|---------|
| `macos-latest` | arm64 (Apple Silicon) | `Joymixa Bridge-darwin-arm64-X.Y.Z.dmg` + `.zip` | M-series Macs |
| `macos-15-intel` | x64 (Intel) | `Joymixa Bridge-darwin-x64-X.Y.Z.dmg` + `.zip` | 2017–2020 Intel Macs |

Both are produced natively (each runner *is* the target arch), so neither path
cross-compiles. They are uploaded as separate artifacts (`dist-macos-latest`,
`dist-macos-15-intel`) and both attach to the GitHub Release on a tag push.

**The `.dmg` is the end-user download** — mount, drag to Applications, done. The
`.zip` is what Squirrel.Mac consumes for auto-update (wired since v1.9.0 via
`update-electron-app`; requires the signed build, in place since v1.8.1) — do
not drop it from the matrix.

The DMG maker only runs on macOS (*"You can only build the DMG target on macOS
machines"*), which is why it appears in the two macOS matrix rows and nowhere
else. Building it on Linux fails loudly rather than silently producing nothing.

## Signing & notarization (since v1.8.1)

Every tagged macOS build is signed with a Developer ID Application certificate,
notarized via Apple's notary service, and has the ticket stapled — a clean
Gatekeeper first launch, verified on real hardware against v1.9.0.

How it works:

- `forge.config.ts` spreads `osxSign: {}` + `osxNotarize` into `packagerConfig`
  **only when** `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`
  are all set. Local builds, Linux/Windows CI rows and forks without the
  secrets keep building unsigned, exactly as before.
- `@electron/osx-sign` defaults are correct for this app: it finds the identity
  in the keychain, signs the unpacked `.node` addons, and enables the hardened
  runtime. No extra entitlements (the multicast entitlement is iOS-only; the
  addons don't need `allow-unsigned-executable-memory`).
- The workflow's "Prepare macOS signing keychain" step imports the base64 `.p12`
  (`MACOS_CERT_P12` / `MACOS_CERT_PASSWORD` repo secrets) into a throwaway
  keychain with a random password, and deletes it in an `always()` cleanup step.
  When the secrets are absent the step logs and skips — unsigned build, no error.
- Notarization is Apple's automated malware scan, not a review: most
  submissions complete in under 5 minutes (Apple's stated commitment: 98%
  within 15). It has no per-submission cost. Stapling is automatic.
- The certificate is valid until **2031-07-14** (5-year Developer ID, G2
  Sub-CA). Renewal means: new CSR from the existing key (OpenSSL, no Mac
  needed), new cert from the Apple portal, rebuild the `.p12`, update the two
  cert secrets. Key custody is maintainer-private (not in any repo).

⚠ Once signed, never repackage the `.app` with a plain `zip` — it can drop
symlinks/permissions and genuinely corrupt the signature (Apple's tooling uses
`ditto`). The Forge zip maker handles this correctly; the warning is for manual
repacking.

## Why an Intel build at all

An arm64-only app cannot run on an Intel Mac. Rosetta 2 translates x64→arm64
(Intel apps on Apple Silicon), **not** the reverse — there is no arm64→x64 path.
So an Intel-Mac user who downloads the arm64 zip gets an app that will not
launch. Apple stopped selling Intel Macs in 2023, but the last models (2019–2020
MacBook Pro/Air, 2018 Mac mini, 2017 iMac Pro) remain in use, and there is no
Rosetta fallback for them — a real x64 build is the only way to support them.

The frontend download page labels the two Mac assets by architecture
("macOS (Apple Silicon)" / Intel) so users pick the one that runs.

## Why a dedicated Intel runner, not cross-compile or universal

Three approaches were considered (investigation: frontend repo
`todo/bridge-tasks/task2-macos-intel-build.md`, decision 2026-05-20):

1. **Cross-compile** `--arch=x64` on the arm64 runner — rejected. The risk is not
   our addons (see below) but the electron-forge / electron-rebuild toolchain
   itself, which has open issues where cross-arch native rebuilds silently emit
   wrong-arch binaries (electron/forge#3114, electron/rebuild#378).
2. **Universal** `--arch=universal` — rejected for now. `@electron/universal`
   *merges two independently-built apps* (x64 + arm64); it does not avoid needing
   an x64 build, it sits on top of one. More moving parts and ~2× size for a
   single-download UX gain we don't currently need. The frontend stays arch-split.
3. **Native Intel runner** (`macos-15-intel`) — chosen. Builds `darwin-x64`
   natively, no cross-compile risk, smallest reliable change (one matrix entry).

### The native addons are arch-clean

The build rebuilds three native addons (`yarn rebuild` →
`electron-rebuild -f -w @xicnet/abletonlink,coreaudio-latency,wasapi-latency`).
None has CPU-arch-specific build logic — every `binding.gyp` branches only on
`OS` (`mac`/`win`/`linux`), never on arch:

- `coreaudio-latency` — links `-framework CoreAudio` (present on both archs).
- `wasapi-latency` — `OS=='win'` only; a no-op target on macOS.
- `@xicnet/abletonlink` — the Link SDK is a header-only git submodule
  (`link/include`), with no committed prebuilt binaries to pin an arch.

So compiling from source for x64 vs arm64 is a node-gyp target switch, not a
source change. This is why the Intel runner "just builds" rather than needing
addon work.

### `@xicnet/abletonlink` compile on `macos-15-intel`

The Link SDK compiles fresh from headers on whatever runner it lands on. The
arch-clean analysis above says the x64 compile should be identical to the arm64
one (same `MACOSX_DEPLOYMENT_TARGET`, same flags), but the **first
`macos-15-intel` CI run is what confirms it** against the runner's Xcode/clang.
If it fails, diagnose from the CI log — do not preemptively edit `binding.gyp`.
Wait for CI signal.

## Triggering a build

Two paths (same workflow as every platform):

1. **Manual dispatch** (testing without releasing) — Actions tab → "Build &
   Release" → "Run workflow" → pick branch → Run. Artifacts are produced; no
   Release is created. Use this to exercise the Intel build before tagging.
2. **Tag push** (release) — `./scripts/release.sh` bumps `package.json`, commits,
   tags `vX.Y.Z`, pushes. CI builds all platforms and creates a GitHub Release
   with the artifacts attached.

## Downloading artifacts

After the run completes:

- Manual dispatch: Actions → run page → "Artifacts" → download
  `dist-macos-latest` (arm64 zip) and/or `dist-macos-15-intel` (x64 zip).
- Tag push: same zips, plus a GitHub Release with both attached.

## First-run on macOS

The app is unsigned and un-notarized (Beta channel). Gatekeeper blocks it on
first launch with "cannot be opened because the developer cannot be verified."
Right-click the app → **Open** → **Open** to run it anyway, or clear the
quarantine attribute. Code signing + notarization are on the roadmap.

## Intel runner shelf life

`macos-15-intel` is the **last** Intel macOS image GitHub Actions will offer,
supported until **August 2027** (actions/runner-images#13045); `macos-13` (the
previous Intel runner) was retired ~December 2025. After August 2027, producing
a new x64 build needs self-hosted Intel hardware or accepting the cross-compile
risk. This shelf life applies to any GitHub-hosted Intel build approach, not just
this one — it is not a reason to prefer a different option today.
