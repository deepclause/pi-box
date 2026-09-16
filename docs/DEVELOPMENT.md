# pi-box — development & maintenance notes

Handoff/reminder document for the repository. Covers the repo layout, code
structure, how it works, known quirks, tests, and the release process.

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
  `deepclause-agentvm` (**exact pin, currently `0.3.1`**). agentvm changes must
  be published to npm before the app can consume them.

---

## 2. Stack

- **Electron** — main process is Node, required because agentvm uses
  `worker_threads`, `node:wasi`, `SharedArrayBuffer` and raw sockets. The main
  process also hosts the **pi RPC session manager**.
- **electron-vite** — build tooling for main/preload/renderer (HMR in dev).
- **React 19 + TypeScript** — renderer.
- **@xterm/xterm + addon-fit + addon-image** — the terminal view.
- **marked + dompurify** — chat markdown rendering; **highlight.js** for code.
- **@fontsource-variable/inter + jetbrains-mono** — bundled fonts (macOS-like).
- **Vitest** — unit tests for the pure logic.
- **electron-builder** — packaging/installers.
- **deepclause-agentvm** — WASM Alpine VM with the pi coding agent + tmux.

---

## 3. Code structure

```
pi-box-app/
├── electron-builder.yml          # packaging config
├── electron.vite.config.ts
├── vitest.config.ts              # unit-test config (aliases)
├── package.json
├── scripts/
│   ├── ev.mjs                    # dev/preview launcher (sets NO_SANDBOX on Linux)
│   ├── pi-rpc-bridge.py          # guest TCP<->stdio bridge (source of truth)
│   └── spike-rpc.cjs             # Phase 0 transport spike (manual)
├── build/                        # app icons
├── docs/                         # this file, the design doc, proposals
├── .github/workflows/
│   ├── ci.yml                    # typecheck + test + build
│   └── release.yml               # release pipeline
└── src/
    ├── shared/
    │   ├── types.ts              # IPC/UI types
    │   └── rpc-types.ts          # RPC chat types + PI_RPC_GUEST_PORT
    ├── main/                     # Electron main process
    │   ├── index.ts              # app bootstrap, window, VM + RPC wiring
    │   ├── vm.ts                 # VmManager: AgentVM lifecycle + startup script
    │   ├── rpc.ts                # RpcSessionManager + RpcConnection (+ pure helpers)
    │   ├── workspaces.ts         # WorkspaceStore: persistence, tree, .pi seeding
    │   ├── ipc.ts                # IPC handlers + MOUNT_POINT
    │   ├── raw.d.ts              # `?raw` import typing
    │   └── agentvm.d.ts          # deepclause-agentvm typings
    ├── preload/
    │   ├── index.ts              # contextBridge API → window.pibox (+ .rpc)
    │   └── index.d.ts
    └── renderer/
        ├── index.html
        ├── public/logo.png
        └── src/
            ├── App.tsx           # view switch, theme, workspace wiring
            ├── styles.css
            ├── lib/chat.ts       # transcript model + event reducer
            └── components/
                ├── AppHeader.tsx      # header, view switch, theme toggle
                ├── ChatView.tsx       # chat: transcript, composer, controls
                ├── SessionsPanel.tsx  # session list + search + actions
                ├── ToolCard.tsx       # tool-aware, truncated tool output
                ├── BranchTree.tsx     # get_tree viewer + fork
                ├── ExtensionUi.tsx    # extension dialogs
                ├── Markdown.tsx       # marked + highlight.js + DOMPurify
                ├── TerminalView.tsx   # xterm (kept mounted)
                ├── WorkspaceSidebar.tsx / FileTree.tsx
                ├── NetworkSettings.tsx / LoadingScreen.tsx / icons.tsx
```

---

## 4. How it works

pi-box has **two independent planes** into the same VM:

1. **Console plane** — tmux on the serial console, rendered by xterm. Used for
   terminals (`vi`, extra shells, …).
2. **RPC plane** — a headless `pi --mode rpc` process reached over a guest TCP
   bridge, rendered as a native chat UI.

### 4.1 Process model

```
Electron main (Node)                 preload              renderer (React)
WorkspaceStore  ──IPC──►  window.pibox[.rpc]  ◄──IPC──  Sidebar / ChatView
VmManager ── AgentVM (console, port forwards)
RpcSessionManager ── net.Socket ──► host port ──forward──► guest bridge ── pi --mode rpc
```

- One `AgentVM` in the main process, **interactive/raw mode**.
- The chat owns the pi process; tmux is only for terminals.
- No backend server; everything is Electron IPC.

### 4.2 VM startup (in `src/main/vm.ts`)

