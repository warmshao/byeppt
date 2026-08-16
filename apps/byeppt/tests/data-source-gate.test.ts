/** Figure-provenance gate: chart data must declare dataSource; 'sample' figures force disclosure. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSlidesExecutor } from '../src/renderer/agent/executors'
import type { DeckAccess } from '../src/renderer/agent/deck-access'
import type { RenderSlide, PlacedBox, ShapeRenderNode } from '@byeppt/pptx-render'
import type { SlideToolCall } from '../src/renderer/agent/executors'

const box = (x: number, y: number, w: number, h: number): PlacedBox => ({
  x,
  y,
  w,
  h,
  rotationDeg: 0,
  flipH: false,
  flipV: false,
  centerX: x + w / 2,
  centerY: y + h / 2,
})
const textNode = (id: string, text: string): ShapeRenderNode =>
  ({
    id,
    sourceId: id,
    type: 'shape',
    box: box(60, 60, 400, 80),
    fill: { kind: 'none' },
    text: {
      lines: [
        {
          runs: [
            {
              text,
              x: 0,
              baselineY: 20,
              fontFamily: 'Arial',
              fontSizePx: 24,
              color: '#000',
              bold: false,
              italic: false,
              underline: false,
              widthPx: 100,
            },
          ],
          top: 0,
          height: 28,
        },
      ],
      insets: { l: 0, t: 0, r: 0, b: 0 },
      anchor: 'top',
      fontScale: 1,
      contentHeight: 28,
    },
  }) as unknown as ShapeRenderNode

// Rich deck so the anti-scratch-build guard stays out of the way
const richDeck = {
  widthPx: 1280,
  heightPx: 720,
  nodes: [textNode('a', 'Title'), textNode('b', 'P1'), textNode('c', 'P2'), textNode('d', 'P3')],
} as unknown as RenderSlide

function mkAccess(extra: Record<string, unknown> = {}): DeckAccess {
  return {
    getSlides: () => [richDeck],
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck: () => {},
    fitWidthPx: 1280,
    ...extra,
  } as unknown as DeckAccess
}

const chartCall = (extra: Record<string, unknown> = {}): SlideToolCall => ({
  id: 't',
  name: 'add_chart',
  input: {
    slideIndex: 0,
    kind: 'bar',
    categories: ['Q1', 'Q2'],
    series: [{ name: 'Sales', values: [12.5, 48.2] }],
    ...extra,
  },
})

beforeEach(() => {
  ;(window as any).slidesApi = {
    addChart: vi.fn(async () => ({ slide: richDeck, sourceId: 'c1' })),
    editChart: vi.fn(async () => ({ slide: richDeck })),
  }
})

describe('add_chart provenance gate', () => {
  it('refuses without dataSource and names the accepted values', async () => {
    const r = await createSlidesExecutor(mkAccess()).executeTool!(chartCall())
    expect(r.isError).toBe(true)
    expect(r.output).toContain('dataSource')
    expect((window as any).slidesApi.addChart).not.toHaveBeenCalled()
  })

  it("accepts dataSource 'search' (web search runs in the agent's own tools, outside this layer)", async () => {
    const r = await createSlidesExecutor(mkAccess()).executeTool!(chartCall({ dataSource: 'search' }))
    expect(r.isError).toBeUndefined()
    expect((window as any).slidesApi.addChart).toHaveBeenCalledOnce()
  })

  it("accepts 'sample' but forces disclosure in the output", async () => {
    const r = await createSlidesExecutor(mkAccess()).executeTool!(chartCall({ dataSource: 'sample' }))
    expect(r.isError).toBeUndefined()
    expect(r.output).toContain('illustrative')
  })

  it("accepts 'user' with no disclosure note", async () => {
    const r = await createSlidesExecutor(mkAccess()).executeTool!(chartCall({ dataSource: 'user' }))
    expect(r.isError).toBeUndefined()
    expect(r.output).not.toContain('illustrative')
  })
})

describe('edit_chart provenance gate', () => {
  it('gates only calls that pass series data', async () => {
    const skill = createSlidesExecutor(mkAccess())
    const withData = await skill.executeTool!({
      id: 't',
      name: 'edit_chart',
      input: { slideIndex: 0, sourceId: 'c1', series: [{ name: 's', values: [1.5, 2.5] }] },
    })
    expect(withData.isError).toBe(true)
    expect(withData.output).toContain('dataSource')

    const styleOnly = await skill.executeTool!({
      id: 't',
      name: 'edit_chart',
      input: { slideIndex: 0, sourceId: 'c1', title: 'New title' },
    })
    expect(styleOnly.isError).toBeUndefined()
  })
})
