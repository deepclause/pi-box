import type { LocalLlmCapabilities } from './local-llm-types'

/**
 * Messages exchanged between the Electron main process and the hidden host
 * page that runs wllama. Transported over IPC channels
 * (`pibox:llm:host:in` / `pibox:llm:host:out`), bridged by the dedicated
 * `llm-host` preload.
 */

export interface HostInit {
  t: 'init'
  wasmUrl: string
}

export interface HostLoad {
  t: 'load'
  requestId: string
  modelId: string
  url: string
  params: Record<string, unknown>
}

export interface HostChat {
  t: 'chat'
  requestId: string
  body: Record<string, unknown>
}

export interface HostAbort {
  t: 'abort'
  requestId: string
}

export interface HostUnload {
  t: 'unload'
}

export interface HostCapabilitiesRequest {
  t: 'capabilities'
}

export interface HostShutdown {
  t: 'shutdown'
}

export type MainToHost =
  | HostInit
  | HostLoad
  | HostChat
  | HostAbort
  | HostUnload
  | HostCapabilitiesRequest
  | HostShutdown

export interface HostReady {
  t: 'ready'
  libllamaVersion?: string
}

export interface HostCapabilitiesMessage {
  t: 'capabilities'
  capabilities: LocalLlmCapabilities
}

export interface HostStatus {
  t: 'status'
  status: 'idle' | 'loading' | 'ready' | 'generating' | 'error' | 'unavailable'
  modelId?: string | null
}

export interface HostLoaded {
  t: 'loaded'
  requestId: string
  modelId: string
  nCtx?: number
}

export interface HostUnloaded {
  t: 'unloaded'
}

export interface HostChunk {
  t: 'chunk'
  requestId: string
  chunk: unknown
}

export interface HostDone {
  t: 'done'
  requestId: string
}

export interface HostError {
  t: 'error'
  requestId?: string
  scope: 'load' | 'chat' | 'engine'
  message: string
  code?: string
}

export interface HostLog {
  t: 'log'
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

export type HostToMain =
  | HostReady
  | HostCapabilitiesMessage
  | HostStatus
  | HostLoaded
  | HostUnloaded
  | HostChunk
  | HostDone
  | HostError
  | HostLog
