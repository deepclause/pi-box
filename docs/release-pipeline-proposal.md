# Release build pipeline proposal

Status: **proposal** (no implementation yet)

## Goal

Build downloadable binaries for **macOS**, **Linux** and **Windows** on every
GitHub Release, and attach them to the release as assets.

## 1. Recommended approach

- **Packager:** `electron-builder` (paired with the existing `electron-vite`
  build). It produces `dmg`/`zip` (macOS), `AppImage`/`deb` (Linux) and
  `nsis`/`portable` (Windows) from one config file.
- **Runner matrix:** one job per OS (native toolchains):
  - macOS builds **must** run on macOS (dmg + signing/notarization).
  - Windows NSIS is most reliable on Windows.
  - Linux AppImage/deb on Ubuntu.
- **Trigger:** `release: { types: [published] }` (+ a manual `workflow_dispatch`
  for testing).
- **Artifact upload:** `softprops/action-gh-release` (or electron-builder's
  GitHub publisher) attaches the built files to the release.

### Per-OS targets

| OS | Runner | Targets | Arch |
|----|--------|---------|------|
| macOS | `macos-14` | `dmg`, `zip` | arm64 (Apple Silicon) |
| macOS | `macos-13` | `dmg`, `zip` | x64 (Intel) |
| Linux | `ubuntu-latest` | `AppImage`, `deb` | x64 |
| Windows | `windows-latest` | `nsis`, `portable` | x64 |

Notes:
- `macos-latest` is currently arm64; use explicit `macos-14` / `macos-13`
  labels so the matrix does not drift.
- A single universal macOS build is possible later; start with per-arch.

## 2. Critical: dependency and the 320 MB wasm

### Switch from `file:../agentvm` to the npm package

`deepclause-agentvm@0.2.0` is published on npm and already contains everything
the app needs (verified against the published tarball):

- the fs fixes (`FD_WRITE` rights handling, `fd_filestat_get`,
  `fd_filestat_set_size`),
- the **tmux** image `agentvm-alpine-python.wasm` (322 MB),
- **no runtime dependencies** (only Node built-ins), so packaging is trivial.

Recommendation: change `"deepclause-agentvm": "file:../agentvm"` to an exact
pin `"deepclause-agentvm": "0.2.0"`. This makes CI self-contained — the
workflow no longer needs to checkout or vendor the `agentvm` repo.

> Keep the npm package as the source of truth for future agentvm fixes/images.

### Unpack the wasm out of asar

agentvm loads the wasm with `fs.readFileSync()` inside a Node **worker thread**.
Electron's asar fs-patching is unreliable in worker threads, and a 322 MB file
should not live inside `app.asar` anyway.

Recommendation: `asarUnpack: ["**/*.wasm"]` (or unpack the whole
`node_modules/deepclause-agentvm` tree). This keeps the wasm as a real file on
disk at runtime.

## 3. Pipeline shape

Per job:

1. `actions/checkout`
2. `actions/setup-node` with Node **22** (electron-vite requires `>=22.12.0`)
3. `npm ci` (lockfile is already committed)
4. `npm run typecheck`
5. `npm run build` (`electron-vite build` → `out/`)
6. `npx electron-builder --<platform> --publish never`
7. upload `dist/*` artifacts to the release

Caching to speed up builds:

- `~/.npm`
- `~/.cache/electron`
- `~/.cache/electron-builder`

## 4. Code signing & notarization

| OS | What | Required secrets | Notes |
|----|------|------------------|-------|
| macOS | signing + notarization | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Apple Developer Program needed; electron-builder auto-skips (builds unsigned) when secrets are absent |
| Windows | Authenticode signing | `CSC_LINK` (pfx), `CSC_KEY_PASSWORD` | needs an OV/EV certificate |
| Linux | none | — | — |

Recommendation: **phase signing in later.** Ship unsigned builds first (macOS
users get a Gatekeeper right-click-open; Windows SmartScreen warning), then add
notarization/signing secrets once the flow is proven.

## 5. Prerequisites before implementation

- `pi-box-app` must become a git repo and be pushed to GitHub (currently it is
  not a repo).
- Add `electron-builder` (devDependency) + an `electron-builder.yml` config +
  `dist` npm scripts.
- Set `appId`, `productName`, `directories.output`.
- Add app icons: `build/icon.icns`, `build/icon.ico`, `build/icon.png`
  (generated from the DeepClause logo). Without them electron-builder falls
  back to the default Electron icon.
- Commit `package-lock.json` (already present).

## 6. Size expectations & limits

- Each installer ≈ **430–450 MB** (Electron ~100 MB + wasm 322 MB + app code).
- GitHub release asset limit is 2 GB per file → no problem.
- A full release with 5–6 artifacts is roughly **~2 GB total**; downloads are
  large because of the embedded VM image (acceptable for now, worth revisiting
  later via delta updates).

## 7. Risks / notes

- The 322 MB wasm makes installs large; electron-builder compresses installers,
  but the payload is inherently big.
- The `file:` → npm switch must land before the pipeline is wired up, and all
  future agentvm changes must be published to npm for CI to pick them up.
- Linux sandbox: dev already sets `NO_SANDBOX` on Linux. Packaged AppImage
  users on unusual setups may need `--no-sandbox`; deb installs the sandbox
  helper correctly.
- Auto-update (`electron-updater`) is a natural follow-up; structuring the
  macOS/Windows `zip` + `latest.yml` output now makes it cheap later.

## 8. Rollout plan

1. **Phase 1** — unsigned builds, three-OS matrix, upload to release.
2. **Phase 2** — macOS signing + notarization (secrets in GitHub Actions).
3. **Phase 3** — Windows signing + auto-update via `electron-updater`.
