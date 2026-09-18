import { contextBridge, ipcRenderer, shell } from 'electron'
import type { AppState, AttachFileResult, FbFrame, FbSnapshot, FileNode, FirewallRule, OpenResult } from '../shared/types'
import type {
  AuthEventMessage,
  AuthLoginResult,
  AuthMethod,
  AuthPromptRequest,
  AuthPromptResponse,
  AuthProviderInfo,
  AuthSessionHandle,
  AuthStatus
} from '../shared/auth-types'
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
  RpcTree
} from '../shared/rpc-types'

export interface PiBoxRpcApi {
  getState(): Promise<RpcState>
  open(): Promise<RpcState>
  getEntries(): Promise<unknown>
  prompt(message: string, behavior?: RpcStreamingBehavior, images?: RpcImage[]): Promise<RpcState>
  steer(message: string, images?: RpcImage[]): Promise<RpcState>
  followUp(message: string, images?: RpcImage[]): Promise<RpcState>
  abort(): Promise<RpcState>
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>
  getAvailableModels(): Promise<RpcModelInfo[]>
  setModel(provider: string, modelId: string): Promise<RpcState>
  setThinkingLevel(level: string): Promise<RpcState>
  cycleModel(): Promise<RpcState>
  cycleThinkingLevel(): Promise<RpcState>
  getSessionStats(): Promise<RpcSessionStats>
  getAvailableThinkingLevels(): Promise<string[]>
  getCommands(): Promise<RpcCommand[]>
  setSessionName(name: string): Promise<RpcState>
  listSessions(): Promise<RpcSessionSummary[]>
  newSession(): Promise<RpcState>
  switchSession(file: string): Promise<RpcState>
  deleteSession(file: string): Promise<RpcState>
  exportHtml(outputPath?: string): Promise<{ path: string }>
  getForkMessages(): Promise<RpcForkMessage[]>
  getTree(): Promise<RpcTree>
  reconnect(): Promise<RpcState>
  fork(entryId: string): Promise<{ state: RpcState; text: string }>
  clone(): Promise<RpcState>
  respondExtensionUi(response: RpcExtensionUIResponse): void
  onEvent(cb: (event: RpcEvent) => void): () => void
  onState(cb: (state: RpcState) => void): () => void
}

export interface PiBoxAuthApi {
  providers(): Promise<AuthProviderInfo[]>
  status(): Promise<AuthStatus[]>
  login(providerId: string, method: AuthMethod): Promise<AuthSessionHandle>
  logout(providerId: string): Promise<AuthStatus[]>
  respond(response: AuthPromptResponse): void
  cancel(sessionId: string): void
  onPrompt(cb: (request: AuthPromptRequest) => void): () => void
  onEvent(cb: (message: AuthEventMessage) => void): () => void
  onDone(cb: (result: AuthLoginResult) => void): () => void
  onStatus(cb: (status: AuthStatus[]) => void): () => void
}

export interface PiBoxFbApi {
  /** Latest full frame (BGRA), or null before the first frame. */
  get(): Promise<FbSnapshot | null>
  /** Launch a program in the guest (backgrounded); returns when it has started. */
  run(command: string): Promise<boolean>
  /** Stop the program launched by run(). */
  stop(): Promise<boolean>
  /** Keyboard event: a key name (e.g. 'ArrowLeft') or a raw evdev keycode. */
  key(code: string | number, down: boolean): void
  /** Pointer event in framebuffer pixels (1=left, 2=right, 4=middle). */
  mouse(x: number, y: number, buttons: number): void
  onFrame(cb: (frame: FbFrame) => void): () => void
}