1. `VmManager.start()` creates `AgentVM({ network, interactive: true, mounts, persistentRoot: true })`.
2. Status `loading` → "Booting AgentVM…".
3. Wait for the busybox ash prompt (`ESC[6n`), answer DSR with `ESC[1;1R`, then
   inject the startup script:
   ```sh
   (ip link set eth0 up; udhcpc ...) &          # network (background)
   mkdir -p /workspace/.pi/sessions
   export PI_CODING_AGENT_DIR=/workspace/.pi
   export PI_CODING_AGENT_SESSION_DIR=/workspace/.pi/sessions
   export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 LANG=C.UTF-8
   cd /workspace
   rm -f /workspace/.pi-box/rpc-bridge.log.ready
   nohup python3 /workspace/.pi/pi-rpc-bridge.py --port 7100 \
       --log /workspace/.pi-box/rpc-bridge.log >/dev/null 2>&1 &   # warms pi
   python3 /workspace/.pi/tty-resize-daemon.py &                    # console resize
   tmux -f /workspace/.pi/tmux.conf new-session -A -s pi-box -n shell
   ```
4. The VM is considered **ready** `READY_DELAY_MS` (3 s) after the script is
   injected — it boots to a shell now, so there is no pi TUI marker to wait for.

### 4.3 Ready-detection & shell gotchas

- `ESC[6n` is busybox ash **asking** the terminal for the cursor position. The
  DSR answer (`ESC[1;1R`) must be written **before** the startup script, or the
  shell swallows the script's leading bytes and ash reports
  `syntax error: unexpected ")"`.
- `handleOutput` searches a 128-char carry buffer **plus the full current chunk**
  (a single VM write can exceed the carry buffer).
- With `persistentRoot`, `/workspace/.pi-box/rpc-bridge.log.ready` survives VM
  restarts, so the startup script (and `index.ts` before `vm.start()`) removes
  it; the bridge re-publishes it once `eth0` has an IPv4 address.

### 4.4 Workspaces

- Persisted to `<userData>/workspaces.json` (`WorkspaceStore`).
- Active workspace mounted at **`/workspace`** (`MOUNT_POINT` in `ipc.ts`).
- Each workspace's `.pi/` is seeded with `settings.json`, `sessions/`,
  `tmux.conf`, `tty-resize-daemon.py`, `tty-size`, and the **`pi-rpc-bridge.py`**
  (inlined from `scripts/pi-rpc-bridge.py` via a Vite `?raw` import).
- pi's config, auth and sessions live in `.pi` via `PI_CODING_AGENT_DIR` /
  `PI_CODING_AGENT_SESSION_DIR`, so they survive restarts.
- Switching workspaces restarts the VM (tearing down the RPC session too).

### 4.5 Terminals / tmux

- **One tmux session per workspace** (`pi-box`), created with `-A` (attach if it
  exists). Terminals are new windows inside it.
- The "new shell" button sends `Ctrl+B c` (`\x02c`) through `termInput`.
- The file tree's **edit** action opens `vi` in a new tmux window and switches
  the app to the Terminal view.
- The TerminalView is **kept mounted** (only visibility toggles) so it keeps
  receiving console output while the chat is on screen; on reveal it re-fits and
  `term.refresh()`es from its buffer.

### 4.6 pi RPC chat

- `scripts/pi-rpc-bridge.py` runs in the guest: it listens on a TCP port, warms
  a `pi --mode rpc` child, and pipes the socket to the child's stdio in both
  directions (`os.read`, not buffered `read`). It publishes a `.ready` marker
  only after the NIC is up.
- `src/main/rpc.ts` (`RpcSessionManager`) allocates a host port, adds an AgentVM
  port forward, waits for the marker, connects, and speaks JSONL:
  - `drainJsonl()` implements the LF-only framing (CR-tolerant; never splits on
    U+2028/U+2029) and is unit-tested.
  - Requests are correlated by an `id`; responses resolve the matching promise,
    everything else is emitted as an event.
  - Session management: `listSessions` (summarises `.pi/sessions/*.jsonl`,
    including the live session before its file exists), `switchSession`,
    `newSession`, `deleteSession`, `setSessionName`, `exportHtml`, `fork`,
    `clone`, `getTree`, model/thinking setters plus `cycleModel` /
    `cycleThinkingLevel`, and `respondExtensionUi` (fire-and-forget write).
  - On startup it resumes the most recent session when pi begins a fresh one.
