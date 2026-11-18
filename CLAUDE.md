# CLAUDE.md

Joymixa Bridge: one Ableton Link -> WebSocket bridge (port 20809) in three implementations: desktop
(`src/`, Electron + TypeScript), Android (`android/`, Kotlin + NDK), iOS (`ios/`, Swift). Per-platform
output-latency addons live in `native/`. A separate frontend consumes the WebSocket protocol.

## Context loading

Load the entry for your task before answering or searching the code. Subsystem rules in `.claude/rules/`
load by themselves when you read or edit a matching file.

- Before touching `src/**`, `forge.config.ts` or webpack configs: `.claude/rules/electron-main.md` loads by path; desktop build detail is `docs/desktop.md`.
- Before touching `native/**` or addon loading in `src/bridge.ts`: read `docs/native-latency-contract.md`.
- Before any WebSocket payload, message type or broadcast change: read `docs/protocol.md`.
- Before any audio, sync, phase-alignment or latency work: read the frontend-side specs named in `CLAUDE.local.md` ("Cross-repo required reading"). If you do not have that file, ask the maintainer.
- Before Android work: `docs/android.md`. Before iOS work: `docs/ios.md`.
- Before a bundle variant or game assets: `docs/game-bundle.md`.
- Before a Windows or macOS build or CI change: `docs/windows-build.md` / `docs/macos-build.md`.
- Before cutting a release: `./scripts/release.sh` (it bumps, commits, tags and pushes; never tag by hand).
- Before bumping `@xicnet/abletonlink`: read "Dependency fork" below.

## Always-on rules

- **Diagnose before fixing.** Read the code, trace the path, gather evidence (logs, ALSA `delay`, HRESULTs), present the diagnosis, then change code. No speculative fixes.
- **Cross-platform symmetry beats local cleverness.** A behaviour on one platform and not another is usually a bug in the missing one. Match the existing pattern unless you document why you diverge.
- **Never edit `node_modules/`.** Upstream PR, a fork by `git+` URL, or `patch-package`. If a task says to edit it, halt and flag it.
- **Never commit game source or built game assets.** Bundle variants are local-only; CI builds only bridge-only variants.
- **No cross-repo or home-directory paths in committed files.** This repo is public.
- **No tokens or personal data in logs.** "Copy Diagnostics" surfaces them to users.
- Use `Bridge.log/warn/pin` inside `Bridge`, not `console.log`.
- `execFile` with an argument array, never a built shell string. No `eval`.
- Code: no `as any`, no dead or commented-out code, no unused variables, no magic numbers.
- Resources: store and clear every timer on `Bridge.stop()`; remove clients and per-client state on close/error; tear down listeners; release every COM/CF handle on every exit path.
- Wire values the frontend assumes (`port`, `quantum`) change only with a coordinated frontend change.

## Dependency fork

`@xicnet/abletonlink` is pinned in `package.json` by `git+https://github.com/Xicnet/ableton-link.git#<sha>`.
Edit it in a separate checkout of the fork, push to GitHub `Xicnet/ableton-link`, bump the SHA, run
`yarn install`. If yarn fails with "divergent branches", remove the stale bare clone in
yarn's temp cache (`v6/.tmp/`) and rerun.

## Commands

    yarn install && yarn start         # desktop dev
    yarn rebuild                       # native addons against Electron; run after every Electron update
    yarn make                          # installers
    yarn lint                          # ESLint
    git submodule update --init --recursive
    cd android && ./gradlew assembleBridgeOnlyDebug     # needs JAVA_HOME set to a JDK 17
    ./scripts/copy-game-assets.sh && cd android && ./gradlew assembleBundleDebug

No automated test suite: verify against a real Link peer (Ableton Live, iPad Launchpad). iOS builds on
macOS CI only. Desktop native addons need a C++ toolchain and `libavahi-compat-libdnssd-dev` on Linux.

## Git

- Work on a branch. The maintainer tests on real hardware first: write the changes, then wait for an explicit go before committing. The user handles merges and pushes: never merge or push without the user's word.
- Commit messages follow Conventional Commits, `type(scope): subject`, imperative, lowercase. Types: feat, fix, perf, refactor, docs, test, build, ci, chore. A scope is not a type. A WebSocket protocol break takes `!` and a `BREAKING CHANGE:` footer.
- Commit messages describe the actual diff. Never `--no-verify`.

## Maintaining this file

- It holds traps and pointers, not maps. No version numbers, plugin lists or dated incident stories.
- No rule lives only here: each has an owning doc or rule; this file states it in one line.
- Every file in `.claude/rules/` carries a `paths:` frontmatter key.
