import type { RpcTreeEntry, RpcTreeNode } from '@shared/rpc-types'
import { CloseIcon } from './icons'

interface Props {
  tree: RpcTreeNode[]
  leafId: string | null
  onFork: (entryId: string) => void
  onClose: () => void
}

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
  return { text: entry.label ? String(entry.label) : entry.type, kind: entry.type, forkable: false }
}

function Node({
  node,
  depth,
  leafId,
  onFork
}: {
  node: RpcTreeNode
  depth: number
  leafId: string | null
  onFork: (entryId: string) => void
}) {
  const info = describe(node.entry)
  const active = node.entry.id === leafId
  return (
    <div className="branch-node">
      <div className="branch-row" data-active={active ? 'true' : 'false'} style={{ paddingLeft: 8 + depth * 16 }}>
        <span className="branch-kind" data-kind={info.kind}>
          {info.kind}
        </span>
        <span className="branch-text">{info.text}</span>
        {info.forkable ? (
          <button className="branch-fork" title="Fork a new session from here" onClick={() => onFork(node.entry.id)}>
            fork
          </button>
        ) : null}
      </div>
      {node.children.map((child) => (
        <Node key={child.entry.id} node={child} depth={depth + 1} leafId={leafId} onFork={onFork} />
      ))}
    </div>
  )
}

export default function BranchTree({ tree, leafId, onFork, onClose }: Props) {
  return (
    <div className="ui-dialog-overlay" onClick={onClose}>
      <div className="ui-dialog branch-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-head">
          <span className="ui-dialog-title">Session branches</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>
        <div className="branch-list">
          {tree.length === 0 ? <div className="empty-hint">No entries yet.</div> : null}
          {tree.map((node) => (
            <Node key={node.entry.id} node={node} depth={0} leafId={leafId} onFork={onFork} />
          ))}
        </div>
      </div>
    </div>
  )
}
