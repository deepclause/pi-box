import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { RpcEvent, RpcModelInfo, RpcState, RpcStreamingBehavior } from '../shared/rpc-types'
import { PI_RPC_GUEST_PORT } from '../shared/rpc-types'
import type { VmManager } from './vm'
import type { WorkspaceStore } from './workspaces'

/** Workspace-relative location of the bridge log + readiness marker. */
const BRIDGE_LOG_REL = path.join('.pi-box', 'rpc-bridge.log')
const START_TIMEOUT_MS = 120_000

function log(message: string, ...rest: unknown[]): void {
  console.log(`[rpc ${new Date().toISOString().slice(11, 23)}] ${message}`, ...rest)
}

interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

interface PendingRequest {
  resolve: (value: RpcResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Bind an ephemeral port on the host loopback and return it. */
function allocateHostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('could not allocate a host port'))))
    })
  })
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fs.existsSync(file)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * One JSONL connection to a guest `pi --mode rpc` process. Framing is LF-only
 * (per the RPC spec): split on `\n`, strip one trailing `\r`, and never use
 * Node's readline (it also splits on U+2028/U+2029).
 */
class RpcConnection extends EventEmitter {
  private socket: net.Socket | null = null
  private buffer = ''
  private requestSeq = 0
  private pending = new Map<string, PendingRequest>()
  private closed = false

  isOpen(): boolean {
    return this.socket !== null && !this.socket.destroyed && !this.closed
  }

