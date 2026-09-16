import { contextBridge, ipcRenderer, shell } from 'electron'
import type { AppState, FileNode, FirewallRule, OpenResult } from '../shared/types'
import type {
  RpcCommand,
  RpcEvent,
  RpcExtensionUIResponse,
  RpcModelInfo,
  RpcSessionStats,
  RpcSessionSummary,
  RpcState,
  RpcStreamingBehavior
} from '../shared/rpc-types'

export interface PiBoxRpcApi {
  getState(): Promise<RpcState>
  open(): Promise<RpcState>
  getEntries(): Promise<unknown>
  prompt(message: string, behavior?: RpcStreamingBehavior): Promise<RpcState>
  steer(message: string): Promise<RpcState>
  followUp(message: string): Promise<RpcState>
  abort(): Promise<RpcState>
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>
  getAvailableModels(): Promise<RpcModelInfo[]>
  setModel(provider: string, modelId: string): Promise<RpcState>
  setThinkingLevel(level: string): Promise<RpcState>
  cycleModel(): Promise<RpcState>
  getSessionStats(): Promise<RpcSessionStats>
  getAvailableThinkingLevels(): Promise<string[]>
  getCommands(): Promise<RpcCommand[]>
  setSessionName(name: string): Promise<RpcState>
  listSessions(): Promise<RpcSessionSummary[]>
  newSession(): Promise<RpcState>
  switchSession(file: string): Promise<RpcState>
  deleteSession(file: string): Promise<RpcState>
  respondExtensionUi(response: RpcExtensionUIResponse): void
  onEvent(cb: (event: RpcEvent) => void): () => void
  onState(cb: (state: RpcState) => void): () => void
}

export interface PiBoxApi {
  getState(): Promise<AppState>
  restart(): Promise<AppState>
  editFile(workspaceId: string, hostPath: string): Promise<OpenResult>
  addWorkspace(): Promise<AppState>
  removeWorkspace(id: string): Promise<AppState>
  setActiveWorkspace(id: string): Promise<AppState>
  openFolder(id: string): Promise<OpenResult>
  readTree(id: string, dirPath?: string): Promise<FileNode[]>
  termInput(data: string): void
  startPiTui(): void
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
}

const api: PiBoxApi = {
  getState: () => ipcRenderer.invoke('pibox:getState'),
  restart: () => ipcRenderer.invoke('pibox:restartVm'),
  editFile: (workspaceId, hostPath) => ipcRenderer.invoke('pibox:editFile', workspaceId, hostPath),
  addWorkspace: () => ipcRenderer.invoke('pibox:addWorkspace'),
  removeWorkspace: (id) => ipcRenderer.invoke('pibox:removeWorkspace', id),
  setActiveWorkspace: (id) => ipcRenderer.invoke('pibox:setActiveWorkspace', id),
  openFolder: (id) => ipcRenderer.invoke('pibox:openFolder', id),
  readTree: (id, dirPath) => ipcRenderer.invoke('pibox:readTree', id, dirPath),
  termInput: (data) => ipcRenderer.send('pibox:termInput', data),
  startPiTui: () => ipcRenderer.send('pibox:startPiTui'),
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
    prompt: (message, behavior) => ipcRenderer.invoke('pibox:rpc:prompt', message, behavior),
    steer: (message) => ipcRenderer.invoke('pibox:rpc:steer', message),
    followUp: (message) => ipcRenderer.invoke('pibox:rpc:followUp', message),
    abort: () => ipcRenderer.invoke('pibox:rpc:abort'),
    clearQueue: () => ipcRenderer.invoke('pibox:rpc:clearQueue'),
    getAvailableModels: () => ipcRenderer.invoke('pibox:rpc:getAvailableModels'),
    setModel: (provider, modelId) => ipcRenderer.invoke('pibox:rpc:setModel', provider, modelId),
    setThinkingLevel: (level) => ipcRenderer.invoke('pibox:rpc:setThinkingLevel', level),
    cycleModel: () => ipcRenderer.invoke('pibox:rpc:cycleModel'),
    getSessionStats: () => ipcRenderer.invoke('pibox:rpc:getSessionStats'),
    getAvailableThinkingLevels: () => ipcRenderer.invoke('pibox:rpc:getAvailableThinkingLevels'),
    getCommands: () => ipcRenderer.invoke('pibox:rpc:getCommands'),
    setSessionName: (name) => ipcRenderer.invoke('pibox:rpc:setSessionName', name),
    listSessions: () => ipcRenderer.invoke('pibox:rpc:listSessions'),
    newSession: () => ipcRenderer.invoke('pibox:rpc:newSession'),
    switchSession: (file) => ipcRenderer.invoke('pibox:rpc:switchSession', file),
    deleteSession: (file) => ipcRenderer.invoke('pibox:rpc:deleteSession', file),
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
  }
}

contextBridge.exposeInMainWorld('pibox', api)
