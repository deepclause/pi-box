import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export interface LlamaServerStartOptions {
  binary: string
  modelPath: string
  modelId: string
  port: number
  nCtx: number
  /** -1 = all layers on the GPU, 0 = CPU only. */
  nGpuLayers: number
  token: string
  onLog?: (line: string) => void
}

const MAX_LOG_LINES = 80
const HEALTH_TIMEOUT_MS = 120_000

function binaryNames(): string[] {
  return process.platform === 'win32' ? ['llama-server.exe', 'llama-server'] : ['llama-server']
}

function candidateDirs(): string[] {
  const home = os.homedir()
  return [
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin',
    '/opt/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    process.cwd()
  ]
}

/** Locate a native `llama-server` binary (settings path or PATH/common dirs). */
export function detectLlamaServerPath(hint?: string | null): string | null {
  if (hint) {
    try {
      if (fs.existsSync(hint) && fs.statSync(hint).isFile()) return hint
    } catch {
      // ignore
    }
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of [...dirs, ...candidateDirs()]) {
    for (const name of binaryNames()) {
      const candidate = path.join(dir, name)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
      } catch {
        // ignore
      }
    }
  }
  return null
}

/** Read `llama-server --version` (best effort). */
export async function readLlamaServerVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        child.kill()
        finish(null)
      }, 5000)
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()))
      child.on('error', () => {
        clearTimeout(timer)
        finish(null)
      })
      child.on('exit', () => {
        clearTimeout(timer)
        const match = /version:\s*([^\s]+)/i.exec(out)
        finish(match ? match[1] : out.trim().split('\n')[0] || null)
      })
    } catch {
      finish(null)
    }
  })
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Manages a native llama-server child process. The process is completely
 * optional and user-provided; it gives GPU acceleration on hardware that the
 * WebGPU path cannot use (and native tool calling via `--jinja`).
 */
export class LlamaServerManager {
  private child: ChildProcess | null = null
  private signature: string | null = null
  private _port: number | null = null
  private _version: string | null = null
  private logLines: string[] = []

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed
  }

  get port(): number | null {
    return this._port
  }

  get version(): string | null {
    return this._version
  }

  get log(): string {
    return this.logLines.join('\n')
  }

  async start(opts: LlamaServerStartOptions): Promise<void> {
    const signature = JSON.stringify({
      binary: opts.binary,
      modelPath: opts.modelPath,
      port: opts.port,
      nCtx: opts.nCtx,
      nGpuLayers: opts.nGpuLayers,
      modelId: opts.modelId
    })
    if (this.running && this.signature === signature) return

    await this.stop()
    this.logLines = []

    const ngl = opts.nGpuLayers < 0 ? 999 : opts.nGpuLayers
    const args = [
      '-m',
      opts.modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(opts.port),
      '-c',
      String(opts.nCtx),
      '-ngl',
      String(ngl),
      '--alias',
      opts.modelId,
      '--api-key',
      opts.token,
      '--jinja'
    ]

    const child = spawn(opts.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    const record = (chunk: Buffer): void => {
      for (const raw of chunk.toString().split(/\r?\n/)) {
        const line = raw.trimEnd()
        if (!line) continue
        this.logLines.push(line)
        if (this.logLines.length > MAX_LOG_LINES) this.logLines.shift()
        opts.onLog?.(line)
      }
    }
    child.stdout?.on('data', record)
    child.stderr?.on('data', record)

    let earlyExit: string | null = null
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null
        this._port = null
        this.signature = null
      }
      if (code !== 0 && code !== null) {
        earlyExit = `llama-server exited with code ${code}${signal ? ` (${signal})` : ''}`
      }
    })
    child.on('error', (error) => {
      earlyExit = `Failed to launch llama-server: ${error.message}`
    })

    // Wait for /health.
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (earlyExit) throw new Error(`${earlyExit}\n${this.log}`)
      if (!this.child) throw new Error(`llama-server stopped during startup\n${this.log}`)
      if (await isHealthy(opts.port)) {
        this._port = opts.port
        this.signature = signature
        this._version = await readLlamaServerVersion(opts.binary)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    const error = new Error(`Timed out waiting for llama-server on port ${opts.port}\n${this.log}`)
    await this.stop()
    throw error
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this._port = null
    this.signature = null
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}

/** Return `preferred` if it is free, otherwise an ephemeral free port. */
export function findFreePort(preferred: number): Promise<number> {
  const tryPort = (port: number): Promise<number | null> =>
    new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(null))
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        server.close(() => resolve(typeof address === 'object' && address ? address.port : null))
      })
    })
  return (async () => {
    const preferredPort = await tryPort(preferred)
    if (preferredPort) return preferredPort
    return (await tryPort(0)) ?? preferred
  })()
}
