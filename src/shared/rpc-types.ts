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

export interface RpcTokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface RpcContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface RpcSessionStats {
  tokens?: RpcTokenUsage
  cost?: number
  contextUsage?: RpcContextUsage | null
}

/** Coarse state of the single live chat session. */
export interface RpcState {
  status: RpcStatus
  statusMessage?: string
  sessionId: string | null
  sessionName?: string
  sessionFile?: string
  model: RpcModelInfo | null
  thinkingLevel: string | null
  isStreaming: boolean
  isCompacting: boolean
  stats?: RpcSessionStats
}

/** A raw JSON record from the pi RPC stdout stream (event or extension_ui). */
export type RpcEvent = { type: string } & Record<string, unknown>

export type RpcStreamingBehavior = 'steer' | 'followUp'

/** Image content attached to a prompt (pi's `ImageContent`). */
export interface RpcImage {
  type: 'image'
  /** Base64 data without the `data:` prefix. */
  data: string
  mimeType: string
}

export interface RpcModelOption extends RpcModelInfo {}

/** Command available via the composer's `/` menu. */
export interface RpcCommand {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill' | 'builtin'
}

/** A session file discovered in the workspace's `.pi/sessions` directory. */
export interface RpcSessionSummary {
  /** Session id from the file header. */
  id: string
  /** Guest path (used by `switch_session` / `delete`). */
  file: string
  /** Display name if one was set. */
  name?: string
  /** First user message, used as a preview. */
  title: string
  /** Last modified time (ms). */
  updatedAt: number
  /** True for the session the live pi process currently has loaded. */
  active: boolean
}

/** Response to a blocking `extension_ui_request` dialog. */
export type RpcExtensionUIResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true }

/** A pending dialog requested by an extension. */
export interface RpcForkMessage {
  entryId: string
  text: string
}

export interface RpcTreeEntry {
  type: string
  id: string
  parentId?: string | null
  timestamp?: string | number
  message?: Record<string, unknown>
  [key: string]: unknown
}

export interface RpcTreeNode {
  entry: RpcTreeEntry
  children: RpcTreeNode[]
  label?: string
}

export interface RpcTree {
  tree: RpcTreeNode[]
  leafId: string | null
}

export interface RpcUiDialog {
  id: string
  method: 'select' | 'confirm' | 'input' | 'editor'
  title: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
}
