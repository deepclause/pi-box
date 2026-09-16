import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type {
  RpcCommand,
  RpcEvent,
  RpcExtensionUIResponse,
  RpcForkMessage,
  RpcImage,
  RpcModelInfo,
  RpcSessionStats,
  RpcSessionSummary,
  RpcState,
  RpcStreamingBehavior,
  RpcTree,
  RpcTreeNode
} from '../shared/rpc-types'
import { PI_RPC_GUEST_PORT } from '../shared/rpc-types'
import type { VmManager } from './vm'
import type { WorkspaceStore } from './workspaces'

/** Workspace-relative location of the bridge log + readiness marker. */
const BRIDGE_LOG_REL = path.join('.pi-box', 'rpc-bridge.log')
const START_TIMEOUT_MS = 120_000

function log(message: string, ...rest: unknown[]): void {
  console.log(`[rpc ${new Date().toISOString().slice(11, 23)}] ${message}`, ...rest)
}

const GUEST_SESSIONS_DIR = '/workspace/.pi/sessions'

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: string }).type === 'text'
        ? String((block as { text?: string }).text ?? '')
        : ''
    )
    .filter(Boolean)
    .join(' ')
}

/** Summarize a session JSONL for the session list. */
export function summarizeSession(hostFile: string, basename: string): RpcSessionSummary {
  let updatedAt = 0
  try {
    updatedAt = fs.statSync(hostFile).mtimeMs
  } catch {
    // ignore
  }
  const summary: RpcSessionSummary = {
    id: path.basename(basename, '.jsonl'),
    file: `${GUEST_SESSIONS_DIR}/${basename}`,
    title: 'Empty session',
    updatedAt,
    active: false
  }
  try {
    const content = fs.readFileSync(hostFile, 'utf8')
    for (const line of content.split('\n')) {
      if (!line) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (entry.type === 'session' && typeof entry.id === 'string') summary.id = entry.id
      if (typeof entry.name === 'string' && !summary.name) summary.name = entry.name
      if (entry.type === 'message' && summary.title === 'Empty session') {
        const message = entry.message as Record<string, unknown> | undefined
        if (message?.role === 'user') {
          const text = extractText(message.content).trim()
          if (text) summary.title = text.slice(0, 90)
        }
      }
    }
  } catch {
    // ignore
  }
  return summary
}

/**
 * Split a UTF-8 string stream into JSONL records. Framing is LF-only per the
 * RPC spec: split on `\n`, strip one trailing `\r`, and never use readline
 * (which also splits on U+2028/U+2029). Returns complete lines plus the
 * unterminated remainder.
 */
export function drainJsonl(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk
  const lines: string[] = []
  let start = 0
  for (;;) {
    const newline = combined.indexOf('\n', start)
    if (newline < 0) break
    let line = combined.slice(start, newline)
    start = newline + 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line) lines.push(line)
  }
  return { lines, rest: combined.slice(start) }
}

