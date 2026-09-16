import type { RpcEvent, RpcImage } from '@shared/rpc-types'

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | {
      type: 'toolCall'
      id: string
      name: string
      argsText: string
      result?: string
      images?: Array<{ data: string; mimeType: string }>
      isError?: boolean
      running?: boolean
    }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  blocks: ChatBlock[]
  timestamp?: number
  streaming?: boolean
  pending?: boolean
  error?: string
}

export interface ChatState {
  messages: ChatMessage[]
  activeAssistantId: string | null
}

let localSeq = 0
function nextLocalId(): string {
  return `local-${++localSeq}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** Flatten a pi message content field into render blocks. */
export function blocksFromContent(content: unknown): ChatBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const blocks: ChatBlock[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (!block) continue
    if (block.type === 'text') blocks.push({ type: 'text', text: String(block.text ?? '') })
    else if (block.type === 'thinking') blocks.push({ type: 'thinking', text: String(block.thinking ?? '') })
    else if (block.type === 'image') {
      blocks.push({ type: 'image', data: String(block.data ?? ''), mimeType: String(block.mimeType ?? 'image/png') })
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'toolCall',
        id: String(block.id ?? ''),
        name: String(block.name ?? 'tool'),
        argsText: block.arguments ? JSON.stringify(block.arguments, null, 2) : ''
      })
    }
  }
  return blocks
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((raw) => {
      const block = asRecord(raw)
      if (!block) return ''
      if (block.type === 'text') return String(block.text ?? '')
      if (block.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function contentImages(content: unknown): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(content)) return []
  const images: Array<{ data: string; mimeType: string }> = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (block?.type === 'image' && typeof block.data === 'string') {
      images.push({ data: block.data, mimeType: String(block.mimeType ?? 'image/png') })
    }
  }
  return images
}

function updateToolCall(
  state: ChatState,
  toolCallId: string,
  update: (block: Extract<ChatBlock, { type: 'toolCall' }>) => Extract<ChatBlock, { type: 'toolCall' }>
): ChatState {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i]
    const index = message.blocks.findIndex((b) => b.type === 'toolCall' && b.id === toolCallId)
    if (index >= 0) {
      const blocks = message.blocks.slice()
      const block = blocks[index] as Extract<ChatBlock, { type: 'toolCall' }>
      blocks[index] = update(block)
      const messages = state.messages.slice()
      messages[i] = { ...message, blocks }
      return { ...state, messages }
    }
  }
  return state
}

function setToolRunning(state: ChatState, toolCallId: string, running: boolean): ChatState {
  return updateToolCall(state, toolCallId, (block) => ({ ...block, running }))
}

function attachToolResult(
  state: ChatState,
  toolCallId: string,
  result: string,
  isError: boolean,
  images: Array<{ data: string; mimeType: string }> = [],
  running = false
): ChatState {
  return updateToolCall(state, toolCallId, (block) => ({
    ...block,
    result,
    isError,
    running,
    images: images.length ? images : block.images
  }))
}

/** Build a transcript from a `get_entries` response. */
export function messagesFromEntries(data: unknown): ChatMessage[] {
  const entries = (asRecord(data)?.entries as unknown[]) ?? []
  if (!Array.isArray(entries)) return []
  let state: ChatState = { messages: [], activeAssistantId: null }
  for (const raw of entries) {
    const entry = asRecord(raw)
    if (!entry || entry.type !== 'message') continue
    const message = asRecord(entry.message)
    if (!message) continue
    const role = message.role
    if (role === 'user') {
      state = {
        ...state,
        messages: [
          ...state.messages,
          {
            id: String(entry.id ?? nextLocalId()),
            role: 'user',
            blocks: blocksFromContent(message.content),
            timestamp: message.timestamp as number | undefined
          }
        ]
      }
    } else if (role === 'assistant') {
      state = {
        ...state,
        messages: [
          ...state.messages,
          {
            id: String(entry.id ?? nextLocalId()),
            role: 'assistant',
            blocks: blocksFromContent(message.content),
            timestamp: message.timestamp as number | undefined,
            error: message.stopReason === 'error' ? String(message.errorMessage ?? 'error') : undefined
          }
        ]
      }
    } else if (role === 'toolResult') {
      state = attachToolResult(
        state,
        String(message.toolCallId ?? ''),
        contentToText(message.content),
        Boolean(message.isError),
        contentImages(message.content)
      )
    } else if (role === 'bashExecution') {
      state = {
        ...state,
        messages: [
          ...state.messages,
          {
            id: String(entry.id ?? nextLocalId()),
            role: 'assistant',
            blocks: [
              {
                type: 'toolCall',
                id: `bash-${entry.id ?? nextLocalId()}`,
                name: 'bash',
                argsText: String(message.command ?? ''),
                result: String(message.output ?? ''),
                isError: Number(message.exitCode ?? 0) !== 0,
                running: false
              }
            ],
            timestamp: message.timestamp as number | undefined
          }
        ]
      }
    }
  }
  return state.messages
}

/** Optimistic user message shown immediately on send. */
export function makeUserMessage(text: string, images: RpcImage[] = []): ChatMessage {
  const blocks: ChatBlock[] = []
  if (text) blocks.push({ type: 'text', text })
  for (const image of images) blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return { id: nextLocalId(), role: 'user', blocks, pending: true }
}

function updateMessage(state: ChatState, id: string, update: (message: ChatMessage) => ChatMessage): ChatState {
  const index = state.messages.findIndex((message) => message.id === id)
  if (index < 0) return state
  const messages = state.messages.slice()
  messages[index] = update(messages[index])
  return { ...state, messages }
}

function applyDelta(state: ChatState, delta: Record<string, unknown>): ChatState {
  const id = state.activeAssistantId
  if (!id) return state
  const type = String(delta.type ?? '')
  const contentIndex = typeof delta.contentIndex === 'number' ? delta.contentIndex : 0
  return updateMessage(state, id, (message) => {
    const blocks = message.blocks.slice()
    for (let i = blocks.length; i <= contentIndex; i++) blocks.push({ type: 'text', text: '' })

    if (type === 'text_start') blocks[contentIndex] = { type: 'text', text: '' }
    else if (type === 'text_delta') {
      const block = blocks[contentIndex]
      if (block.type === 'text') blocks[contentIndex] = { type: 'text', text: block.text + String(delta.delta ?? '') }
    } else if (type === 'thinking_start') blocks[contentIndex] = { type: 'thinking', text: '' }
    else if (type === 'thinking_delta') {
      const block = blocks[contentIndex]
      if (block.type === 'thinking') {
        blocks[contentIndex] = { type: 'thinking', text: block.text + String(delta.delta ?? '') }
      }
    } else if (type === 'toolcall_start') {
      blocks[contentIndex] = {
        type: 'toolCall',
        id: String(delta.id ?? ''),
        name: String(delta.toolName ?? 'tool'),
        argsText: '',
        running: true
      }
    } else if (type === 'toolcall_delta') {
      const block = blocks[contentIndex]
      if (block.type === 'toolCall') blocks[contentIndex] = { ...block, argsText: block.argsText + String(delta.delta ?? '') }
    } else if (type === 'toolcall_end') {
      const toolCall = asRecord(delta.toolCall)
      const block = blocks[contentIndex]
      if (block.type === 'toolCall' && toolCall) {
        blocks[contentIndex] = {
          ...block,
          id: String(toolCall.id ?? block.id),
          name: String(toolCall.name ?? block.name),
          argsText: toolCall.arguments ? JSON.stringify(toolCall.arguments, null, 2) : block.argsText
        }
      }
    }
    return { ...message, blocks }
  })
}

/** Apply one raw RPC event to the transcript. */
export function reduceEvent(state: ChatState, event: RpcEvent): ChatState {
  switch (event.type) {
    case 'message_start': {
      const message = asRecord(event.message)
      if (!message) return state
      const role = message.role
      if (role === 'user') {
        // Confirm an optimistic user bubble if one is pending at the tail.
        const last = state.messages[state.messages.length - 1]
        if (last?.pending && last.role === 'user') {
          const messages = state.messages.slice()
          messages[messages.length - 1] = {
            ...last,
            id: `event-${String(message.timestamp ?? nextLocalId())}`,
            pending: false
          }
          return { ...state, messages }
        }
        return {
          ...state,
          messages: [
            ...state.messages,
            {
              id: `event-${String(message.timestamp ?? nextLocalId())}`,
              role: 'user',
              blocks: blocksFromContent(message.content),
              timestamp: message.timestamp as number | undefined
            }
          ]
        }
      }
      if (role === 'assistant') {
        const id = `event-${String(message.timestamp ?? nextLocalId())}-${nextLocalId()}`
        return {
          ...state,
          activeAssistantId: id,
          messages: [
            ...state.messages,
            {
              id,
              role: 'assistant',
              blocks: blocksFromContent(message.content),
              timestamp: message.timestamp as number | undefined,
              streaming: true
            }
          ]
        }
      }
      return state
    }
    case 'message_update': {
      const delta = asRecord(event.assistantMessageEvent)
      return delta ? applyDelta(state, delta) : state
    }
    case 'message_end': {
      const message = asRecord(event.message)
      const id = state.activeAssistantId
      if (!message || !id) return state
      const role = message.role
      const next = updateMessage(state, id, (current) => ({
        ...current,
        blocks: blocksFromContent(message.content).length ? blocksFromContent(message.content) : current.blocks,
        streaming: false,
        error: message.stopReason === 'error' ? String(message.errorMessage ?? 'error') : undefined
      }))
      return role === 'assistant' ? { ...next, activeAssistantId: null } : next
    }
    case 'tool_execution_start':
      return setToolRunning(state, String(event.toolCallId ?? ''), true)
    case 'tool_execution_update': {
      const toolCallId = String(event.toolCallId ?? '')
      const partial = asRecord(event.partialResult)
      const text = partial ? contentToText(partial.content) : ''
      // Still running: keep the indicator while output streams in.
      return attachToolResult(state, toolCallId, text, false, partial ? contentImages(partial.content) : [], true)
    }
    case 'tool_execution_end': {
      const toolCallId = String(event.toolCallId ?? '')
      const result = asRecord(event.result)
      const text = result ? contentToText(result.content) : ''
      return attachToolResult(state, toolCallId, text, Boolean(event.isError), result ? contentImages(result.content) : [], false)
    }
    case 'agent_settled': {
      if (!state.activeAssistantId) return state
      const id = state.activeAssistantId
      const next = updateMessage(state, id, (message) => ({ ...message, streaming: false }))
      return { ...next, activeAssistantId: null }
    }
    default:
      return state
  }
}

function findToolMessageId(state: ChatState, toolCallId: string): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].blocks.some((b) => b.type === 'toolCall' && b.id === toolCallId)) {
      return state.messages[i].id
    }
  }
  return ''
}
