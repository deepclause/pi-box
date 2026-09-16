/**
 * Attachment classification shared by the composer and its tests.
 *
 * Only raster images the model providers accept are sent as inline image
 * content (webp/png/jpeg/gif). Anything else — including SVG, BMP and every
 * document format — is copied into the workspace and referenced by path, so pi
 * reads it with its own tools. Sending an unsupported "image" (e.g. SVG) makes
 * the provider reject the whole request.
 */
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const INLINE_IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i

export function isInlineImage(file: { type?: string; name?: string }): boolean {
  const type = (file.type ?? '').toLowerCase()
  if (type) return INLINE_IMAGE_TYPES.has(type)
  // Some drag sources provide no MIME type; fall back to the extension.
  return INLINE_IMAGE_EXTENSIONS.test(file.name ?? '')
}
