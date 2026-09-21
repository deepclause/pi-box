# Running an embedded-WebGPU LLM for the pi agent

Status: **research / proposal** (no code, no model downloaded)
Scope: run a small LLM *on the host* using Electron's embedded Chromium
(WebGPU), expose it to the `pi` agent that runs *inside* the AgentVM, and let
pi use it as a model provider.

## 0. TL;DR

**It is technically feasible end-to-end**, and the plumbing is simpler than it
looks because pi-box already has two of the three pieces:

1. **Electron 44 ships Chromium 152** → WebGPU is available in the renderer
   (verified: adapter + a real compute shader ran on this machine).
2. **AgentVM maps the guest gateway IP `192.168.127.1` to host `127.0.0.1`**
   (`_openTcpConnect` in `agentvm/src/index.js`), so the guest can reach an HTTP
   server started by the Electron main process with no new port-forwarding work.
3. **pi reads custom providers from `.pi/models.json`** and supports
   `api: "openai-completions"`, so it can point at that host server directly.

The **hard part is not WebGPU, it is agentic tool calling**. WebLLM (the leading
WebGPU inference library) only enables the OpenAI `tools` protocol for five
Hermes 7–8B models. All of them need **4.0–5.8 GB VRAM**, which already exceeds
this laptop's 4 GB GTX 1050. Every small model that would fit (Qwen3 0.6–4B,
Llama 3.2 1B/3B, gemma3-1b, SmolLM2) is rejected by WebLLM when `tools` is
present. So a **tool-call shim** (prompt-based tool protocol + parser) is
required for a genuinely agentic pi session, or the local model is limited to
non-agent tasks.

