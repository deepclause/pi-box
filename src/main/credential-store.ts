import fs from 'node:fs'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'

type AuthFile = Record<string, Credential>

/** pi writes auth.json with 0600; same for us. */
const WRITE_OPTIONS = { encoding: 'utf-8' as const, mode: 0o600 }

function ensureDir(file: string): void {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function readAuthFile(file: string): AuthFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as AuthFile
  } catch {
    // Missing or corrupt: treat as empty. pi will reject a corrupt file too.
  }
  return {}
}

/**
 * A pi-ai `CredentialStore` backed by the workspace's `.pi/auth.json`.
 *
 * It mirrors pi's own `AuthStorage`: flat `{ providerId: Credential }` JSON,
 * `0600` mode, and `proper-lockfile` locking on the same path, so the host and
 * the VM's pi can safely read/write the same file (pi refreshes OAuth tokens
 * inside the VM while pi-box performs logins on the host).
 *
 * An optional `mirrorPath` keeps a second copy in sync (the app-wide account
 * file) so new workspaces can be seeded with existing credentials.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly paths: string[]

  constructor(
    private readonly primaryPath: string,
    private readonly mirrorPath?: string
  ) {
    this.paths =
      mirrorPath && mirrorPath !== primaryPath ? [primaryPath, mirrorPath] : [primaryPath]
    this.seedFromMirror()
  }

  /** Seed a brand-new workspace from the shared account file, if present. */
  private seedFromMirror(): void {
    if (this.paths.length < 2) return
    if (fs.existsSync(this.primaryPath)) return
    const mirror = this.paths[1]
    if (!fs.existsSync(mirror)) return
    try {
      ensureDir(this.primaryPath)
      fs.copyFileSync(mirror, this.primaryPath)
      fs.chmodSync(this.primaryPath, 0o600)
    } catch {
      // Best effort; login will recreate it.
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    ensureDir(this.primaryPath)
    if (!fs.existsSync(this.primaryPath)) fs.writeFileSync(this.primaryPath, '{}', WRITE_OPTIONS)
    const release = await lockfile.lock(this.primaryPath, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 8, minTimeout: 25, maxTimeout: 250 }
    })
    try {
      return await fn()
    } finally {
      await release().catch(() => {
        // Lock release is best effort.
      })
    }
  }

  private writeAll(data: AuthFile): void {
    const text = JSON.stringify(data, null, 2) + '\n'
    for (const file of this.paths) {
      ensureDir(file)
      fs.writeFileSync(file, text, WRITE_OPTIONS)
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return readAuthFile(this.primaryPath)[providerId]
  }

  /** Credential metadata only — never resolves or exposes secrets. */
  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(readAuthFile(this.primaryPath)).map(([providerId, credential]) => ({
      providerId,
      type: credential.type
    }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return this.withLock(async () => {
      const data = readAuthFile(this.primaryPath)
      const next = await fn(data[providerId])
      if (next === undefined) return data[providerId]
      data[providerId] = next
      this.writeAll(data)
      return next
    })
  }

  async delete(providerId: string): Promise<void> {
    await this.withLock(async () => {
      const data = readAuthFile(this.primaryPath)
      if (!(providerId in data)) return
      delete data[providerId]
      this.writeAll(data)
    })
  }
}
