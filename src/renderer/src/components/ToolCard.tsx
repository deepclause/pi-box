import { useState } from 'react'
import type { ChatBlock } from '../lib/chat'

type ToolBlock = Extract<ChatBlock, { type: 'toolCall' }>

/** Lines of tool output shown before the "show all" toggle. */
const PREVIEW_LINES = 12

function firstLine(text: string, max = 120): string {
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? text
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function parseArgs(block: ToolBlock): Record<string, unknown> | null {
  if (block.args) return block.args
  if (!block.argsText) return null
  try {
    return JSON.parse(block.argsText) as Record<string, unknown>
  } catch {
    return null
  }
}

function summarize(block: ToolBlock): { subject: string; detail?: string } {
  const args = parseArgs(block)
  const get = (...keys: string[]): string | undefined => {
    if (!args) return undefined
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value) return value
    }
    return undefined
  }

  switch (block.name.toLowerCase()) {
    case 'bash':
    case 'powershell':
    case 'shell': {
      const command = get('command', 'cmd')
      return { subject: command ? firstLine(command) : 'shell command' }
    }
    case 'read':
    case 'cat': {
      const path = get('path', 'file_path', 'filePath', 'file')
      const offset = args?.offset
      const limit = args?.limit
      const range =
        typeof offset === 'number' || typeof limit === 'number'
          ? `lines ${offset ?? 1}${limit ? `–${Number(offset ?? 1) + Number(limit)}` : ''}`
          : undefined
      return { subject: path ?? 'file', detail: range }
    }
    case 'write':
    case 'create': {
      const path = get('path', 'file_path', 'filePath', 'file')
      const content = get('content', 'text')
      const lines = content ? content.split('\n').length : undefined
      return { subject: path ?? 'file', detail: lines ? `${lines} lines` : undefined }
    }
    case 'edit':
    case 'patch': {
      const path = get('path', 'file_path', 'filePath', 'file')
      const replacements = args?.replacements
      const detail = Array.isArray(replacements) ? `${replacements.length} edit${replacements.length === 1 ? '' : 's'}` : 'edit'
      return { subject: path ?? 'file', detail }
    }
    case 'grep':
    case 'search': {
      const pattern = get('pattern', 'query')
      const where = get('path', 'glob', 'include')
      return { subject: pattern ? `/${firstLine(pattern, 60)}/` : 'search', detail: where }
    }
    case 'find': {
      const pattern = get('pattern', 'glob', 'query')
      const where = get('path')
      return { subject: pattern ?? 'find', detail: where }
    }
    case 'ls':
    case 'list': {
      return { subject: get('path') ?? '.', detail: undefined }
    }
    default: {
      if (args) {
        const detail = Object.entries(args)
          .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
          .slice(0, 2)
          .map(([key, value]) => `${key}=${String(value).slice(0, 40)}`)
          .join('  ')
        return { subject: block.name, detail: detail || undefined }
      }
      return { subject: block.name }
    }
  }
}

export default function ToolCard({ block }: { block: ToolBlock }) {
  const [expanded, setExpanded] = useState(false)
  const { subject, detail } = summarize(block)
  const result = block.result ?? ''
  const lines = result ? result.split('\n') : []
  const truncated = lines.length > PREVIEW_LINES
  const shown = expanded ? result : lines.slice(0, PREVIEW_LINES).join('\n')

  return (
    <div className="tool-card" data-error={block.isError ? 'true' : 'false'} data-running={block.running ? 'true' : 'false'}>
      <div className="tool-card-head">
        <span className="tool-card-kind">{block.name}</span>
        <span className="tool-card-subject" title={subject}>
          {subject}
        </span>
        {detail ? <span className="tool-card-detail">{detail}</span> : null}
        {block.running ? (
          <span className="tool-card-status running">
            <span className="tool-spinner" />
            running
          </span>
        ) : block.isError ? (
          <span className="tool-card-status error">error</span>
        ) : block.result !== undefined || block.images?.length ? (
          <span className="tool-card-status done">done</span>
        ) : null}
      </div>

      {block.images?.length ? (
        <div className="tool-card-images">
          {block.images.map((image, index) => (
            <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="tool result" />
          ))}
        </div>
      ) : null}

      {result ? (
        <div className="tool-card-body">
          <pre className="tool-card-output">{expanded || !truncated ? shown : `${shown}\n…`}</pre>
          {truncated ? (
            <button className="tool-card-toggle" onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'Show less' : `Show all ${lines.length} lines`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
