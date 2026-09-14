import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { FileNode, Workspace } from '../shared/types'

const DEFAULT_WORKSPACE_DIR = path.join(os.homedir(), 'pi-box-workspace')
const MAX_ENTRIES_PER_DIR = 500
const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.venv', 'dist', 'out'])

/**
 * Guest-side helpers seeded into every workspace's `.pi`:
 *  - `tty-resize-daemon.py` applies the host-written `.pi/tty-size` to the VM
 *    console (TIOCSWINSZ), which tmux then propagates to pi.
 *  - `tmux.conf` is the app's base tmux config (mouse off so xterm selection
 *    works; power users can override via `.pi-box/config`).
 *
 * Multiplexing (extra shells) is handled natively by tmux, not by us.
 */
const TTY_RESIZE_DAEMON = String.raw`import fcntl, termios, struct, os, time, json

CONSOLE = '/dev/console'
SIZE_FILE = '/workspace/.pi/tty-size'

fd = os.open(CONSOLE, os.O_RDWR)
last = None
while True:
    try:
        with open(SIZE_FILE) as f:
            data = json.load(f)
        size = (int(data['rows']), int(data['cols']))
    except Exception:
        size = None
    if size and size != last:
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', size[0], size[1], 0, 0))
            last = size
        except Exception:
            pass
    time.sleep(1.0)
`

const TMUX_CONF = `set -g history-limit 10000
set -g default-terminal "xterm-256color"
set -g extended-keys on
set -g allow-passthrough on
`

/**
 * Per-workspace, user-editable startup config. Sourced by the guest shell
 * before tmux launches, so power users can export extra env vars or point
 * `PI_BOX_TMUX_CONF` at a custom tmux config. Never overwritten once created.
 */
const PIBOX_CONFIG = `# pi-box startup config — sourced before tmux launches.
# This file is yours to edit; the app never overwrites it.
#
# Environment variables set here are inherited by tmux and pi:
#   export PI_TRUE_COLOR=1
#   export MY_CUSTOM_VAR=hello
#
# Use a custom tmux config (optional). Leave unset to use the app default
# /workspace/.pi/tmux.conf:
#   PI_BOX_TMUX_CONF=/workspace/.pi-box/tmux.conf
`

interface StoreShape {
  version: number
  lastActiveId: string | null
  workspaces: Workspace[]
}

