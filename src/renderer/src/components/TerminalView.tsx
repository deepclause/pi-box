import { useCallback, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { AppState } from '@shared/types'
import { PiMark, PlusIcon } from './icons'

interface Props {
  state: AppState | null
}

const TERMINAL_THEME = {
  background: '#0b0f16',
  foreground: '#dbe4f0',
  cursor: '#7aa2f7',
  cursorAccent: '#0b0f16',
  selectionBackground: '#2b3b5c',
  black: '#11151c',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5'
}

export default function TerminalView({ state }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const resizeTimerRef = useRef<number | null>(null)
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.25,
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
      theme: TERMINAL_THEME,
      scrollback: 10000,
      convertEol: false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()

    const unsubscribeOutput = window.pibox.onOutput((data) => {
      try {
        term.write(data)
      } catch {
        // ignore write errors
      }
    })

    const inputDisposable = term.onData((data) => {
      window.pibox.termInput(data)
    })

    termRef.current = term
    fitRef.current = fit

    const handleResize = (): void => {
      try {
        fit.fit()
      } catch {
        // container may be momentarily hidden
      }
      const size = { cols: term.cols, rows: term.rows }
      if (size.cols === lastSizeRef.current.cols && size.rows === lastSizeRef.current.rows) return
      lastSizeRef.current = size

      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = window.setTimeout(() => {
        window.pibox.termResize(size.cols, size.rows)
      }, 250)
    }

    const observer = new ResizeObserver(handleResize)
    observer.observe(container)

    return () => {
      observer.disconnect()
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current)
      unsubscribeOutput()
      inputDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    if (state?.status === 'ready' && termRef.current && fitRef.current) {
      try {
        fitRef.current.fit()
      } catch {
        // ignore
      }
      termRef.current.focus()
      window.pibox.termResize(termRef.current.cols, termRef.current.rows)
    }
  }, [state?.status])

  // tmux handles multiplexing natively; "new shell" = tmux prefix + c.
  const newShell = useCallback(() => {
    window.pibox.termInput('\x02c')
  }, [])

  return (
    <section className="terminal-pane">
      <header className="terminal-header">
        <div className="terminal-header-left">
          <PiMark size={16} className="pi-mark" />
          <span className="terminal-title">pi</span>
          <span className="status-pill" data-status={state?.status ?? 'loading'}>
            <span className="status-dot" data-status={state?.status ?? 'loading'} />
            {state?.status === 'ready' ? 'ready' : state?.status === 'error' ? 'error' : state?.status === 'stopped' ? 'stopped' : 'starting'}
          </span>
        </div>
        <span className="mount-label" title={state?.activeMountPath ?? undefined}>
          <button className="icon-btn accent" title="New shell window (Ctrl+B c)" onClick={newShell}>
            <PlusIcon size={14} />
          </button>
          <span className="mount-arrow">←</span>
          {state?.activeMountPath ?? 'no workspace'}
          <span className="mount-point">{state?.mountPoint ?? '/workspace'}</span>
        </span>
      </header>
      <div ref={containerRef} className="terminal-container" />
    </section>
  )
}
