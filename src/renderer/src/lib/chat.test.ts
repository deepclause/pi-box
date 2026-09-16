import { describe, expect, it } from 'vitest'
import { blocksFromContent, makeUserMessage, messagesFromEntries, reduceEvent, type ChatState } from './chat'

const empty = (): ChatState => ({ messages: [], activeAssistantId: null })

describe('blocksFromContent', () => {
  it('maps text, thinking, toolCall and image blocks', () => {
    const blocks = blocksFromContent([
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } },
      { type: 'image', data: 'AAA', mimeType: 'image/png' }
    ])
    expect(blocks).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'thinking', text: 'hmm' },
      { type: 'toolCall', id: 't1', name: 'bash', argsText: '{"command":"ls"}', args: { command: 'ls' } },
      { type: 'image', data: 'AAA', mimeType: 'image/png' }
    ])
  })

  it('wraps string content', () => {
    expect(blocksFromContent('hello')).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('makeUserMessage', () => {
  it('carries attachments and starts pending', () => {
    const message = makeUserMessage('look', [{ type: 'image', data: 'x', mimeType: 'image/png' }])
    expect(message.role).toBe('user')
    expect(message.pending).toBe(true)
    expect(message.blocks).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'x', mimeType: 'image/png' }
    ])
  })
})

describe('messagesFromEntries', () => {
  it('maps messages and attaches tool results to their tool call', () => {
    const messages = messagesFromEntries({
      entries: [
        { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'run ls' }] } },
        {
          type: 'message',
          id: 'a1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'ok' },
              { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }
            ]
          }
        },
        {
          type: 'message',
          id: 'r1',
          message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'file.txt' }], isError: false }
        }
      ]
    })
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('user')
    const tool = messages[1].blocks.find((block) => block.type === 'toolCall')
    expect(tool).toMatchObject({ name: 'bash', result: 'file.txt', running: false, args: { command: 'ls' } })
  })

  it('renders bashExecution entries as a tool card', () => {
    const messages = messagesFromEntries({
      entries: [{ type: 'message', id: 'b1', message: { role: 'bashExecution', command: 'echo hi', output: 'hi', exitCode: 0 } }]
    })
    expect(messages[0].blocks[0]).toMatchObject({ type: 'toolCall', name: 'bash', result: 'hi', isError: false })
  })
})

describe('reduceEvent', () => {
  it('streams assistant text and finalizes on message_end', () => {
    let state = empty()
    state = reduceEvent(state, { type: 'agent_start' })
    state = reduceEvent(state, { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } })
    state = reduceEvent(state, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' } })
    state = reduceEvent(state, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' } })
    expect(state.messages[0].blocks[0]).toEqual({ type: 'text', text: 'Hello' })
    state = reduceEvent(state, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } })
    expect(state.activeAssistantId).toBeNull()
    expect(state.messages[0].streaming).toBe(false)
  })

  it('keeps a tool running through streaming updates', () => {
    let state: ChatState = {
      messages: [{ id: 'a', role: 'assistant', blocks: [{ type: 'toolCall', id: 'c1', name: 'bash', argsText: '' }] }],
      activeAssistantId: null
    }
    state = reduceEvent(state, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'sleep' } })
    expect(state.messages[0].blocks[0]).toMatchObject({ running: true, args: { command: 'sleep' } })
    state = reduceEvent(state, {
      type: 'tool_execution_update',
      toolCallId: 'c1',
      partialResult: { content: [{ type: 'text', text: 'partial' }] }
    })
    expect(state.messages[0].blocks[0]).toMatchObject({ running: true, result: 'partial' })
    state = reduceEvent(state, {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      result: { content: [{ type: 'text', text: 'done' }] },
      isError: false
    })
    expect(state.messages[0].blocks[0]).toMatchObject({ running: false, result: 'done' })
  })

  it('confirms an optimistic user message on user message_start', () => {
    let state: ChatState = { messages: [makeUserMessage('hi')], activeAssistantId: null }
    state = reduceEvent(state, {
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 42 }
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].pending).toBe(false)
  })
})
