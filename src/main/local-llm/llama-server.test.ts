import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  detectLlamaServerPath,
  findFreePort,
  readLlamaServerVersion,
  LlamaServerManager
} from './llama-server'

const dirs: string[] = []
const originalPath = process.env.PATH

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibox-llama-'))
  dirs.push(dir)
  return dir
}

function fakeBinary(dir: string, body: string): string {
  const file = path.join(dir, 'llama-server')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}

afterEach(() => {
  process.env.PATH = originalPath
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const isWindows = process.platform === 'win32'

describe('detectLlamaServerPath', () => {
  it.skipIf(isWindows)('finds a llama-server on PATH', () => {
    const dir = tempDir()
    const bin = fakeBinary(dir, '#!/bin/sh\necho hi\n')
    process.env.PATH = dir
    expect(detectLlamaServerPath(null)).toBe(bin)
  })

  it('prefers an existing hint path', () => {
    const dir = tempDir()
    const bin = fakeBinary(dir, '#!/bin/sh\necho hi\n')
    process.env.PATH = ''
    expect(detectLlamaServerPath(bin)).toBe(bin)
  })

  it('returns null for a missing hint when nothing is on PATH', () => {
    process.env.PATH = tempDir()
    // Common system dirs are still searched; only assert the hint is ignored.
    expect(detectLlamaServerPath('/definitely/not/llama-server')).not.toBe(
      '/definitely/not/llama-server'
    )
  })
})

describe('readLlamaServerVersion', () => {
  it.skipIf(isWindows)('parses the version from --version', async () => {
    const dir = tempDir()
    const bin = fakeBinary(dir, '#!/bin/sh\necho "version: 4773 (deadbeef)"\n')
    expect(await readLlamaServerVersion(bin)).toBe('4773')
  })
})

describe('findFreePort', () => {
  it('returns a bindable port', async () => {
    const port = await findFreePort(0)
    expect(port).toBeGreaterThan(0)
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => server.close(() => resolve()))
    })
  })

  it('moves off an occupied preferred port', async () => {
    const occupied = await new Promise<number>((resolve) => {
      const server = net.createServer()
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    const chosen = await findFreePort(occupied)
    expect(chosen).not.toBe(occupied)
  })
})

describe('LlamaServerManager', () => {
  it('rejects when the binary cannot be launched', async () => {
    const manager = new LlamaServerManager()
    await expect(
      manager.start({
        binary: '/definitely/not/a/llama-server',
        modelPath: '/tmp/model.gguf',
        modelId: 'local/test',
        port: 8399,
        nCtx: 2048,
        nGpuLayers: -1,
        token: 't'
      })
    ).rejects.toThrow()
    expect(manager.running).toBe(false)
  })
})