export interface PiBoxApi {
  getState(): Promise<AppState>
  setOnboardingDone(done: boolean): Promise<AppState>
  restart(): Promise<AppState>
  editFile(workspaceId: string, hostPath: string): Promise<OpenResult>
  addWorkspace(): Promise<AppState>
  removeWorkspace(id: string): Promise<AppState>
  setActiveWorkspace(id: string): Promise<AppState>
  openFolder(id: string): Promise<OpenResult>
  readTree(id: string, dirPath?: string): Promise<FileNode[]>
  attachFile(name: string, bytes: Uint8Array): Promise<AttachFileResult>
  fb: PiBoxFbApi
  termInput(data: string): void
  termResize(cols: number, rows: number): void
  clipboardReadText(): Promise<string>
  clipboardWriteText(text: string): Promise<void>
  openExternal(url: string): void
  platform: string
  toggleNetwork(): Promise<AppState>
  addFirewallRule(rule: FirewallRule): Promise<AppState>
  removeFirewallRule(id: string): Promise<AppState>
  clearFirewall(): Promise<AppState>
  addPortForward(config: { hostPort: number; guestPort: number; guestHost?: string }): Promise<AppState>
  removePortForward(hostPort: number): Promise<AppState>
  onState(cb: (state: AppState) => void): () => void
  onOutput(cb: (data: string) => void): () => void
  rpc: PiBoxRpcApi
  auth: PiBoxAuthApi
}

