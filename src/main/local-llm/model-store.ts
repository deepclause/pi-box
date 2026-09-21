import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { LOCAL_MODEL_CATALOG, findCatalogEntry, huggingFaceDownloadUrl } from './catalog'
import type { LocalModelCatalogEntry, LocalModelInfo } from '../../shared/local-llm-types'

interface StoredModel {
  id: string
  file: string
  bytes: number
  downloadedAt: number
}

type ModelIndex = Record<string, StoredModel>

/** Only these file names may be requested through the asset protocol. */
const SAFE_FILE = /^[A-Za-z0-9._-]+$/

export class LocalModelStore {
  private index: ModelIndex = {}

  constructor(private readonly dir: string) {}

  get modelsDir(): string {
    return this.dir
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    this.index = await this.readIndex()
  }

  private indexPath(): string {
    return path.join(this.dir, 'index.json')
  }

  private async readIndex(): Promise<ModelIndex> {
    try {
      const raw = await fsp.readFile(this.indexPath(), 'utf8')
      const parsed = JSON.parse(raw) as ModelIndex
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  private async writeIndex(): Promise<void> {
    await fsp.writeFile(this.indexPath(), JSON.stringify(this.index, null, 2) + '\n', 'utf8')
  }

  /** Absolute path for a stored model file (validated). */
  pathForFile(file: string): string | null {
    if (!SAFE_FILE.test(file)) return null
    const resolved = path.resolve(this.dir, file)
    if (path.dirname(resolved) !== path.resolve(this.dir)) return null
    return resolved
  }

  pathForId(id: string): string | null {
    const entry = findCatalogEntry(id)
    if (!entry) return null
    return this.pathForFile(entry.file)
  }

  isInstalled(id: string): boolean {
    const p = this.pathForId(id)
    return !!p && fs.existsSync(p)
  }

  /** Merge the catalog with what is on disk. */
  list(): LocalModelInfo[] {
    return LOCAL_MODEL_CATALOG.map((entry) => {
      const p = this.pathForId(entry.id)
      let bytes: number | undefined
      try {
        if (p && fs.existsSync(p)) bytes = fs.statSync(p).size
      } catch {
        bytes = undefined
      }
      return {
        ...entry,
        installed: bytes !== undefined,
        path: bytes !== undefined ? p ?? undefined : undefined,
        bytes
      }
    })
  }

  catalog(): LocalModelCatalogEntry[] {
    return LOCAL_MODEL_CATALOG
  }

  async freeBytes(): Promise<number> {
    try {
      const stats = await fsp.statfs(this.dir, { bigint: true })
      return Number(stats.bavail * stats.bsize)
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }

  /**
   * Download a catalog entry to `<modelsDir>/<file>.part`, then rename it into
   * place. Reports progress and honours an AbortSignal.
   */
  async download(
    entry: LocalModelCatalogEntry,
    opts: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {}
  ): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    const target = this.pathForFile(entry.file)
    if (!target) throw new Error(`Unsafe model file name: ${entry.file}`)

    const partial = `${target}.part`
    const response = await fetch(huggingFaceDownloadUrl(entry), {
      signal: opts.signal,
      redirect: 'follow'
    })
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`)
    }

    const totalHeader = response.headers.get('content-length')
    const total = totalHeader ? Number(totalHeader) : entry.approxBytes
    let received = 0

    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      opts.onProgress?.(received, total)
    })

    try {
      await pipeline(source, fs.createWriteStream(partial))
    } catch (error) {
      await fsp.rm(partial, { force: true }).catch(() => undefined)
      throw error
    }

    await fsp.rename(partial, target)
    this.index[entry.id] = {
      id: entry.id,
      file: entry.file,
      bytes: received,
      downloadedAt: Date.now()
    }
    await this.writeIndex()
  }

  async remove(id: string): Promise<void> {
    const p = this.pathForId(id)
    if (p) await fsp.rm(p, { force: true }).catch(() => undefined)
    delete this.index[id]
    await this.writeIndex()
  }
}
