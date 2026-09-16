import fs from 'node:fs'
import path from 'node:path'

/** Workspace-relative directory where attached files are copied. */
export const ATTACHMENTS_DIR = '.pi-box/attachments'

/** Refuse to shuttle enormous files through IPC. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/**
 * Make a user-supplied file name safe for the workspace mount: drop any
 * directory components, keep an alphanumeric/._- surface, and bound the length.
 */
export function sanitizeAttachmentName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/[\s_]+/g, '_')
  const trimmed = base.replace(/^[._]+/, '').slice(0, 120)
  return trimmed || 'file'
}

export interface SavedAttachment {
  /** Absolute host path of the copy. */
  hostPath: string
  /** Workspace-relative path (POSIX separators), e.g. `.pi-box/attachments/…`. */
  relative: string
  size: number
}

/**
 * Copy an attached file into the workspace so the VM's pi can read it. Names
 * are stamped to avoid collisions and exposed as a stable path in the prompt.
 */
export function saveAttachment(workspacePath: string, name: string, bytes: Buffer): SavedAttachment {
  const dir = path.join(workspacePath, '.pi-box', 'attachments')
  fs.mkdirSync(dir, { recursive: true })
  const stamped = `${Date.now()}-${sanitizeAttachmentName(name)}`
  const hostPath = path.join(dir, stamped)
  fs.writeFileSync(hostPath, bytes)
  return {
    hostPath,
    relative: path.posix.join(ATTACHMENTS_DIR, stamped),
    size: bytes.byteLength
  }
}
