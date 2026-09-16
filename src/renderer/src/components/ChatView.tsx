import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AppState } from '@shared/types'
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
  RpcTree,
  RpcUiDialog
} from '@shared/rpc-types'
import {
  makeUserMessage,
  messagesFromEntries,
  reduceEvent,
  type ChatBlock,
  type ChatMessage,
  type ChatState
} from '../lib/chat'
import Markdown from './Markdown'
import SessionsPanel from './SessionsPanel'
import ExtensionUi from './ExtensionUi'
import BranchTree from './BranchTree'
import { PaperclipIcon, SendIcon, StopIcon } from './icons'

interface Attachment {
  id: number
  name: string
  mimeType: string
  data: string
}

const EMPTY_STATE: ChatState = { messages: [], activeAssistantId: null }

const INITIAL_RPC_STATE: RpcState = {
  status: 'idle',
  sessionId: null,
  model: null,
  thinkingLevel: null,
  isStreaming: false,
  isCompacting: false
}

interface Notice {
  id: number
  text: string
}

interface Toast {
  id: number
  message: string
  kind: string
}

function formatTokens(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function formatCost(value: number | undefined): string {
  if (value == null) return '—'
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function noticeFromEvent(event: RpcEvent): string | null {
  switch (event.type) {
    case 'compaction_start':
      return 'Compacting context…'
    case 'compaction_end': {
      if (event.aborted) return 'Compaction aborted'
      const result = event.result as { tokensBefore?: number; estimatedTokensAfter?: number } | null
      if (!result) return event.errorMessage ? `Compaction failed: ${String(event.errorMessage)}` : 'Compaction finished'
      return `Compacted context: ${formatTokens(result.tokensBefore)} → ~${formatTokens(result.estimatedTokensAfter)} tokens`
    }
    case 'auto_retry_start':
      return `Provider error — retrying (attempt ${String(event.attempt)}/${String(event.maxAttempts)})…`
    case 'auto_retry_end':
      return event.success ? 'Retry succeeded' : `Retry failed: ${String(event.finalError ?? '')}`
    case 'summarization_retry_scheduled':
      return 'Summarization retry scheduled…'
    case 'summarization_retry_attempt_start':
      return 'Retrying summarization…'
    case 'extension_error':
      return `Extension error: ${String(event.error ?? '')}`
    default:
      return null
  }
}

function dialogFromEvent(event: RpcEvent): RpcUiDialog | null {
  const method = String(event.method ?? '')
  if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') return null
  return {
    id: String(event.id ?? ''),
    method,
    title: String(event.title ?? ''),
    message: event.message as string | undefined,
    options: event.options as string[] | undefined,
    placeholder: event.placeholder as string | undefined,
    prefill: event.prefill as string | undefined
  }
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
          if (block.type === 'image') {
            return <img className="chat-image" key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="attachment" />
          }
          return <ToolCard key={index} block={block} />
        })}
        {message.streaming ? <span className="chat-cursor" /> : null}
        {message.error ? <div className="chat-msg-error">{message.error}</div> : null}
      </div>
    </div>
  )
}

function UsageBar({ stats }: { stats: RpcSessionStats | undefined }) {
  const percent = stats?.contextUsage?.percent
  const total = stats?.tokens?.total
  return (
    <span className="chat-usage" title="Context window usage · session tokens · session cost">
      {typeof percent === 'number' ? (
        <>
          <span className="chat-ctx-bar">
            <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
          </span>
          {percent.toFixed(0)}% ·{' '}
        </>
      ) : null}
      {formatTokens(total)} tok · {formatCost(stats?.cost)}
    </span>
  )
}

