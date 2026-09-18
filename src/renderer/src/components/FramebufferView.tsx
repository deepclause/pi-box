import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { AppState, FbFrame, FbSnapshot } from '@shared/types'
import { applyFbRects, framebufferToRgba } from '../lib/framebuffer'

interface Props {
  state: AppState | null
  visible: boolean
}

const DEFAULT_COMMAND = 'python3 /workspace/.pi-box/fbgames/bounce.py'

/** Map a browser key event to an AgentVM / evdev key name. */
function keyName(event: ReactKeyboardEvent<HTMLCanvasElement>): string | null {
  const k = event.key
  if (k === ' ') return 'space'
  if (k.length === 1) return k.toLowerCase()
  const named: Record<string, string> = {
    Escape: 'esc',
    Enter: 'enter',
    Tab: 'tab',
    Backspace: 'backspace',
    ArrowLeft: 'arrowleft',
    ArrowRight: 'arrowright',
    ArrowUp: 'arrowup',
    ArrowDown: 'arrowdown',
    Shift: 'shift',
    Control: 'ctrl',
    Alt: 'alt',
    Meta: 'alt',
    Delete: 'delete',
    Home: 'home',
    End: 'end',
    PageUp: 'pageup',
    PageDown: 'pagedown'
  }
  return named[k] ?? null
}

/**
 * The VM's virtual framebuffer (TinyEMU simplefb): a canvas that shows whatever
 * the guest draws to `/dev/fb0`, with keyboard/mouse forwarded to virtio-input.
 * Used to play small games written by pi.
 */
export default function FramebufferView({ state, visible }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const imgRef = useRef<ImageData | null>(null)
  const dimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const [command, setCommand] = useState(DEFAULT_COMMAND)
  const [running, setRunning] = useState(false)
  const [focused, setFocused] = useState(false)
  const [status, setStatus] = useState('Not running')
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  const ensure = useCallback((w: number, h: number): ImageData | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    if (dimsRef.current.w !== w || dimsRef.current.h !== h || !imgRef.current) {
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctxRef.current = ctx
      imgRef.current = ctx.createImageData(w, h)
      dimsRef.current = { w, h }
      setSize({ w, h })
    }
    return imgRef.current
  }, [])

  // Frames arrive as BGRA damaged rectangles; blit them into an RGBA ImageData.
  const applyRects = useCallback(
    (frame: FbFrame) => {
      const img = ensure(frame.width, frame.height)
      const ctx = ctxRef.current
      if (!img || !ctx) return
      applyFbRects(img.data, frame.width, frame.rects)
      for (const r of frame.rects) ctx.putImageData(img, 0, 0, r.x, r.y, r.w, r.h)
    },
    [ensure]
  )

  const applySnapshot = useCallback(
    (snap: FbSnapshot) => {
      const img = ensure(snap.width, snap.height)
      const ctx = ctxRef.current
      if (!img || !ctx) return
      img.data.set(framebufferToRgba({ width: snap.width, height: snap.height, data: snap.data }))
      ctx.putImageData(img, 0, 0)
    },
    [ensure]
  )

  useEffect(() => {
    const unsubscribe = window.pibox.fb.onFrame(applyRects)
    window.pibox.fb
      .get()
      .then((snap) => {
        if (snap) applySnapshot(snap)
      })
      .catch(() => undefined)
    return unsubscribe
  }, [applyRects, applySnapshot])

  const start = useCallback(async () => {
    setStatus('Starting…')
    try {
      await window.pibox.fb.run(command)
      setRunning(true)
      setStatus('Running')
    } catch (err) {
      setRunning(false)
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }, [command])

  const stop = useCallback(async () => {
    try {
      await window.pibox.fb.stop()
    } catch {
      // ignore
    }
    setRunning(false)
    setStatus('Stopped')
  }, [])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const name = keyName(event)
    if (!name) return
    event.preventDefault()
    window.pibox.fb.key(name, true)
  }, [])

  const onKeyUp = useCallback((event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const name = keyName(event)
    if (!name) return
    event.preventDefault()
    window.pibox.fb.key(name, false)
  }, [])

  const onMouse = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.round(((event.clientX - rect.left) / rect.width) * canvas.width)
    const y = Math.round(((event.clientY - rect.top) / rect.height) * canvas.height)
    const buttons = event.type === 'mouseup' ? 0 : event.buttons & 7
    window.pibox.fb.mouse(x, y, buttons)
  }, [])

  const ready = state?.status === 'ready'

  return (
    <section className="fb-pane">
      <div className="fb-toolbar">
        <input
          className="fb-command mono"
          value={command}
          spellCheck={false}
          placeholder="command to run (e.g. python3 games/snake.py)"
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !running) void start()
          }}
          disabled={!ready}
        />
        {running ? (
          <button className="btn" onClick={() => void stop()}>
            Stop
          </button>
        ) : (
          <button className="btn primary" onClick={() => void start()} disabled={!ready || !command.trim()}>
            Run
          </button>
        )}
        <span className="fb-status">
          {status}
          {size ? ` · ${size.w}×${size.h}` : ''}
        </span>
      </div>
      <div className="fb-stage">
        <canvas
          ref={canvasRef}
          className="fb-canvas"
          tabIndex={0}
          data-visible={visible ? 'true' : 'false'}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onMouseDown={(event) => {
            canvasRef.current?.focus()
            onMouse(event)
          }}
          onMouseUp={onMouse}
          onMouseMove={onMouse}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {!ready || !size ? (
          <div className="fb-overlay">
            {!ready ? 'Waiting for the VM…' : 'Run a program to see its screen here.'}
          </div>
        ) : !focused ? (
          <div className="fb-overlay hint">Click the screen to send keyboard input</div>
        ) : null}
      </div>
    </section>
  )
}