function storeFile(): string {
  return path.join(app.getPath('userData'), 'workspaces.json')
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export class WorkspaceStore {
  private data: StoreShape = { version: 1, lastActiveId: null, workspaces: [] }

  init(): void {
    const file = storeFile()
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoreShape>
        this.data = {
          version: 1,
          lastActiveId: parsed.lastActiveId ?? null,
          workspaces: Array.isArray(parsed.workspaces) ? (parsed.workspaces as Workspace[]) : []
        }
      }
    } catch (err) {
      console.error('Failed to read workspace store:', err)
      this.data = { version: 1, lastActiveId: null, workspaces: [] }
    }

    this.ensureDefaultWorkspace()
    this.save()

    // Restore last active workspace if it still exists.
    const active = this.data.workspaces.find((w) => w.id === this.data.lastActiveId)
    if (!active) {
      const def = this.data.workspaces.find((w) => w.isDefault)
      this.data.lastActiveId = def?.id ?? this.data.workspaces[0]?.id ?? null
      this.save()
    }

    for (const ws of this.data.workspaces) {
      this.ensurePiDir(ws.id)
      this.ensureConfig(ws.id)
    }
  }

  private ensureDefaultWorkspace(): void {
    const existing = this.data.workspaces.find((w) => w.isDefault)
    if (existing) return

    try {
      fs.mkdirSync(DEFAULT_WORKSPACE_DIR, { recursive: true })
    } catch (err) {
      console.error('Failed to create default workspace dir:', err)
    }

    this.data.workspaces.unshift({
      id: randomUUID(),
      name: 'Default',
      path: DEFAULT_WORKSPACE_DIR,
      isDefault: true,
      createdAt: Date.now()
    })
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
      fs.writeFileSync(storeFile(), JSON.stringify(this.data, null, 2), 'utf8')
    } catch (err) {
      console.error('Failed to write workspace store:', err)
    }
  }

  list(): Workspace[] {
    return [...this.data.workspaces]
  }

  get(id: string): Workspace | undefined {
    return this.data.workspaces.find((w) => w.id === id)
  }

  getActive(): Workspace | undefined {
    return this.data.workspaces.find((w) => w.id === this.data.lastActiveId)
  }

  add(dirPath: string): Workspace {
    const resolved = path.resolve(dirPath)

    const existing = this.data.workspaces.find((w) => path.resolve(w.path) === resolved)
    if (existing) {
      this.data.lastActiveId = existing.id
      this.save()
      return existing
    }

    const ws: Workspace = {
      id: randomUUID(),
      name: path.basename(resolved) || resolved,
      path: resolved,
      isDefault: false,
      createdAt: Date.now()
    }
    this.data.workspaces.push(ws)
    this.data.lastActiveId = ws.id
    this.save()
    this.ensurePiDir(ws.id)
    this.ensureConfig(ws.id)
    return ws
  }

  remove(id: string): boolean {
    const ws = this.get(id)
    if (!ws || ws.isDefault) return false

    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id)
    if (this.data.lastActiveId === id) {
      const def = this.data.workspaces.find((w) => w.isDefault)
      this.data.lastActiveId = def?.id ?? this.data.workspaces[0]?.id ?? null
    }
    this.save()
    return true
  }

  setActive(id: string): boolean {
    if (!this.get(id)) return false
    this.data.lastActiveId = id
    this.save()
    this.ensurePiDir(id)
    this.ensureConfig(id)
    return true
  }

  /**
   * Make sure the workspace has a `.pi` directory with a starter settings.json
   * (project trust + model defaults live here) and a sessions directory, so pi
   * keeps config and sessions inside the workspace across reboots.
   */
  ensurePiDir(id: string): void {
    const ws = this.get(id)
    if (!ws) return

    const piDir = path.join(ws.path, '.pi')
    try {
      fs.mkdirSync(path.join(piDir, 'sessions'), { recursive: true })

      const settingsPath = path.join(piDir, 'settings.json')
      if (!fs.existsSync(settingsPath)) {
        fs.writeFileSync(settingsPath, JSON.stringify({ defaultProjectTrust: 'always' }, null, 2) + '\n', 'utf8')
      }

      // App-owned infrastructure: always refresh so fixes propagate to
      // existing workspaces.
      const daemonPath = path.join(piDir, 'tty-resize-daemon.py')
      fs.writeFileSync(daemonPath, TTY_RESIZE_DAEMON, 'utf8')

      const tmuxConfPath = path.join(piDir, 'tmux.conf')
      fs.writeFileSync(tmuxConfPath, TMUX_CONF, 'utf8')

      // Remove the old PTY-supervisor helper seeded by earlier builds.
      const legacySupervisor = path.join(piDir, 'tty-supervisor.py')
      if (fs.existsSync(legacySupervisor)) {
        fs.rmSync(legacySupervisor, { force: true })
      }

      const sizePath = path.join(piDir, 'tty-size')
      if (!fs.existsSync(sizePath)) {
        fs.writeFileSync(sizePath, JSON.stringify({ cols: 100, rows: 30 }), 'utf8')
      }
    } catch (err) {
      console.error('Failed to prepare .pi directory:', err)
    }
  }

  /**
   * Seed the user-editable `.pi-box/config` startup file. Unlike `.pi/*`, this
   * file is created once and never refreshed, so user edits survive restarts.
   */
  ensureConfig(id: string): void {
    const ws = this.get(id)
    if (!ws) return

    try {
      const boxDir = path.join(ws.path, '.pi-box')
      fs.mkdirSync(boxDir, { recursive: true })
      const configPath = path.join(boxDir, 'config')
      if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, PIBOX_CONFIG, 'utf8')
      }
    } catch (err) {
      console.error('Failed to prepare .pi-box config:', err)
    }
  }

  /** Write the desired terminal size for a workspace's VM console. */
  writeTtySize(id: string, cols: number, rows: number): void {
    const ws = this.get(id)
    if (!ws) return
    try {
      fs.writeFileSync(path.join(ws.path, '.pi', 'tty-size'), JSON.stringify({ cols, rows }), 'utf8')
    } catch (err) {
      console.error('Failed to write tty-size:', err)
    }
  }

  /**
   * Return the children of a directory inside a workspace. `dirPath` defaults
   * to the workspace root and is validated to stay inside the workspace.
   */
  readTree(workspaceId: string, dirPath?: string): FileNode[] {
    const ws = this.get(workspaceId)
    if (!ws) return []

    const base = path.resolve(ws.path)
    const dir = dirPath ? path.resolve(dirPath) : base
    if (!isWithin(base, dir)) return []

    return this.readDir(dir)
  }

  private readDir(dir: string): FileNode[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }

    const visible = entries
      .filter((e) => !IGNORED_DIR_NAMES.has(e.name))
      .sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1
        const bDir = b.isDirectory() ? 0 : 1
        if (aDir !== bDir) return aDir - bDir
        return a.name.localeCompare(b.name)
      })
      .slice(0, MAX_ENTRIES_PER_DIR)

    const nodes: FileNode[] = []
    for (const entry of visible) {
      const full = path.join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          nodes.push({ name: entry.name, path: full, type: 'directory', children: null })
        } else if (entry.isFile()) {
          nodes.push({ name: entry.name, path: full, type: 'file' })
        } else if (entry.isSymbolicLink()) {
          // Avoid following symlinks; show them as leaf entries.
          nodes.push({ name: entry.name, path: full, type: 'file' })
        }
      } catch {
        // skip unreadable entries
      }
    }
    return nodes
  }
}