**Update — there is a platform-independent alternative that solves this:**
[`@wllama/wllama`](https://github.com/ngxson/wllama) is llama.cpp's
`server-context` compiled to WASM. It ships an OpenAI-shaped API *with native
tool calling* (`tools`/`tool_choice`/`response_format`), runs **GGUF** models
directly, bundles a single 8.4 MB WASM, has **zero runtime dependencies**, and
falls back to CPU if WebGPU is unavailable. It needs no per-model MLC build and
no per-OS binary. This makes wllama the recommended primary engine over WebLLM
(see §4a).

Recommended framing:

- **Cheap next step / most reliable product:** run a native `llama-server` on
  the host and use pi's built-in `llama.cpp` provider. It gives native tool
  calling, any context size, and much better throughput. Cost: ship a
  per-platform binary.
- **The WebGPU route explored here:** zero extra native binary, one cross-
  platform code path, GPU handled by Chromium — but tool calling needs a shim
  and model/context choices are constrained.

---

## 1. What was verified on this machine

| Fact | Evidence |
| --- | --- |
| Electron `44.3.0`, Chromium `152.0.7977.78`, Node `24.20.0` | `ELECTRON_RUN_AS_NODE=1 electron -e 'console.log(process.versions)'` |
| GPU present: NVIDIA GTX 1050 Mobile (4 GB) + Intel HD 630; desktop is Wayland + XWayland | `nvidia-smi`, `lspci` |
| `navigator.gpu` exists, page is a secure context, adapters returned on both `--ozone-platform=x11` and `wayland` | offscreen `BrowserWindow` executing `navigator.gpu.requestAdapter()` |
| WebGPU **requires `--enable-unsafe-webgpu`** here; `--ignore-gpu-blocklist` alone was not enough (adapter was `null`) | four flag combinations tested |
| A real compute pipeline works: 512×512 f32 matvec returned the exact result (`1024`), 21 adapter features | WGSL compute smoke test in Electron |
| The chosen adapter does **not** expose `shader-f16` (Pascal GTX 1050) | `adapter.features.has('shader-f16') === false` |
| AgentVM gateway translation: guest → `192.168.127.1:PORT` is dialed as host → `127.0.0.1:PORT` | `const GATEWAY_IP = '192.168.127.1'` and `connectIP = (dstIP === GATEWAY_IP) ? '127.0.0.1' : dstIP` |
| AgentVM default firewall is `{ default: 'allow', rules: [] }` | `agentvm/src/index.js` |
| pi config dir is `PI_CODING_AGENT_DIR=/workspace/.pi`; custom models come from `${agentDir}/models.json` | `pi-box-app/src/main/vm.ts`, `pi-coding-agent/dist/config.js` |
| Disk is essentially full (≈365 MB free) | `df -h` — do **not** download a model now |

Practical implication of the last row: a full integration test is blocked on
disk. The plumbing can be proven without a model by serving canned OpenAI SSE
from the host.

---

## 2. Proposed architecture

```
┌────────────────────────────── Electron (host) ──────────────────────────────┐
│ main process (Node)                                                         │
│   LocalLlmService                                                            │
│     node:http server on 127.0.0.1:<port>                                     │
│       POST /v1/chat/completions   (SSE streaming, OpenAI schema)            │
│       GET  /v1/models                                                       │
│       GET  /health                                                          │
│         │  MessagePort / IPC (request + streamed chunks + abort)             │
│         ▼                                                                    │
│   hidden BrowserWindow  (renderer, backgroundThrottling:false)              │
│     Web Worker ── WebLLM (MLCEngine) ── WebGPU → GPU                        │
│       engine.chat.completions.create({stream:true, messages, tools?})      │
└──────────────────────────────────────▲──────────────────────────────────────┘
                                       │ HTTP (guest dials gateway IP)
┌──────────────────────────────────────┼──────────────────────────────────────┐
│ AgentVM guest                        │                                       │
│   pi --mode rpc  (or TUI)  ──────────┘                                       │
│     reads /workspace/.pi/models.json  → provider "pi-box-local"             │
│         baseUrl = http://192.168.127.1:<port>/v1                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

Why a **hidden window + Web Worker** rather than the existing chat renderer:

- the model stays resident even if the chat UI reloads;
- a Worker keeps token generation off the UI thread;
- `backgroundThrottling: false` avoids hidden-window throttling;
- isolation from the UI's own GPU use and failure modes.

`node:http` cannot run in a renderer, and WebGPU cannot run in the main process,
so the main↔renderer hop is unavoidable. Use a `MessagePort` (structured clone)
rather than `webContents.send` for the stream to avoid per-token IPC overhead.

### Request/response flow

1. pi sends an OpenAI `POST /v1/chat/completions` (usually `stream: true`, with
   `tools`) to `http://192.168.127.1:<port>/v1`.
2. AgentVM dials `127.0.0.1:<port>`; the main-process server authenticates the
   `Authorization: Bearer <run-token>` header.
3. Main forwards the JSON body to the hidden window.
4. The Worker calls WebLLM; main relays each OpenAI chunk back as an SSE
   `data: {...}\n\n` line, ending with `data: [DONE]\n\n`.
5. On client disconnect or `abort`, main signals the Worker to call
   `engine.interruptGenerate()` (and drops the pending request).

### Security

- Bind **only** `127.0.0.1`; the guest reaches it through the gateway mapping.
- Generate a random token per app run, pass it to pi via `.pi/models.json`'s
  `apiKey` (which also satisfies pi's "provider has auth" gate), and require it
  on every request. Any other local process then cannot use the endpoint.
- The guest's own user can reach the endpoint by design (same trust domain).

---

## 3. pi integration

pi loads `${PI_CODING_AGENT_DIR}/models.json` (`/workspace/.pi/models.json`,
which pi-box already seeds). No extension is required for a plain
OpenAI-compatible endpoint:

```json
{
  "providers": {
    "pi-box-local": {
      "baseUrl": "http://192.168.127.1:PORT/v1",
      "api": "openai-completions",
      "apiKey": "<run-token>",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsStore": false,
        "supportsStrictMode": false,
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "local-small",
          "name": "pi-box local (WebGPU)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 8192,
          "maxTokens": 2048,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Notes:

- `models.json` is reloaded each time `/model` opens, so the port/token can be
  written at VM-start time without restarting the app.
- pi's `openai-completions` client **will send `tools`** for a normal agent
  session. The host server must handle that (see §6).
- Alternative integration: pi already has a first-class `llama.cpp` provider
  (`/login llama.cpp`, `LLAMA_BASE_URL`). If the host exposes a llama.cpp-shaped
  server (including `/models`), that provider could be reused instead of
  `models.json`.

---

## 4. Inference engine: WebLLM

[`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm) `0.2.85` (~14 MB unpacked,
only dep is `loglevel`) is the best fit:

- WebGPU-native, OpenAI-compatible streaming chat API
  (`engine.chat.completions.create({ stream: true, … })`);
- dedicated `WebWorkerMLCEngine` support;
- XGrammar-backed **structured JSON generation** (`response_format` schemas) —
  useful even for a tool shim;
- model weights cached in Cache Storage / IndexedDB;
- `engine.setInitProgressCallback` / `interruptGenerate` / `resetChat`.

Known 0.2.85 constraints (read from the source, matters for an agent):

- **Native `tools` is hard-gated** by `functionCallingModelIds` in `src/config.ts`
  to `Hermes-2-Pro-Llama-3-8B`, `Hermes-2-Pro-Mistral-7B`, `Hermes-3-Llama-3.1-8B`.
  Passing `tools` for any other model **throws** in `postInitAndCheckFields`.
- Prebuilt `ModelRecord`s default to `context_window_size: 4096`. The compiled
  wasm filename suffix (`cs1k`/`cs2k`) is *not* binding — a maintainer confirmed
  the runtime overrides context, so larger windows are possible at more VRAM
  cost (see issue mlc-ai/web-llm#752).

## 4a. Platform-independent alternatives to WebLLM

First, a clarification: **WebLLM is already platform-independent** — it is a JS
package and its model `.wasm` files are fetched at runtime. Its real dependency
is on **MLC-compiled, model-specific `model_lib` artifacts**; running a model
MLC has not prebuilt means using the MLC/TVM toolchain with pinned versions
(see mlc-ai/web-llm#752). If the concern is *per-OS native binaries*, WebLLM
already qualifies. If the concern is *per-model compilation and model breadth*,
wllama and transformers.js are the alternatives.

### wllama — the strongest alternative, and it fixes the tool-calling gap

[`@wllama/wllama`](https://github.com/ngxson/wllama) `3.6.1` is llama.cpp's
`server-context` (the engine inside `llama-server`) compiled to WASM. Since
**V3** it ships a full OpenAI-shaped API and — critically — **native tool
calling for any model with a tool-call chat template** (Qwen, Llama, …), via
Jinja template parsing identical to `llama-server`:

```ts
// Runs in the renderer/Worker; OAI-shaped, from the wllama V3 guide
const stream = await wllama.createChatCompletion({
  messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
  tools, tool_choice: 'auto', stream: true, max_tokens: 256,
});
// -> chunks with choices[0].delta.tool_calls / .content, finish_reason
```

Properties that matter for pi-box:

- **No platform-specific dependency.** One 8.4 MB `wllama.wasm` is *bundled in
the npm package* (verified: `esm/wasm/wllama.wasm`, 8 457 512 bytes); the whole
package is ~19.6 MB with **zero runtime dependencies**. Fully offline-capable —
no CDN required.
- **Runs GGUF directly** (any llama.cpp-compatible quantization, from HF, URL,
or a local file). No MLC compilation step, far broader model coverage.
- **WebGPU *and* CPU fallback.** V3.1 offers a single WASM build that toggles
single/multi-threaded and WebGPU at runtime. WebGPU is enabled automatically
with all layers offloaded (`n_gpu_layers` to tune); otherwise it runs on WASM
SIMD on the CPU. So the feature degrades gracefully on machines with no usable
GPU instead of being unavailable. (WebGPU is Chrome-first; Firefox needs a flag.
Electron is Chromium, so that is fine.)
- **OAI request fields** include `tools`, `tool_choice`, `response_format`
(schema/grammar), `stream`, `chat_template_kwargs` (e.g. Qwen thinking), plus
multimodal (mmproj) input.
- Because the API is already OAI-shaped **with tool calls**, the host HTTP server
can be a near-transparent proxy — no tool-call shim is needed (contrast §6.1).

Caveats: the WebGPU backend is llama.cpp's newer `ggml-webgpu`; the WASM+WebGPU
interop is young, so throughput/op coverage needs a spike, and multi-threaded CPU
mode needs `Cross-Origin-Embedder-Policy`/`Cross-Origin-Opener-Policy` headers
(Electron can set these on its session; single-thread and WebGPU do not need
them).

### transformers.js / ONNX Runtime Web

`@huggingface/transformers` v4.3.0 runs ONNX models on WebGPU (via
`onnxruntime-web` 1.30.0), pure JS/WASM, platform-independent. It can run many
small models (Qwen, Llama, SmolLM, gemma, Phi). It does **not** ship an agent
tool protocol, so it needs the shim described in §6.1 and an ONNX-converted
model. Useful as a secondary option, but wllama dominates it for an agent.

### Not platform-independent

Native runtimes — `llama-server`/`ollama`, `node-llama-cpp`, ONNX Runtime Node —
rely on prebuilt binaries per OS/arch (and CUDA/Vulkan/Metal drivers). They are
the most capable but break the "no platform-specific dependency" requirement.

### Summary of options

| Option | Platform-independent | Tool calling | Model format | WebGPU |
| --- | :-: | :-: | :-: | :-: |
| WebLLM | yes (JS) | Hermes 7–8B only | MLC (per-model wasm) | yes |
| **wllama** | **yes (JS+WASM)** | **native, any tool template** | **GGUF** | **yes (+CPU)** |
| transformers.js / ORT-web | yes (JS+WASM) | no (shim) | ONNX | yes |
| llama-server / ollama | no | native (jinja) | GGUF | native |

With this in view, **wllama is a better primary engine than WebLLM for
pi-box**: it removes the tool-calling blocker, removes the per-model MLC build
step, keeps the "single JS dependency, GPU optional" property, and can start
with CPU-only as a universal fallback.

---

## 5. Candidate models (host VRAM / disk)

VRAM numbers are WebLLM's `vram_required_MB`; disk sizes are the sum of the HF
repo files (queried via the HF API; nothing downloaded).

| Model | VRAM | Disk | shader-f16 | Native tools |
| --- | ---: | ---: | :---: | :---: |
| SmolLM2-360M-Instruct q4f16 | 376 MB | 207 MB | required | no |
| SmolLM2-360M-Instruct q4f32 | 580 MB | ~290 MB | – | no |
| gemma3-1b-it q4f16 | 711 MB | 602 MB | – | no |
| Llama-3.2-1B-Instruct q4f16 | 879 MB | 705 MB | – | no |
| Qwen3-0.6B q4f16 | 1 403 MB | 352 MB | – | no |
| Qwen3-1.7B q4f16 | 2 037 MB | 984 MB | – | no |
| Qwen3-4B q4f16 | 3 432 MB | 2 279 MB | – | no |
| Hermes-2-Pro-Mistral-7B q4f16 | 4 033 MB | ~4 GB | required | **yes** |
| Hermes-3-Llama-3.1-8B q4f16 | 4 876 MB | ~4.7 GB | – | **yes** |

Takeaways for a 4 GB GPU:

- Qwen3-1.7B q4f16 (~2 GB) is the largest coherent chat model that fits with
  room for KV cache; Qwen3-0.6B or gemma3-1b are safer.
- On this Pascal GPU `shader-f16` is missing, so prefer q4f32 variants or models
  whose `ModelRecord` does not require it.
- **No fitting model supports native tools**, which is the crux.

Rough throughput expectations (to be measured, not verified here):
0.6B ≈ tens of tok/s, 1.7B ≈ ~10–25 tok/s on a GTX 1050; integrated GPUs are
several times slower; SwiftShader (CPU fallback) is unusable for chat.

---

## 6. The hard parts

### 6.1 Tool calling (the blocker for "agent in pi")

pi is an agent: every turn includes tool schemas, and it expects `tool_calls`
back. WebLLM rejects `tools` for every model that fits. Options:

1. **Host-side shim (recommended).** The local server accepts pi's `tools`,
   injects a compact tool protocol into the prompt (ReAct / Hermes-style text),
   lets the model answer as text, then parses the result and emits proper OpenAI
   `tool_calls` chunks. Optionally use WebLLM's JSON/grammar mode to constrain
   each single tool call to a schema. pi never knows the difference. Cost: the
   shim owns prompt design and parsing/robustness.
2. **Guest-side pi extension.** Same idea, but implemented as a pi
   `registerProvider` with a custom `streamSimple` that talks to a dumb local
   completion endpoint. Keeps the host server thin; runs glue in the (emulated,
   slow) guest.
3. **Upstream WebLLM support.** Add Qwen3 (or a generic chat-template tool path)
   to WebLLM's function-calling handling. Best long-term, but out of our hands
   and version-pinned.
4. **Don't be an agent.** Use the local model only for auxiliary work
   (titles, compaction summaries, commit messages, simple Q&A) and keep a cloud
   model for the main loop. Much lower risk, less "local agent" value.

Small-model tool-calling reliability is itself the risk: even a perfect shim
will see malformed calls from a 0.6–1.7B model. Expect retries/repair.

### 6.2 Context window

pi's system prompt plus 7 built-in tools (plus any installed extension tools)
and a growing transcript will not fit comfortably in 4 096 tokens. Mitigations:
raise `context_window_size` (8k–16k) at the cost of KV-cache VRAM, keep pi's
auto-compaction on, and prefer smaller models so the KV budget fits. This needs
empirical tuning once a model is available.

### 6.3 Hardware coverage

- macOS: Metal via Chromium — usually fine.
- Windows: D3D12 — usually fine; SwiftShader fallback is too slow.
- Linux: needs Vulkan drivers; older/integrated GPUs may need
  `--enable-unsafe-webgpu` (as on this machine) and may lack `shader-f16`.
- Ship the switches (`enable-unsafe-webgpu`, possibly `ignore-gpu-blocklist`)
  and a capability screen that disables the feature when no adapter appears.

### 6.4 Disk / model cache

Model weights live in the Electron session cache (Cache Storage or IndexedDB)
under `userData`, **not** in the workspace. Sizes are 200 MB–2.3 GB for fitting
models. A download UI with progress, cancel, size labels, and a delete/clear
action is needed. Consider pointing the cache at a user-chosen directory.

### 6.5 Concurrency and abort

The VM is single-hart and pi is meant to run one process at a time; still, the
server should serialize generation (WebLLM has one engine) and honor
`AbortSignal`/socket close with `interruptGenerate()`.

---

## 7. Alternative: native llama.cpp on the host

Given the tool-calling constraint, the pragmatic path is a host-side
`llama-server` and pi's built-in `llama.cpp` provider:

- native tool calling via `--jinja` for any tool-capable GGUF chat template;
- arbitrary context, much faster, works with CUDA/Vulkan/Metal/CPU;
- download/manage GGUFs with pi's existing `/llama` flow.
- Requires bundling/releasing a platform-specific binary (or fetching it on
  first use) and GPU driver assumptions.

A reasonable product can even do both: WebGPU for a zero-install "try it"
experience, llama.cpp for serious use.

---

## 8. Recommended phased plan

**Phase 0 — prove the pipe with zero downloads (do this first).**
1. Add a `LocalLlmService` in the main process: `127.0.0.1` HTTP server with
   `/v1/models`, `/v1/chat/completions` (SSE), `/health`, bearer-token auth.
2. Have it return a canned streamed completion (echo the last user message).
3. Seed `.pi/models.json` pointing at `http://192.168.127.1:<port>/v1`.
4. Verify inside the booted VM: `curl` the endpoint and run
   `pi --list-models`, then a `pi -p "hello"` round-trip. This validates
   gateway routing, auth, streaming framing and pi's provider plumbing for free.
5. Separately, render a small "WebGPU: available / unavailable" diagnostic using
   the already-verified adapter probe.

**Phase 1 — real inference, non-agent.**
- Add **wllama** (preferred) with a hidden window + Worker, IPC streaming, and a
  model download/init UI. Its OAI-shaped `createChatCompletion` can back the
  Phase-0 server almost directly, including `tools`.
- Start with a small GGUF: **Qwen3.5-0.8B Q4_K_M (533 MB)** or
  **Qwen3-1.7B Q4_K_M (1 107 MB)**; both support tool calling via their chat
  templates. If evaluating WebLLM instead, use **SmolLM2-360M q4f32** or
  **gemma3-1b** for a disk-safe smoke test.
- Prefer WebGPU offload (`n_gpu_layers`) with CPU fallback; gate the WebGPU path
  on adapter presence and `shader-f16` when picking a quant.
- This requires freeing disk first (currently ~365 MB free; even the 0.8B GGUF is
  533 MB).

**Phase 2 — agentic shim.**
- Implement the tool protocol shim (option 1 or 2 above) and iterate on prompt
  and parsing against pi's real tool schemas.
- Measure tok/s, tool-call validity rate, and context headroom.

**Phase 3 — decide on llama.cpp.**
- If the local agent quality is insufficient, implement the native path (or
  offer it as an option) and keep WebGPU for the no-install case.

---

## 9. Open questions / risks

- Can a 0.6–1.7B model drive pi's 7-tool loop with acceptable reliability even
  with a perfect shim? (Unknown without testing.)
- Actual throughput on GTX 1050 / Intel HD 630 / Apple Silicon / typical Windows
  GPUs.
- How much can `context_window_size` be raised before OOM on 4 GB VRAM?
- Model cache location and cleanup UX, and preloading vs. on-demand download.
- Whether pi's `openai-completions` tolerates all quirks WebLLM emits (it should
  with the `compat` block above, especially `supportsUsageInStreaming:false`).
- Licensing/redistribution of model weights (WebLLM fetches from HF at runtime,
  which sidesteps bundling).
