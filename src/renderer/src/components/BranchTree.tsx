import { useState } from 'react'
import type { RpcTreeEntry, RpcTreeNode } from '@shared/rpc-types'
import { CloseIcon } from './icons'

interface Props {
  tree: RpcTreeNode[]
  leafId: string | null
  onFork: (entryId: string) => void
  onClose: () => void
}

type Filter = 'all' | 'user' | 'labeled' | 'no-tools'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'user', label: 'User' },
  { id: 'labeled', label: 'Labeled' },
  { id: 'no-tools', label: 'No tools' }
]

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const record = block as { type?: string; text?: string; name?: string }
      if (record.type === 'text') return record.text ?? ''
      if (record.type === 'toolCall') return `[${record.name ?? 'tool'}]`
      return ''
    })
    .filter(Boolean)
    .join(' ')
    .slice(0, 120)
}

function describe(entry: RpcTreeEntry): { text: string; kind: string; forkable: boolean } {
  if (entry.type === 'message') {
    const message = entry.message as { role?: string; content?: unknown } | undefined
    const role = message?.role ?? 'message'
    return { text: contentText(message?.content) || role, kind: role, forkable: role === 'user' }
  }
  if (entry.type === 'model_change') return { text: `model → ${String(entry.modelId ?? '')}`, kind: 'model', forkable: false }
  if (entry.type === 'thinking_level_change') {
    return { text: `thinking → ${String(entry.thinkingLevel ?? '')}`, kind: 'thinking', forkable: false }
  }
  return { text: entry.type, kind: entry.type, forkable: false }
}

function matches(node: RpcTreeNode, filter: Filter): boolean {
  if (filter === 'all') return true
  const role = (node.entry.message as { role?: string } | undefined)?.role
  const self =
    filter === 'user'
      ? role === 'user'
      : filter === 'labeled'
        ? Boolean(node.label)
        : filter === 'no-tools'
          ? role !== 'toolResult'
          : true
  return self || node.children.some((child) => matches(child, filter))
}

function Node({
  node,
  depth,
  leafId,
  filter,
  onFork
}: {
  node: RpcTreeNode
  depth: number
  leafId: string | null
  filter: Filter
  onFork: (entryId: string) => void
}) {
  const info = describe(node.entry)
  const active = node.entry.id === leafId
  const children = node.children.filter((child) => matches(child, filter))

  return (
    <div className="branch-node">
      <div className="branch-row" data-active={active ? 'true' : 'false'} style={{ paddingLeft: 8 + depth * 16 }}>
        <span className="branch-kind" data-kind={info.kind}>
          {info.kind}
        </span>
        <span className="branch-text">{info.text}</span>
        {node.label ? <span className="branch-label">{node.label}</span> : null}
        {info.forkable ? (
          <button className="branch-fork" title="Fork a new session from here" onClick={() => onFork(node.entry.id)}>
            fork
          </button>
        ) : null}
      </div>
      {children.map((child) => (
        <Node key={child.entry.id} node={child} depth={depth + 1} leafId={leafId} filter={filter} onFork={onFork} />
      ))}
    </div>
  )
}

export default function BranchTree({ tree, leafId, onFork, onClose }: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const roots = tree.filter((node) => matches(node, filter))

  return (
    <div className="ui-dialog-overlay" onClick={onClose}>
      <div className="ui-dialog branch-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-head">
          <span className="ui-dialog-title">Session branches</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="view-switch branch-filter">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              className="view-switch-btn"
              data-active={filter === entry.id ? 'true' : 'false'}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="branch-list">
          {roots.length === 0 ? <div className="empty-hint">No entries for this filter.</div> : null}
          {roots.map((node) => (
            <Node key={node.entry.id} node={node} depth={0} leafId={leafId} filter={filter} onFork={onFork} />
          ))}
        </div>
      </div>
    </div>
  )
}
