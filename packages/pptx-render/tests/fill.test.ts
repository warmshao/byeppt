import { describe, it, expect } from 'vitest'
import { resolveFill, resolveStroke } from '../src/fill'
import { makeViewport } from '../src/coords'
import type { Fill, Stroke } from '@byeppt/pptx-engine'

const vp = makeViewport({ cx: 9525 * 1000, cy: 9525 * 1000 }, 1000) // scale 1

describe('2.2 fill/stroke resolution', () => {
  it('solid fill passes color through', () => {
    const f: Fill = { type: 'solid', color: '#3366CC' }
    expect(resolveFill(f, vp)).toEqual({ kind: 'solid', color: '#3366CC' })
  })

  it('none / undefined → none', () => {
    expect(resolveFill(undefined, vp)).toEqual({ kind: 'none' })
    expect(resolveFill({ type: 'none' }, vp)).toEqual({ kind: 'none' })
  })

  it('gradient converts angle from 60000ths to degrees', () => {
    const f: Fill = {
      type: 'gradient',
      stops: [
        { pos: 0, color: '#000' },
        { pos: 1, color: '#FFF' },
      ],
      angle: 2700000,
    }
    const r = resolveFill(f, vp)
    expect(r.kind).toBe('gradient')
    if (r.kind === 'gradient') {
      expect(r.angleDeg).toBe(45)
      expect(r.stops.length).toBe(2)
    }
  })

  it('image fill resolves dataUrl via media resolver', () => {
    const f: Fill = { type: 'image', mediaRef: 'ppt/media/image1.png', mode: 'stretch' }
    const r = resolveFill(f, vp, (ref) => (ref.includes('image1') ? 'data:img' : undefined))
    expect(r).toEqual({ kind: 'image', dataUrl: 'data:img', mode: 'stretch' })
  })

  it('stroke converts EMU width to px and maps dash preset', () => {
    const s: Stroke = { fill: { type: 'solid', color: '#111' }, width: 9525 * 2, dash: 'dash' }
    const r = resolveStroke(s, vp)
    expect(r?.color).toBe('#111')
    expect(r?.widthPx).toBeCloseTo(2, 4)
    expect(Array.isArray(r?.dash)).toBe(true)
  })

  it('noFill stroke → undefined', () => {
    const s: Stroke = { fill: { type: 'none' }, width: 12700 }
    expect(resolveStroke(s, vp)).toBeUndefined()
  })
})
