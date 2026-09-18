import type { FbRect, FbSnapshot } from '@shared/types'

/**
 * Apply damaged framebuffer rectangles from the VM to an RGBA canvas buffer.
 *
 * The VM's framebuffer is `a8r8g8b8` little-endian, so its bytes are B,G,R,A;
 * `ImageData` expects R,G,B,A, hence the channel swap. `target` is the RGBA
 * buffer of the whole screen (`width*4` bytes per row).
 */
export function applyFbRects(
  target: Uint8ClampedArray,
  width: number,
  rects: FbRect[] | null | undefined
): void {
  if (!rects) return
  for (const r of rects) {
    for (let y = 0; y < r.h; y++) {
      let s = y * r.w * 4
      let d = ((r.y + y) * width + r.x) * 4
      for (let x = 0; x < r.w; x++) {
        target[d] = r.data[s + 2]
        target[d + 1] = r.data[s + 1]
        target[d + 2] = r.data[s]
        target[d + 3] = r.data[s + 3]
        s += 4
        d += 4
      }
    }
  }
}

/** Convert a full BGRA frame snapshot into an RGBA buffer. */
export function framebufferToRgba(frame: Pick<FbSnapshot, 'width' | 'height' | 'data'>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(frame.width * frame.height * 4)
  const px = frame.width * frame.height
  for (let i = 0; i < px; i++) {
    const s = i * 4
    out[s] = frame.data[s + 2]
    out[s + 1] = frame.data[s + 1]
    out[s + 2] = frame.data[s]
    out[s + 3] = frame.data[s + 3]
  }
  return out
}
