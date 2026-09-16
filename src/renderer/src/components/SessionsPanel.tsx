import type { RpcSessionSummary } from '@shared/rpc-types'
import { CloseIcon, PlusIcon } from './icons'

interface Props {
  sessions: RpcSessionSummary[]
  onSelect: (file: string) => void
  onNew: () => void
  onDelete: (file: string) => void
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export default function SessionsPanel({ sessions, onSelect, onNew, onDelete }: Props) {
  return (
    <aside className="sessions-panel">
      <header className="sessions-header">
        <span className="sessions-title">Sessions</span>
        <button className="icon-btn accent" title="New session" onClick={onNew}>
          <PlusIcon size={14} />
        </button>
      </header>
      <div className="sessions-list">
        {sessions.length === 0 ? <div className="empty-hint">No sessions yet.</div> : null}
        {sessions.map((session) => (
          <div className="session-item" data-active={session.active ? 'true' : 'false'} key={session.file}>
            <button className="session-main" onClick={() => onSelect(session.file)} title={session.file}>
              <span className="session-title">{session.name || session.title}</span>
              <span className="session-time">{relativeTime(session.updatedAt)}</span>
            </button>
            <button className="icon-btn danger session-delete" title="Delete session" onClick={() => onDelete(session.file)}>
              <CloseIcon size={12} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}
