import { useEffect, useState } from 'react'
import type { AppState, Workspace } from '@shared/types'
import FileTree from './FileTree'
import { ChevronIcon, CloseIcon, ExternalLinkIcon, PlusIcon } from './icons'

interface Props {
  state: AppState | null
  visible: boolean
  onAdd: () => void
  onRemove: (id: string) => void
  onSelect: (id: string) => void
  onOpenFolder: (id: string) => void
  onEditFile: (workspaceId: string, hostPath: string) => void
}

export default function WorkspaceSidebar({
  state,
  visible,
  onAdd,
  onRemove,
  onSelect,
  onOpenFolder,
  onEditFile
}: Props) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (state?.activeWorkspaceId) {
      setExpandedIds((prev) => {
        if (prev.has(state.activeWorkspaceId as string)) return prev
        const next = new Set(prev)
        next.add(state.activeWorkspaceId as string)
        return next
      })
    }
  }, [state?.activeWorkspaceId])

  const toggleExpand = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSelect = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
    onSelect(id)
  }

  return (
    <aside className={`sidebar ${visible ? '' : 'hidden'}`}>
      <header className="sidebar-header">
        <span className="sidebar-title">Workspaces</span>
        <button className="icon-btn accent" title="Add workspace" onClick={onAdd}>
          <PlusIcon size={15} />
        </button>
      </header>

      <div className="workspace-list">
        {state?.workspaces.map((ws) => (
          <WorkspaceItem
            key={ws.id}
            workspace={ws}
            active={state.activeWorkspaceId === ws.id}
            activeWorkspaceId={state.activeWorkspaceId}
            expanded={expandedIds.has(ws.id)}
            onToggleExpand={() => toggleExpand(ws.id)}
            onSelect={() => handleSelect(ws.id)}
            onRemove={() => onRemove(ws.id)}
            onOpenFolder={() => onOpenFolder(ws.id)}
            onEditFile={onEditFile}
          />
        ))}
        {(!state || state.workspaces.length === 0) && (
          <div className="empty-hint">No workspaces yet.</div>
        )}
      </div>

      <footer className="sidebar-footer">
        <button className="text-btn" onClick={onAdd}>
          <PlusIcon size={14} />
          Add workspace
        </button>
      </footer>
    </aside>
  )
}

interface ItemProps {
  workspace: Workspace
  active: boolean
  activeWorkspaceId: string | null
  expanded: boolean
  onToggleExpand: () => void
  onSelect: () => void
  onRemove: () => void
  onOpenFolder: () => void
  onEditFile: (workspaceId: string, hostPath: string) => void
}

function WorkspaceItem({
  workspace,
  active,
  activeWorkspaceId,
  expanded,
  onToggleExpand,
  onSelect,
  onRemove,
  onOpenFolder,
  onEditFile
}: ItemProps) {
  return (
    <div className={`workspace-item ${active ? 'active' : ''}`}>
      <div className="workspace-row" title={workspace.path}>
        <button className="chevron-btn" onClick={onToggleExpand} aria-label="Toggle tree">
          <ChevronIcon size={13} className={`chevron ${expanded ? 'open' : ''}`} />
        </button>
        <button className="workspace-name" onClick={onSelect}>
          {workspace.name}
          {workspace.isDefault && <span className="badge">default</span>}
        </button>
        <span className="workspace-actions">
          <button className="icon-btn" title="Open folder in file manager" onClick={onOpenFolder}>
            <ExternalLinkIcon size={13} />
          </button>
          {!workspace.isDefault && (
            <button className="icon-btn danger" title="Remove workspace" onClick={onRemove}>
              <CloseIcon size={13} />
            </button>
          )}
        </span>
      </div>
      <div className="workspace-path" title={workspace.path}>
        {workspace.path}
      </div>
      {expanded && (
        <div className="workspace-tree">
          <FileTree workspaceId={workspace.id} activeWorkspaceId={activeWorkspaceId} onEditFile={onEditFile} />
        </div>
      )}
    </div>
  )
}