- IPC surface: `pibox:rpc:*` handlers in `ipc.ts`, exposed as `window.pibox.rpc`.
- The renderer reduces RPC events into a transcript (`src/renderer/src/lib/
  chat.ts`), renders text (markdown + highlighting), thinking blocks, tool cards,
  pending steering/follow-up chips, compaction/retry notices, and extension
  dialogs. Sessions are listed in `SessionsPanel`.

### 4.7 Theming

- Light/dark via `<html data-theme="…">`; **dark is the default**, the header
  toggle persists the choice (`pibox.theme`), set before first paint.
- Neutral **graphite** accent (no blue); semantic green/amber/red for status.
- All colours are CSS variables in `:root` / `[data-theme='dark']`.
- Fonts are bundled (Inter / JetBrains Mono); the terminal follows the theme.
- The loading screen is a compact, always-dark splash.

---

## 5. Tests & CI

- `npm test` runs **Vitest** (`vitest.config.ts`, `src/**/*.test.ts`):
  - `src/renderer/src/lib/chat.test.ts` — content mapping, history mapping,
    the event reducer (streaming, tool running/done, optimistic user message).
  - `src/main/rpc.test.ts` — `drainJsonl` framing, `normalizeStats`,
    `summarizeSession`.
- `.github/workflows/ci.yml` runs `npm ci` → `npm run typecheck` → `npm test` →
  `npm run build` on pushes to `main` and on every pull request.
- Integration is still verified manually: `scripts/spike-rpc.cjs` for the
  transport, and CDP over `--remote-debugging-port` for the UI.

---

## 6. Known quirks & gotchas

1. **Startup takes ~30 s.** The VM boots to a shell quickly (Wizer snapshot), but
   `pi` is a V8 process under emulated RISC-V. `PI_OFFLINE=1` skips its startup
   network ops (not later provider calls). The chat shows a "Starting pi…" card.
2. **~350 MB wasm read every boot.** The image is read into memory on start.
3. **No `chmod` on the mount.** The host mount is 9p/WASI; `fs.chmod` returns
   `EPROTO` and creation mode bits are dropped (pi's auth save is unaffected).
4. **`asar: false` is deliberate** — agentvm loads its wasm/worker with real file
   APIs inside a worker thread.
5. **macOS x64 is built on the arm64 runner** (`macos-14` with `--mac --x64`).
6. **Linux dev needs `NO_SANDBOX`** (`scripts/ev.mjs` sets it on Linux only).
7. **Single guest hart.** Run one pi process at a time; switching sessions reuses
   the process rather than running several.
8. **RPC framing is LF-only.** Never use `readline` to parse the socket.
9. **Resize is file-driven.** The renderer writes `.pi/tty-size`; the guest daemon
   applies TIOCSWINSZ to `/dev/console`; tmux propagates it.

---

## 7. Release process

Trigger: GitHub Release (`release: { types: [published] }`) → builds and attaches
binaries. Manual `workflow_dispatch` builds without creating a release.

### Steps

```bash
npm version 0.1.2 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Bump version to 0.1.2"
git push origin main

gh release create v0.1.2 --target main --title "pi-box v0.1.2" --notes "..." --latest

# then update the README Download section with the exact asset URLs
```

### Workflow (`release.yml`)

| Job | Runner | Targets |
|-----|--------|---------|
| macOS arm64 | `macos-14` | `--mac --arm64` |
| macOS x64 | `macos-14` | `--mac --x64` (cross-arch) |
| Linux x64 | `ubuntu-latest` | `--linux --x64` (AppImage + deb) |
| Windows x64 | `windows-latest` | `--win --x64` (nsis + portable) |

Steps per job: checkout → Node 22 → `npm ci` → `npm run typecheck` →
`npm run build` → `electron-builder --<platform> --publish never` → upload via
`softprops/action-gh-release`.

### Local validation before releasing

```bash
npm run typecheck
npm test
npm run build
npm run dist:dir     # quick unpacked build (fast sanity check)
npm run dist:linux   # real AppImage + deb
```

macOS/Windows packaging can only be validated in CI (or on those OSes).
Builds are currently **unsigned** (macOS Gatekeeper / Windows SmartScreen
warnings); signing/notarization is a future step (secrets `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).

---

## 8. Useful commands

```bash
npm install
npm run dev          # HMR (Linux sets NO_SANDBOX automatically)
npm run build        # electron-vite build → out/
npm run start        # preview production build
npm run typecheck    # type-check main + renderer
npm test             # vitest unit tests
npm run dist:dir     # unpacked package
npm run dist:linux   # AppImage + deb
npm run dist:mac     # dmg + zip (macOS only)
npm run dist:win     # NSIS + portable (Windows only)
```

See also: `docs/pi-rpc-ui-design.md` for the RPC chat design, and
`README.md` for the user-facing overview.
