import { EventEmitter } from 'node:events'
import { AgentVM } from 'deepclause-agentvm'
import type { VmStatus } from '../shared/types'

// busybox ash queries the terminal for the cursor position once its prompt is
// interactive. This tells us the shell is ready to receive the startup script.
const SHELL_READY_MARKER = '\x1b[6n'
// Answer to the cursor-position query (DSR). Without it the shell can consume
// the first bytes of the startup script as the query's response, so the
// script's first line arrives unbalanced and ash reports
// `syntax error: unexpected ")"` (seen on macOS/Windows release builds).
const DSR_RESPONSE = '\x1b[1;1R'
// pi's TUI shows this startup-help hint once it has finished rendering. tmux
// consumes pi's OSC title escape, so we can't use the old `π - …` marker. The
// footer text is a second, always-visible signal.
const PI_READY_MARKERS = ['Press ctrl+o', 'ctrl+c/ctrl+d']

type Phase = 'booting' | 'starting' | 'ready'

/**
 * Owns the AgentVM instance. Runs it in interactive/raw mode, then injects a
 * startup script that brings the network up and launches `pi` with its config
 * and sessions rooted in the mounted workspace's `.pi` directory.
 *
 * Emits:
 *  - 'status' (status: VmStatus, message: string)
 *  - 'output' (text: string) — decoded console output
 */
export class VmManager extends EventEmitter {
  private vm: AgentVM | null = null
  private stopping = false
  private decoder = new TextDecoder('utf-8')
  private scanBuffer = ''
  private phase: Phase = 'booting'
  private startToken = 0
  private readyFallback: ReturnType<typeof setTimeout> | null = null
  private shellWaitTimer: ReturnType<typeof setTimeout> | null = null

  private _status: VmStatus = 'loading'
  private _statusMessage = 'Starting…'

  get status(): VmStatus {
    return this._status
  }

  get statusMessage(): string {
    return this._statusMessage
  }

  private setStatus(status: VmStatus, message?: string): void {
    this._status = status
    if (message !== undefined) this._statusMessage = message
    this.emit('status', status, this._statusMessage)
  }

  async start(mounts: Record<string, string>, options: { network?: boolean } = {}): Promise<void> {
    const token = ++this.startToken

    await this.stop()
    this.stopping = false
    this.phase = 'booting'
    this.scanBuffer = ''
    this.decoder = new TextDecoder('utf-8')
    this.setStatus('loading', 'Booting AgentVM…')

    const network = options.network !== false
    const mountPoint = Object.keys(mounts)[0] ?? '/workspace'

    const vm = new AgentVM({
      network,
      interactive: true,
      mounts
    })

    vm.onStdout = (data: Uint8Array) => this.handleOutput(token, data)
    vm.onStderr = (data: Uint8Array) => this.handleOutput(token, data)
    vm.onExit = (error?: string) => {
      if (token !== this.startToken || this.stopping) return
      if (this.phase !== 'ready') {
        this.setStatus('error', error ? `VM exited: ${error}` : 'VM exited during startup')
      } else {
        this.setStatus('stopped', error ? `pi exited: ${error}` : 'pi exited')
      }
    }

    this.vm = vm
    try {
      await vm.start()
      if (token !== this.startToken || this.stopping) return

      // Wait for the shell prompt to appear before typing into it. This keeps
      // the boot output visible and lets us show a "Starting pi…" state.
      await this.waitForShellReady(30_000, token)
      if (token !== this.startToken || this.stopping) return

      // Answer the shell's cursor-position query first, so it finishes that
      // read and returns to the prompt before consuming the startup script.
      await this.write(DSR_RESPONSE)
      // The script is consumed by the shell once it reads stdin.
      await this.write(this.buildStartupScript(mountPoint, network))
      this.scheduleReadyFallback(token)
    } catch (err) {
      if (token !== this.startToken) return
      this.setStatus('error', err instanceof Error ? err.message : String(err))
    }
  }

