/**
 * Types shared between the main process and the renderer for the pi RPC chat
 * feature. See docs/pi-rpc-ui-design.md.
 */

/** Guest TCP port the workspace's pi RPC bridge listens on. */
export const PI_RPC_GUEST_PORT = 7100

export type RpcStatus = 'idle' | 'starting' | 'ready' | 'error'

export interface RpcModelInfo {
  provider: string
  id: string
  name?: string
  contextWindow?: number
  reasoning?: boolean
}

/** Coarse state of the single live chat session (Phase 1). */
export interface RpcState {
  status: RpcStatus
  statusMessage?: string
  sessionId: string | null
  sessionName?: string
  sessionFile?: string
  model: RpcModelInfo | null
  thinkingLevel: string | null
  isStreaming: boolean
}

/** A raw JSON record from the pi RPC stdout stream (event or extension_ui). */
export type RpcEvent = { type: string } & Record<string, unknown>

export type RpcStreamingBehavior = 'steer' | 'followUp'

/** Command available via the composer's `/` menu. */
export interface RpcCommand {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
}