  async connect(hostPort: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const candidate = net.connect(hostPort, '127.0.0.1')
          candidate.once('connect', () => resolve(candidate))
          candidate.once('error', reject)
        })
        socket.setNoDelay(true)
        this.socket = socket
        this.closed = false
        socket.on('data', (chunk: Buffer) => this.handleData(chunk))
        socket.on('error', (err: Error) => this.emit('error', err))
        socket.on('close', () => this.handleClose())
        return
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(`could not connect to guest rpc bridge: ${(err as Error).message}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }

  send(command: Record<string, unknown>, timeoutMs = 600_000): Promise<RpcResponse> {
    const socket = this.socket
    if (!socket || this.closed) return Promise.reject(new Error('rpc connection is closed'))
    const id = `req-${++this.requestSeq}`
    const payload = { ...command, id }
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc command timed out: ${String(command.type)}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify(payload) + '\n')
    })
  }

  close(): void {
    this.closed = true
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.end()
      } catch {
        // ignore
      }
    }
    this.failAll(new Error('rpc connection closed'))
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) continue

      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.emit('event', { type: 'parse_error', line })
        continue
      }
      const record = message as { type?: string; id?: string }
      if (record.type === 'response' && record.id && this.pending.has(record.id)) {
        const pending = this.pending.get(record.id)!
        this.pending.delete(record.id)
        clearTimeout(pending.timer)
        pending.resolve(message as RpcResponse)
      } else if (record.type === 'response') {
        // Response for a request we no longer track; ignore.
        continue
      } else {
        this.emit('event', message as RpcEvent)
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    this.socket = null
    this.failAll(new Error('rpc socket closed'))
    this.emit('close')
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }
}

/**
 * Owns the single live pi RPC chat session for the active workspace. On demand
 * it adds a host port forward, waits for the guest bridge to be listening, and
 * speaks the RPC protocol over the resulting socket.
 */
export class RpcSessionManager extends EventEmitter {
  private connection: RpcConnection | null = null
  private hostPort: number | null = null
  private starting: Promise<RpcState> | null = null

  private stateValue: RpcState = {
    status: 'idle',
    sessionId: null,
    model: null,
    thinkingLevel: null,
    isStreaming: false
  }

  constructor(
    private readonly vm: VmManager,
    private readonly store: WorkspaceStore
  ) {
    super()
  }

  get state(): RpcState {
    return { ...this.stateValue }
  }

  private setState(patch: Partial<RpcState>): void {
    this.stateValue = { ...this.stateValue, ...patch }
    this.emit('state', this.state)
  }

  /** Ensure a live session exists, starting one if necessary. */
  async ensureSession(): Promise<RpcState> {
    if (this.connection?.isOpen()) return this.state
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInternal(): Promise<RpcState> {
    const workspace = this.store.getActive()
    if (!workspace) {
      this.setState({ status: 'error', statusMessage: 'No active workspace' })
      throw new Error('No active workspace')
    }
    // Start while the VM is still booting so the chat pi overlaps with the TUI
    // pi startup. The bridge's readiness marker only appears once the guest NIC
    // is up, so it is safe to connect as soon as the marker exists.
    if (this.vm.status === 'stopped' || this.vm.status === 'error') {
      this.setState({ status: 'error', statusMessage: 'VM is not running' })
      throw new Error('VM is not running')
    }

    this.setState({ status: 'starting', statusMessage: 'Starting pi…' })
    log(`starting session for ${workspace.path}`)

    let connection: RpcConnection | null = null
    let hostPort: number | null = null
    try {
      hostPort = await allocateHostPort()
      await this.vm.addPortForward({ hostPort, guestPort: PI_RPC_GUEST_PORT })

      // The bridge is launched by the guest startup script before tmux; wait for
      // its readiness marker so we don't connect before it is listening (an early
      // connect would be RST by the guest and kill the socket).
      const readyFile = path.join(workspace.path, BRIDGE_LOG_REL + '.ready')
      log(`waiting for bridge marker ${readyFile}`)
      await waitForFile(readyFile, 120_000)

      connection = new RpcConnection()
      connection.on('event', (event: RpcEvent) => this.handleEvent(event))
      connection.on('error', (err: Error) => {
        log('connection error:', err.message)
        this.setState({ status: 'error', statusMessage: err.message })
      })
      connection.on('close', () => {
        if (this.stateValue.status === 'ready' || this.stateValue.status === 'starting') {
          this.setState({ status: 'idle', statusMessage: 'Session closed', isStreaming: false })
        }
      })

      await connection.connect(hostPort)
      this.connection = connection
      this.hostPort = hostPort
      log('connected; requesting state (pi may take ~30s to start)')

      const response = await connection.send({ type: 'get_state' }, START_TIMEOUT_MS)
      if (!response.success) throw new Error(response.error ?? 'get_state failed')
      const data = (response.data ?? {}) as Record<string, unknown>
      const model = data.model as { provider?: string; id?: string; name?: string } | null | undefined
      this.setState({
        status: 'ready',
        statusMessage: undefined,
        sessionId: (data.sessionId as string) ?? null,
        sessionName: data.sessionName as string | undefined,
        sessionFile: data.sessionFile as string | undefined,
        model: model ? { provider: model.provider ?? '', id: model.id ?? '', name: model.name } : null,
        thinkingLevel: (data.thinkingLevel as string) ?? null,
        isStreaming: Boolean(data.isStreaming)
      })
      log(`ready (model ${this.stateValue.model?.id ?? 'none'})`)
      return this.state
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('start failed:', message)
      if (connection) connection.close()
      this.connection = null
      if (hostPort !== null) {
        try {
          this.vm.removePortForward(hostPort)
        } catch {
          // ignore
        }
      }
      this.hostPort = null
      this.setState({ status: 'error', statusMessage: message, isStreaming: false, sessionId: null })
      throw err
    }
  }

  private handleEvent(event: RpcEvent): void {
    if (event.type === 'agent_start') this.setState({ isStreaming: true })
    else if (event.type === 'agent_settled') this.setState({ isStreaming: false })
    this.emit('event', event)
  }

  async getEntries(): Promise<unknown> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'get_entries' })
    if (!response.success) throw new Error(response.error ?? 'get_entries failed')
    return response.data
  }

  async getMessages(): Promise<unknown> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'get_messages' })
    if (!response.success) throw new Error(response.error ?? 'get_messages failed')
    return response.data
  }

  async prompt(message: string, behavior?: RpcStreamingBehavior): Promise<void> {
    await this.ensureSession()
    const command: Record<string, unknown> = { type: 'prompt', message }
    if (behavior) command.streamingBehavior = behavior
    const response = await this.connection!.send(command)
    if (!response.success) throw new Error(response.error ?? 'prompt rejected')
  }

  async steer(message: string): Promise<void> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'steer', message })
    if (!response.success) throw new Error(response.error ?? 'steer rejected')
  }

  async followUp(message: string): Promise<void> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'follow_up', message })
    if (!response.success) throw new Error(response.error ?? 'follow_up rejected')
  }

  async abort(): Promise<void> {
    await this.ensureSession()
    await this.connection!.send({ type: 'abort' })
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'clear_queue' })
    const data = (response.data ?? {}) as { steering?: string[]; followUp?: string[] }
    return { steering: data.steering ?? [], followUp: data.followUp ?? [] }
  }

  async getAvailableModels(): Promise<RpcModelInfo[]> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'get_available_models' })
    const data = (response.data ?? {}) as { models?: Array<Record<string, unknown>> }
    return (data.models ?? []).map((model) => ({
      provider: String(model.provider ?? ''),
      id: String(model.id ?? ''),
      name: model.name as string | undefined,
      contextWindow: model.contextWindow as number | undefined,
      reasoning: model.reasoning as boolean | undefined
    }))
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'set_model', provider, modelId })
    if (!response.success) throw new Error(response.error ?? 'set_model failed')
    this.setState({ model: { provider, id: modelId } })
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'set_thinking_level', level })
    if (!response.success) throw new Error(response.error ?? 'set_thinking_level failed')
    this.setState({ thinkingLevel: level })
  }

  /** Close the live session (called before the VM restarts or the app quits). */
  async teardown(): Promise<void> {
    const connection = this.connection
    this.connection = null
    if (this.hostPort !== null) {
      try {
        this.vm.removePortForward(this.hostPort)
      } catch {
        // VM may already be gone
      }
      this.hostPort = null
    }
    if (connection) connection.close()
    this.setState({ status: 'idle', statusMessage: undefined, isStreaming: false, sessionId: null })
  }
}
