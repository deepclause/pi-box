/// <reference types="@webgpu/types" />
import { Wllama, type ChatCompletionChunk } from '@wllama/wllama/esm/index.js'
import type { HostError, HostToMain, MainToHost } from '@shared/local-llm-ipc'
import type { LocalLlmCapabilities } from '@shared/local-llm-types'

interface LlmHostBridge {
  send(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): () => void
}

declare global {
  interface Window {
    llmHost: LlmHostBridge
  }
}

let wllama: Wllama | null = null
let wasmUrl: string | null = null
let currentModelId: string | null = null
let engineStatus: HostToMain & { t: 'status' } = { t: 'status', status: 'idle', modelId: null }
const aborts = new Map<string, AbortController>()

function send(msg: HostToMain): void {
  window.llmHost.send(msg)
}

function sendError(error: unknown, scope: HostError['scope'], requestId?: string): void {
  const message = error instanceof Error ? error.message : String(error)
  send({ t: 'error', requestId, scope, message })
}

function setStatus(
  status: 'idle' | 'loading' | 'ready' | 'generating' | 'error' | 'unavailable',
  modelId: string | null = currentModelId
): void {
  engineStatus = { t: 'status', status, modelId }
  send(engineStatus)
}

async function probeCapabilities(): Promise<LocalLlmCapabilities> {
  const caps: LocalLlmCapabilities = {
    webgpu: false,
    shaderF16: false,
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (adapter) {
        caps.webgpu = true
        caps.shaderF16 = adapter.features.has('shader-f16')
        caps.maxBufferSize = adapter.limits.maxBufferSize
        const info = (adapter as unknown as { info?: GPUAdapterInfo }).info
        if (info) {
          caps.adapter = {
            vendor: info.vendor,
            architecture: info.architecture,
            description: info.description
          }
        }
      }
    }
  } catch {
    // leave webgpu=false
  }
  return caps
}

// llama.cpp's WebGPU backend asserts on adapters without `shader-f16` (see
// wllama#241), so we only offload when the GPU actually provides it; otherwise
// we force wllama's supported CPU path instead of letting native abort.
let f16Promise: Promise<boolean> | null = null
function gpuHasShaderF16(): Promise<boolean> {
  if (!f16Promise) {
    f16Promise = (async () => {
      try {
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
        return !!adapter?.features.has('shader-f16')
      } catch {
        return false
      }
    })()
  }
  return f16Promise
}

function ensureEngine(): Wllama {
  if (!wllama) {
    if (!wasmUrl) throw new Error('Engine not initialised')
    wllama = new Wllama(
      { default: wasmUrl },
      { suppressNativeLog: true, allowOffline: true, logger: console }
    )
  }
  return wllama
}

async function handleInit(msg: Extract<MainToHost, { t: 'init' }>): Promise<void> {
  wasmUrl = msg.wasmUrl
  send({ t: 'ready', libllamaVersion: Wllama.getLibllamaVersion() })
  send({ t: 'capabilities', capabilities: await probeCapabilities() })
  setStatus('idle', null)
}

async function handleLoad(msg: Extract<MainToHost, { t: 'load' }>): Promise<void> {
  const engine = ensureEngine()
  if (currentModelId === msg.modelId && engine.isModelLoaded()) {
    send({ t: 'loaded', requestId: msg.requestId, modelId: msg.modelId })
    setStatus('ready', msg.modelId)
    return
  }
  if (engine.isModelLoaded()) {
    await engine.exit()
    currentModelId = null
  }
  const params = { ...msg.params }
  if (params.n_gpu_layers !== 0 && !(await gpuHasShaderF16())) {
    params.n_gpu_layers = 0
    send({
      t: 'log',
      level: 'warn',
      message:
        'GPU lacks shader-f16, which llama.cpp\'s WebGPU backend requires; loading on CPU.'
    })
    send({ t: 'capabilities', capabilities: await probeCapabilities() })
  }
  setStatus('loading', msg.modelId)
  await engine.loadModelFromUrl(msg.url, { useCache: false, ...params } as never)
  currentModelId = msg.modelId
  const ctx = engine.getLoadedContextInfo()
  send({ t: 'loaded', requestId: msg.requestId, modelId: msg.modelId, nCtx: ctx?.n_ctx })
  setStatus('ready', msg.modelId)
}

async function handleChat(msg: Extract<MainToHost, { t: 'chat' }>): Promise<void> {
  const engine = ensureEngine()
  if (!engine.isModelLoaded()) throw new Error('No model loaded')
  const controller = new AbortController()
  aborts.set(msg.requestId, controller)
  setStatus('generating', currentModelId)
  try {
    const stream = (await engine.createChatCompletion({
      ...msg.body,
      stream: true,
      abortSignal: controller.signal
    } as never)) as unknown as AsyncIterable<ChatCompletionChunk>
    for await (const chunk of stream) {
      send({ t: 'chunk', requestId: msg.requestId, chunk })
    }
    send({ t: 'done', requestId: msg.requestId })
  } finally {
    aborts.delete(msg.requestId)
    if (engineStatus.status === 'generating') setStatus('ready', currentModelId)
  }
}

async function handleUnload(): Promise<void> {
  if (wllama && wllama.isModelLoaded()) await wllama.exit()
  currentModelId = null
  send({ t: 'unloaded' })
  setStatus('idle', null)
}

async function handle(msg: MainToHost): Promise<void> {
  switch (msg.t) {
    case 'init':
      return handleInit(msg)
    case 'capabilities':
      send({ t: 'capabilities', capabilities: await probeCapabilities() })
      return
    case 'load':
      return handleLoad(msg)
    case 'chat':
      return handleChat(msg)
    case 'abort':
      aborts.get(msg.requestId)?.abort()
      return
    case 'unload':
      return handleUnload()
    case 'shutdown':
      await handleUnload().catch(() => undefined)
      window.close()
      return
  }
}

window.llmHost.onMessage((raw) => {
  const msg = raw as MainToHost
  void handle(msg).catch((error) => {
    const scope: HostError['scope'] = msg.t === 'load' ? 'load' : msg.t === 'chat' ? 'chat' : 'engine'
    const requestId =
      msg.t === 'load' || msg.t === 'chat' || msg.t === 'abort' ? msg.requestId : undefined
    if (msg.t === 'load' || msg.t === 'chat') setStatus('error', currentModelId)
    sendError(error, scope, requestId)
  })
})
