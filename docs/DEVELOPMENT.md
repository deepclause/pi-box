# pi-box — development & maintenance notes

Handoff/reminder document for the repository. Covers the repo layout, code
structure, how it works, known quirks, and the release process.

---

## 1. Repo layout

- **GitHub repo:** `deepclause/pi-box` (public).
  - This repo **is** the `pi-box-app/` directory — `git init` was run inside
    `pi-box-app`, so the repo root contains the Electron app, not the
    `agentvm/` sibling.
- Locally, the folder `~/git/gh/pi-box/` contains two things:
  - `pi-box-app/` → pushed to `deepclause/pi-box`
  - `agentvm/` → a **separate** checkout of `deepclause/agentvm`
- The app does **not** vendor agentvm. It depends on the published npm package
  `deepclause-agentvm` (exact pin, currently `0.2.0`). agentvm changes must be
  published to npm before the app can consume them.

---

## 2. Stack

- **Electron** (main process is Node — required because agentvm uses
  `worker_threads`, `node:wasi`, `SharedArrayBuffer`, raw sockets).
- **electron-vite** (build tooling for main/preload/renderer, HMR in dev).
- **React + TypeScript** (renderer).
- **@xterm/xterm + @xterm/addon-fit** (terminal emulator).
- **electron-builder** (packaging/installers).
- **deepclause-agentvm** (WASM Alpine VM with pi coding agent + tmux preinstalled).

---

## 3. Code structure

```
pi-box-app/
├── electron-builder.yml          # packaging config
├── electron.vite.config.ts
├── package.json
├── scripts/ev.mjs                # dev/preview launcher (sets NO_SANDBOX on Linux)
├── build/                        # app icons (icns/ico/png)
├── docs/                         # proposals + this file
├── .github/workflows/release.yml # release pipeline
└── src/
    ├── shared/types.ts           # types shared across processes
    ├── main/                     # Electron main process
    │   ├── index.ts              # app bootstrap, window, VM wiring, broadcasts
    │   ├── vm.ts                 # VmManager: AgentVM lifecycle + startup script + ready detection
    │   ├── workspaces.ts         # WorkspaceStore: persistence, file tree, .pi seeding
    │   ├── ipc.ts                # IPC handlers + MOUNT_POINT
    │   └── agentvm.d.ts          # type declarations for deepclause-agentvm
    ├── preload/
    │   ├── index.ts              # contextBridge API → window.pibox
    │   └── index.d.ts
    └── renderer/
        ├── index.html
        ├── public/logo.png
        └── src/
            ├── App.tsx
            ├── styles.css
            └── components/
                ├── LoadingScreen.tsx
                ├── WorkspaceSidebar.tsx
                ├── FileTree.tsx
                ├── TerminalView.tsx
                └── icons.tsx
```

---

## 4. How it works

### 4.1 Process model

```
Electron main (Node)         preload (bridge)        renderer (React)
WorkspaceStore  ──IPC──►  window.pibox  ◄──IPC──  Sidebar (tree)
VmManager/AgentVM ◄──output / termInput──►         TerminalView (xterm.js)
```

- One `AgentVM` instance lives in the main process, in **interactive/raw mode**.
- VM stdout/stderr → decoded → `pibox:output` → xterm. Keystrokes → `pibox:termInput` → `vm.writeToStdin()`.
- No backend server; everything is Electron IPC.

### 4.2 Startup sequence (in `src/main/vm.ts`)

1. `VmManager.start()` creates `AgentVM({ network, interactive: true, mounts })`.
2. Status `loading` → "Booting AgentVM…".
3. Waits for the busybox ash prompt, detected via `ESC[6n` (`\x1b[6n`), with a
   30 s timeout fallback.
4. Injects the startup script (buffered by the ring buffer until the shell reads stdin):
   ```sh
   (ip link set eth0 up; udhcpc ...) &      # network up in background
   mkdir -p /workspace/.pi/sessions
   export PI_CODING_AGENT_DIR=/workspace/.pi
   export PI_CODING_AGENT_SESSION_DIR=/workspace/.pi/sessions
   export PI_OFFLINE=1                      # skip pi's slow startup network ops
   export PI_SKIP_VERSION_CHECK=1
   export PI_TELEMETRY=0
   export LANG=C.UTF-8
   cd /workspace
   python3 /workspace/.pi/tty-resize-daemon.py &   # console resize (TIOCSWINSZ)
   tmux -f /workspace/.pi/tmux.conf new-session -s pi -n pi pi
   ```
5. Status `loading` → "Starting pi…".
6. Detects pi's TUI via `Press ctrl+o` or `ctrl+c/ctrl+d` in the console stream,
   then status `ready` and the splash hides. A 150 s fallback forces `ready` so
   the splash can never hang forever.

### 4.3 Ready-detection gotcha

The console stream arrives in chunks that can be **larger than 512 bytes**
(a pi TUI redraw can be ~1.5 KB). `VmManager.handleOutput` therefore searches a
128-char carry buffer **plus the full current chunk** — never slice-then-search.
tmux consumes pi's OSC title escape, so the old `π - …` title marker does not
work; the footer/hint text is used instead.

### 4.4 Workspaces

- Persisted to `<userData>/workspaces.json` (`WorkspaceStore`).
- Active workspace mounted at **`/workspace`** (`MOUNT_POINT` in `ipc.ts`).
- Every workspace gets a seeded `.pi/`:
  - `settings.json` (`{"defaultProjectTrust":"always"}`)
  - `sessions/`
  - `tmux.conf` (mouse on, scrollback)
  - `tty-resize-daemon.py` (applies host-written `tty-size` via TIOCSWINSZ)
  - `tty-size`
