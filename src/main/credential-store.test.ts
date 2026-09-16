import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileCredentialStore } from './credential-store'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pibox-auth-'))
}

describe('FileCredentialStore', () => {
  it('round-trips a credential through modify/read/list/delete', async () => {
    const dir = tempDir()
    const authPath = path.join(dir, '.pi', 'auth.json')
    const store = new FileCredentialStore(authPath)

    expect(await store.list()).toEqual([])
    expect(await store.read('deepseek')).toBeUndefined()

    const written = await store.modify('deepseek', async () => ({ type: 'api_key', key: 'sk-1' }))
    expect(written).toEqual({ type: 'api_key', key: 'sk-1' })
    expect(await store.read('deepseek')).toEqual({ type: 'api_key', key: 'sk-1' })
    expect(await store.list()).toEqual([{ providerId: 'deepseek', type: 'api_key' }])

    await store.delete('deepseek')
    expect(await store.read('deepseek')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('leaves the entry unchanged when modify returns undefined', async () => {
    const dir = tempDir()
    const authPath = path.join(dir, 'auth.json')
    const store = new FileCredentialStore(authPath)

    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-a' }))
    const result = await store.modify('anthropic', async (current) => current)
    expect(result).toEqual({ type: 'api_key', key: 'sk-a' })
    expect(await store.read('anthropic')).toEqual({ type: 'api_key', key: 'sk-a' })
  })

  it('writes the primary file with 0600 permissions', async () => {
    if (process.platform === 'win32') return
    const dir = tempDir()
    const authPath = path.join(dir, 'auth.json')
    const store = new FileCredentialStore(authPath)
    await store.modify('groq', async () => ({ type: 'api_key', key: 'k' }))
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600)
  })

  it('mirrors writes to a second (shared) file', async () => {
    const dir = tempDir()
    const primary = path.join(dir, 'ws', 'auth.json')
    const mirror = path.join(dir, 'shared', 'auth.json')
    const store = new FileCredentialStore(primary, mirror)

    await store.modify('openai', async () => ({ type: 'api_key', key: 'sk-o' }))
    expect(JSON.parse(fs.readFileSync(mirror, 'utf8'))).toEqual({
      openai: { type: 'api_key', key: 'sk-o' }
    })

    await store.delete('openai')
    expect(JSON.parse(fs.readFileSync(mirror, 'utf8'))).toEqual({})
  })

  it('seeds a new workspace from the shared file', async () => {
    const dir = tempDir()
    const primary = path.join(dir, 'ws', 'auth.json')
    const mirror = path.join(dir, 'shared', 'auth.json')
    fs.mkdirSync(path.dirname(mirror), { recursive: true })
    fs.writeFileSync(mirror, JSON.stringify({ deepseek: { type: 'api_key', key: 'sk-seed' } }))

    const store = new FileCredentialStore(primary, mirror)
    expect(await store.read('deepseek')).toEqual({ type: 'api_key', key: 'sk-seed' })
    expect(fs.existsSync(primary)).toBe(true)
  })
})
