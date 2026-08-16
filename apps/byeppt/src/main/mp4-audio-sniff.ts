/**
 * Minimal ISO-BMFF (mp4/m4v/mov) box walker: extract the sample-entry fourccs of
 * audio tracks so we can warn at insert time when a video's audio codec cannot be
 * decoded by Chromium (video plays, sound silently missing).
 *
 * Only container boxes on the moov→trak→mdia→minf→stbl path are descended into;
 * anything malformed simply yields no formats (no warning).
 */

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])

/**
 * Audio codecs Chromium's mp4 demuxer knows but cannot decode (no license/support):
 * Dolby AC-3/E-AC-3, DTS family, Apple Lossless, Dolby TrueHD, AMR. AAC (mp4a),
 * MP3, Opus, FLAC and the PCM variants all play fine.
 */
const CHROMIUM_UNPLAYABLE_AUDIO = new Set([
  'ac-3',
  'ec-3',
  'ac-4',
  'dtsc',
  'dtse',
  'dtsh',
  'dtsl',
  'dtsx',
  'alac',
  'mlpa',
  'samr',
  'sawb',
])

function fourcc(bytes: Uint8Array, off: number): string {
  return String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!)
}

function readU32(bytes: Uint8Array, off: number): number {
  return (
    ((bytes[off]! << 24) | (bytes[off + 1]! << 16) | (bytes[off + 2]! << 8) | bytes[off + 3]!) >>> 0
  )
}

interface TrackState {
  handler?: string
  formats: string[]
}

function walk(
  bytes: Uint8Array,
  start: number,
  end: number,
  track: TrackState | null,
  out: string[][],
): void {
  let off = start
  while (off + 8 <= end) {
    let size = readU32(bytes, off)
    const type = fourcc(bytes, off + 4)
    let payload = off + 8
    if (size === 1) {
      if (off + 16 > end) return
      // 64-bit largesize: high word must be 0 for anything we can index
      if (readU32(bytes, off + 8) !== 0) return
      size = readU32(bytes, off + 12)
      payload = off + 16
    } else if (size === 0) {
      size = end - off
    }
    if (size < 8 || off + size > end) return
    const boxEnd = off + size

    if (type === 'trak') {
      const t: TrackState = { formats: [] }
      walk(bytes, payload, boxEnd, t, out)
      if (t.handler === 'soun' && t.formats.length) out.push(t.formats)
    } else if (CONTAINER_BOXES.has(type)) {
      walk(bytes, payload, boxEnd, track, out)
    } else if (type === 'hdlr' && track) {
      // FullBox: version/flags(4) + pre_defined(4) + handler_type(4)
      if (payload + 12 <= boxEnd) track.handler = fourcc(bytes, payload + 8)
    } else if (type === 'stsd' && track) {
      // FullBox: version/flags(4) + entry_count(4), then sample entries (size + format)
      let p = payload + 8
      const count = payload + 8 <= boxEnd ? readU32(bytes, payload + 4) : 0
      for (let i = 0; i < count && p + 8 <= boxEnd; i++) {
        const esize = readU32(bytes, p)
        if (esize < 8 || p + esize > boxEnd) break
        track.formats.push(fourcc(bytes, p + 4))
        p += esize
      }
    }
    off = boxEnd
  }
}

/** Sample-entry fourccs of every audio (`hdlr` = `soun`) track in the file. */
export function audioSampleFormats(bytes: Uint8Array): string[] {
  const out: string[][] = []
  walk(bytes, 0, bytes.length, null, out)
  return out.flat()
}

/**
 * Returns the offending fourcc when the file's audio track uses a codec Chromium
 * is known not to decode (playback would be video-only), else null. Unknown
 * fourccs are trusted to avoid false alarms.
 */
export function unplayableAudioCodec(bytes: Uint8Array): string | null {
  for (const f of audioSampleFormats(bytes)) {
    const norm = f.trim().toLowerCase()
    if (CHROMIUM_UNPLAYABLE_AUDIO.has(norm)) return norm
  }
  return null
}