- pi's config, auth, and sessions live in `.pi` via `PI_CODING_AGENT_DIR` /
  `PI_CODING_AGENT_SESSION_DIR`, so they survive VM restarts.
- Switching workspaces restarts the VM (and pi).

### 4.5 Shells / tmux

- pi runs in tmux window 0; extra shells are new tmux windows.
- The "new shell" button sends `Ctrl+B c` (`\x02c`) through `termInput`.
- Window switching is tmux's own status bar / mouse / keys.

---

## 5. Known quirks & gotchas

1. **Slow startup (~1 min).** Booting to a shell is fast because the image is
   snapshotted with Wizer, but pi itself (Node/V8 under emulated RISC-V) is
   slow. `PI_OFFLINE=1` skips pi's startup network ops (fd/ripgrep download,
   catalog refresh) — this does **not** disable later provider/model API calls.
2. **322 MB wasm read every boot.** The VM image is read into memory on every
   start; that's what the splash screen is for.
3. **No `chmod` on the mount.** The agentvm host mount is 9p/WASI; WASI preview1
   has no chmod, so `fs.chmod` returns `EPROTO` and creation mode bits are
   dropped. pi's auth save is unaffected, but fd/ripgrep binary chmod and the
   extension temp-folder chmod rely on it.
4. **`asar: false` is deliberate.** agentvm loads its wasm and worker script
   with real file APIs inside a worker thread, so `node_modules/deepclause-agentvm`
   must stay as real files on disk (electron-builder warns about this; ignore it).
5. **macOS x64 is built on the arm64 runner.** `macos-13` Intel runners are
   retired, so the x64 job runs on `macos-14` with `--mac --x64` (cross-arch).
6. **Linux dev needs `NO_SANDBOX`.** `scripts/ev.mjs` sets it on Linux only.
   Packaged AppImage users on odd setups may need `--no-sandbox`; the deb installs
   the sandbox helper correctly.
7. **agentvm worker fs fixes are required.** The published `deepclause-agentvm@0.2.0`
   includes the fixes for mounted-file writes (`O_TRUNC`/`O_WRONLY` via
   `fs_rights_base`, `fd_filestat_get`, `fd_filestat_set_size`). If you upgrade
   agentvm, keep/verify these, or pi can't save `auth.json` on the mount.
8. **Console is a serial TTY.** tmux provides PTYs for its panes; without tmux
   there is no PTY and full-screen programs are limited.
9. **Resize is file-driven.** The renderer writes `.pi/tty-size`; the guest
   daemon applies TIOCSWINSZ to `/dev/console`; tmux propagates it to pi. Never
   type `stty` into the console while pi is running.

---

## 6. Release process

Trigger: GitHub Release (`release: { types: [published] }`) → builds and attaches
binaries. Manual `workflow_dispatch` builds without creating a release (artifacts
only) for smoke tests.

### Steps

```bash
# 1. Bump the version (no tag — the release creates the tag)
npm version 0.1.2 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Bump version to 0.1.2"
git push origin main

# 2. Create + publish the release (triggers the workflow)
gh release create v0.1.2 --target main \
  --title "pi-box v0.1.2" \
  --notes "..." \
  --latest

# 3. After the workflow finishes, update the README Download section with the
#    exact asset URLs, then commit + push.
```

### Workflow (`release.yml`)

| Job | Runner | Targets |
|-----|--------|---------|
| macOS arm64 | `macos-14` | `--mac --arm64` |
| macOS x64 | `macos-14` | `--mac --x64` (cross-arch) |
| Linux x64 | `ubuntu-latest` | `--linux --x64` (AppImage + deb) |
| Windows x64 | `windows-latest` | `--win --x64` (nsis + portable) |

Steps per job: checkout → Node 22 → `npm ci` → `npm run typecheck` →
`npm run build` → `electron-builder --<platform> --publish never` →
upload via `softprops/action-gh-release`.

### Asset naming (v0.1.1 as reference)

- macOS Apple Silicon: `pi-box-<ver>-arm64.dmg` (+ `-arm64-mac.zip`)
- macOS Intel: `pi-box-<ver>.dmg` (+ `-mac.zip`)
- Linux: `pi-box-<ver>.AppImage`, `pi-box_<ver>_amd64.deb`
- Windows: `pi-box.Setup.<ver>.exe` (installer), `pi-box.<ver>.exe` (portable)

The README "Download" section must be updated with these exact names after each
release (the URLs are `https://github.com/deepclause/pi-box/releases/download/v<ver>/<name>`).

### Local validation before releasing

```bash
npm run typecheck
npm run build
npm run dist:dir     # quick unpacked build (fast sanity check)
npm run dist:linux   # real AppImage + deb (validates the deb maintainer config)
```

macOS/Windows packaging can only be validated in CI (or on those OSes).

### Signing / notarization (not set up yet)

- Currently builds are **unsigned** (macOS Gatekeeper and Windows SmartScreen
  warnings for users).
- Future: add secrets `CSC_LINK`/`CSC_KEY_PASSWORD` (+ `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization) for macOS;
  a Windows Authenticode cert for `.exe`.

---

## 7. Useful commands

```bash
npm install
npm run dev          # HMR (Linux sets NO_SANDBOX automatically)
npm run build        # electron-vite build → out/
npm run start        # preview production build
npm run typecheck    # type-check main + renderer
npm run dist:dir     # unpacked package
npm run dist:linux   # AppImage + deb
npm run dist:mac     # dmg + zip (macOS only)
npm run dist:win     # NSIS + portable (Windows only)
```
