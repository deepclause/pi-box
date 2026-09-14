import { useEffect, useState } from 'react'
import type { FileNode } from '@shared/types'
import { ChevronIcon, EditIcon, FileIcon, FolderIcon } from './icons'

const SYNC_INTERVAL_MS = 5000

interface Props {
  workspaceId: string
  activeWorkspaceId: string | null
}

export default function FileTree({ workspaceId, activeWorkspaceId }: Props) {
  const [nodes, setNodes] = useState<FileNode[] | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    let cancelled = false

    const load = (): void => {
      window.pibox
        .readTree(workspaceId)
        .then((result) => {
          if (!cancelled) setNodes(result)
        })
        .catch(() => {
          if (!cancelled) setNodes([])
        })
    }

    setNodes(null)
    load()

    // Poll so files created/changed inside the VM (or on the host) show up.
    const id = window.setInterval(() => {
      load()
      setRefreshNonce((n) => n + 1)
    }, SYNC_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [workspaceId])

  if (nodes === null) {
    return <div className="tree-loading">Loading…</div>
  }
  if (nodes.length === 0) {
    return <div className="tree-empty">Empty folder</div>
  }

  return (
    <ul className="file-tree">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          workspaceId={workspaceId}
          activeWorkspaceId={activeWorkspaceId}
          node={node}
          depth={0}
          refreshNonce={refreshNonce}
        />
      ))}
    </ul>
  )
}

interface NodeProps {
  workspaceId: string
  activeWorkspaceId: string | null
  node: FileNode
  depth: number
  refreshNonce: number
}

function TreeNode({ workspaceId, activeWorkspaceId, node, depth, refreshNonce }: NodeProps) {
  const isDir = node.type === 'directory'
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileNode[] | null>(node.children ?? null)

  const toggle = (): void => {
    if (!isDir) return
    if (!open && children === null) {
      setOpen(true)
      window.pibox
        .readTree(workspaceId, node.path)
        .then((result) => setChildren(result))
        .catch(() => setChildren([]))
    } else {
      setOpen(!open)
    }
  }

  // Refresh the children of open directories on every sync tick so the tree
  // stays current without needing a manual reload.
  useEffect(() => {
    if (!isDir || !open) return
    let cancelled = false
    window.pibox
      .readTree(workspaceId, node.path)
      .then((result) => {
        if (!cancelled) setChildren(result)
      })
      .catch(() => {
        if (!cancelled) setChildren([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce])

  const edit = (): void => {
    void window.pibox.editFile(workspaceId, node.path).catch((err) => console.error(err))
  }

  return (
    <li>
      <div
        className={`tree-row ${isDir ? 'is-dir' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={toggle}
        title={node.path}
      >
        <span className="tree-chevron">
          {isDir && <ChevronIcon size={11} className={`chevron ${open ? 'open' : ''}`} />}
        </span>
        <span className="tree-icon">
          {isDir ? <FolderIcon size={13} /> : <FileIcon size={13} />}
        </span>
        <span className="tree-name">{node.name}</span>
        {!isDir && activeWorkspaceId === workspaceId && (
          <button
            className="icon-btn tree-edit-btn"
            title="Edit file in vi"
            onClick={(e) => {
              e.stopPropagation()
              edit()
            }}
          >
            <EditIcon size={12} />
          </button>
        )}
      </div>

      {isDir && open && (
        <ul className="file-tree">
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              workspaceId={workspaceId}
              activeWorkspaceId={activeWorkspaceId}
              node={child}
              depth={depth + 1}
              refreshNonce={refreshNonce}
            />
          ))}
          {children !== null && children !== undefined && children.length === 0 && (
            <li className="tree-row" style={{ paddingLeft: (depth + 1) * 14 + 6 }}>
              <span className="tree-name muted">empty</span>
            </li>
          )}
        </ul>
      )}
    </li>
  )
}
