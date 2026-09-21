import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildProviderBlock, writeLocalProvider, GUEST_GATEWAY_IP } from './pi-bridge'

const dirs: string[] = []

function tempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibox-pi-bridge-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, '.pi'), { recursive: true })
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('buildProviderBlock', () => {
  it('points pi at the guest gateway with the run token', () => {
    const block = buildProviderBlock({
      port: 8321,
      token: 'secret',
      models: [{ id: 'local/x', name: 'X', contextWindow: 8192 }]
    })
    expect(block.baseUrl).toBe(`http://${GUEST_GATEWAY_IP}:8321/v1`)
    expect(block.api).toBe('openai-completions')
    expect(block.apiKey).toBe('secret')
    expect((block.models as unknown[]).length).toBe(1)
  })
})

describe('writeLocalProvider', () => {
  it('upserts without clobbering user providers, then removes only its own', () => {
    const ws = tempWorkspace()
    const file = path.join(ws, '.pi', 'models.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ providers: { openai: { baseUrl: 'https://example.com' } } })
    )

    writeLocalProvider(ws, {
      port: 9000,
      token: 't',
      models: [{ id: 'local/x', name: 'X', contextWindow: 4096 }]
    })
    let parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(parsed.providers.openai).toEqual({ baseUrl: 'https://example.com' })
    expect(parsed.providers['pi-box-local']).toBeTruthy()

    writeLocalProvider(ws, null)
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(parsed.providers.openai).toEqual({ baseUrl: 'https://example.com' })
    expect(parsed.providers['pi-box-local']).toBeUndefined()
  })

  it('removes the file when it only ever held our provider', () => {
    const ws = tempWorkspace()
    const file = path.join(ws, '.pi', 'models.json')
    writeLocalProvider(ws, {
      port: 9000,
      token: 't',
      models: [{ id: 'local/x', name: 'X', contextWindow: 4096 }]
    })
    expect(fs.existsSync(file)).toBe(true)
    writeLocalProvider(ws, null)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('backs up a malformed file instead of destroying it', () => {
    const ws = tempWorkspace()
    const file = path.join(ws, '.pi', 'models.json')
    fs.writeFileSync(file, '{ not json')
    writeLocalProvider(ws, {
      port: 9000,
      token: 't',
      models: [{ id: 'local/x', name: 'X', contextWindow: 4096 }]
    })
    expect(fs.existsSync(`${file}.bak`)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(parsed.providers['pi-box-local']).toBeTruthy()
  })
})