  /** Send raw bytes/keys to the VM console. */
  write(data: string | Uint8Array): Promise<void> {
    return this.vm ? this.vm.writeToStdin(data) : Promise.resolve()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearReadyFallback()
    if (this.vm) {
      const vm = this.vm
      this.vm = null
      try {
        await vm.stop()
      } catch {
        // ignore stop errors
      }
    }
    this.setStatus('stopped', 'Stopped')
  }

  private buildStartupScript(mountPoint: string, network: boolean): string {
    const piDir = `${mountPoint}/.pi`
    const lines: string[] = []

    if (network) {
      // Bring the NIC up in the background so the pi terminal stays clean.
      lines.push('(ip link set eth0 up; udhcpc -i eth0 -s /sbin/udhcpc.script >/dev/null 2>&1) &')
    }

    lines.push(`mkdir -p ${piDir}/sessions`)
    lines.push(`export PI_CODING_AGENT_DIR=${piDir}`)
    lines.push(`export PI_CODING_AGENT_SESSION_DIR=${piDir}/sessions`)
    // PI_OFFLINE skips pi's slow startup network ops (version check, fd/ripgrep
    // download, model-catalog refresh) so the TUI appears in ~40s instead of
    // minutes. It does not disable provider/model API calls later.
    lines.push('export PI_OFFLINE=1')
    lines.push('export PI_SKIP_VERSION_CHECK=1')
    lines.push('export PI_TELEMETRY=0')
    lines.push('export LANG=C.UTF-8')
    lines.push(`cd ${mountPoint}`)
    // Guest-side resize daemon (TIOCSWINSZ on the console). tmux then
    // propagates the size to pi. Multiplexing is handled by tmux itself.
    lines.push(`python3 ${piDir}/tty-resize-daemon.py &`)
    lines.push(`tmux -f ${piDir}/tmux.conf new-session -s pi -n pi pi`)

    return lines.join('\n') + '\n'
  }

  private handleOutput(token: number, data: Uint8Array): void {
    if (token !== this.startToken) return

    const text = this.decoder.decode(data, { stream: true })
    this.emit('output', text)

    // Search a small carry buffer + the FULL current chunk. We must search the
    // whole chunk: a single VM write can be larger than the carry buffer, and
    // slicing first would drop markers that appear early in a large chunk.
    const combined = this.scanBuffer + text
    this.scanBuffer = combined.slice(-128)

    if (this.phase === 'booting' && combined.includes(SHELL_READY_MARKER)) {
      this.enterStartingPhase()
    } else if (this.phase === 'starting' && PI_READY_MARKERS.some((m) => combined.includes(m))) {
      this.markReady(token)
    }
  }

  private enterStartingPhase(): void {
    this.phase = 'starting'
    this.setStatus('loading', 'Starting pi…')
  }

  private waitForShellReady(timeoutMs: number, token: number): Promise<void> {
    return new Promise((resolve) => {
      const tick = (): void => {
        if (token !== this.startToken || this.phase !== 'booting' || this.stopping) {
          resolve()
          return
        }
        if (Date.now() >= startedAt + timeoutMs) {
          // The prompt marker never showed up; proceed anyway.
          this.enterStartingPhase()
          resolve()
          return
        }
        this.shellWaitTimer = setTimeout(tick, 100)
      }
      const startedAt = Date.now()
      tick()
    })
  }

  private markReady(token: number): void {
    if (token !== this.startToken || this.phase === 'ready') return
    this.phase = 'ready'
    this.clearReadyFallback()
    this.setStatus('ready')
  }

  private scheduleReadyFallback(token: number): void {
    this.clearReadyFallback()
    // Marker detection usually fires within ~30s of pi launch. The fallback
    // guarantees the splash never hangs forever even if markers change.
    this.readyFallback = setTimeout(() => {
      this.readyFallback = null
      if (token === this.startToken && this.phase !== 'ready' && !this.stopping) {
        this.markReady(token)
      }
    }, 150_000)
  }

  private clearReadyFallback(): void {
    if (this.readyFallback) {
      clearTimeout(this.readyFallback)
      this.readyFallback = null
    }
  }
}
