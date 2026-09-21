/**
 * Types for the optional local LLM provider (wllama: WebGPU/CPU inference on
 * the host, exposed to the guest's pi as an OpenAI-compatible endpoint).
 *
 * See docs/wllama-local-llm-spec.md.
 */

export type LocalLlmStatus =
  | 'unavailable'
  | 'idle'
  | 'downloading'
  | 'loading'
  | 'ready'
  | 'generating'
  | 'error'

/** Which backend serves the OpenAI-compatible endpoint. */
export type LocalLlmEngine = 'wllama' | 'llama-server'

export interface LocalModelCatalogEntry {
  /** Stable id used in pi's models.json, e.g. "local/qwen3.5-0.8b-instruct". */
  id: string
  name: string
  /** Hugging Face repo id. */
  repo: string
  /** GGUF file name inside the repo. */
  file: string
  quant: string
  approxBytes: number
  /** Default context window (n_ctx) when loading. */
  defaultContext: number
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
  libllamaVersion?: string
}

export interface LocalLlmSettings {
  enabled: boolean
  engine: LocalLlmEngine
  port: number
  token: string
  activeModelId: string | null
  nCtx: number
  /** -1 = offload all layers to the GPU; 0 = CPU only. */
  nGpuLayers: number
  modelsDir: string
  /** Absolute path to a native `llama-server` binary (llama-server engine). */
  llamaServerPath: string | null
  /** Port the native server listens on. */
  llamaServerPort: number
}

export interface LocalLlmDownload {
  modelId: string
  received: number
  total: number
}

export interface LocalLlmState {
  status: LocalLlmStatus
  enabled: boolean
  engine: LocalLlmEngine
  /** True once the wllama HTTP server is listening. */
  serverRunning: boolean
  port: number | null
  capabilities: LocalLlmCapabilities | null
  models: LocalModelInfo[]
  catalog: LocalModelCatalogEntry[]
  activeModelId: string | null
  downloads: LocalLlmDownload[]
  modelsDir: string
  nCtx: number
  nGpuLayers: number
  /** Native llama-server state. */
  llamaServerPath: string | null
  llamaServerRunning: boolean
  llamaServerPort: number | null
  llamaServerVersion?: string
  llamaServerLog?: string
  lastError?: string
}
