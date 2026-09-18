import { describe, expect, it } from 'vitest'
import { applyFbRects, framebufferToRgba } from './framebuffer'

describe('applyFbRects', () => {
  it('swaps BGRA to RGBA inside the damaged rect only', () => {
    const width = 4
    const height = 2
    const target = new Uint8ClampedArray(width * height * 4)
    // One 2x1 rect at (1,1) with a red and a green pixel (BGRA).
    const rects = [
      {
        x: 1,
        y: 1,
        w: 2,
        h: 1,
        data: new Uint8Array([0, 0, 255, 255, 0, 255, 0, 255])
      }
    ]
    applyFbRects(target, width, rects)

    const px = (x: number, y: number): number[] => {
      const i = (y * width + x) * 4
      return Array.from(target.slice(i, i + 4))
    }
    expect(px(1, 1)).toEqual([255, 0, 0, 255]) // red
    expect(px(2, 1)).toEqual([0, 255, 0, 255]) // green
    expect(px(0, 0)).toEqual([0, 0, 0, 0]) // untouched
    expect(px(3, 0)).toEqual([0, 0, 0, 0])
  })

  it('ignores a missing rect list', () => {
    expect(() => applyFbRects(new Uint8ClampedArray(16), 2, null)).not.toThrow()
  })
})

describe('framebufferToRgba', () => {
  it('converts a full BGRA frame', () => {
    const frame = { width: 2, height: 1, data: new Uint8Array([0, 0, 255, 255, 10, 20, 30, 40]) }
    expect(Array.from(framebufferToRgba(frame))).toEqual([255, 0, 0, 255, 30, 20, 10, 40])
  })
})
