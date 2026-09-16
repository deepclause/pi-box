# pi RPC UI — design document

Status: **proposal** (not implemented). Supersedes the current
"tmux + pi TUI on the serial console" interaction model for pi sessions, while
keeping tmux for plain terminal sessions.

## 0. TL;DR

Add a native, Claude-Desktop-style chat UI for pi inside pi-box:

- **pi sessions** are `pi --mode rpc` processes running *inside the AgentVM*.
  The host talks to them over a JSONL protocol (not the terminal), so the
  renderer can draw clean messages, thinking blocks, tool cards, diffs and an
  input composer instead of an ANSI transcript.
- **Terminal sessions** stay exactly as they are today: tmux on the VM console,
  rendered by xterm.js.
- The transport is the hard part. AgentVM has no host→guest stdio channel, so
  each RPC session gets a small **guest-side TCP↔stdio bridge**
  (`pi-rpc-bridge.py`, seeded into `.pi/` like the existing resize daemon) and
  the host reaches it through the **AgentVM port-forwarding** feature it already
  ships.
- Sessions, auth, models and settings continue to live in the workspace's
  `.pi` directory, so everything stays workspace-contained and survives VM
  restarts through the persistent-root ext4 overlay.

```
┌──────────────────────────── Electron ─────────────────────────────┐
│ renderer (React)                                                   │
│   SessionsSidebar │ ChatView (transcript + composer) │ TerminalView│
│        ▲ contextBridge / IPC                                       │
│ main (Node)                                                        │
│   WorkspaceStore   VmManager ── AgentVM (console/tmux + port fwd)  │
│                    RpcSessionManager                               │
│                        ├─ RpcConnection A ─┐                       │
│                        └─ RpcConnection B ─┤ net.Socket→127.0.0.1  │
└────────────────────────────────────────────┼───────────────────────┘
                                             │ AgentVM port forward
┌──────────────────────────── AgentVM guest ─┼───────────────────────┐
│  pi-rpc-bridge.py :71xx  ◄─────────────────┘                       │
│      └─ stdio ─ pi --mode rpc --session …   (headless, JSONL)      │
│  tmux (console) ── shells / terminals                              │
│  /workspace/.pi  { settings, auth, models, sessions/, … }          │
└────────────────────────────────────────────────────────────────────┘
```

---

## 1. Goals and non-goals

### Goals
1. A first-class **chat UI** for pi: streaming assistant text, thinking,
   tool calls with live output, images, token/cost/context indicators, model
   and thinking-level pickers.
2. **Multiple pi sessions** per workspace, listed in a sidebar and resumable
   from their persisted JSONL session files.
3. **Terminal sessions** via tmux as today, coexisting with the chat sessions.
4. Keep all pi state **inside the workspace** (`.pi`): settings, auth, models,
   sessions. Switching workspaces switches the whole pi configuration.
5. No new backend service. Everything runs in the Electron main process plus
   the existing AgentVM.

### Non-goals (v1)
- Running pi outside the VM (the RPC process stays in the guest).
- Concurrent *streaming* from many sessions (see §9 — the VM is single-hart).
- Replacing the pi TUI for power users; it remains available in a tmux window.
- Remote/multi-user access.

---

## 2. Background: how pi-box works today

Relevant pieces (see `README.md`, `docs/DEVELOPMENT.md`):

- `src/main/vm.ts` (`VmManager`) owns one `AgentVM` in interactive/raw mode.
  It injects a startup script once the busybox prompt appears
  (`ESC[6n` detection), then launches tmux with `pi` in window 0.
- The startup script (`VmManager.buildStartupScript`) exports:
  `PI_CODING_AGENT_DIR=/workspace/.pi`,
  `PI_CODING_AGENT_SESSION_DIR=/workspace/.pi/sessions`,
  `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`,
  `LANG=C.UTF-8`, TUI colour/image hints, then sources
  `/workspace/.pi-box/config`, starts the resize daemon and runs
  `tmux … new-session -s pi -n pi pi`.
- `src/main/workspaces.ts` (`WorkspaceStore`) seeds each workspace's `.pi`
  (`settings.json`, `sessions/`, `tmux.conf`, `tty-resize-daemon.py`,
  `tty-size`) and `.pi-box/config`, and persists the workspace list to
  `<userData>/workspaces.json`.
- `src/main/ipc.ts` (`registerIpc`, `MOUNT_POINT = '/workspace'`) is the full
  host↔renderer surface; `src/preload/index.ts` exposes `window.pibox`.
- The active workspace is mounted at `/workspace`; switching workspaces
  restarts the VM.
- AgentVM exposes console I/O (`vm.writeToStdin`, `onStdout`), `vm.exec()`, and
  **runtime TCP port forwarding** (`addPortForward` / `removePortForward` /
  `listPortForwards`).

The interaction model today is "terminal first": the renderer only sees a byte
stream and paints it with xterm.js. This design adds a structured second
channel.

---

## 3. The pi RPC interface

