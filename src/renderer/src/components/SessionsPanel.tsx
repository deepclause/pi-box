import { useState } from 'react'
import type { RpcSessionSummary } from '@shared/rpc-types'
import { CloseIcon, EditIcon, ExternalLinkIcon, PlusIcon } from './icons'

interface Props {
  sessions: RpcSessionSummary[]
  onSelect: (file: string) => void
  onNew: () => void
  onDelete: (file: string) => void
  onRename: (file: string, name: string) => void
  onExport: () => void
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

export default function SessionsPanel({ sessions, onSelect, onNew, onDelete, onRename, onExport }: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')

  const commit = (file: string): void => {
    onRename(file, value.trim())
    setEditing(null)
  }

  return (
    <aside className="sessions-panel">
      <header className="sessions-header">
        <span className="sessions-title">Sessions</span>
        <button className="icon-btn accent" title="New session (Ctrl/Cmd+N)" onClick={onNew}>
          <PlusIcon size={14} />
        </button>
      </header>
      <div className="sessions-list">
        {sessions.length === 0 ? <div className="empty-hint">No sessions yet.</div> : null}
        {sessions.map((session) => (
          <div className="session-item" data-active={session.active ? 'true' : 'false'} key={session.file}>
            {editing === session.file ? (
              <input
                className="session-rename"
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onBlur={() => commit(session.file)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit(session.file)
                  if (event.key === 'Escape') setEditing(null)
                }}
              />
            ) : (
              <>
                <button className="session-main" onClick={() => onSelect(session.file)} title={session.file}>
                  <span className="session-title">{session.name || session.title}</span>
                  <span className="session-time">{relativeTime(session.updatedAt)}</span>
                </button>
                <span className="session-actions">
                  {session.active ? (
                    <button
                      className="icon-btn"
                      title="Rename session"
                      onClick={() => {
                        setEditing(session.file)
                        setValue(session.name || session.title)
                      }}
                    >
                      <EditIcon size={12} />
                    </button>
                  ) : null}
                  {session.active ? (
                    <button className="icon-btn" title="Export session to HTML" onClick={onExport}>
                      <ExternalLinkIcon size={12} />
                    </button>
                  ) : null}
                  <button className="icon-btn danger" title="Delete session" onClick={() => onDelete(session.file)}>
                    <CloseIcon size={12} />
                  </button>
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
