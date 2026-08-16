/** TIFF pictures must transcode to PNG for display (Chromium can't decode TIFF). */
import { describe, expect, it } from 'vitest'
import UTIF from 'utif2'
import { PNG } from 'pngjs'
import { tiffToPng } from '../src/main/tiff-decode'

function makeTiff(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 200 // R
    rgba[i + 1] = 100 // G
    rgba[i + 2] = 50 // B
    rgba[i + 3] = 255
  }
  return new Uint8Array(UTIF.encodeImage(rgba, width, height))
}

describe('tiffToPng', () => {
  it('decodes a TIFF into a valid PNG with matching dimensions', () => {
    const decoded = tiffToPng(makeTiff(20, 12))
    expect(decoded).not.toBeNull()
    expect(decoded!.width).toBe(20)
    expect(decoded!.height).toBe(12)
    const png = PNG.sync.read(Buffer.from(decoded!.png))
    expect(png.width).toBe(20)
    expect(png.height).toBe(12)
    expect(png.data[0]).toBe(200)
    expect(png.data[1]).toBe(100)
    expect(png.data[2]).toBe(50)
  })

  it('returns null on garbage bytes instead of throwing', () => {
    expect(tiffToPng(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull()
  })
})
