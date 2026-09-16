import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeAttachmentName, saveAttachment } from './attachments'

describe('sanitizeAttachmentName', () => {
  it('strips directory components', () => {
    expect(sanitizeAttachmentName('/etc/passwd')).toBe('passwd')
    expect(sanitizeAttachmentName('../../secret.txt')).toBe('secret.txt')
  })

  it('replaces unsafe characters and spaces', () => {
    expect(sanitizeAttachmentName('Q3 report (final).pdf')).toBe('Q3_report_final_.pdf')
  })

  it('falls back for empty / dot-only names', () => {
    expect(sanitizeAttachmentName('')).toBe('file')
    expect(sanitizeAttachmentName('...')).toBe('file')
  })

  it('bounds the length', () => {
    expect(sanitizeAttachmentName('a'.repeat(300)).length).toBe(120)
  })
})

describe('saveAttachment', () => {
  it('copies bytes into .pi-box/attachments and returns paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibox-attach-'))
    const saved = saveAttachment(dir, 'notes.txt', Buffer.from('hello world'))

    expect(saved.size).toBe(11)
    expect(saved.relative.startsWith('.pi-box/attachments/')).toBe(true)
    expect(fs.readFileSync(saved.hostPath, 'utf8')).toBe('hello world')
    expect(path.resolve(saved.hostPath).startsWith(path.resolve(dir))).toBe(true)
  })

  it('keeps the extension so the agent can identify the format', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibox-attach-'))
    const saved = saveAttachment(dir, 'book.xlsx', Buffer.from([0x50, 0x4b]))
    expect(saved.hostPath.endsWith('.xlsx')).toBe(true)
  })
})
