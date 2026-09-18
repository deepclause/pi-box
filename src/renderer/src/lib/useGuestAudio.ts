import { useCallback, useEffect, useRef, useState } from 'react'

// The AudioWorklet is a file in the renderer's public dir; `blob:`/`data:`
// worklet modules are refused by Electron's renderer.
const WORKLET_URL = 'pibox-pcm-worklet.js'

export interface UseGuestAudio {
  /** Whether playback is enabled (user toggle). */
  enabled: boolean
  /** True once the AudioWorklet is ready. */
  available: boolean
  toggle: () => void
}

/**
 * Plays the guest's virtio-snd PCM. The guest emits 48 kHz stereo S16_LE, so the
 * AudioContext is pinned to 48000 Hz and the samples are converted to Float32
 * on the way to an AudioWorklet.
 */
export function useGuestAudio(): UseGuestAudio {
  const [enabled, setEnabled] = useState(true)
  const [available, setAvailable] = useState(false)
  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const enabledRef = useRef(enabled)

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  useEffect(() => {
    let disposed = false
    const ctx = new AudioContext({ sampleRate: 48000 })
    ctxRef.current = ctx

    ctx.audioWorklet
      .addModule(WORKLET_URL)
      .then(() => {
        if (disposed) return
        const node = new AudioWorkletNode(ctx, 'pibox-pcm', { outputChannelCount: [2] })
        node.connect(ctx.destination)
        nodeRef.current = node
        setAvailable(true)
      })
      .catch(() => undefined)

    const off = window.pibox.audio.onFrame(({ channels, data }) => {
      const node = nodeRef.current
      if (!node || !enabledRef.current) return
      // Autoplay policy: the context stays suspended until a user gesture.
      if (ctx.state === 'suspended') void ctx.resume()
      const count = data.length >> 1
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const samples = new Float32Array(count)
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768
      node.port.postMessage({ samples, channels }, [samples.buffer])
    })

    const resume = (): void => {
      if (enabledRef.current && ctx.state === 'suspended') void ctx.resume()
    }
    window.addEventListener('pointerdown', resume)
    window.addEventListener('keydown', resume)

    return () => {
      disposed = true
      off()
      window.removeEventListener('pointerdown', resume)
      window.removeEventListener('keydown', resume)
      nodeRef.current?.disconnect()
      nodeRef.current = null
      void ctx.close()
      ctxRef.current = null
    }
  }, [])

  const toggle = useCallback(() => {
    setEnabled((value) => {
      const next = !value
      if (next) void ctxRef.current?.resume()
      return next
    })
  }, [])

  return { enabled, available, toggle }
}
