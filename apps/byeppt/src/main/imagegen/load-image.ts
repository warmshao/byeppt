/**
 * Shared image-input helpers for the imagegen backends: turn a reference image
 * (absolute path, data URL, or raw base64) into bytes / inline parts.
 */
import { readFile } from 'node:fs/promises'

/** Decode a reference image into raw bytes. Throws when it can't be read. */
export async function loadImageBytes(ref: string): Promise<Uint8Array> {
  try {
    if (ref.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(ref)
      if (m) return Buffer.from(m[2]!, 'base64')
    }
    // Plain base64 (no data: prefix) when it is long enough to be an image blob
    if (/^[A-Za-z0-9+/=\s]+$/.test(ref) && ref.length > 64) {
      return Buffer.from(ref.trim(), 'base64')
    }
    const buf = await readFile(ref)
    return new Uint8Array(buf)
  } catch (err) {
    throw new Error(`cannot read image input: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Decode a reference image into an inline part for the Gemini Interactions
 *  API ({ mimeType, data: base64 }). Returns null when it can't be read. */
export async function loadInlineData(
  ref: string,
): Promise<{ mimeType: string; data: string } | null> {
  try {
    if (ref.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(ref)
      return m ? { mimeType: m[1]!, data: m[2]! } : null
    }
    const buf = await readFile(ref)
    const ext = ref.toLowerCase().split('.').pop() ?? 'png'
    const mime =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : 'image/png'
    return { mimeType: mime, data: buf.toString('base64') }
  } catch {
    return null
  }
}
