import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { drainJsonl, normalizeStats, summarizeSession } from './rpc'

describe('drainJsonl', () => {
  it('splits LF records and keeps the remainder', () => {
    expect(drainJsonl('', 'a\nb\npar')).toEqual({ lines: ['a', 'b'], rest: 'par' })
  })

  it('strips a trailing carriage return', () => {
    expect(drainJsonl('', 'a\r\n')).toEqual({ lines: ['a'], rest: '' })
  })

  it('does not split on U+2028 / U+2029', () => {
    const { lines } = drainJsonl('', '{"text":"a\u2028b\u2029c"}\n')
    expect(lines).toEqual(['{"text":"a\u2028b\u2029c"}'])
  })

  it('continues a partial record across chunks', () => {
    expect(drainJsonl('par', 'tial\n')).toEqual({ lines: ['partial'], rest: '' })
  })

  it('skips empty records', () => {
    expect(drainJsonl('', '\n\n')).toEqual({ lines: [], rest: '' })
  })
})

describe('normalizeStats', () => {
  it('maps tokens, cost and context usage', () => {
    expect(
      normalizeStats({
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        cost: 0.5,
        contextUsage: { tokens: 5, contextWindow: 100, percent: 5 }
      })
    ).toEqual({
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      cost: 0.5,
      contextUsage: { tokens: 5, contextWindow: 100, percent: 5 }
    })
  })

  it('falls back to totalTokens and tolerates missing data', () => {
    expect(normalizeStats({ tokens: { totalTokens: 7 } }).tokens?.total).toBe(7)
    expect(normalizeStats(undefined)).toEqual({ tokens: undefined, cost: undefined, contextUsage: null })
  })
})

describe('summarizeSession', () => {
  it('reads the id, first user message title and marks active false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-box-test-'))
    const file = path.join(dir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id: 'abc', version: 3 }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Build a todo app' }] } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] } })
      ].join('\n') + '\n'
    )
    const summary = summarizeSession(file, 's.jsonl')
    expect(summary.id).toBe('abc')
    expect(summary.title).toBe('Build a todo app')
    expect(summary.file).toBe('/workspace/.pi/sessions/s.jsonl')
    expect(summary.active).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('handles a name entry and empty sessions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-box-test-'))
    const named = path.join(dir, 'named.jsonl')
    fs.writeFileSync(named, [JSON.stringify({ type: 'session', id: 'n1' }), JSON.stringify({ type: 'session_name', name: 'My session' })].join('\n'))
    expect(summarizeSession(named, 'named.jsonl').name).toBe('My session')

    const empty = path.join(dir, 'empty.jsonl')
    fs.writeFileSync(empty, JSON.stringify({ type: 'session', id: 'e1' }) + '\n')
    expect(summarizeSession(empty, 'empty.jsonl').title).toBe('Empty session')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