const api: PiBoxApi = {
  getState: () => ipcRenderer.invoke('pibox:getState'),
  setOnboardingDone: (done) => ipcRenderer.invoke('pibox:setOnboardingDone', done),
  restart: () => ipcRenderer.invoke('pibox:restartVm'),
  editFile: (workspaceId, hostPath) => ipcRenderer.invoke('pibox:editFile', workspaceId, hostPath),
  addWorkspace: () => ipcRenderer.invoke('pibox:addWorkspace'),
  removeWorkspace: (id) => ipcRenderer.invoke('pibox:removeWorkspace', id),
  setActiveWorkspace: (id) => ipcRenderer.invoke('pibox:setActiveWorkspace', id),
  openFolder: (id) => ipcRenderer.invoke('pibox:openFolder', id),
  readTree: (id, dirPath) => ipcRenderer.invoke('pibox:readTree', id, dirPath),
  attachFile: (name, bytes) => ipcRenderer.invoke('pibox:attachFile', name, bytes),

  fb: {
    get: () => ipcRenderer.invoke('pibox:fb:get'),
    run: (command) => ipcRenderer.invoke('pibox:fb:run', command),
    stop: () => ipcRenderer.invoke('pibox:fb:stop'),
    key: (code, down) => ipcRenderer.send('pibox:fb:key', code, down),
    mouse: (x, y, buttons) => ipcRenderer.send('pibox:fb:mouse', x, y, buttons),
    onFrame: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, frame: FbFrame): void => cb(frame)
      ipcRenderer.on('pibox:fb:frame', listener)
      return () => ipcRenderer.removeListener('pibox:fb:frame', listener)
    }
  },
  termInput: (data) => ipcRenderer.send('pibox:termInput', data),
  termResize: (cols, rows) => ipcRenderer.send('pibox:termResize', cols, rows),
  clipboardReadText: () => ipcRenderer.invoke('pibox:clipboardReadText'),
  clipboardWriteText: (text) => ipcRenderer.invoke('pibox:clipboardWriteText', text),
  openExternal: (url) => {
    void shell.openExternal(url)
  },
  platform: process.platform,
  toggleNetwork: () => ipcRenderer.invoke('pibox:toggleNetwork'),
  addFirewallRule: (rule) => ipcRenderer.invoke('pibox:addFirewallRule', rule),
  removeFirewallRule: (id) => ipcRenderer.invoke('pibox:removeFirewallRule', id),
  clearFirewall: () => ipcRenderer.invoke('pibox:clearFirewall'),
  addPortForward: (config) => ipcRenderer.invoke('pibox:addPortForward', config),
  removePortForward: (hostPort) => ipcRenderer.invoke('pibox:removePortForward', hostPort),

  onState: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState): void => cb(state)
    ipcRenderer.on('pibox:state', listener)
    return () => ipcRenderer.removeListener('pibox:state', listener)
  },

  onOutput: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, data: string): void => cb(data)
    ipcRenderer.on('pibox:output', listener)
    return () => ipcRenderer.removeListener('pibox:output', listener)
  },

  rpc: {
    getState: () => ipcRenderer.invoke('pibox:rpc:state'),
    open: () => ipcRenderer.invoke('pibox:rpc:open'),
    getEntries: () => ipcRenderer.invoke('pibox:rpc:getEntries'),
    prompt: (message, behavior, images) => ipcRenderer.invoke('pibox:rpc:prompt', message, behavior, images),
    steer: (message, images) => ipcRenderer.invoke('pibox:rpc:steer', message, images),
    followUp: (message, images) => ipcRenderer.invoke('pibox:rpc:followUp', message, images),
    abort: () => ipcRenderer.invoke('pibox:rpc:abort'),
    clearQueue: () => ipcRenderer.invoke('pibox:rpc:clearQueue'),
    getAvailableModels: () => ipcRenderer.invoke('pibox:rpc:getAvailableModels'),
    setModel: (provider, modelId) => ipcRenderer.invoke('pibox:rpc:setModel', provider, modelId),
    setThinkingLevel: (level) => ipcRenderer.invoke('pibox:rpc:setThinkingLevel', level),
    cycleModel: () => ipcRenderer.invoke('pibox:rpc:cycleModel'),
    cycleThinkingLevel: () => ipcRenderer.invoke('pibox:rpc:cycleThinkingLevel'),
    getSessionStats: () => ipcRenderer.invoke('pibox:rpc:getSessionStats'),
    getAvailableThinkingLevels: () => ipcRenderer.invoke('pibox:rpc:getAvailableThinkingLevels'),
    getCommands: () => ipcRenderer.invoke('pibox:rpc:getCommands'),
    setSessionName: (name) => ipcRenderer.invoke('pibox:rpc:setSessionName', name),
    listSessions: () => ipcRenderer.invoke('pibox:rpc:listSessions'),
    newSession: () => ipcRenderer.invoke('pibox:rpc:newSession'),
    switchSession: (file) => ipcRenderer.invoke('pibox:rpc:switchSession', file),
    deleteSession: (file) => ipcRenderer.invoke('pibox:rpc:deleteSession', file),
    exportHtml: (outputPath) => ipcRenderer.invoke('pibox:rpc:exportHtml', outputPath),
    getForkMessages: () => ipcRenderer.invoke('pibox:rpc:getForkMessages'),
    getTree: () => ipcRenderer.invoke('pibox:rpc:getTree'),
    reconnect: () => ipcRenderer.invoke('pibox:rpc:reconnect'),
    fork: (entryId) => ipcRenderer.invoke('pibox:rpc:fork', entryId),
    clone: () => ipcRenderer.invoke('pibox:rpc:clone'),
    respondExtensionUi: (response) => ipcRenderer.send('pibox:rpc:extensionUi', response),

    onEvent: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RpcEvent): void => cb(payload)
      ipcRenderer.on('pibox:rpc:event', listener)
      return () => ipcRenderer.removeListener('pibox:rpc:event', listener)
    },

    onState: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RpcState): void => cb(payload)
      ipcRenderer.on('pibox:rpc:state', listener)
      return () => ipcRenderer.removeListener('pibox:rpc:state', listener)
    }
  },

  auth: {
    providers: () => ipcRenderer.invoke('pibox:auth:providers'),
    status: () => ipcRenderer.invoke('pibox:auth:status'),
    login: (providerId, method) => ipcRenderer.invoke('pibox:auth:login', providerId, method),
    logout: (providerId) => ipcRenderer.invoke('pibox:auth:logout', providerId),
    respond: (response) => ipcRenderer.send('pibox:auth:respond', response),
    cancel: (sessionId) => ipcRenderer.send('pibox:auth:cancel', sessionId),

    onPrompt: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AuthPromptRequest): void => cb(payload)
      ipcRenderer.on('pibox:auth:prompt', listener)
      return () => ipcRenderer.removeListener('pibox:auth:prompt', listener)
    },

    onEvent: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AuthEventMessage): void => cb(payload)
      ipcRenderer.on('pibox:auth:event', listener)
      return () => ipcRenderer.removeListener('pibox:auth:event', listener)
    },

    onDone: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AuthLoginResult): void => cb(payload)
      ipcRenderer.on('pibox:auth:done', listener)
      return () => ipcRenderer.removeListener('pibox:auth:done', listener)
    },

    onStatus: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AuthStatus[]): void => cb(payload)
      ipcRenderer.on('pibox:auth:status', listener)
      return () => ipcRenderer.removeListener('pibox:auth:status', listener)
    }
  }
}

contextBridge.exposeInMainWorld('pibox', api)
