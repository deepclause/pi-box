import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { LocalLlmHostWindow } from './host-window'
import { LocalLlmHttpServer, type ChatEngine } from './http-server'
import { LocalModelStore } from './model-store'
import { installLocalLlmProtocol } from './asset-protocol'
import { findCatalogEntry } from './catalog'
import { writeLocalProvider } from './pi-bridge'
import { LlamaServerManager, detectLlamaServerPath, findFreePort } from './llama-server'
import type { HostToMain } from '../../shared/local-llm-ipc'
import type {
  LocalLlmCapabilities,
  LocalLlmEngine,
  LocalLlmSettings,
  LocalLlmState,
  LocalLlmStatus,
  LocalModelInfo
} from '../../shared/local-llm-types'

const DEFAULT_PORT = 8321
const DEFAULT_LLAMA_PORT = 8322
const ALL_LAYERS = -1

interface LoadWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

/** Push-based async iterable bridging host chunks to the HTTP server. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private waiters: Array<(result: IteratorResult<T>) => void> = []
  private finished = false
  private error: Error | null = null

  constructor(private readonly onClose?: () => void) {}

  push(value: T): void {
    if (this.finished) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    if (this.finished) return
    this.finished = true
    this.flush()
    this.onClose?.()
  }

  fail(error: Error): void {
    if (this.finished) return
    this.error = error
    this.finished = true
    this.flush()
    this.onClose?.()
  }

  private flush(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false })
        }
        if (this.error) return Promise.reject(this.error)
        if (this.finished) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve, reject) => {
          this.waiters.push((result) => {
            if (this.error) reject(this.error)
            else resolve(result)
          })
        })
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end()
        return Promise.resolve({ value: undefined as never, done: true })
      }
    }
  }
}

export interface LocalLlmServiceOptions {
  userDataDir: string
  onChange: (state: LocalLlmState) => void
}

export class LocalLlmService {
  private settings!: LocalLlmSettings
  private store!: LocalModelStore
  private capabilities: LocalLlmCapabilities | null = null

  private http = new LocalLlmHttpServer({
    getToken: () => this.settings.token,
    getEngine: () => this.engine,
    listModels: () => this.installedModels().map((model) => ({ id: model.id })),
    onLog: (message) => console.warn('[local-llm]', message)
  })

  private host = new LocalLlmHostWindow(
    (msg) => this.onHostMessage(msg),
    () => this.onHostGone()
  )

  private llama = new LlamaServerManager()

  private hostReady = false
  private hostInitPromise: Promise<void> | null = null
  private readyResolvers: Array<() => void> = []
  private capabilitiesWaiters: Array<(caps: LocalLlmCapabilities | null) => void> = []
  private hostStatus: 'idle' | 'loading' | 'ready' | 'generating' | 'error' | 'unavailable' = 'idle'

  private loadWaiters = new Map<string, LoadWaiter>()
  private chatStreams = new Map<string, AsyncQueue<Record<string, unknown>>>()
  private downloadControllers = new Map<string, AbortController>()
  private downloadProgress = new Map<string, { received: number; total: number }>()
  private lastProgressEmit = 0

  private currentModel: string | null = null
  private workspacePath: string | null = null
  private lastError: string | undefined
  private started = false

  constructor(private readonly options: LocalLlmServiceOptions) {}

  private get engine(): ChatEngine {
    return {
      ensureModel: (modelId) => this.ensureModel(modelId),
      streamChat: (requestId, body, signal) => this.streamChat(requestId, body, signal),
      currentModelId: () => this.currentModel,
      isReady: () => this.hostStatus === 'ready' || this.hostStatus === 'generating'
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.settings = this.loadSettings()
    this.store = new LocalModelStore(this.settings.modelsDir)
    await this.store.init()
    installLocalLlmProtocol(this.store)

    try {
      const port = await this.startServer(this.settings.port)
      if (port !== this.settings.port) {
        this.settings.port = port
        this.saveSettings()
      }
    } catch (error) {
      this.lastError = `Could not start local LLM server: ${String(error)}`
    }
    await this.syncBackends()
    this.emit()
  }

  async stop(): Promise<void> {
    for (const controller of this.downloadControllers.values()) controller.abort()
    this.downloadControllers.clear()
    await this.llama.stop().catch(() => undefined)
    await this.http.stop().catch(() => undefined)
    this.host.destroy()
    this.started = false
  }

  private async startServer(preferred: number): Promise<number> {
    let port = preferred
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await this.http.start(port)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        port += 1
      }
    }
    return await this.http.start(0)
  }

  private loadSettings(): LocalLlmSettings {
    const file = this.settingsPath()
    const defaults: LocalLlmSettings = {
      enabled: false,
      engine: 'wllama',
      port: DEFAULT_PORT,
      token: randomBytes(24).toString('hex'),
      activeModelId: null,
      nCtx: 8192,
      nGpuLayers: ALL_LAYERS,
      modelsDir: path.join(this.options.userDataDir, 'models'),
      llamaServerPath: null,
      llamaServerPort: DEFAULT_LLAMA_PORT
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LocalLlmSettings>
      return { ...defaults, ...parsed }
    } catch {
      fs.mkdirSync(this.options.userDataDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2) + '\n', { mode: 0o600 })
      return defaults
    }
  }

  private saveSettings(): void {
    fs.mkdirSync(this.options.userDataDir, { recursive: true })
    fs.writeFileSync(this.settingsPath(), JSON.stringify(this.settings, null, 2) + '\n', {
      mode: 0o600
    })
  }

  private settingsPath(): string {
    return path.join(this.options.userDataDir, 'local-llm.json')
  }

  // ---- state ---------------------------------------------------------------

  private installedModels(): LocalModelInfo[] {
    return this.store ? this.store.list().filter((model) => model.installed) : []
  }

  private recomputeStatus(): LocalLlmStatus {
    if (this.downloadProgress.size > 0) return 'downloading'
    if (this.lastError && this.hostStatus === 'error') return 'error'
    return this.hostStatus
  }

  getState(): LocalLlmState {
    return {
      status: this.recomputeStatus(),
      enabled: this.settings?.enabled ?? false,
      engine: this.settings?.engine ?? 'wllama',
      serverRunning: this.http.running,
      port: this.http.boundPort,
      capabilities: this.capabilities,
      models: this.store ? this.store.list() : [],
      catalog: this.store ? this.store.catalog() : [],
      activeModelId: this.settings?.activeModelId ?? null,
      downloads: Array.from(this.downloadProgress, ([modelId, value]) => ({
        modelId,
        received: value.received,
        total: value.total
      })),
      modelsDir: this.settings?.modelsDir ?? '',
      nCtx: this.settings?.nCtx ?? 8192,
      nGpuLayers: this.settings?.nGpuLayers ?? ALL_LAYERS,
      llamaServerPath: this.settings?.llamaServerPath ?? null,
      llamaServerRunning: this.llama.running,
      llamaServerPort: this.llama.port,
      llamaServerVersion: this.llama.version ?? undefined,
      llamaServerLog: this.llama.log || undefined,
      lastError: this.lastError
    }
  }

  private emit(): void {
    this.options.onChange(this.getState())
  }

  // ---- host window ---------------------------------------------------------

  private async ensureHost(): Promise<void> {
    if (this.hostReady) return
    if (this.hostInitPromise) return this.hostInitPromise
    this.hostInitPromise = (async () => {
      await this.host.ensure()
      const ready = new Promise<void>((resolve) => {
        if (this.hostReady) return resolve()
        this.readyResolvers.push(resolve)
      })
      this.host.send({ t: 'init', wasmUrl: 'pibox-asset://wasm/wllama.wasm' })
      await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 5000))])
    })()
    try {
      await this.hostInitPromise
    } finally {
      this.hostInitPromise = null
    }
  }

  private onHostGone(): void {
    this.hostReady = false
    this.hostStatus = 'unavailable'
    const error = new Error('Local LLM host stopped')
    for (const waiter of this.loadWaiters.values()) waiter.reject(error)
    this.loadWaiters.clear()
    for (const queue of this.chatStreams.values()) queue.fail(error)
    this.chatStreams.clear()
    this.emit()
  }

  private onHostMessage(msg: HostToMain): void {
    switch (msg.t) {
      case 'ready':
        this.hostReady = true
        for (const resolve of this.readyResolvers.splice(0)) resolve()
        break
      case 'capabilities':
        this.capabilities = msg.capabilities
        for (const resolve of this.capabilitiesWaiters.splice(0)) resolve(msg.capabilities)
        this.emit()
        break
      case 'status':
        this.hostStatus = msg.status
        if (msg.modelId !== undefined) this.currentModel = msg.modelId
        this.emit()
        break
      case 'loaded': {
        const waiter = this.loadWaiters.get(msg.requestId)
        this.loadWaiters.delete(msg.requestId)
        this.currentModel = msg.modelId
        waiter?.resolve()
        this.emit()
        break
      }
      case 'unloaded':
        this.currentModel = null
        this.emit()
        break
      case 'chunk':
        this.chatStreams.get(msg.requestId)?.push(msg.chunk as Record<string, unknown>)
        break
      case 'done':
        this.chatStreams.get(msg.requestId)?.end()
        this.chatStreams.delete(msg.requestId)
        break
      case 'error': {
        const error = new Error(msg.message)
        if (msg.requestId) {
          const waiter = this.loadWaiters.get(msg.requestId)
          if (waiter) {
            this.loadWaiters.delete(msg.requestId)
            waiter.reject(error)
          }
          this.chatStreams.get(msg.requestId)?.fail(error)
          this.chatStreams.delete(msg.requestId)
        } else {
          this.lastError = msg.message
          this.hostStatus = 'error'
        }
        this.emit()
        break
      }
      case 'log':
        if (msg.level === 'error') console.warn('[local-llm:host]', msg.message)
        break
    }
  }

  /** Probe WebGPU/CPU capabilities (lazily creates the host window). */
  async getCapabilities(): Promise<LocalLlmCapabilities | null> {
    await this.ensureHost()
    if (this.capabilities) return this.capabilities
    return new Promise((resolve) => {
      this.capabilitiesWaiters.push(resolve)
      this.host.send({ t: 'capabilities' })
      setTimeout(() => resolve(this.capabilities), 3000)
    })
  }

  // ---- engine (ChatEngine) -------------------------------------------------

  private async ensureModel(modelId: string): Promise<void> {
    if (
      this.currentModel === modelId &&
      (this.hostStatus === 'ready' || this.hostStatus === 'generating')
    ) {
      return
    }
    const info = this.store.list().find((model) => model.id === modelId)
    if (!info || !info.installed) throw new Error(`Model not installed: ${modelId}`)

    await this.ensureHost()
    const requestId = randomUUID()
    const promise = new Promise<void>((resolve, reject) => {
      this.loadWaiters.set(requestId, { resolve, reject })
    })
    this.hostStatus = 'loading'
    this.lastError = undefined
    this.emit()
    this.host.send({
      t: 'load',
      requestId,
      modelId,
      url: `pibox-asset://model/${encodeURIComponent(info.file)}`,
      params: {
        n_ctx: this.settings.nCtx,
        n_gpu_layers: this.settings.nGpuLayers,
        flash_attn: true
      }
    })
    await promise
  }

  private streamChat(
    requestId: string,
    body: Record<string, unknown>,
    signal: AbortSignal
  ): AsyncIterable<Record<string, unknown>> {
    const queue = new AsyncQueue<Record<string, unknown>>(() => {
      signal.removeEventListener('abort', onAbort)
      this.chatStreams.delete(requestId)
    })
    const onAbort = (): void => {
      this.host.send({ t: 'abort', requestId })
      queue.end()
    }
    if (signal.aborted) {
      queue.end()
      return queue
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.chatStreams.set(requestId, queue)
    this.host.send({ t: 'chat', requestId, body })
    return queue
  }

  // ---- pi integration ------------------------------------------------------

  /** Called before the VM starts so pi sees the provider immediately. */
  onWorkspace(workspacePath: string | null): void {
    this.workspacePath = workspacePath
    this.writeProvider()
  }

  private writeProvider(): void {
    if (!this.workspacePath) return
    const useLlama = this.settings.engine === 'llama-server'
    const active = this.settings.activeModelId
      ? this.installedModels().find((model) => model.id === this.settings.activeModelId)
      : undefined
    const port = useLlama ? this.settings.llamaServerPort : this.http.boundPort
    // llama-server loads one model per process, so advertise only the active one.
    const models = useLlama ? (active ? [active] : []) : this.installedModels()
    const ready = useLlama ? this.llama.running : !!this.http.boundPort
    if (this.settings.enabled && active && ready && port) {
      writeLocalProvider(this.workspacePath, {
        port,
        token: this.settings.token,
        models: models.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: this.settings.nCtx || model.defaultContext
        }))
      })
    } else {
      writeLocalProvider(this.workspacePath, null)
    }
  }

  /**
   * Start/stop/restart the native llama-server to match the selected engine,
   * active model and load parameters. A no-op for the wllama engine.
   */
  private async syncBackends(): Promise<void> {
    if (this.settings.engine !== 'llama-server') {
      await this.llama.stop().catch(() => undefined)
      this.writeProvider()
      return
    }
    const binary = this.settings.llamaServerPath
    const active = this.settings.activeModelId
      ? this.installedModels().find((model) => model.id === this.settings.activeModelId)
      : undefined
    if (!this.settings.enabled || !binary || !active) {
      await this.llama.stop().catch(() => undefined)
      this.writeProvider()
      return
    }
    const modelPath = this.store.pathForId(active.id)
    if (!modelPath) {
      this.lastError = `Model file missing for ${active.id}`
      this.writeProvider()
      return
    }
    try {
      const port = await findFreePort(this.settings.llamaServerPort)
      if (port !== this.settings.llamaServerPort) {
        this.settings.llamaServerPort = port
        this.saveSettings()
      }
      await this.llama.start({
        binary,
        modelPath,
        modelId: active.id,
        port,
        nCtx: this.settings.nCtx || active.defaultContext,
        nGpuLayers: this.settings.nGpuLayers,
        token: this.settings.token,
        onLog: (line) => console.log('[llama-server]', line)
      })
      this.lastError = undefined
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    this.writeProvider()
  }

  // ---- public actions ------------------------------------------------------

  setEnabled(enabled: boolean): LocalLlmState {
    this.settings.enabled = enabled
    this.saveSettings()
    this.writeProvider()
    this.emit()
    void this.syncBackends().then(() => this.emit())
    return this.getState()
  }

  setEngine(engine: LocalLlmEngine): LocalLlmState {
    this.settings.engine = engine
    this.saveSettings()
    this.writeProvider()
    this.emit()
    void this.syncBackends().then(() => this.emit())
    return this.getState()
  }

  setLlamaServerPath(binaryPath: string | null): LocalLlmState {
    this.settings.llamaServerPath = binaryPath
    this.saveSettings()
    this.emit()
    void this.syncBackends().then(() => this.emit())
    return this.getState()
  }

  detectLlamaServer(): LocalLlmState {
    const found = detectLlamaServerPath(this.settings.llamaServerPath)
    if (found) this.settings.llamaServerPath = found
    this.saveSettings()
    this.emit()
    return this.getState()
  }

  restartLlamaServer(): LocalLlmState {
    void this.syncBackends().then(() => this.emit())
    return this.getState()
  }

  setActiveModel(modelId: string | null): LocalLlmState {
    this.settings.activeModelId = modelId
    this.saveSettings()
    this.writeProvider()
    this.emit()
    void this.syncBackends().then(() => this.emit())
    return this.getState()
  }

  setNctx(nCtx: number): LocalLlmState {
    this.settings.nCtx = Math.max(512, Math.min(32768, Math.floor(nCtx)))
    this.saveSettings()
    this.writeProvider()
    this.emit()
    void this.syncBackends().then(() => this.emit())
    return this.getState()
  }

  setGpuLayers(layers: number): LocalLlmState {
    this.settings.nGpuLayers = Number.isFinite(layers) ? Math.floor(layers) : ALL_LAYERS
    this.saveSettings()
    this.emit()
    void this.syncBackends().then(() => this.emit())
    return this.getState()
  }

  refreshModels(): LocalLlmState {
    this.writeProvider()
    this.emit()
    return this.getState()
  }

  async download(modelId: string): Promise<LocalLlmState> {
    if (this.downloadControllers.has(modelId)) return this.getState()
    const entry = findCatalogEntry(modelId)
    if (!entry) throw new Error(`Unknown model: ${modelId}`)

    const free = await this.store.freeBytes()
    if (free < entry.approxBytes * 1.1) {
      this.lastError = `Not enough disk space for ${entry.name} (~${Math.round(
        entry.approxBytes / 1e6
      )} MB)`
      this.emit()
      throw new Error(this.lastError)
    }

    const controller = new AbortController()
    this.downloadControllers.set(modelId, controller)
    this.downloadProgress.set(modelId, { received: 0, total: entry.approxBytes })
    this.lastError = undefined
    this.emit()

    try {
      await this.store.download(entry, {
        signal: controller.signal,
        onProgress: (received, total) => {
          this.downloadProgress.set(modelId, { received, total })
          const now = Date.now()
          if (now - this.lastProgressEmit > 250) {
            this.lastProgressEmit = now
            this.emit()
          }
        }
      })
      if (!this.settings.activeModelId) this.settings.activeModelId = modelId
      this.saveSettings()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.downloadControllers.delete(modelId)
      this.downloadProgress.delete(modelId)
      this.writeProvider()
      this.emit()
    }
    return this.getState()
  }

  cancelDownload(modelId: string): LocalLlmState {
    this.downloadControllers.get(modelId)?.abort()
    return this.getState()
  }

  async remove(modelId: string): Promise<LocalLlmState> {
    if (this.currentModel === modelId) {
      this.host.send({ t: 'unload' })
      this.currentModel = null
    }
    if (this.settings.activeModelId === modelId) await this.llama.stop().catch(() => undefined)
    await this.store.remove(modelId)
    if (this.settings.activeModelId === modelId) this.settings.activeModelId = null
    this.saveSettings()
    this.writeProvider()
    void this.syncBackends().then(() => this.emit())
    this.emit()
    return this.getState()
  }
}
