import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import type { AppState } from '@shared/types'

interface Props {
  state: AppState | null
}

const TERMINAL_THEME = {
  background: '#141416',
  foreground: '#d8d8dc',
  cursor: '#8aa0e8',
  cursorAccent: '#141416',
  selectionBackground: '#3a3a42',
  black: '#1c1c1f',
  red: '#e8757f',
  green: '#7fc98a',
  yellow: '#e0b060',
  blue: '#7c9cf5',
  magenta: '#b48ee0',
  cyan: '#6fc3e0',
  white: '#d8d8dc'
}

export default function TerminalView({ state }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const resizeTimerRef = useRef<number | null>(null)
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const copySelection = useCallback(() => {
    const term = termRef.current
    if (!term) return
    const selection = term.getSelection()
    if (!selection) return
    window.pibox.clipboardWriteText(selection).catch((err) => console.error('copy failed', err))
  }, [])

  const pasteClipboard = useCallback(() => {
    const term = termRef.current
    if (!term) return
    void window.pibox
      .clipboardReadText()
      .then((text) => {
        if (text) term.paste(text)
      })
      .catch(() => {
        // ignore clipboard read errors
      })
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      fontWeight: 400,
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace',
      theme: TERMINAL_THEME,
      scrollback: 10000,
      convertEol: false,
      linkHandler: {
        activate: (_event, text) => {
          const url = text.trim()
          if (/^https?:\/\//i.test(url)) window.pibox.openExternal(url)
        }
      }
    })
    const fit = new FitAddon()
    const imageAddon = new ImageAddon()
    term.loadAddon(fit)
    term.loadAddon(imageAddon)
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

    const isMac = window.pibox.platform === 'darwin'

    // Normalize copy/paste across platforms without hijacking plain Ctrl+C
    // (which stays SIGINT to the TTY). xterm invokes this handler for keydown,
    // keyup, AND keypress, so only act on keydown — otherwise paste fires twice.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const key = event.key.toLowerCase()

      // Copy
      if (isMac && event.metaKey && !event.ctrlKey && !event.shiftKey && key === 'c') {
        copySelection()
        return false
      }
      if (event.ctrlKey && event.shiftKey && key === 'c') {
        copySelection()
        return false
      }
      // Ctrl+C with a selection copies (Windows Terminal convention); plain
      // Ctrl+C still reaches the TTY as SIGINT.
      if (!isMac && event.ctrlKey && !event.shiftKey && key === 'c') {
        if (term.hasSelection()) {
          copySelection()
          return false
        }
        return true
      }

      // Paste: handle shortcuts ourselves. Electron's DOM `paste` event has
      // an empty clipboardData, so xterm's native paste is suppressed by the
      // capture-phase listener below.
      if (isMac && event.metaKey && !event.ctrlKey && !event.shiftKey && key === 'v') {
        pasteClipboard()
        return false
      }
      if (event.ctrlKey && event.shiftKey && key === 'v') {
        pasteClipboard()
        return false
      }
      if (!isMac && event.ctrlKey && !event.shiftKey && key === 'v') {
        pasteClipboard()
        return false
      }
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && key === 'insert') {
        pasteClipboard()
        return false
      }

      return true
    })

    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY })
    }
    container.addEventListener('contextmenu', onContextMenu)

    // Suppress xterm's native `paste` DOM listener. In Electron its
    // clipboardData is empty, so native paste is a no-op at best and a
    // duplicate at worst. Pasting is done via the key handler / context menu.
    const onPaste = (e: ClipboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    container.addEventListener('paste', onPaste, true)

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
      container.removeEventListener('contextmenu', onContextMenu)
      container.removeEventListener('paste', onPaste, true)
      unsubscribeOutput()
      inputDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [copySelection, pasteClipboard])

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

  return (
    <section className="terminal-pane">
      <div ref={containerRef} className="terminal-container" />

      {menu && (
        <div
          className="context-menu-overlay"
          onClick={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu(null)
          }}
        >
          <div
            className="context-menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="context-menu-item"
              disabled={!termRef.current?.hasSelection()}
              onClick={() => {
                copySelection()
                setMenu(null)
              }}
            >
              Copy
            </button>
            <button
              className="context-menu-item"
              onClick={() => {
                pasteClipboard()
                setMenu(null)
              }}
            >
              Paste
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
