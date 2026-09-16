import { describe, expect, it } from 'vitest'
import { isInlineImage } from './attach'

describe('isInlineImage', () => {
  it('accepts the raster types providers support', () => {
    expect(isInlineImage({ type: 'image/png' })).toBe(true)
    expect(isInlineImage({ type: 'image/jpeg' })).toBe(true)
    expect(isInlineImage({ type: 'image/gif' })).toBe(true)
    expect(isInlineImage({ type: 'image/webp' })).toBe(true)
  })

  it('rejects SVG and BMP so they are copied as files', () => {
    expect(isInlineImage({ type: 'image/svg+xml', name: 'icon.svg' })).toBe(false)
    expect(isInlineImage({ type: 'image/bmp', name: 'scan.bmp' })).toBe(false)
  })

  it('rejects documents', () => {
    expect(isInlineImage({ type: 'application/pdf', name: 'report.pdf' })).toBe(false)
    expect(isInlineImage({ type: 'text/plain', name: 'notes.txt' })).toBe(false)
    expect(isInlineImage({ type: '', name: 'sheet.xlsx' })).toBe(false)
  })

  it('falls back to the extension when no MIME type is present', () => {
    expect(isInlineImage({ name: 'screenshot.PNG' })).toBe(true)
    expect(isInlineImage({ name: 'photo.jpeg' })).toBe(true)
    expect(isInlineImage({ name: 'vector.svg' })).toBe(false)
  })
})
