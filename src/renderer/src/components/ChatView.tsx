import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AppState } from '@shared/types'
import type { RpcState } from '@shared/rpc-types'
import {
  makeUserMessage,
  messagesFromEntries,
  reduceEvent,
  type ChatBlock,
  type ChatMessage,
  type ChatState
} from '../lib/chat'
import Markdown from './Markdown'
import { SendIcon, StopIcon } from './icons'

const EMPTY_STATE: ChatState = { messages: [], activeAssistantId: null }

const INITIAL_RPC_STATE: RpcState = {
  status: 'idle',
  sessionId: null,
  model: null,
  thinkingLevel: null,
  isStreaming: false
}

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <details className="thinking-block" open={streaming}>
      <summary>Thinking</summary>
      <pre>{text}</pre>
    </details>
  )
}

function ToolCard({ block }: { block: Extract<ChatBlock, { type: 'toolCall' }> }) {
  return (
    <div className="tool-card" data-error={block.isError ? 'true' : 'false'}>
      <div className="tool-card-head">
        <span className="tool-card-name">{block.name}</span>
        {block.running ? <span className="tool-card-status">running…</span> : null}
        {block.isError ? <span className="tool-card-status error">error</span> : null}
      </div>
      {block.argsText ? <pre className="tool-card-args">{block.argsText}</pre> : null}
      {block.result ? <pre className="tool-card-result">{block.result}</pre> : null}
    </div>
  )
}

function Message({ message }: { message: ChatMessage }) {
  return (
    <div className="chat-msg" data-role={message.role} data-pending={message.pending ? 'true' : 'false'}>
      <div className="chat-msg-body">
        {message.blocks.map((block, index) => {
          if (block.type === 'text') return <Markdown key={index} text={block.text} />
          if (block.type === 'thinking') return <ThinkingBlock key={index} text={block.text} streaming={message.streaming} />
          return <ToolCard key={index} block={block} />
        })}
        {message.streaming ? <span className="chat-cursor" /> : null}
        {message.error ? <div className="chat-msg-error">{message.error}</div> : null}
      </div>
    </div>
  )
}

export default function ChatView({ state }: { state: AppState | null }) {
  const [rpcState, setRpcState] = useState<RpcState>(INITIAL_RPC_STATE)
  const [chat, setChat] = useState<ChatState>(EMPTY_STATE)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const openingRef = useRef(false)
  const retryRef = useRef(0)

  useEffect(() => {
    let mounted = true
    const unsubscribeState = window.pibox.rpc.onState((next) => {
      if (mounted) setRpcState(next)
    })
    const unsubscribeEvent = window.pibox.rpc.onEvent((event) => {
      if (mounted) setChat((prev) => reduceEvent(prev, event))
    })
    window.pibox.rpc
      .getState()
      .then(async (next) => {
        if (!mounted) return
        setRpcState(next)
        // A session may already be live (e.g. switching back from the terminal
        // view); reload its history so the transcript is not empty.
        if (next.status === 'ready') {
          try {
            const entries = await window.pibox.rpc.getEntries()
            if (mounted) setChat({ messages: messagesFromEntries(entries), activeAssistantId: null })
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {
        /* ignore */
      })
    return () => {
      mounted = false
      unsubscribeState()
      unsubscribeEvent()
    }
  }, [])

  const open = useCallback(async () => {
    if (openingRef.current) return
    openingRef.current = true
    setError(null)
    try {
      const next = await window.pibox.rpc.open()
      setRpcState(next)
      const entries = await window.pibox.rpc.getEntries()
      setChat({ messages: messagesFromEntries(entries), activeAssistantId: null })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      openingRef.current = false
    }
  }, [])

  useEffect(() => {
    if (rpcState.status === 'ready') retryRef.current = 0
  }, [rpcState.status])

  // Auto-open once the VM is ready (a shell, which is fast now); retry a few
  // times if startup fails so a transient error does not leave it stuck.
  useEffect(() => {
    if (state?.status !== 'ready' || !state?.activeWorkspaceId) return
    if (rpcState.status === 'starting' || rpcState.status === 'ready') return
    if (rpcState.status === 'error') {
      if (retryRef.current >= 3) return
      retryRef.current += 1
      const timer = setTimeout(() => void open(), 4000)
      return () => clearTimeout(timer)
    }
    void open()
  }, [state?.status, rpcState.status, open])

  useEffect(() => {
    const element = transcriptRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [chat])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || rpcState.status !== 'ready') return
    setInput('')
    setChat((prev) => ({ ...prev, messages: [...prev.messages, makeUserMessage(text)] }))
    try {
      const behavior = rpcState.isStreaming ? 'steer' : undefined
      const next = await window.pibox.rpc.prompt(text, behavior)
      setRpcState(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [input, rpcState.status, rpcState.isStreaming])

  const stop = useCallback(() => {
    window.pibox.rpc
      .abort()
      .then(setRpcState)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const busy = rpcState.status === 'starting'
  const notReady = state?.status !== 'ready'

  return (
    <section className="chat-pane">
      <div className="chat-transcript" ref={transcriptRef}>
        {busy ? (
          <div className="chat-starting">
            <div className="chat-starting-card">
              <div className="chat-spinner" />
              <div className="chat-starting-title">Starting pi…</div>
              <div className="chat-starting-sub">
                pi runs inside the VM, so first launch takes ~30 seconds while it boots.
              </div>
            </div>
          </div>
        ) : chat.messages.length === 0 ? (
          <div className="chat-empty">
            {notReady ? 'Waiting for the VM to become ready…' : rpcState.status === 'error' ? 'Could not start pi.' : 'Ask pi anything.'}
          </div>
        ) : (
          chat.messages.map((message) => <Message key={message.id} message={message} />)
        )}
      </div>

      {error ? (
        <div className="chat-error-bar">
          {error}
          <button className="text-btn" onClick={() => void open()} disabled={notReady}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="chat-composer">
        <div className="chat-composer-meta">
          <span className="chat-model">{rpcState.model ? `${rpcState.model.id}` : 'no model'}</span>
          {rpcState.thinkingLevel ? <span className="chat-thinking">{rpcState.thinkingLevel}</span> : null}
          {rpcState.isStreaming ? <span className="chat-streaming">streaming</span> : null}
        </div>
        <div className="chat-composer-row">
          <textarea
            className="chat-input"
            placeholder={rpcState.isStreaming ? 'Steer pi…  (Enter to send)' : 'Message pi…  (Enter to send, Shift+Enter for newline)'}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            disabled={rpcState.status !== 'ready'}
          />
          {rpcState.isStreaming ? (
            <button className="chat-send stop" title="Stop" onClick={stop}>
              <StopIcon size={15} />
            </button>
          ) : (
            <button className="chat-send" title="Send" onClick={() => void send()} disabled={!input.trim() || rpcState.status !== 'ready'}>
              <SendIcon size={15} />
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
