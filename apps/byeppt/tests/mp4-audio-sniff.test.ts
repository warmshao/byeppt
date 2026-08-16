import { describe, expect, it } from 'vitest'
import { audioSampleFormats, unplayableAudioCodec } from '../src/main/mp4-audio-sniff'

// ── Tiny ISO-BMFF builders ──────────────────────────────────────────────

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  let off = 8
  for (const p of payload) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}

function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)))
}

/** hdlr FullBox: version/flags + pre_defined + handler_type + reserved[3] + empty name */
function hdlr(handler: string): Uint8Array {
  return box('hdlr', u32(0), u32(0), ascii(handler), u32(0), u32(0), u32(0), new Uint8Array(1))
}

/** stsd FullBox with one sample entry of the given format (opaque 16-byte body) */
function stsd(format: string): Uint8Array {
  const entry = new Uint8Array(24)
  new DataView(entry.buffer).setUint32(0, 24)
  for (let i = 0; i < 4; i++) entry[4 + i] = format.charCodeAt(i)
  return box('stsd', u32(0), u32(1), entry)
}

function trak(handler: string, format: string): Uint8Array {
  return box('trak', box('mdia', hdlr(handler), box('minf', box('stbl', stsd(format)))))
}

function file(...traks: Uint8Array[]): Uint8Array {
  const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isomiso2'))
  return Uint8Array.from([...ftyp, ...box('moov', ...traks)])
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('mp4 audio codec sniffing', () => {
  it('finds the audio sample format and ignores video tracks', () => {
    const bytes = file(trak('vide', 'avc1'), trak('soun', 'mp4a'))
    expect(audioSampleFormats(bytes)).toEqual(['mp4a'])
    expect(unplayableAudioCodec(bytes)).toBeNull()
  })

  it('flags AC-3 / E-AC-3 audio as unplayable', () => {
    expect(unplayableAudioCodec(file(trak('vide', 'avc1'), trak('soun', 'ac-3')))).toBe('ac-3')
    expect(unplayableAudioCodec(file(trak('soun', 'ec-3')))).toBe('ec-3')
  })

  it('accepts PCM and Opus audio', () => {
    expect(unplayableAudioCodec(file(trak('soun', 'sowt')))).toBeNull()
    expect(unplayableAudioCodec(file(trak('soun', 'Opus')))).toBeNull()
  })

  it('video-only files report nothing', () => {
    expect(audioSampleFormats(file(trak('vide', 'avc1')))).toEqual([])
    expect(unplayableAudioCodec(file(trak('vide', 'avc1')))).toBeNull()
  })

  it('is safe on truncated/garbage input', () => {
    expect(audioSampleFormats(new Uint8Array([0, 0, 0]))).toEqual([])
    expect(audioSampleFormats(ascii('not a real mp4 file at all'))).toEqual([])
    // Truncation invalidates the enclosing moov size: degrade to "no formats", never throw
    const good = file(trak('soun', 'ac-3'))
    expect(unplayableAudioCodec(good.slice(0, good.length - 5))).toBeNull()
  })
})