Source of truth: `pi-coding-agent/docs/rpc.md` (bundled in the VM image at
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`, and
https://pi.dev/docs/latest/rpc). Types: `dist/modes/rpc/rpc-types.d.ts`; typed
client: `dist/modes/rpc/rpc-client.d.ts` / `.js`.

### 3.1 Transport and framing

- One process: `pi --mode rpc [options]` (or the dedicated
  `dist/rpc-entry.js`, which just calls `main(["--mode", "rpc", …])`).
- **Commands** are JSON objects written to **stdin**, one per line.
- **Responses** and **events** are JSON objects written to **stdout**, one per
  line.
- Framing is **strict JSONL with LF (`\n`) only**:
  - split on `\n` only;
  - strip one trailing `\r` to tolerate CRLF;
  - **do not use Node `readline`** — it also splits on `U+2028`/`U+2029`, which
    are legal inside JSON strings. Implement a byte/UTF-8-safe line splitter.
- Diagnostics go to **stderr** and are not part of the protocol.
- Every command may carry an optional `id`; the matching response echoes it.
  This is the request/response correlation mechanism. Events generally have no
  `id` (except `bash_execution_update`, which echoes its command's `id`).
- Streaming is asynchronous: after `prompt` is *accepted* (`success: true`),
  events flow until the run settles.

### 3.2 Commands

| Group | Commands |
|---|---|
| Prompting | `prompt` (with `images`, `streamingBehavior: steer\|followUp`), `steer`, `follow_up`, `abort`, `clear_queue` |
| Session | `new_session`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `set_session_name` |
| State | `get_state`, `get_messages`, `get_entries` (with `since` cursor), `get_tree`, `get_last_assistant_text` |
| Model / thinking | `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels` |
| Queue modes | `set_steering_mode`, `set_follow_up_mode` |
| Context | `compact`, `set_auto_compaction` |
| Retry | `set_auto_retry`, `abort_retry` |
| Bash | `bash`, `abort_bash` |
| Stats / export | `get_session_stats`, `export_html` |
| Discovery | `get_commands` |

Notable semantics for the UI:

- `prompt` while streaming **must** pass `streamingBehavior`, otherwise it
  errors. `steer` is delivered after the current assistant turn's tool calls,
  before the next LLM call. `follow_up` is delivered only when the agent stops.
- `clear_queue` returns the queued texts; the documented Esc pattern is
  `clear_queue` → restore text in the composer → `abort`.
- `switch_session` and `new_session` can be **cancelled** by an extension
  (`data.cancelled`).
- `get_entries` returns the append-only tree, including pre-compaction history
  and abandoned branches, and is cursor-addressable via `since`. `get_messages`
  returns only current context. For faithful transcript rendering on reload,
  prefer `get_entries` (+ `get_tree` for branches); use `get_messages` only when
  you specifically want the model-visible context.

### 3.3 Responses

```json
{"id":"req-1","type":"response","command":"prompt","success":true}
{"type":"response","command":"set_model","success":false,"error":"Model not found: …"}
```

`success: true` for `prompt` means *accepted/queued/handled*; later failures
surface as events, not as a second response. The UI must therefore drive its
state from events, not only from responses.

### 3.4 Events

Events are `JsonAgentSessionEvent` (see `dist/modes/json-event.d.ts`):

| Event | Use in UI |
|---|---|
| `agent_start` / `agent_end` / `agent_settled` | run spinner; `agent_end.willRetry`; "settled" is the true idle signal |
| `turn_start` / `turn_end` | turn boundaries (assistant message + tool results) |
| `message_start` / `message_end` | begin/finalize a message; `message_end.message` is authoritative |
| `message_update` | streaming deltas (see below) |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | tool cards; `partialResult` is **cumulative** (replace, don't append) |
| `bash_execution_update` | direct `bash` command output chunks, correlated by `id` |
| `queue_update` | pending steering/follow-up chips |
| `compaction_start` / `compaction_end` | context compaction notice; `willRetry` on overflow |
| `auto_retry_start` / `auto_retry_end` | transient-error retry UI |
| `summarization_retry_*` | compaction/branch-summary retry UI |
| `extension_error` | surfaced as a non-fatal error toast |

`message_update.assistantMessageEvent` deltas:

| Delta | Meaning |
|---|---|
| `text_start` / `text_delta` / `text_end` | assistant text block (`contentIndex`) |
| `thinking_start` / `thinking_delta` / `thinking_end` | reasoning block |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | tool call assembly (`id`, `toolName`, then argument deltas) |

The wire `message_update` deliberately omits the cumulative partial message.
Assemble from `message_start` + deltas keyed by `contentIndex`, and treat
`message_end.message` as the final truth. This is important: do not try to
render `assistantMessageEvent.partial` (it is absent in RPC/JSON mode).

### 3.5 Extension UI sub-protocol

Extensions can drive UI through `extension_ui_request` records on stdout:

- **Dialogs** (`select`, `confirm`, `input`, `editor`) block the extension until
  the client sends `extension_ui_response` with the matching `id`
  (`value` | `confirmed` | `cancelled`). Requests may carry a `timeout`; the
  agent auto-resolves it, so the client never needs to.
- **Fire-and-forget** (`notify`, `setStatus`, `setWidget`, `setTitle`,
  `set_editor_text`) are displayed or ignored.
- In RPC mode `ctx.mode === "rpc"` and `ctx.hasUI === true`; TUI-only APIs
  (`custom()`, `setFooter()`, themes, …) are no-ops or return defaults.

This is a feature, not a burden: it lets extensions ask the user questions in
the web UI (e.g. an "approve this command?" prompt).

### 3.6 Message and content types

`AgentMessage` is one of `user`, `assistant`, `toolResult`, `bashExecution`,
`custom`. Content blocks are `text`, `thinking`, `toolCall`, and (for user and
tool results) `image`. Usage/cost are attached to assistant and tool-result
messages. See `docs/session-format.md` for the exact shapes. These are exactly
what the session JSONL stores, so a client can render either the live event
stream or a historical session file with the same components.

### 3.7 Startup options relevant to embedding

```
pi --mode rpc
   [--provider <name>] [--model <pattern>]
   [--name <name>] [-n <name>]
   [--no-session]
   [--session-dir <path>]
   [--session <path|id>] [--fork <path|id>]
   [--approve | --no-approve]
```

`get_state` returns `model`, `thinkingLevel`, `isStreaming`, `isCompacting`,
`steeringMode`, `followUpMode`, `sessionFile`, `sessionId`, `sessionName`,
`autoCompactionEnabled`, `messageCount`, `pendingMessageCount`.

### 3.8 What RPC does *not* provide

- No host-facing server: it is **stdio only**. There is no TCP/HTTP/WebSocket
  listener, so the host cannot connect to it directly.
- No TUI rendering: layout, markdown, diffs and syntax highlighting are the
  client's job.
- No built-in multiplexing: one process = one active session. "Several
  sessions" means either several processes or in-process `switch_session`.

That last point drives both the transport design (§4) and the concurrency model
(§9).

---

## 4. The transport problem: host ↔ guest stdio

### 4.1 Constraints

- The pi process lives in the **guest**; the UI lives in the **host**. We need a
  reliable, bidirectional, backpressured **byte stream** carrying JSONL.
- The guest↔host interfaces AgentVM actually offers are:
  1. the **serial console** (`writeToStdin` / `onStdout`) — a TTY shared with
     tmux, so framing is polluted by escape sequences and echo;
  2. the **9p/WASI mount** at `/workspace` — regular files only
     (`fs_mknod`/`mkfifo` unsupported, no xattrs, no chmod);
  3. the **userspace TCP/IP NAT** plus `addPortForward` (host TCP connect →
     guest TCP server);
  4. `vm.exec()` — sentinel-delimited one-shot commands on the persistent shell,
     which buffer until a marker and are not an interactive stdin pipe.
- AgentVM has **no `spawn()`/PTY/stdio-bridge** API (0.3.x).

### 4.2 Options considered

| Option | Mechanism | Verdict |
|---|---|---|
| **A. TCP bridge + port forward** | guest runs a TCP server that pipes to `pi --mode rpc` stdio; host connects via `addPortForward` | ✅ **chosen** — real byte stream, backpressure, uses shipped AgentVM features |
| B. FIFO on the mount | `mkfifo` in `/workspace`, host/guest read the pipe | ❌ 9p/WASI has no `mknod`; host cannot open a guest-created FIFO |
| C. Append-only files + polling | guest appends stdout to a file, tails a command file | ⚠️ works over 9p but fragile: no backpressure, polling latency, concurrent-write hazards, cursor bookkeeping |
| D. Console/tmux | run RPC in a tmux pane, parse the console stream | ❌ tmux/ANSI mangles JSONL; no clean request/response |
| E. AgentVM `spawn()`/PTY API | add a real process bridge to AgentVM | ⚠️ clean long-term, but a large AgentVM change (new WASI fd semantics, streaming `exec`) — out of scope for v1 |
| F. Guest dials out to host | guest connects to the gateway, host listens | ❌ NAT resolves the guest's destination as a real network address; no supported host-loopback mapping |

### 4.3 Chosen design

A small Python program, `pi-rpc-bridge.py`, is seeded into the workspace's
`.pi/` (exactly like the existing `tty-resize-daemon.py`). For each pi session
the host:

1. allocates a **host loopback port** and a **guest port**;
2. calls `vm.addPortForward({ hostPort, guestPort })` (binds `127.0.0.1` by
   default — not exposed to the LAN);
3. launches the bridge in the guest via `vm.exec()` in the background:
   `nohup python3 /workspace/.pi/pi-rpc-bridge.py --port <guestPort> … >log 2>&1 &`
4. waits for the bridge's **readiness marker** (a file it writes on the
   workspace mount right after `listen()`), then connects a `net.Socket` to
   `127.0.0.1:<hostPort>`. This is essential: AgentVM's port-forward listener
   accepts the host connection *immediately*, even before the guest server is
   bound, and an early connect makes the guest RST the injected SYN, killing
   the host socket for good (see §14);
5. speaks JSONL over that socket exactly as if pi's stdio were local.

Why Python: the pi image already ships `python3` (`image/Dockerfile.pi`) and
this mirrors the existing resize-daemon pattern. `socat` is **not** in the
image, and adding it would mean rebuilding the agentvm image.

Why this maps cleanly onto AgentVM: the port-forward path is the same
guest-server ↔ host-loopback path already used for user-facing port forwards,
so it is exercised code. The bridge process is a normal guest process started
from the persistent shell, just like the resize daemon.

### 4.4 Wire path

```
RpcConnection ── net.Socket ── 127.0.0.1:hostPort
                                    │  (AgentVM addPortForward)
                                    ▼
                          guest TCP flow → 192.168.127.3:guestPort
                                    │
                          pi-rpc-bridge.py accept()
                            ├─ socket → pi.stdin   (commands)
                            └─ pi.stdout → socket  (responses + events)
                               pi.stderr → bridge log file
```

---

## 5. Guest side: `pi-rpc-bridge.py`

Seeded by `WorkspaceStore.ensurePiDir` (app-owned, refreshed on every boot, like
`tty-resize-daemon.py`).

Interface:

```
python3 /workspace/.pi/pi-rpc-bridge.py \
    --port <guestPort> \
    [--session <path>]     # resume a specific session file
    [--name <name>] \
    [--cwd /workspace] \
    [--log <path>]
```

Behaviour:

1. Set the workspace-scoped pi environment (`PI_CODING_AGENT_DIR`,
   `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`,
   `PI_TELEMETRY`, `LANG`) — the same values `VmManager.buildStartupScript`
   already uses. Do **not** set the TUI-only hints (`COLORTERM`,
   `PI_TRUE_COLOR`, `PI_IMAGE_PROTOCOL`); RPC is structured, not ANSI.
2. Spawn `pi --mode rpc --approve [--session …] [--name …]` with
   `stdin=PIPE, stdout=PIPE, stderr=<log>`, `cwd=/workspace`.
3. `accept()` one host connection (set `TCP_NODELAY`), then pump bytes in both
   directions with `select` until either side closes.
4. On host disconnect, terminate pi and exit, or (option) keep pi alive and
   buffer a bounded amount of stdout for a reconnect. See §11.

Design notes:

- **Backpressure**: use blocking `send`/`recv` loops or `select` with a bounded
  read buffer; never buffer unbounded tool output in the bridge.
- **Readiness marker**: after `listen()`, write a `.ready` file on the mount so
  the host can tell when the guest side is accepting (see §14).
- **Boot-time launch**: the bridge is started from the VM startup script
  (`VmManager.buildStartupScript`), not on demand with `vm.exec()`. In
  interactive mode the console is owned by tmux/pi, so `vm.exec()` would type
  the launch command straight into the running agent. The startup script also
  removes any stale `.ready` marker first, because the workspace (and therefore
  the marker) survives VM restarts.
- **Byte pump**: forward pi's stdout with `os.read()`/`read1()`, never a
  buffered `read(n)`; the latter blocks until `n` bytes or EOF and would stall
  every JSON line (see §14).
- **Logging**: redirect pi's stderr to `/workspace/.pi-box/rpc/<id>.log` so
  diagnostics do not corrupt the protocol and remain inspectable.
- **Trust**: RPC mode never prompts for project trust. `--approve` guarantees
  `.pi/settings.json` and `.pi` resources are loaded for that run. (Do not rely
  on `defaultProjectTrust`, which is documented as a *global* setting.)
- **One process per port**: simplest and matches "one port forward per
  session". A multiplexed single-port bridge is possible later but adds a second
  framing layer.

---

## 6. Host side: `RpcSessionManager`

New module, e.g. `src/main/rpc.ts`, owned by the main process alongside
`VmManager`. One `RpcConnection` per live session.

```ts
class RpcSessionManager {
  create(workspaceId, opts): Promise<SessionMeta>
  open(sessionId): Promise<SessionSnapshot>   // history + state
  close(sessionId): Promise<void>
  send(sessionId, command): Promise<RpcResponse>
  on(event, cb): void                          // 'event' | 'response' | 'status'
}
```

### 6.1 `RpcConnection`

- Owns the host `net.Socket`, a `StringDecoder` (utf-8, streaming) and a
  **LF-only** line splitter (buffer + `indexOf(0x0a)`, strip trailing `\r`).
- Assigns monotonic `id`s to commands and resolves the matching `response`.
- Emits every parsed event to subscribers.
- Rejects all pending requests and emits a `status: 'closed'` on socket error.
- Enables `setNoDelay(true)` for streaming latency.

The framing and correlation logic can be adapted from pi's own
`src/modes/rpc/rpc-client.ts`; it is a good reference implementation.

### 6.2 Lifecycle

```
create(session):
  hostPort = allocateHostPort()          # probe-bind 0, then close
  guestPort = allocateGuestPort()        # e.g. 7100..7199, tracked
  await vm.addPortForward({ hostPort, guestPort })
  await vm.exec(`nohup python3 …/pi-rpc-bridge.py --port ${guestPort} … &`)
  socket = await connectWithRetry('127.0.0.1', hostPort)   # until accept
  await send('get_state')                # handshake / liveness
  if resuming: history = await send('get_entries')        # or read JSONL
tracked.set(sessionId, { hostPort, guestPort, socket, … })

close(session):
  socket.end()
  await vm.exec(`pkill -f "pi-rpc-bridge.py --port ${guestPort}" || true`)
  vm.removePortForward(hostPort)
```

- **Host port allocation**: AgentVM requires an explicit `hostPort` and keys its
  map by it, so probe for a free port (`net.createServer().listen(0)` → read
  `address().port` → close). Guard against races with a small in-process set.
- **Guest port allocation**: simple counter/range maintained by the manager.
- **VM restart / workspace switch**: `VmManager` already restarts the VM on
  workspace change; the manager must tear down all connections and re-create the
  per-workspace open set afterwards.
- **App quit**: `before-quit` already awaits `vm.stop()`; the manager should
  close sockets first (best effort).

### 6.3 Session registry

The set of known sessions is derived from the workspace's
`.pi/sessions/**/*.jsonl` files (readable from the host through the mount) plus
in-memory live connections:

```ts
interface SessionMeta {
  id: string                 // sessionId (from get_state) or file stem
  workspaceId: string
  file: string | null        // /workspace/.pi/sessions/.../*.jsonl
  name?: string
  model?: { provider, id }
  thinkingLevel?: string
  lastActivity?: number
  live: boolean
  streaming: boolean
}
```

Because the JSONL is a plain file on the mount, the sidebar can list sessions
and show a preview **without booting a pi process**, and the host can delete or
rename files directly (matching `/resume`'s delete/rename semantics).

### 6.4 IPC surface

Extend `src/shared/types.ts` and `src/preload/index.ts` with an `rpc` namespace
(keeping the existing `window.pibox` API for VM/terminal/workspace control):

```ts
interface PiBoxApi {
  // …existing…
  rpc: {
    listSessions(workspaceId): Promise<SessionMeta[]>
    createSession(workspaceId, opts?): Promise<SessionMeta>
    openSession(sessionId): Promise<SessionSnapshot>
    closeSession(sessionId): Promise<void>
    prompt(sessionId, message, images?, streamingBehavior?): Promise<void>
    steer(sessionId, message, images?): Promise<void>
    followUp(sessionId, message, images?): Promise<void>
    abort(sessionId): Promise<void>
    clearQueue(sessionId): Promise<{ steering: string[]; followUp: string[] }>
    getState/getMessages/getEntries/getTree/getSessionStats/getCommands…
    setModel/cycleModel/getAvailableModels/setThinkingLevel/…
    newSession/switchSession/fork/clone/setSessionName/exportHtml
    bash(sessionId, command)/abortBash
    respondExtensionUi(sessionId, response): void
    onEvent(sessionId, cb): () => void
    onStatus(cb): () => void
  }
}
```

The renderer never sees raw sockets; it only sees typed events. The manager
should also **reduce** noisy events (e.g. coalesce `message_update` deltas into
~30–60 ms frames before forwarding over IPC) to avoid flooding the renderer,
while still delivering final and state-changing events immediately.

---

## 7. Renderer and UX

Target look and feel: Claude Desktop — a session list on the left, a spacious
transcript in the middle, a persistent composer at the bottom, and inline tool
activity.

### 7.1 Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ titlebar: workspace ▾   [ + New pi ]  [ + Terminal ]   ⚙ network │
├──────────────┬───────────────────────────────────────────────────┤
│ Sessions     │  ChatView                                         │
│  ▸ pi chat A │   ┌─────────────────────────────────────────────┐ │
│  ▸ pi chat B │   │ user bubble                                 │ │
│  ▸ …          │   │ assistant markdown (streaming)              │ │
│  ───────────  │   │ ▸ thinking (collapsible)                    │ │
│  Terminals   │   │ ┌ tool card: bash (live output) ──────────┐ │ │
│  ▸ shell 1   │   │ └─────────────────────────────────────────┘ │ │
│  ▸ shell 2   │   └─────────────────────────────────────────────┘ │
│  [+ new]     │   composer: [textarea]  /  📎  model  thinking ➤  │
└──────────────┴───────────────────────────────────────────────────┘
```

The sidebar has two groups: **pi sessions** and **terminals** (tmux windows).
Selecting a terminal switches the xterm pane to that tmux window; selecting a pi
session shows `ChatView`.

### 7.2 Transcript rendering

Build a message list from `get_entries` on open, then apply live events:

- **user**: plain text + image thumbnails, right-aligned or bubble style.
- **assistant**: markdown (code fences with syntax highlighting, GFM tables,
  mermaid as the docs allow), streaming cursor; images inline.
- **thinking**: collapsed by default, expandable, dimmed; streamed from
  `thinking_*` deltas.
- **tool call**: a card keyed by `toolCallId`, titled by `toolName` + a
  one-line argument summary, with a status (running/done/error) and a body:
  - `bash`: terminal-style monospace block, live from
    `tool_execution_update.partialResult` (replace, not append);
  - `read`: file path + content (with line numbers if available);
  - `edit`/`write`: unified diff from the tool's structured `details` when
    present, otherwise the text result;
  - `grep`/`find`/`ls`: result list;
  - images returned by tools: thumbnails;
  - unknown tools: pretty-printed JSON arguments + text result.
- **bashExecution** messages (from the direct `bash` command) render as a
  terminal card too.
- **compaction / retry**: inline system notices with the reason and, on
  `compaction_end`, before/after token counts.
- **errors**: `stopReason: "error"` / `isError` render as an error block with
  `errorMessage`.

Streaming assembly rule: `message_start` creates the item; deltas mutate it by
`contentIndex`; `message_end` replaces it with the authoritative message. For
tool cards, `tool_execution_end.result` is authoritative.

### 7.3 Composer

- Enter sends; Shift+Enter newline (configurable).
- If `isStreaming`: the primary button becomes **Steer** vs **Follow up**
  (a small split control), matching `streamingBehavior`. A plain send with no
  behavior would error, so the UI must always choose one.
- **Stop** button → `abort`.
- **Esc** → `clear_queue`, put the returned texts back into the composer, then
  `abort` (the documented interactive behaviour).
- `/` opens command autocomplete from `get_commands` (extension commands,
  prompt templates, `skill:*`). Built-in TUI-only commands are intentionally
  absent.
- **Attachments**: pasted/dropped images become `ImageContent`
  (`{type:"image", data:<base64>, mimeType}`) on `prompt`/`steer`/`follow_up`.
- Pending steering/follow-up messages render as chips above the composer, driven
  by `queue_update`.

### 7.4 Header / status

From `get_state` and `get_session_stats`:
- session name (editable → `set_session_name`);
- model picker (`get_available_models`, `set_model`, `cycle_model`);
- thinking-level picker (`get_available_thinking_levels`,
  `set_thinking_level`);
- context usage bar (`contextUsage.percent`), token totals and cost;
- streaming / compacting indicators.

### 7.5 Session management

- New, rename, delete, fork, clone, export HTML, resume.
- Delete/rename can operate directly on the `.pi/sessions` files on the mount
  (no pi process needed) or via `set_session_name` for the live one.
- The tree (`get_tree`) enables a branch navigator equivalent to `/tree`:
  selecting a user entry can move the leaf and pre-fill the composer, mirroring
  the TUI behaviour. This can be phase 3.

### 7.6 Extension UI

Map `extension_ui_request` methods to components:

| Method | UI |
|---|---|
| `select` | modal list; respond `{value}` or `{cancelled:true}` |
| `confirm` | modal yes/no; respond `{confirmed}` |
| `input` | single-line prompt; respond `{value}` |
| `editor` | multi-line editor prefilled; respond `{value}` |
| `notify` | toast, styled by `notifyType` |
| `setStatus` | status-bar entry keyed by `statusKey` |
| `setWidget` | block above/below the composer (`widgetLines`, `widgetPlacement`) |
| `setTitle` | window/tab title |
| `set_editor_text` | set composer text |

Timeouts are agent-side; the UI just needs to render and respond.

### 7.7 Terminals

Unchanged: xterm.js + tmux on the console. The "new shell" action still sends
`Ctrl+B c`. If terminal *tabs* are wanted, the host can query
`tmux list-windows` via `vm.exec()` and select windows with `tmux select-window
-t <n>`; the single xterm stays attached to the active tmux client. This is
optional polish, not required for v1.

---

## 8. Workspace and settings integration

Everything pi needs already lives in the workspace, and RPC must be pointed at
the same place:

| Concern | Value | Mechanism |
|---|---|---|
| Project dir | `/workspace` | bridge `--cwd /workspace` |
| Config dir | `/workspace/.pi` | `PI_CODING_AGENT_DIR` |
| Sessions | `/workspace/.pi/sessions` | `PI_CODING_AGENT_SESSION_DIR` (or `--session-dir`) |
| Auth | `/workspace/.pi/auth.json` | via config dir |
| Model defaults | `/workspace/.pi/settings.json`, `models-store.json` | via config dir |
| Trust | `/workspace/.pi/settings.json` + `--approve` | avoid the non-interactive trust fallback |
| Extra env / tmux overrides | `/workspace/.pi-box/config` | source it in the bridge too, so RPC and TUI stay consistent |
| Session persistence | ext4 overlay (`<workspace>/.agentvm/upper.img`) | already enabled by `persistentRoot` |

Consequences and rules:

1. **One pi config per workspace.** Multiple sessions share `auth.json`,
   `models-store.json` and `settings.json`, so signing in once covers all
   sessions in that workspace.
2. **Session files are first-class workspace artifacts.** They appear under
   `.pi/sessions` in the existing file tree, can be opened in `vi` via the
   existing per-file action, exported with `export_html`, and backed up with the
   workspace.
3. **`PI_OFFLINE=1` semantics.** It skips pi's startup network operations
   (version check, fd/ripgrep download, catalog refresh) but does **not** disable
   provider/model calls. Keep it for fast startup; the chat still needs working
   guest networking for inference.
4. **Workspace switching restarts the VM** (current design), which kills all RPC
   processes. The manager must rebuild the session list from the new workspace's
   `.pi/sessions` and optionally reopen the previously focused session.
5. **The resize daemon and `tty-size` file are TUI-only** and irrelevant to RPC;
   leave them untouched for the terminal path.
6. **The console's tmux window 0 no longer runs `pi` (implemented).** Since the
   chat UI owns the (headless, RPC) pi process, booting a second TUI pi only
   contends for the single emulated hart and delays the chat. tmux window 0 is
   now a shell and `VmManager` marks the VM ready shortly after the startup
   script (no longer waiting for pi's TUI markers). The header's pi button opens
   the TUI in a new tmux window for power users.

---

## 9. Concurrency and resource model

This is the single most important practical constraint.

- The AgentVM guest is a **single-hart RISC-V emulator**. Every pi process is a
  full Node/V8 instance running under emulation with `--single-threaded-gc`.
  pi startup is ~20 s; a running agent is CPU-bound.
- Two or more live pi processes therefore contend for one emulated CPU and one
  shared guest memory budget (the WASM linear memory is fixed at ~1.34 GiB). This
  is not just slower — it risks OOM and long stalls.

Recommended policy:

- **Default: one live RPC process per workspace.** The UI still lists many
  sessions; switching sessions reuses the same process via `switch_session`
  (or `new_session`), or spawns on demand if none is live. This matches the
  Claude Desktop model, where only the active conversation is loaded.
- **`maxLiveSessions` setting** (default 1, allow 2 for users who want a
  second agent while the first waits for input). Each live session costs one
  bridge process, one pi process, one port forward and one socket.
- **Lazy activation**: opening a session from the sidebar resumes it only when
  focused; non-focused sessions are "cold" (JSONL preview only).
- **Switching while streaming**: either block with a confirm ("Stop the current
  run to switch?") or call `abort` then `switch_session`. `switch_session` may
  also be cancelled by an extension, so always inspect `data.cancelled`.

If true parallel agents are ever needed, they should probably be a future
AgentVM feature (multi-hart, or a lighter pi runtime) rather than more processes
in one guest.

---

## 10. Security

- Port forwards bind `127.0.0.1` by default; never use `bind: '0.0.0.0'` for RPC.
- The RPC endpoint has the full capability of the agent (shell in the VM,
  workspace read/write). Treat the socket as trusted-local only.
- The guest firewall should not need changes, but if the user adds a deny rule
  for inbound traffic, ensure it cannot cut off the loopback forward path.
- Session files and `auth.json` are inside the mounted workspace, which the user
  already owns; this is unchanged from today.
- Extension UI dialogs are a social-engineering surface (an extension can ask
  the user to run something); render the requesting extension path where the RPC
  protocol provides it, and do not auto-confirm.

---

## 11. Failure modes and mitigations

| Failure | Mitigation |
|---|---|
| Guest bridge not yet listening when host connects | connect-with-retry (e.g. 20 × 250 ms) after launch |
| Host socket drops mid-stream | surface a disconnected state; offer "reconnect" (spawn bridge with `--session <file>`), or keep pi alive and buffer output (option) |
| pi process crashes | bridge exits, host detects EOF, marks session errored, logs stderr to `.pi-box/rpc/` |
| Bridge leaks after app crash | bridge kills pi when the socket closes; also `pkill -f pi-rpc-bridge.py` on session close and VM restart |
| Large tool output / images | LF framing handles arbitrary record size; coalesce deltas; avoid unbounded bridge buffers; use `fullOutputPath` for truncated bash output |
| `message_update` omits cumulative message | assemble from `message_start` + deltas; trust `message_end` |
| Unknown/newer event types | ignore unknown event `type`s gracefully; log once |
| Extension dialog never answered | agent-side `timeout` auto-resolves; UI mirrors it if provided |
| Workspace switch during a run | abort/tear down before restarting the VM |
| Trust not applied | always pass `--approve`; verify `.pi` resources load |

---

## 12. Phased implementation plan

**Phase 0 — transport spike (highest risk).**
Seed `pi-rpc-bridge.py`, forward one port, connect from Node, send `prompt`,
print raw events. Confirms port forwarding, framing, latency and that
`pi --mode rpc` behaves headless in the guest. Exit criterion: a full
prompt→stream→`agent_settled` round trip.

**Phase 1 — minimal chat. ✅ done.**
`RpcSessionManager` + `RpcConnection` (`src/main/rpc.ts`), one live session,
`openSession` loads `get_entries`, rendering of user/assistant text + markdown
(`marked` + `dompurify`), composer with send/steer/follow-up/abort and
streaming text (`src/renderer/src/components/ChatView.tsx`, `AppHeader.tsx`,
`lib/chat.ts`, `Markdown.tsx`), wired through IPC + preload. Verified end to
end in the running app: a real prompt streamed `PHASE1_OK` into the transcript
with no renderer errors.

Startup notes from testing: the RPC session must ignore **stale readiness
markers** — the marker lives on the workspace mount and survives restarts, so
`index.ts` deletes it before every `vm.start()`. The guest bridge only publishes
the marker after `eth0` has an IPv4 address, so a connect can never race the
NIC. With tmux booting a shell (no TUI pi), a cold start reached a ready chat in
~55 s (down from ~90 s with the TUI pi also booting).

Further trimming got that to **~48 s**: the bridge now warms a pi process the
moment it starts (before the NIC wait) and the startup script launches the
bridge before the resize daemon. Profiling inside the guest shows the floor:
`node -e 1` alone takes ~5 s under emulation and `pi --mode rpc` adds ~25 s
executing the 7.6 MB bundle (the unbundled `dist/rpc-entry.js` is ~4x slower, so
the single bundle is essential). The remaining cost is inherent to running V8
under RISC-V emulation, not to pi-box. The real lever is image-level: build a V8
startup snapshot into the agentvm pi image (`node --build-snapshot` /
`--snapshot-blob`) so top-level execution is skipped, or ship a smaller bundle.
That is an `agentvm` change, not an app change.

**Phase 2 — full transcript + controls.**
Thinking blocks, tool cards (bash/edit/write/read), `get_session_stats` header,
model/thinking pickers, queue chips, compaction/retry notices, error states,
`/` command autocomplete.

**Phase 3 — multi-session + extension UI. ✅ done (core).**
Sessions panel from `.pi/sessions` with new/switch/delete, `switch_session`
reuse, and the live session shown even before its file exists (brand-new
sessions have no file until the first message). Extension UI dialogs
(`select`/`confirm`/`input`/`editor`), `notify` toasts, `setStatus`,
`setWidget` and `set_editor_text` are handled. Rename/fork/clone/export and
image attachments are still open (Phase 4).

**Phase 4 — polish / power features. ◑ partial.**
Done: inline rename (`set_session_name`), `export_html`, Cmd/Ctrl+N, image
attachments (paste/drop/picker), fork-from-message and clone, and a README
refresh. Still open: `get_tree` branch navigator, terminal tabs via
`tmux list-windows`, explicit reconnect, `maxLiveSessions`, per-session
settings, and the rest of the TUI keybindings.

---

## 13. Open questions

1. **Reconnect semantics**: kill pi on disconnect (simple, ~20 s resume) vs keep
   it alive and buffer (faster, more state). Recommendation: start simple.
2. **Delta coalescing cadence** over IPC (throughput vs smoothness); needs a
   measurement on real sessions.
3. **One bridge per session vs one multiplexed bridge**; the latter saves ports
   but adds framing.
4. **Whether to keep the pi TUI in tmux** as a first-class alternative, and how
   the two views share a session file safely (they must not write concurrently).
5. **Default `maxLiveSessions`** (1 vs 2) on capable hosts.
6. Whether to eventually replace the Python bridge with a native AgentVM
   `spawn()`/stdio API (§4.2 option E), which would remove the TCP hop.

---

## 14. Phase 0 results (transport spike, validated)

Status: **done**. Scripts: `scripts/pi-rpc-bridge.py` (guest bridge) and
`scripts/spike-rpc.cjs` (host driver). Run with
`node scripts/spike-rpc.cjs`.

The full path was validated against published `deepclause-agentvm@0.3.1`:
AgentVM boots, the workspace mounts, a port forward is added, the guest bridge
listens, the host speaks JSONL to `pi --mode rpc`, and a real model turn streams
to completion.

Observed on the development host:

| Step | Result |
|---|---|
| VM boot (`vm.start()`) | ~1.9 s |
| `pi --mode rpc` readiness (first `get_state` response) | ~33 s |
| Models discovered | 29 (`get_available_models`) |
| `prompt` accepted | ~0.2 s |
| `prompt` → `agent_settled` (deepseek-v4-pro, thinking high) | ~9.5 s |
| Returned text | `RPC_OK` |
| Session file | `/workspace/.pi/sessions/<ts>_<id>.jsonl`, 4 entries |
| Events seen | `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `turn_end`, `agent_end`, `agent_settled` |
| Whole spike | ~50 s |

Confirmed integration details:

- `pi --mode rpc --approve` runs headless in the guest, resolves
  `/workspace/.pi` (settings, auth, models) and writes the session file under
  `/workspace/.pi/sessions`. `get_state`, `get_available_models`,
  `get_session_stats`, `get_last_assistant_text`, `get_entries` and streaming
  `message_update` deltas all behave as documented.
- Guest networking must be up (AgentVM auto-runs DHCP in exec mode); the
  port-forward path is the same one used for user-facing forwards.

Two implementation gotchas that are **required** for correctness:

1. **Readiness race (host).** AgentVM's `addPortForward` listener accepts the
   host TCP connection the moment it is created, regardless of whether the
   guest server is listening. If the host connects before the bridge has
   `listen()`ed — or if `pi` is still starting — the guest RSTs the injected
   SYN and AgentVM tears the host socket down permanently, so the session is
   dead with no useful error. The bridge must therefore publish a readiness
   marker after `listen()` and the host must wait for it before connecting.
   (This is why the spike waits on `~/pi-box-rpc-spike/.pi-box/rpc-bridge.log.ready`.)
2. **Buffered pipe reads (bridge).** Forwarding pi's stdout with Python's
   `proc.stdout.read(65536)` blocks until 64 KiB or EOF, so a single JSON line
   is never sent and the host times out on `get_state` even though pi replied.
   Use `os.read(fd, 65536)` (or `read1`). The reverse direction is fine because
   `socket.recv` returns available bytes.

Other notes from the spike: `vm.exec('nohup … &')` reliably leaves a guest
process running (verified with a delayed background write), and the guest root
in the test run did not use `persistentRoot`, so the session file was written
through the transient root rather than a per-workspace overlay.

## Appendix A — RPC → UI mapping

| RPC | UI element |
|---|---|
| `prompt` / `steer` / `follow_up` | composer send, split control during streaming |
| `abort` / `clear_queue` | Stop button, Esc |
| `message_*`, `message_update` | transcript bubbles, streaming |
| `thinking_*` deltas | collapsible thinking block |
| `toolcall_*`, `tool_execution_*` | tool cards (live) |
| `bash` / `bash_execution_update` | direct shell card |
| `agent_*`, `turn_*` | run/turn activity, spinner, "settled" |
| `queue_update` | pending message chips |
| `compaction_*`, `auto_retry_*`, `summarization_retry_*` | notices |
| `get_state` | header (model, thinking, name, flags) |
| `get_session_stats` | context bar, tokens, cost |
| `get_available_models`, `set_model`, `cycle_model` | model picker |
| `get_available_thinking_levels`, `set_*` | thinking picker |
| `get_commands` | `/` autocomplete |
| `get_entries` / `get_tree` / `get_messages` | history and branch navigator |
| `new_session` / `switch_session` / `fork` / `clone` / `set_session_name` | session actions |
| `export_html` | export |
| `extension_ui_request` | dialogs, toasts, status, widgets |

## Appendix B — bridge environment

```
cwd                                  /workspace
PI_CODING_AGENT_DIR                  /workspace/.pi
PI_CODING_AGENT_SESSION_DIR          /workspace/.pi/sessions
PI_OFFLINE                           1
PI_SKIP_VERSION_CHECK                1
PI_TELEMETRY                         0
LANG                                 C.UTF-8
NODE_COMPILE_CACHE                   /usr/local/lib/pi-cache   (from image)
argv                                 pi --mode rpc --approve [--session …] [--name …]
```

Sources: `pi-coding-agent/docs/rpc.md`, `docs/environment-variables.md`,
`docs/settings.md`, `docs/sessions.md`, `docs/session-format.md`,
`dist/modes/rpc/rpc-types.d.ts`, `dist/modes/rpc/rpc-client.d.ts`;
agentvm `src/index.js` (`addPortForward`), `docs/network-persistence-proposal.md`;
pi-box `src/main/{vm,ipc,workspaces}.ts`.
