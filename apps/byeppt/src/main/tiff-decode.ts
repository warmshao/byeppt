/**
 * TIFF → PNG transcoding (main process). Chromium cannot decode TIFF, so pictures
 * embedded as ppt/media/*.tif(f) would render as blank placeholders. Decode with
 * UTIF (pure JS) and re-encode as PNG for display; the original TIFF bytes stay
 * untouched in the package so saving preserves them byte-for-byte.
 */
import UTIF from 'utif2'
import { PNG } from 'pngjs'

export interface DecodedTiff {
  png: Uint8Array
  width: number
  height: number
}

export function tiffToPng(bytes: Uint8Array): DecodedTiff | null {
  try {
    const buf = Buffer.from(bytes)
    const ifds = UTIF.decode(buf)
    if (!ifds.length) return null
    // Multi-page/multi-resolution TIFFs: pick the largest page
    let page = ifds[0]!
    for (const ifd of ifds) {
      UTIF.decodeImage(buf, ifd)
      const cur = (ifd.width || 0) * (ifd.height || 0)
      if (cur > (page.width || 0) * (page.height || 0)) page = ifd
    }
    const width = page.width
    const height = page.height
    if (!width || !height) return null
    const rgba = UTIF.toRGBA8(page)
    const png = new PNG({ width, height })
    png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
    return { png: PNG.sync.write(png), width, height }
  } catch {
    return null
  }
}