export function normalizeStats(data: unknown): RpcSessionStats {
  const record = (data ?? {}) as Record<string, unknown>
  const tokens = record.tokens as Record<string, number> | undefined
  const context = record.contextUsage as Record<string, unknown> | null | undefined
  return {
    tokens: tokens
      ? {
          input: tokens.input ?? 0,
          output: tokens.output ?? 0,
          cacheRead: tokens.cacheRead ?? 0,
          cacheWrite: tokens.cacheWrite ?? 0,
          total: tokens.total ?? tokens.totalTokens ?? 0
        }
      : undefined,
    cost: typeof record.cost === 'number' ? record.cost : undefined,
    contextUsage: context
      ? {
          tokens: (context.tokens as number | null) ?? null,
          contextWindow: (context.contextWindow as number) ?? 0,
          percent: (context.percent as number | null) ?? null
        }
      : null
  }
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
  private decoder = new TextDecoder('utf-8')
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

  /** Write a JSON record without tracking a response (extension UI, etc.). */
  write(record: Record<string, unknown>): void {
    if (!this.socket || this.closed) return
    this.socket.write(JSON.stringify(record) + '\n')
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
    const { lines, rest } = drainJsonl(this.buffer, this.decoder.decode(chunk, { stream: true }))
    this.buffer = rest
    for (const line of lines) {
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
    isStreaming: false,
    isCompacting: false
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
        isStreaming: Boolean(data.isStreaming),
        isCompacting: Boolean(data.isCompacting)
      })
      log(`ready (model ${this.stateValue.model?.id ?? 'none'})`)
      await this.refreshStats().catch(() => undefined)

      // Relaunch convenience: continue the most recent conversation when pi
      // started a fresh, empty session (like Claude Desktop).
      if (Number(data.messageCount ?? 0) === 0) {
        await this.resumeMostRecent(connection).catch(() => undefined)
      }
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
    else if (event.type === 'agent_settled') {
      this.setState({ isStreaming: false })
      void this.refreshStats().catch(() => undefined)
    } else if (event.type === 'compaction_start') this.setState({ isCompacting: true })
    else if (event.type === 'compaction_end') this.setState({ isCompacting: false })
    this.emit('event', event)
  }

  private async refreshStats(): Promise<void> {
    if (!this.connection?.isOpen()) return
    const response = await this.connection.send({ type: 'get_session_stats' })
    if (response.success) this.setState({ stats: normalizeStats(response.data) })
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

  async prompt(message: string, behavior?: RpcStreamingBehavior, images?: RpcImage[]): Promise<void> {
    await this.ensureSession()
    const command: Record<string, unknown> = { type: 'prompt', message }
    if (behavior) command.streamingBehavior = behavior
    if (images?.length) command.images = images
    const response = await this.connection!.send(command)
    if (!response.success) throw new Error(response.error ?? 'prompt rejected')
  }

  async steer(message: string, images?: RpcImage[]): Promise<void> {
    await this.ensureSession()
    const command: Record<string, unknown> = { type: 'steer', message }
    if (images?.length) command.images = images
    const response = await this.connection!.send(command)
    if (!response.success) throw new Error(response.error ?? 'steer rejected')
  }

  async followUp(message: string, images?: RpcImage[]): Promise<void> {
    await this.ensureSession()
    const command: Record<string, unknown> = { type: 'follow_up', message }
    if (images?.length) command.images = images
    const response = await this.connection!.send(command)
    if (!response.success) throw new Error(response.error ?? 'follow_up rejected')
  }

  async getTree(): Promise<RpcTree> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'get_tree' })
    if (!response.success) throw new Error(response.error ?? 'get_tree failed')
    const data = (response.data ?? {}) as { tree?: RpcTreeNode[]; leafId?: string | null }
    return { tree: data.tree ?? [], leafId: data.leafId ?? null }
  }

  async getForkMessages(): Promise<RpcForkMessage[]> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'get_fork_messages' })
    const data = (response.data ?? {}) as { messages?: Array<Record<string, unknown>> }
    return (data.messages ?? []).map((message) => ({
      entryId: String(message.entryId ?? ''),
      text: String(message.text ?? '')
    }))
  }

  /** Fork from a previous user message; returns the forked message text. */
  async fork(entryId: string): Promise<string> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'fork', entryId })
    if (!response.success) throw new Error(response.error ?? 'fork failed')
    await this.refreshState()
    return String((response.data as { text?: string } | undefined)?.text ?? '')
  }

  async clone(): Promise<void> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'clone' })
    if (!response.success) throw new Error(response.error ?? 'clone failed')
    await this.refreshState()
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

  async getSessionStats(): Promise<RpcSessionStats> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'get_session_stats' })
    const stats = response.success ? normalizeStats(response.data) : {}
    this.setState({ stats })
    return stats
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'get_available_thinking_levels' })
    const data = (response.data ?? {}) as { levels?: string[] }
    return data.levels ?? []
  }

  async getCommands(): Promise<RpcCommand[]> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'get_commands' })
    const data = (response.data ?? {}) as { commands?: Array<Record<string, unknown>> }
    return (data.commands ?? []).map((command) => ({
      name: String(command.name ?? ''),
      description: command.description as string | undefined,
      source: (command.source as RpcCommand['source']) ?? 'extension'
    }))
  }

  async setSessionName(name: string): Promise<void> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'set_session_name', name })
    if (!response.success) throw new Error(response.error ?? 'set_session_name failed')
    this.setState({ sessionName: name })
  }

  async cycleModel(): Promise<void> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'cycle_model' })
    const data = (response.data ?? null) as { model?: { provider?: string; id?: string; name?: string } } | null
    if (data?.model) {
      this.setState({
        model: { provider: data.model.provider ?? '', id: data.model.id ?? '', name: data.model.name }
      })
    }
  }

  async cycleThinkingLevel(): Promise<void> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'cycle_thinking_level' })
    const data = (response.data ?? null) as { level?: string } | null
    if (data?.level) this.setState({ thinkingLevel: data.level })
  }

  /** Switch to the most recently updated session that is not the empty one. */
  private async resumeMostRecent(connection: RpcConnection): Promise<void> {
    const sessions = await this.listSessions()
    const candidate = sessions.find((session) => !session.active && session.title !== 'Empty session')
    if (!candidate) return
    const response = await connection.send({ type: 'switch_session', sessionPath: candidate.file })
    if (!response.success || (response.data as { cancelled?: boolean } | undefined)?.cancelled) return
    await this.refreshState()
    log(`resumed most recent session ${candidate.file}`)
  }

  /** List the workspace's session files, most recently updated first. */
  async listSessions(): Promise<RpcSessionSummary[]> {
    const workspace = this.store.getActive()
    if (!workspace) return []
    const dir = path.join(workspace.path, '.pi', 'sessions')
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      return []
    }
    const activeFile = this.stateValue.sessionFile
    const summaries = files.map((name) => summarizeSession(path.join(dir, name), name))
    summaries.sort((a, b) => b.updatedAt - a.updatedAt)
    // A brand-new session has no file on disk until the first message, so add a
    // synthetic entry for the live session when it is not in the list yet.
    if (activeFile && !summaries.some((summary) => summary.file === activeFile)) {
      summaries.unshift({
        id: this.stateValue.sessionId ?? 'current',
        file: activeFile,
        name: this.stateValue.sessionName,
        title: 'New session',
        updatedAt: Date.now(),
        active: true
      })
    }
    for (const summary of summaries) summary.active = summary.file === activeFile
    return summaries
  }

  async switchSession(file: string): Promise<RpcState> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'switch_session', sessionPath: file })
    if (!response.success) throw new Error(response.error ?? 'switch_session failed')
    if ((response.data as { cancelled?: boolean } | undefined)?.cancelled) {
      throw new Error('Session switch was cancelled')
    }
    await this.refreshState()
    return this.state
  }

  async newSession(): Promise<RpcState> {
    await this.ensureSession()
    const response = await this.connection!.send({ type: 'new_session' })
    if (!response.success) throw new Error(response.error ?? 'new_session failed')
    if ((response.data as { cancelled?: boolean } | undefined)?.cancelled) {
      throw new Error('New session was cancelled')
    }
    await this.refreshState()
    return this.state
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    await this.ensureSession()
    const command: Record<string, unknown> = { type: 'export_html' }
    if (outputPath) command.outputPath = outputPath
    const response = await this.connection!.send(command)
    if (!response.success) throw new Error(response.error ?? 'export_html failed')
    return (response.data ?? { path: '' }) as { path: string }
  }

  /** Delete a session file, moving off it first if it is the live session. */
  async deleteSession(file: string): Promise<void> {
    const workspace = this.store.getActive()
    if (!workspace) return
    if (this.stateValue.sessionFile === file) await this.newSession().catch(() => undefined)
    fs.rmSync(path.join(workspace.path, '.pi', 'sessions', path.basename(file)), { force: true })
  }

  /** Reply to a blocking extension UI dialog (no response is expected). */
  respondExtensionUi(response: RpcExtensionUIResponse): void {
    this.connection?.write(response as unknown as Record<string, unknown>)
  }

  private async refreshState(): Promise<void> {
    if (!this.connection?.isOpen()) return
    const response = await this.connection.send({ type: 'get_state' })
    if (!response.success) return
    const data = (response.data ?? {}) as Record<string, unknown>
    const model = data.model as { provider?: string; id?: string; name?: string } | null | undefined
    this.setState({
      status: 'ready',
      sessionId: (data.sessionId as string) ?? null,
      sessionName: data.sessionName as string | undefined,
      sessionFile: data.sessionFile as string | undefined,
      model: model ? { provider: model.provider ?? '', id: model.id ?? '', name: model.name } : null,
      thinkingLevel: (data.thinkingLevel as string) ?? null,
      isStreaming: Boolean(data.isStreaming),
      isCompacting: Boolean(data.isCompacting)
    })
    await this.refreshStats().catch(() => undefined)
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
