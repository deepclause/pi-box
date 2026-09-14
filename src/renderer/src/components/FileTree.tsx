import { useEffect, useState } from 'react'
import type { FileNode } from '@shared/types'
import { ChevronIcon, EditIcon, FileIcon, FolderIcon } from './icons'

interface Props {
  workspaceId: string
  activeWorkspaceId: string | null
}

export default function FileTree({ workspaceId, activeWorkspaceId }: Props) {
  const [nodes, setNodes] = useState<FileNode[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setNodes(null)
    window.pibox
      .readTree(workspaceId)
      .then((result) => {
        if (!cancelled) setNodes(result)
      })
      .catch(() => {
        if (!cancelled) setNodes([])
      })
    return () => {
      cancelled = true
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
        <TreeNode key={node.path} workspaceId={workspaceId} activeWorkspaceId={activeWorkspaceId} node={node} depth={0} />
      ))}
    </ul>
  )
}

interface NodeProps {
  workspaceId: string
  activeWorkspaceId: string | null
  node: FileNode
  depth: number
}

function TreeNode({ workspaceId, activeWorkspaceId, node, depth }: NodeProps) {
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
            <TreeNode key={child.path} workspaceId={workspaceId} activeWorkspaceId={activeWorkspaceId} node={child} depth={depth + 1} />
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
