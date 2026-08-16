/** Hard guard against "building from scratch by hand": calling add_text_box/add_shape/add_smartart on an empty deck is refused and redirected to add_slide + execute_slide_script. */
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

// Blank deck (1 empty page, no text content) -> from-scratch scenario
const blankDeck = { widthPx: 1280, heightPx: 720, nodes: [] } as unknown as RenderSlide
// Existing polished deck (multiple elements with text) -> refinement scenario
const richDeck = {
  widthPx: 1280,
  heightPx: 720,
  nodes: [
    textNode('a', 'Title'),
    textNode('b', 'Point 1'),
    textNode('c', 'Point 2'),
    textNode('d', 'Point 3'),
  ],
} as unknown as RenderSlide

function mkAccess(slides: RenderSlide[]): DeckAccess {
  return {
    getSlides: () => slides,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck: () => {},
    fitWidthPx: 1280,
  } as unknown as DeckAccess
}
const call = (name: string): SlideToolCall => ({
  id: 't',
  name,
  input: {
    slideIndex: 0,
    paragraphs: [{ runs: [{ text: 'x' }] }],
    kind: 'rect',
    x: 10,
    y: 10,
    w: 100,
    h: 50,
    layout: 'list',
    items: ['a'],
  },
})

beforeEach(() => {
  ;(window as any).slidesApi = {
    addElement: vi.fn(async () => ({ slide: blankDeck, sourceId: 'e1' })),
    addSmartArt: vi.fn(async () => ({ slide: blankDeck, sourceId: 's1' })),
  }
})

describe('anti hand-building from scratch', () => {
  it('empty deck + add_text_box → refused with guidance toward add_slide + execute_slide_script', async () => {
    const r = await createSlidesExecutor(mkAccess([blankDeck])).executeTool!(call('add_text_box'))
    expect(r.isError).toBe(true)
    expect(r.output).toContain('add_slide')
    expect(r.output).toContain('execute_slide_script')
    expect((window as any).slidesApi.addElement).not.toHaveBeenCalled()
  })
  it('empty deck + add_shape → refused', async () => {
    const r = await createSlidesExecutor(mkAccess([blankDeck])).executeTool!(call('add_shape'))
    expect(r.isError).toBe(true)
  })
  it('empty deck + add_smartart → refused', async () => {
    const r = await createSlidesExecutor(mkAccess([blankDeck])).executeTool!(call('add_smartart'))
    expect(r.isError).toBe(true)
    expect((window as any).slidesApi.addSmartArt).not.toHaveBeenCalled()
  })
  it('existing rich deck (lots of content) + add_text_box → allowed (fine-tuning is legitimate)', async () => {
    const r = await createSlidesExecutor(mkAccess([richDeck])).executeTool!(call('add_text_box'))
    expect(r.isError).toBeUndefined()
    expect((window as any).slidesApi.addElement).toHaveBeenCalledOnce()
  })
})
