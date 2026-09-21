# Spec: Local LLM via wllama (WebGPU/CPU) for the pi agent

Status: **implemented** on branch `feat/wllama-local-llm`
Companion docs: `docs/webgpu-local-llm-research.md` (feasibility research)
Target: `pi-box-app`

## Implementation notes (what actually shipped)

- Transport is **IPC channels** (`pibox:llm:host:in` / `:out`) bridged by a
dedicated `llm-host` preload, not `MessagePort`. Same architecture, simpler
plumbing; `MessagePort` remains a possible throughput optimisation.
- The `Wllama` instance is created **lazily on first model load**; `init` only
  records the wasm URL and probes capabilities, so opening the settings panel
  does not instantiate the engine.
- `@wllama/wllama`'s published `main` entry is missing; the host page imports
  the explicit subpath `@wllama/wllama/esm/index.js`.
- Custom file import and multimodal are **not** in this pass (catalog downloads
  only).
- Verified end-to-end in Electron (Chromium 152, GTX 1050): `pibox-asset://`
  served the 8.46 MB wasm and a 1.19 MB GGUF, wllama loaded it on WebGPU and
  generated tokens with usage stats.
- **GPU gate:** llama.cpp's WebGPU backend hard-requires the adapter
  `shader-f16` feature (`GGML_ASSERT(... HasFeature(ShaderF16))`, wllama#241).
  The host page probes for it and forces `n_gpu_layers: 0` when missing, so
  models load deterministically on the CPU instead of hitting the native assert.
  The settings panel reports GPU vs CPU and why. On this dev machine the GTX
  1050 (Pascal) has `subgroups` but no `shader-f16`, and the Intel Gen9 has
  `shader-f16` but no `subgroups` / a too-large workgroup (#229), so both run on
  CPU — a hardware limitation, not an integration bug.

---

## 1. Summary

Add an optional, fully local LLM to pi-box that runs **on the host**, inside
Electron's Chromium, using [`@wllama/wllama`](https://github.com/ngxson/wllama)
(llama.cpp's `server-context` compiled to WebAssembly). The model is exposed to
the `pi` agent running inside the AgentVM as an **OpenAI-compatible HTTP
provider**, so it appears in pi's model picker like any other provider and
participates in the normal agent loop — including native tool calling.

Nothing platform-specific is shipped: wllama is a JS package with a bundled
8.4 MB `wllama.wasm`; WebGPU is provided by Chromium, and inference falls back
to CPU when WebGPU is unavailable. Models are GGUF files.

### Goals

1. Zero platform-specific binaries; one code path across macOS/Windows/Linux.
2. A local model usable for the **pi agent loop**: streaming text, tool calls,
   JSON/structured output, abort, multi-turn.
3. On-demand model download with size/progress, explicit disk management, and
   no model bundled in the installer.
4. Safe defaults: feature off until a model is installed; loopback-only server;
   bearer-token auth; graceful CPU fallback.
5. No regression to existing cloud providers or the VM/RPC path.

### Non-goals

- Training/fine-tuning, embeddings/RAG, image generation (wllama embeddings and
  multimodal exist but are out of scope for v1).
- Multiple simultaneously loaded models (one engine, one loaded model).
- Replacing cloud providers. This is an additional provider.
- Shipping model weights or auto-downloading without user action.

---

## 2. Why wllama (verified)

- **OpenAI-shaped API with native tools.** `createChatCompletion({ messages,
  tools, tool_choice, response_format, stream, abortSignal, ... })` returns
  OpenAI `ChatCompletionChunk`s (including `tool_calls` deltas) or a full
  response. Jinja chat templates are parsed exactly like `llama-server`.
- **No platform-specific dependency.** `@wllama/wllama@3.6.1` ships
  `esm/wasm/wllama.wasm` (8 457 512 bytes) inside the package, ~19.6 MB
  unpacked, **zero runtime dependencies**.
- **GGUF, no per-model compilation.** Load from URL, HF repo/quant, or a local
  file. Any GGUF.
- **WebGPU + CPU.** One WASM build toggles single/multi-thread and WebGPU at
  runtime. `n_gpu_layers` controls offload (default: all layers).
- wllama spawns its own internal module Worker from a Blob URL, so **we do not
  need to bundle a worker**; the `Wllama` instance can live on the hidden host
  page.

Key implementation constraints found while reading the source:

- `new Wllama({ default: <absolute wasm URL> }, config)`.
- `loadModelFromUrl(url, { useCache, n_ctx, n_gpu_layers, n_threads, ... })`.
- `createChatCompletion(params)` → `Promise<ChatCompletionResponse>` when
  `stream` is false; **async iterable of `ChatCompletionChunk`** when `stream`
  is true and no `onData` is given. `abortSignal` is supported.
- `exit()` frees the engine; `isSupportWebGPU()` probes capability.
- Multi-thread requires `crossOriginIsolated` (COOP+COEP + SharedArrayBuffer);
  otherwise wllama transparently runs single-threaded.

---

## 3. Architecture

```
┌──────────────────────────── Electron (host) ───────────────────────────────┐
│ main process (Node)                                                         │
│                                                                             │
│  LocalLlmService                                                            │
│   ├─ ModelStore            <userData>/models/*.gguf + index.json            │
│   ├─ HttpServer            127.0.0.1:<port>  (OpenAI-compatible)            │
│   │     /v1/models, /v1/chat/completions (SSE), /health                     │
│   ├─ AssetProtocol         pibox-asset://wasm/wllama.wasm                   │
│   │                        pibox-asset://model/<file>.gguf                  │
│   ├─ PiBridge              writes <workspace>/.pi/models.json               │
│   └─ HostWindow (hidden)   MessagePortMain ◄──────────────┐                 │
│                                                           │                 │
│                                     hidden BrowserWindow  │                 │
│                                       page: llm-host      │                 │
│                                         new Wllama(...)   │                 │
│                                         └─ internal Blob  │                 │
│                                            Worker ─ WebGPU/CPU              │
└───────────────────────────────────────────────────────────┼─────────────────┘
                                                            │
                             HTTP via gateway 192.168.127.1 ▼
┌──────────────────────────── AgentVM guest ─────────────────────────────────┐
│  pi --mode rpc   reads /workspace/.pi/models.json                          │
│                  provider "pi-box-local"                                   │
│                  baseUrl http://192.168.127.1:<port>/v1                    │
└────────────────────────────────────────────────────────────────────────────┘
```

### Why this split

- **HTTP server must be in main**: `node:http` is unavailable in a renderer, and
  the guest reaches the host through AgentVM's gateway→`127.0.0.1` translation.
- **WebGPU must be in a renderer**: wllama needs `navigator.gpu`; main has none.
- **Hidden window, not the chat window**: keeps the model resident across UI
  reloads and isolates GPU/memory from the React app. (Verified: WebGPU and a
  compute shader work in a `show:false` window.)
- **MessagePort between main and the host page**: structured-clone transport
  avoids per-token `webContents.send` overhead; the host page is trusted and
  minimal.

### Sequence (chat with tool call)

```
pi → POST /v1/chat/completions {messages, tools, stream:true}
   → HttpServer (auth, parse, pick model)
       → HostWindow.load(model) if needed
       → HostWindow.chat(requestId, body)
           → wllama.createChatCompletion({stream:true, tools,...})
               → internal worker → WebGPU/CPU
           ← chunk (delta.content / delta.tool_calls)
       ← HostWindow.chunk(requestId, chunk)
   ← res.write("data: {...}\n\n")
   ... model emits tool_calls, finish_reason:"tool_calls" ...
   ← "data: [DONE]\n\n"
pi executes the tool, calls again with role:"tool"
```

---

## 4. Components

New directory `src/main/local-llm/`, shared types in
`src/shared/local-llm-types.ts`, host page under `src/renderer/llm-host/`.

### 4.1 `shared/local-llm-types.ts`

```ts
export type LocalLlmStatus =
  | 'unavailable' | 'idle' | 'downloading' | 'loading' | 'ready' | 'generating' | 'error'

export interface LocalModelCatalogEntry {
  id: string                 // stable, e.g. "qwen3.5-0.8b-instruct"
  name: string
  repo: string               // HF repo id
  file: string               // GGUF filename in the repo
  quant: string              // e.g. "Q4_K_M"
  approxBytes: number
  defaultContext: number     // n_ctx default, e.g. 8192
  minVramMb: number
  note?: string
}

export interface LocalModelInfo extends LocalModelCatalogEntry {
  installed: boolean
  path?: string
  bytes?: number
}

export interface LocalLlmCapabilities {
  webgpu: boolean
  adapter?: { vendor?: string; architecture?: string; description?: string }
  shaderF16: boolean
  crossOriginIsolated: boolean
  maxBufferSize?: number
}

export interface LocalLlmSettings {
  enabled: boolean
  port: number
  token: string
  activeModelId: string | null
  nCtx: number
  nGpuLayers: number         // -1 = all
  modelsDir: string          // default <userData>/models
}

export interface LocalLlmState {
  status: LocalLlmStatus
  capabilities: LocalLlmCapabilities | null
  models: LocalModelInfo[]
  activeModelId: string | null
  downloads: Array<{ modelId: string; received: number; total: number }>
  lastError?: string
}
```

`AppState` (in `src/shared/types.ts`) gains `localLlm: LocalLlmState`.

### 4.2 `main/local-llm/model-store.ts` — download & disk

- `list(): LocalModelInfo[]` from `modelsDir/index.json` + file existence.
- `download(entry, onProgress, signal)`: stream
  `https://huggingface.co/<repo>/resolve/main/<file>` to
  `<modelsDir>/<file>.part`, then atomic rename. Support resume via
  `Range` on retry. Verify final byte length; optional `sha256` field.
- `remove(id)`, `pathFor(id)`, `ensureDir()`.
- Persists `index.json` (id → {file, bytes, sha256?, addedAt}).
- Downloads happen in **main** (Node `fetch`/`https`) so storage location and
  deletion are controlled, and so the renderer never needs broad network CSP.

### 4.3 `main/local-llm/asset-protocol.ts` — serve WASM and models

- Register before `app.whenReady()`:
  `protocol.registerSchemesAsPrivileged([{ scheme: 'pibox-asset', privileges: {
   standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
   stream: true } }])`.
- `protocol.handle('pibox-asset', ...)`:
  - `pibox-asset://wasm/wllama.wasm` → the packaged `wllama.wasm`.
  - `pibox-asset://model/<file>` → `<modelsDir>/<file>` with
    `Content-Type: application/octet-stream`, `Content-Length`,
    `Accept-Ranges: bytes`, `Access-Control-Allow-Origin: *`; implement Range
    for robustness.
- Resolve the wasm path: dev → `node_modules/@wllama/wllama/esm/wasm/wllama.wasm`;
  prod → `path.join(process.resourcesPath, 'wllama.wasm')` (copy via build step;
  `asar:false` already keeps files real).

### 4.4 `main/local-llm/host-window.ts` — hidden renderer + port

- Lazily create `BrowserWindow({ show:false, width:1, height:1,
  webPreferences:{ preload: <llm-host-preload>, contextIsolation:true,
  sandbox:false, backgroundThrottling:false }})`.
- Load `llm-host.html` (dev: `${ELECTRON_RENDERER_URL}/llm-host.html`;
  prod: `out/renderer/llm-host.html`).
- On `did-finish-load`, create `MessageChannelMain()`, `webContents.postMessage(
  'pibox:llm:port', null, [port1])`, keep `port2` in main. Define a small
  typed `request/response + event` protocol over the port.
- On window `closed`/`render-process-gone`, mark engine `unavailable` and fail
  pending requests.

### 4.5 `renderer/llm-host/` — the engine page

`llm-host.html` (minimal, dedicated CSP), `llm-host.ts`:

- Receive the `MessagePort` from the preload; `port.start()`.
- On `init`: `new Wllama({ default: wasmUrl }, { suppressNativeLog:true,
  logger })`; report capabilities (`isSupportWebGPU`, adapter info,
  `shaderF16` via `navigator.gpu.requestAdapter()` + `adapter.features`,
  `crossOriginIsolated`).
- `load {modelId, url, params}` → `wllama.loadModelFromUrl(url, { useCache:false,
  ...params })`; stream a synthetic progress (wllama has no byte callback, so
  emit phase updates; the actual bytes are already on disk via our protocol).
- `chat {requestId, body}` → `for await (const chunk of
  wllama.createChatCompletion({...body, stream:true, abortSignal})) port.postMessage`
  each chunk; then `done`.
- `abort {requestId}` → `AbortController.abort()`.
- `unload` → `wllama.exit()`.
- Never touches the network except `pibox-asset://`.

CSP for this page (separate `llm-host.html`, not the main app CSP):

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval' blob:;
worker-src 'self' blob:;
connect-src 'self' pibox-asset:;
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
```

`'wasm-unsafe-eval'` is required for Emscripten instantiation; `blob:` for
wllama's internal worker.

### 4.6 `main/local-llm/pi-bridge.ts` — expose to pi

Writes `<workspace>/.pi/models.json`:

```json
{
  "providers": {
    "pi-box-local": {
      "name": "pi-box local (WebGPU/CPU)",
      "baseUrl": "http://192.168.127.1:<port>/v1",
      "api": "openai-completions",
      "apiKey": "<token>",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsStore": false,
        "supportsStrictMode": false,
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        { "id": "local/qwen3.5-0.8b-instruct", "name": "Qwen3.5 0.8B (local)",
          "reasoning": false, "input": ["text"], "contextWindow": 8192,
          "maxTokens": 2048,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
      ]
    }
  }
}
```

- Merge, don't clobber: if `.pi/models.json` already exists (user-authored),
  upsert only the `pi-box-local` provider key and preserve the rest; keep a
  `.pi-box/models.local.json.bak` of the last app-written content.
- Write the file **before the VM/pi starts** (in `restartVm`) and whenever the
  model set, port, or token changes. pi reloads `models.json` on `/model`.
- Only installed models are listed. `reasoning:true` + `thinkingLevelMap` is a
  later per-model option (Qwen templates).
- The token also satisfies pi's auth gate, so the provider is selectable.

### 4.7 `main/local-llm/service.ts` — orchestrator

- Owns settings (persisted `<userData>/local-llm.json`), ModelStore,
  HostWindow, HttpServer, PiBridge.
- Public: `start()`, `stop()`, `getState()`, `getCapabilities()`,
  `download(id)`, `cancelDownload(id)`, `remove(id)`, `setActiveModel(id)`,
  `setEnabled(bool)`, `setNctx(n)`, `refreshModels()`.
- Emits state changes to the main window (`pibox:localLlm:state`).
- Picks a port: prefer configured; if busy, increment; persist the actual port.
  Writes `models.json` again if the port changed.
- Startup order in `main/index.ts`: `localLlm.start()` (register protocol already
  done pre-ready), then `restartVm()` which triggers `piBridge.write()` before
  `vm.start()`.

### 4.8 `main/local-llm/http-server.ts` — OpenAI contract

Endpoints (all require `Authorization: Bearer <token>`, else `401`):

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/health` | `{ ok, status, model }` |
| GET | `/v1/models` | installed models as `{ id, object:'model', created, owned_by:'pi-box' }` |
| POST | `/v1/chat/completions` | mapped to wllama; stream or JSON |

Request handling:

1. Parse JSON body. Reject `> MAX_BODY_BYTES` (e.g. 16 MB).
2. Resolve target model: `body.model` → catalog id; unknown → `400
   model_not_found`. If not `ready`/loaded, `load` first. If a different model is
   loaded and a request is in flight, `409` or queue (v1: serialize; reject with
   `busy` if generating).
3. Map allowed fields 1:1 to wllama: `messages, tools, tool_choice,
   response_format, temperature, max_tokens, top_p, top_k, min_p, seed,
   presence_penalty, frequency_penalty, stop?, chat_template_kwargs`.
   `stream = !!body.stream`.
4. Non-stream → `res.json(await wllama.createChatCompletion(params))`.
5. Stream → `res.writeHead(200, { 'Content-Type':'text/event-stream',
   'Cache-Control':'no-cache', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' })`
   then for each chunk `res.write('data: ' + JSON.stringify(chunk) + '\n\n')`,
   honour backpressure (`await once(res,'drain')`), and finish with
   `data: [DONE]\n\n`.
6. `req.on('close')` → send `abort{requestId}` to the host page.
7. `server.requestTimeout = 0`, `headersTimeout = 0` (long generations).
8. Heartbeat comment (`: ping\n\n`) every 15 s to keep intermediaries happy.

Because wllama already returns OpenAI-shaped chunks with `tool_calls`,
`finish_reason`, and `usage`, the server is essentially a pass-through plus
auth, model selection, and framing. No tool-call shim is needed.

Error mapping:

| Condition | HTTP | `error.type` |
| --- | --- | --- |
| bad JSON / bad params | 400 | `invalid_request_error` |
| unknown model | 404 | `model_not_found` |
| no adapter / engine unavailable | 503 | `engine_unavailable` |
| model load failed | 502 | `model_load_error` |
| generation failed | 500 | `inference_error` |
| aborted by client | (close) | — |

### 4.9 Renderer UI

New panel `LocalModelsSettings.tsx`, opened from the same place as
`ProvidersSettings` (`App.tsx` state `localModelsOpen`; a button in
`AppHeader`/providers dialog). Contents:

- Capability banner: “WebGPU: NVIDIA … (f16)” or “CPU only — slow”.
- Installed models: name, quant, size, context field, **Use** radio,
  **Delete**.
- Catalog: curated rows with size and a **Download** button + progress bar +
  cancel.
- Advanced: `n_ctx` (default 8192), `n_gpu_layers` (-1 all / 0 CPU), models
  directory (open in file manager).
- Master toggle: **Enable local model provider in pi** (writes/removes the
  provider block in `.pi/models.json`).
- “Reveal in pi”: copy the model id / show a “select provider” hint.
- Status pill (idle/loading/generating).

Wire through preload `window.pibox.localLlm.*`:
`getState, refresh, getCapabilities, download, cancelDownload, remove,
setActiveModel, setEnabled, setNctx, setGpuLayers, openModelsDir, onState`.

### 4.10 Electron flags & capability detection

- At startup in `main/index.ts`, before ready:
  `app.commandLine.appendSwitch('enable-unsafe-webgpu')` and
  `app.commandLine.appendSwitch('ignore-gpu-blocklist')` (the former was
  required to get an adapter on the test GTX 1050; harmless where WebGPU is
  already enabled).
- On Linux, optionally add `enable-features=Vulkan` if adapter is missing.
- Capability probing happens in the host page; results shown in the UI. If no
  adapter: still allow CPU (with a warning) or disable per user choice.

---

## 5. IPC protocol (main ⇄ host page)

> Implemented over two IPC channels (`pibox:llm:host:in` / `pibox:llm:host:out`)
> via the `llm-host` preload, using the typed messages below. The `MessagePort`
> alternative described in earlier drafts was not needed.

Main → host:

```
{ t:'init', wasmUrl, config }
{ t:'load', requestId, modelId, url, params }
{ t:'chat', requestId, body }
{ t:'abort', requestId }
{ t:'unload' }
{ t:'capabilities' }
{ t:'shutdown' }
```

Host → main:

```
{ t:'ready', libllamaVersion }
{ t:'capabilities', caps }
{ t:'status', status, modelId? }
{ t:'chunk', requestId, chunk }        // ChatCompletionChunk
{ t:'done', requestId }
{ t:'error', requestId?, scope:'load'|'chat'|'engine', message, code? }
{ t:'log', level, message }
```

A tiny `LocalLlmHostClient` class in main wraps the port with promise/timeout
handling and an async-iterator bridge for a request's chunks (mirrors how
`rpc.ts` frames streams). Pending requests are rejected on `error` or window
loss.

---

## 6. Model catalog (initial)

| id | repo / file | quant | size | n_ctx default | notes |
| --- | --- | --- | ---: | ---: | --- |
| `qwen3.5-0.8b-instruct` | `unsloth/Qwen3.5-0.8B-GGUF` `Qwen3.5-0.8B-Q4_K_M.gguf` | Q4_K_M | 533 MB | 8192 | tool template; recommended first |
| `qwen3-1.7b-instruct` | `unsloth/Qwen3-1.7B-GGUF` `Qwen3-1.7B-Q4_K_M.gguf` | Q4_K_M | 1 107 MB | 8192 | better quality, ~2 GB VRAM |
| `llama-3.2-3b-instruct` | `bartowski/Llama-3.2-3B-Instruct-GGUF` `…-Q4_K_M.gguf` | Q4_K_M | 2 019 MB | 8192 | needs ~3 GB VRAM |
| `smollm2-360m-instruct` | tiny GGUF | Q8_0 | ~380 MB | 4096 | smoke test / very low end |

Sizes verified via the HF API. The catalog is data, not code:
`src/main/local-llm/catalog.ts`, overridable by a user file. Custom HF
repo/quant and local `.gguf` import are supported in the UI.

Storage: default `<userData>/models/`. `modelsDir` is configurable. Show a disk
precheck before download and refuse if insufficient free space.

---

## 7. Settings & lifecycle

Persisted `<userData>/local-llm.json`:

```json
{ "enabled": false, "port": 8321, "token": "<random>", "activeModelId": null,
  "nCtx": 8192, "nGpuLayers": -1, "modelsDir": "<userData>/models" }
```

Lifecycle:

1. **Pre-ready**: register `pibox-asset` scheme; append GPU switches.
2. **Ready**: `localLlm.start()` → load settings, ensure models dir, start HTTP
   server (loopback), do **not** create the host window yet (lazy on first
   use/download).
3. **VM start / workspace switch**: `piBridge.write(activeWorkspace)` before
   `vm.start()`.
4. **First chat to the local provider**: create host window, handshake,
   load model, generate.
5. **Model change/toggle**: rewrite `models.json`; pi sees it on next `/model`
   (or we call `rpc` reconnect/set model if we want it immediate).
6. **Quit**: unload model, close host window, close server.

Feature is off by default; enabling after a model is installed flips
`models.json`.

---

## 8. Security

- HTTP server binds `127.0.0.1` only. The guest reaches it via the AgentVM
  gateway translation (`192.168.127.1` → `127.0.0.1`); no port forward needed.
- Bearer token per install, written only to `models.json` (0600) and settings
  (0600). Constant-time compare; reject missing/incorrect token with 401.
- The asset protocol serves **only** `wasm/wllama.wasm` and regular `.gguf`
  files inside `modelsDir` (path-traversal guard: resolve and check prefix).
- The host page has a restrictive CSP, no Node integration, and only talks
  `pibox-asset:`.
- Note in the UI: the local model requires **guest networking enabled** (the
  gateway route is part of the VM NIC); offline/no-network mode disables it.
- Model downloads fetch from Hugging Face over HTTPS in main; no model bytes
  ever leave the machine. The prompt/completion data never leaves the machine.

---

## 9. Packaging

- Add `@wllama/wllama` to `dependencies`.
- Copy `node_modules/@wllama/wllama/esm/wasm/wllama.wasm` to the app resources
  during build (small script or `electron-builder` `extraResources`); serve via
  `pibox-asset://wasm/wllama.wasm`.
- Renderer build: add a second HTML entry `llm-host.html` in
  `electron.vite.config.ts` (`build.rollupOptions.input`) and an alias; no
  worker bundling needed (wllama builds its own worker from a Blob).
- `asar:false` is already set, so model/wasm files remain real files.
- Do **not** bundle any GGUF in the installer.

---

## 10. Testing

**Unit (vitest, existing setup)**

- `http-server`: request→wllama param mapping; SSE framing; `[DONE]`;
  error status mapping; auth; `model_not_found`; abort propagation.
- `pi-bridge`: merge/upsert preserves a user `models.json`; writes atomically;
  only installed models listed; token/port updates.
- `model-store`: path traversal rejection; download resume/partial cleanup;
  index persistence; free-space guard.
- `asset-protocol`: resolves wasm/model URLs; Range; rejects escapes.

**Integration (Electron, headless where possible)**

- With a stub host page that echoes a canned stream, run the full HTTP contract
  and drive it with `curl`/`fetch` from the test.
- Real end-to-end on a machine with disk: download `smollm2-360m`, load on
  WebGPU (and `n_gpu_layers:0` CPU), stream a completion, exercise a tool call.
- In-VM: boot AgentVM, assert `.pi/models.json`, run `pi --list-models` and
  `pi -p "…"` against the local provider, including a tool-using prompt.

**Manual matrix**

macOS (Metal), Windows (D3D12), Linux (Vulkan) × GPU/no-GPU × Qwen/Llama ×
stream/non-stream × abort mid-generation.

---

## 11. Implementation plan

Estimates: XS ≤ 0.5d, S ≈ 1d, M ≈ 2–3d, L ≈ 4–5d.

### Phase 0 — contract spike (no model) — **~2–3 days**
- [ ] `shared/local-llm-types.ts` (S)
- [ ] `http-server.ts` with a **stub** host (canned stream) + auth + `/v1/models` (S)
- [ ] `pi-bridge.ts` writing `.pi/models.json` (S)
- [ ] Wire `localLlm.start()` + write-before-VM in `main/index.ts` (XS)
- [ ] In-VM verification: `curl http://192.168.127.1:<port>/v1/models` and a
      streamed `pi -p` round-trip against the stub (S)
- **Exit:** pi talks to a fake local provider through the gateway with correct
  SSE framing. Zero model downloads.

### Phase 1 — real wllama engine — **~4–6 days**
- [ ] Add `@wllama/wllama`; bundle/copy `wllama.wasm` (S)
- [ ] `asset-protocol.ts` + privileged scheme (S)
- [ ] `host-window.ts` + `llm-host{,.html,.ts}` + host preload; port handshake (M)
- [ ] `service.ts` orchestration, settings, port selection, lazy window (M)
- [ ] Capability probe + Electron GPU switches (S)
- [ ] Load/unload/chat/abort over the port; map to `createChatCompletion` (M)
- [ ] Verify with one small GGUF on WebGPU and CPU (S, needs disk)

### Phase 2 — downloads & UI — **~4–6 days**
- [ ] `model-store.ts` download/resume/list/delete + free-space guard (M)
- [ ] Catalog data + custom repo/local-file import (S)
- [ ] `LocalModelsSettings.tsx` + preload API + `AppState.localLlm` (M)
- [ ] State broadcasting, status pill, error surfaces (S)
- [ ] Rewrite `models.json` on toggle/model/port change; pi `/model` shows it (S)

### Phase 3 — agent hardening — **~3–4 days**
- [ ] Serialize generation; `busy` handling; queue or reject (S)
- [ ] Abort on client disconnect + cleanup; timeouts (S)
- [ ] Usage passthrough; `stream_options.include_usage` (S)
- [ ] Tool-call and JSON-schema end-to-end tests (M)
- [ ] Handle model-switch while pi session live (reconnect/`set_model`) (S)
- [ ] Context/VRAM defaults per model; f16/quant guard (S)

### Phase 4 — quality & packaging — **~3–4 days**
- [ ] Unit + integration tests (M)
- [ ] electron-builder resource wiring; CI build check (S)
- [ ] Docs: user guide, troubleshooting (no adapter, CPU slow, disk) (S)
- [ ] Cross-platform manual matrix (M)

**Total: roughly 3–4 weeks of focused work; a working internal spike in
Phase 0–1 (under a week, excluding model download time).**

---

## 12. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| WASM+WebGPU backend immaturity / crashes | Med | High | Spike first; CPU fallback; pin wllama version; surface errors clearly |
| CPU-only performance unusable | Med | Med | Warn in UI; recommend small models; WebGPU-first |
| Small models drive pi's tool loop poorly | Med | High | Start at ≥1.7B; validate against pi's real tools; document limits; cloud fallback |
| GPU blocklisted / no adapter | Med | Med | `enable-unsafe-webgpu` + `ignore-gpu-blocklist`; capability screen; CPU mode |
| `shader-f16` absent (older GPUs) | Med | Low | Prefer Q4_K_M (does not require f16 in wllama path) |
| Multi-thread needs COOP/COEP; conflicts with cross-origin fetch | Low | Med | Single-thread default (WebGPU still used); add COOP/COEP only if needed after routing downloads through main |
| Disk usage / full disk | High here | Med | Explicit download, size labels, free-space guard, delete; nothing bundled |
| `models.json` clobbering user config | Low | High | Upsert-only merge with backup |
| CSP blocks wasm/worker | Med | High | Dedicated host-page CSP with `wasm-unsafe-eval`/`blob:`; test early |
| Port/token churn across restarts | Low | Med | Persist both; rewrite `models.json` before VM starts |
| Electron/Chromium update changes WebGPU | Low | Med | Capability probe each launch; feature flag |

---

## 13. Open questions

1. Which exact GGUF tool templates work best with pi's tool schemas at 0.8–1.7B?
2. Default `n_ctx` vs. VRAM: 4096/8192/16384 — needs measurement per GPU class.
3. Should the local provider be exposed as one `pibox-local` model id (simpler)
   or one id per installed model (nicer picker)? Spec assumes per-model ids.
4. Immediate model switch mid-pi-session: auto-reconnect RPC or require the user
   to pick in pi?
5. Do we want CPU-only to be selectable on capable machines (privacy/battery)?
6. Should we support wllama multimodal/embeddings later for image attachments /
   repo search?

---

## Appendix A — wllama usage sketch (host page)

```ts
import { Wllama, LogLevel, type ChatCompletionChunk } from '@wllama/wllama'

const wllama = new Wllama(
  { default: 'pibox-asset://wasm/wllama.wasm' },
  { suppressNativeLog: true, allowOffline: true }
)

await wllama.loadModelFromUrl('pibox-asset://model/Qwen3.5-0.8B-Q4_K_M.gguf', {
  useCache: false,      // main owns the file; don't duplicate into Cache API
  n_ctx: 8192,
  n_gpu_layers: -1,     // all layers; 0 = CPU
  // n_threads: 4,
  flash_attn: true
})

const ac = new AbortController()
const iter = (await wllama.createChatCompletion({
  messages, tools, tool_choice: 'auto',
  stream: true, max_tokens: 2048, temperature: 0.7,
  abortSignal: ac.signal
})) as AsyncIterable<ChatCompletionChunk>

for await (const chunk of iter) port.postMessage({ t: 'chunk', requestId, chunk })
port.postMessage({ t: 'done', requestId })
```

## Appendix B — pi `models.json` path

`PI_CODING_AGENT_DIR=/workspace/.pi` (set in `VmManager.buildStartupScript`),
and pi resolves custom models at `${PI_CODING_AGENT_DIR}/models.json`, i.e.
`<workspace>/.pi/models.json` on the host. No extension or pi change required.