export default function ChatView({ state }: { state: AppState | null }) {
  const [rpcState, setRpcState] = useState<RpcState>(INITIAL_RPC_STATE)
  const [chat, setChat] = useState<ChatState>(EMPTY_STATE)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<RpcModelInfo[]>([])
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([])
  const [commands, setCommands] = useState<RpcCommand[]>([])
  const [queue, setQueue] = useState<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] })
  const [notices, setNotices] = useState<Notice[]>([])
  const [sessions, setSessions] = useState<RpcSessionSummary[]>([])
  const [dialogs, setDialogs] = useState<RpcUiDialog[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const [widgetLines, setWidgetLines] = useState<string[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [forkMessages, setForkMessages] = useState<RpcForkMessage[] | null>(null)
  const [tree, setTree] = useState<RpcTree | null>(null)
  const [commandIndex, setCommandIndex] = useState(0)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const openingRef = useRef(false)
  const retryRef = useRef(0)
  const noticeSeq = useRef(0)
  const toastSeq = useRef(0)
  const attachSeq = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const addImageFiles = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const comma = result.indexOf(',')
        const data = comma >= 0 ? result.slice(comma + 1) : result
        setAttachments((prev) => [
          ...prev,
          { id: ++attachSeq.current, name: file.name || 'image', mimeType: file.type || 'image/png', data }
        ])
      }
      reader.readAsDataURL(file)
    }
  }, [])

  const reloadSessions = useCallback(async () => {
    try {
      setSessions(await window.pibox.rpc.listSessions())
    } catch {
      /* ignore */
    }
  }, [])

  const reloadTranscript = useCallback(async () => {
    try {
      const entries = await window.pibox.rpc.getEntries()
      setChat({ messages: messagesFromEntries(entries), activeAssistantId: null })
      setNotices([])
      setQueue({ steering: [], followUp: [] })
      setDialogs([])
    } catch {
      /* ignore */
    }
  }, [])

  const pushToast = useCallback((message: string, kind = 'info') => {
    const toast: Toast = { id: ++toastSeq.current, message, kind }
    setToasts((prev) => [...prev, toast])
    setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== toast.id)), 6000)
  }, [])

  useEffect(() => {
    let mounted = true
    const unsubscribeState = window.pibox.rpc.onState((next) => {
      if (mounted) setRpcState(next)
    })
    const unsubscribeEvent = window.pibox.rpc.onEvent((event) => {
      if (!mounted) return
      setChat((prev) => reduceEvent(prev, event))
      if (event.type === 'queue_update') {
        setQueue({
          steering: (event.steering as string[]) ?? [],
          followUp: (event.followUp as string[]) ?? []
        })
      }
      const notice = noticeFromEvent(event)
      if (notice) setNotices((prev) => [...prev, { id: ++noticeSeq.current, text: notice }].slice(-30))
      if (event.type === 'agent_settled') void reloadSessions()

      if (event.type === 'extension_ui_request') {
        const method = String(event.method ?? '')
        const dialog = dialogFromEvent(event)
        if (dialog) {
          setDialogs((prev) => [...prev, dialog])
        } else if (method === 'notify') {
          pushToast(String(event.message ?? ''), String(event.notifyType ?? 'info'))
        } else if (method === 'setStatus') {
          const key = String(event.statusKey ?? '')
          setStatuses((prev) => {
            const next = { ...prev }
            if (event.statusText == null) delete next[key]
            else next[key] = String(event.statusText)
            return next
          })
        } else if (method === 'setWidget') {
          setWidgetLines(Array.isArray(event.widgetLines) ? (event.widgetLines as string[]) : [])
        } else if (method === 'set_editor_text') {
          setInput(String(event.text ?? ''))
        } else if (method === 'setTitle') {
          document.title = String(event.title ?? 'pi-box')
        }
      }
    })
    window.pibox.rpc
      .getState()
      .then(async (next) => {
        if (!mounted) return
        setRpcState(next)
        if (next.status === 'ready') {
          try {
            const entries = await window.pibox.rpc.getEntries()
            if (mounted) setChat({ messages: messagesFromEntries(entries), activeAssistantId: null })
          } catch {
            /* ignore */
          }
          if (mounted) void reloadSessions()
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
  }, [reloadSessions, pushToast])

  const open = useCallback(async () => {
    if (openingRef.current) return
    openingRef.current = true
    setError(null)
    try {
      const next = await window.pibox.rpc.open()
      setRpcState(next)
      await reloadTranscript()
      await reloadSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      openingRef.current = false
    }
  }, [reloadTranscript, reloadSessions])

  useEffect(() => {
    if (rpcState.status === 'ready') retryRef.current = 0
  }, [rpcState.status])

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
  }, [state?.status, state?.activeWorkspaceId, rpcState.status, open])

  useEffect(() => {
    if (rpcState.status !== 'ready') return
    void Promise.all([
      window.pibox.rpc.getAvailableModels().catch(() => [] as RpcModelInfo[]),
      window.pibox.rpc.getAvailableThinkingLevels().catch(() => [] as string[]),
      window.pibox.rpc.getCommands().catch(() => [] as RpcCommand[])
    ]).then(([modelList, levels, commandList]) => {
      setModels(modelList)
      setThinkingLevels(levels)
      setCommands(commandList)
    })
  }, [rpcState.status])

  useEffect(() => {
    const element = transcriptRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [chat, notices])

  const send = useCallback(async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || rpcState.status !== 'ready') return
    const images: RpcImage[] = attachments.map((item) => ({ type: 'image', data: item.data, mimeType: item.mimeType }))
    setInput('')
    setAttachments([])
    setCommandIndex(0)
    setChat((prev) => ({ ...prev, messages: [...prev.messages, makeUserMessage(text, images)] }))
    try {
      const behavior = rpcState.isStreaming ? 'steer' : undefined
      const next = await window.pibox.rpc.prompt(text, behavior, images)
      setRpcState(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [input, attachments, rpcState.status, rpcState.isStreaming])

  const stop = useCallback(() => {
    window.pibox.rpc
      .abort()
      .then(setRpcState)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const selectSession = useCallback(
    async (file: string) => {
      if (rpcState.status !== 'ready') return
      setError(null)
      try {
        setRpcState(await window.pibox.rpc.switchSession(file))
        await reloadTranscript()
        await reloadSessions()
        setInput('')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [rpcState.status, reloadTranscript, reloadSessions]
  )

  const newSession = useCallback(async () => {
    if (rpcState.status !== 'ready') return
    setError(null)
    try {
      setRpcState(await window.pibox.rpc.newSession())
      await reloadTranscript()
      await reloadSessions()
      setInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [rpcState.status, reloadTranscript, reloadSessions])

  const renameSession = useCallback(
    async (_file: string, name: string) => {
      if (!name) return
      try {
        setRpcState(await window.pibox.rpc.setSessionName(name))
        await reloadSessions()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [reloadSessions]
  )

  const exportSession = useCallback(async () => {
    try {
      const result = await window.pibox.rpc.exportHtml()
      pushToast(`Exported session to ${result.path}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [pushToast])

  const deleteSession = useCallback(
    async (file: string) => {
      setError(null)
      try {
        setRpcState(await window.pibox.rpc.deleteSession(file))
        await reloadTranscript()
        await reloadSessions()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [reloadTranscript, reloadSessions]
  )

  const respondDialog = useCallback((response: RpcExtensionUIResponse) => {
    window.pibox.rpc.respondExtensionUi(response)
    setDialogs((prev) => prev.slice(1))
  }, [])

  const openFork = useCallback(async () => {
    try {
      setForkMessages(await window.pibox.rpc.getForkMessages())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const doFork = useCallback(
    async (entryId: string) => {
      setForkMessages(null)
      try {
        await window.pibox.rpc.fork(entryId)
        await reloadTranscript()
        await reloadSessions()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [reloadTranscript, reloadSessions]
  )

  const cloneSession = useCallback(async () => {
    try {
      setRpcState(await window.pibox.rpc.clone())
      await reloadTranscript()
      await reloadSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [reloadTranscript, reloadSessions])

  const openTree = useCallback(async () => {
    try {
      setTree(await window.pibox.rpc.getTree())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const reconnect = useCallback(async () => {
    setError(null)
    try {
      setRpcState(await window.pibox.rpc.reconnect())
      await reloadTranscript()
      await reloadSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [reloadTranscript, reloadSessions])

  // Cmd/Ctrl+N starts a fresh session.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void newSession()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession])

  const selectModel = useCallback(async (value: string) => {
    const slash = value.indexOf('/')
    if (slash < 0) return
    try {
      setRpcState(await window.pibox.rpc.setModel(value.slice(0, slash), value.slice(slash + 1)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const selectThinking = useCallback(async (level: string) => {
    try {
      setRpcState(await window.pibox.rpc.setThinkingLevel(level))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const commandMatches = useMemo(() => {
    if (!input.startsWith('/') || input.includes(' ')) return []
    const query = input.toLowerCase()
    return commands.filter((command) => `/${command.name.toLowerCase()}`.startsWith(query)).slice(0, 8)
  }, [input, commands])

  const acceptCommand = useCallback((command: RpcCommand) => {
    setInput(`/${command.name} `)
    setCommandIndex(0)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      if (forkMessages) {
        setForkMessages(null)
        return
      }
      if (tree) {
        setTree(null)
        return
      }
      if (rpcState.isStreaming) {
        event.preventDefault()
        void (async () => {
          try {
            const queued = await window.pibox.rpc.clearQueue()
            const restored = [...queued.steering, ...queued.followUp].join('\n')
            if (restored) setInput((prev) => (prev ? `${prev}\n${restored}` : restored))
            setRpcState(await window.pibox.rpc.abort())
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          }
        })()
      }
      return
    }
    if (commandMatches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCommandIndex((index) => (index + 1) % commandMatches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCommandIndex((index) => (index - 1 + commandMatches.length) % commandMatches.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && commandMatches[commandIndex])) {
        event.preventDefault()
        acceptCommand(commandMatches[commandIndex])
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const busy = rpcState.status === 'starting'
  const notReady = state?.status !== 'ready'
  const modelKey = rpcState.model ? `${rpcState.model.provider}/${rpcState.model.id}` : ''
  const knownModel = models.some((model) => `${model.provider}/${model.id}` === modelKey)
  const levels = thinkingLevels.length ? thinkingLevels : ['off', 'minimal', 'low', 'medium', 'high']

  return (
    <section className="chat-pane">
      <div className="chat-body">
        <SessionsPanel
          sessions={sessions}
          onSelect={(file) => void selectSession(file)}
          onNew={() => void newSession()}
          onDelete={(file) => void deleteSession(file)}
          onRename={(file, name) => void renameSession(file, name)}
          onExport={() => void exportSession()}
        />
        <div className="chat-main">
          <div className="chat-transcript" ref={transcriptRef}>
            {busy ? (
              <div className="chat-starting">
                <div className="chat-starting-card">
                  <div className="chat-spinner" />
                  <div className="chat-starting-title">Starting pi…</div>
                  <div className="chat-starting-sub">pi runs inside the VM, so first launch takes ~30 seconds while it boots.</div>
                </div>
              </div>
            ) : chat.messages.length === 0 ? (
              <div className="chat-empty">
                {notReady ? 'Waiting for the VM to become ready…' : rpcState.status === 'error' ? 'Could not start pi.' : 'Ask pi anything.'}
              </div>
            ) : (
              chat.messages.map((message) => <Message key={message.id} message={message} />)
            )}
            {!busy
              ? notices.map((notice) => (
                  <div className="chat-notice" key={notice.id}>
                    {notice.text}
                  </div>
                ))
              : null}
          </div>

          {error ? (
            <div className="chat-error-bar">
              {error}
              <button className="text-btn" onClick={() => void open()} disabled={notReady}>
                Retry
              </button>
            </div>
          ) : null}

          {widgetLines.length ? (
            <div className="chat-widget">
              {widgetLines.map((line, index) => (
                <div key={index}>{line}</div>
              ))}
            </div>
          ) : null}

          <div className="chat-composer">
            <div className="chat-composer-meta">
              <select className="chat-select" value={modelKey} onChange={(event) => void selectModel(event.target.value)} disabled={rpcState.status !== 'ready'}>
                {!knownModel && modelKey ? <option value={modelKey}>{rpcState.model?.id}</option> : null}
                {models.length === 0 && !modelKey ? <option value="">no model</option> : null}
                {models.map((model) => (
                  <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                    {model.id}
                  </option>
                ))}
              </select>
              <select
                className="chat-select"
                value={rpcState.thinkingLevel ?? 'off'}
                onChange={(event) => void selectThinking(event.target.value)}
                disabled={rpcState.status !== 'ready'}
              >
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
              {Object.entries(statuses).map(([key, value]) => (
                <span className="chat-status" key={key}>
                  {value}
                </span>
              ))}
              <button className="chat-action" title="Fork from a previous message" onClick={() => void openFork()} disabled={rpcState.status !== 'ready'}>
                Fork
              </button>
              <button className="chat-action" title="Clone this session" onClick={() => void cloneSession()} disabled={rpcState.status !== 'ready'}>
                Clone
              </button>
              <button className="chat-action" title="View session branches" onClick={() => void openTree()} disabled={rpcState.status !== 'ready'}>
                Branches
              </button>
              <button className="chat-action" title="Reconnect to pi" onClick={() => void reconnect()} disabled={state?.status !== 'ready'}>
                Reconnect
              </button>
              <UsageBar stats={rpcState.stats} />
              {rpcState.isCompacting ? <span className="chat-streaming">compacting</span> : null}
              {rpcState.isStreaming ? <span className="chat-streaming">streaming</span> : null}
            </div>

            {forkMessages ? (
              <div className="chat-fork-menu">
                <div className="chat-fork-head">Fork from a user message</div>
                {forkMessages.length === 0 ? <div className="empty-hint">No earlier user messages.</div> : null}
                {forkMessages.map((message) => (
                  <button className="chat-command" key={message.entryId} onClick={() => void doFork(message.entryId)}>
                    <span className="chat-command-desc">{message.text.slice(0, 100)}</span>
                  </button>
                ))}
                <button className="text-btn" onClick={() => setForkMessages(null)}>
                  Cancel
                </button>
              </div>
            ) : null}

            {attachments.length ? (
              <div className="chat-attachments">
                {attachments.map((item) => (
                  <div className="chat-attachment" key={item.id}>
                    <img src={`data:${item.mimeType};base64,${item.data}`} alt={item.name} />
                    <button
                      className="chat-attachment-remove"
                      title="Remove"
                      onClick={() => setAttachments((prev) => prev.filter((entry) => entry.id !== item.id))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {queue.steering.length || queue.followUp.length ? (
              <div className="chat-queue">
                {queue.steering.map((text, index) => (
                  <span className="chat-queue-chip" data-kind="steer" key={`s${index}`} title="Queued steering message">
                    {text}
                  </span>
                ))}
                {queue.followUp.map((text, index) => (
                  <span className="chat-queue-chip" data-kind="follow" key={`f${index}`} title="Queued follow-up message">
                    {text}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="chat-composer-row">
              {commandMatches.length > 0 ? (
                <div className="chat-commands">
                  {commandMatches.map((command, index) => (
                    <button
                      key={command.name}
                      className="chat-command"
                      data-active={index === commandIndex ? 'true' : 'false'}
                      onMouseEnter={() => setCommandIndex(index)}
                      onClick={() => acceptCommand(command)}
                    >
                      <span className="chat-command-name">/{command.name}</span>
                      <span className="chat-command-source">{command.source}</span>
                      {command.description ? <span className="chat-command-desc">{command.description}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(event) => {
                  if (event.target.files) addImageFiles(event.target.files)
                  event.target.value = ''
                }}
              />
              <button
                className="chat-attach"
                title="Attach image"
                onClick={() => fileInputRef.current?.click()}
                disabled={rpcState.status !== 'ready'}
              >
                <PaperclipIcon size={15} />
              </button>
              <textarea
                className="chat-input"
                placeholder={rpcState.isStreaming ? 'Steer pi…  (Enter to send)' : 'Message pi…  (Enter to send, Shift+Enter for newline, / for commands)'}
                value={input}
                onChange={(event) => {
                  setInput(event.target.value)
                  setCommandIndex(0)
                }}
                onKeyDown={onKeyDown}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files)
                  if (files.some((file) => file.type.startsWith('image/'))) {
                    event.preventDefault()
                    addImageFiles(files)
                  }
                }}
                onDrop={(event) => {
                  if (event.dataTransfer.files.length) {
                    event.preventDefault()
                    addImageFiles(event.dataTransfer.files)
                  }
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes('Files')) event.preventDefault()
                }}
                rows={3}
                disabled={rpcState.status !== 'ready'}
              />
              {rpcState.isStreaming ? (
                <button className="chat-send stop" title="Stop" onClick={stop}>
                  <StopIcon size={15} />
                </button>
              ) : (
                <button
                  className="chat-send"
                  title="Send"
                  onClick={() => void send()}
                  disabled={(!input.trim() && attachments.length === 0) || rpcState.status !== 'ready'}
                >
                  <SendIcon size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {toasts.length ? (
        <div className="chat-toasts">
          {toasts.map((toast) => (
            <div className="chat-toast" data-kind={toast.kind} key={toast.id}>
              {toast.message}
            </div>
          ))}
        </div>
      ) : null}

      {dialogs.length ? <ExtensionUi dialog={dialogs[0]} onRespond={respondDialog} /> : null}

      {tree ? (
        <BranchTree
          tree={tree.tree}
          leafId={tree.leafId}
          onFork={(entryId) => {
            setTree(null)
            void doFork(entryId)
          }}
          onClose={() => setTree(null)}
        />
      ) : null}
    </section>
  )
}
