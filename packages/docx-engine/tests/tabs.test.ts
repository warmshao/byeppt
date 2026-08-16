import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx, type TabStop } from '../src/index'
import { buildDocx } from './helpers/build-docx'

// ---- fixture XML fragments ----

/** paragraph with left + center tab stops and dot leader */
const TABS_P =
  '<w:p>' +
  '<w:pPr><w:tabs>' +
  '<w:tab w:val="left" w:pos="720"/>' +
  '<w:tab w:val="center" w:pos="2160" w:leader="dot"/>' +
  '<w:tab w:val="right" w:pos="4320"/>' +
  '<w:tab w:val="decimal" w:pos="5040"/>' +
  '</w:tabs></w:pPr>' +
  '<w:r><w:t xml:space="preserve">A\tB\tC</w:t></w:r>' +
  '</w:p>'

/** paragraph with NO tabs (control) */
const PLAIN_P = '<w:p><w:r><w:t>plain</w:t></w:r></w:p>'

describe('tab stops parsing', () => {
  it('parses w:tabs into block.format.tabStops', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: TABS_P }))
    const block = doc.blocks[0]
    expect(block.format?.tabStops).toBeDefined()
    const stops = block.format!.tabStops!
    expect(stops).toHaveLength(4)
    expect(stops[0]).toMatchObject({ pos: 720, val: 'left' })
    expect(stops[1]).toMatchObject({ pos: 2160, val: 'center', leader: 'dot' })
    expect(stops[2]).toMatchObject({ pos: 4320, val: 'right' })
    expect(stops[3]).toMatchObject({ pos: 5040, val: 'decimal' })
  })

  it('plain paragraph has no tabStops', async () => {
    const doc = await parseDocx(await buildDocx({ bodyXml: PLAIN_P }))
    expect(doc.blocks[0].format?.tabStops).toBeUndefined()
  })
})

describe('tab stops roundtrip', () => {
  it('untouched tabs paragraph saves byte-identical', async () => {
    const bytes = await buildDocx({ bodyXml: TABS_P })
    const doc = await parseDocx(bytes)
    const saved = await saveDocx(doc, [{ kind: 'original', docxIndex: 0 }])
    const reparsed = await parseDocx(saved)
    expect(reparsed.blocks[0].format?.tabStops).toEqual(doc.blocks[0].format?.tabStops)
    expect(reparsed.internal.documentXml).toContain('<w:tabs>')
    expect(reparsed.internal.documentXml).toContain('w:val="center"')
    expect(reparsed.internal.documentXml).toContain('w:leader="dot"')
  })

  it('writing new tabStops via format regenerates correct pPr', async () => {
    const { generateParagraphXml } = await import('../src/generate')
    const newStops: TabStop[] = [
      { pos: 1440, val: 'right', leader: 'dot' },
      { pos: 2880, val: 'left' },
    ]
    const block = {
      type: 'paragraph' as const,
      runs: [{ text: 'test' }],
      format: { tabStops: newStops },
    }
    const xml = generateParagraphXml(block, {
      headingStyleIds: new Map(),
      allocateHyperlinkRel: () => 'rId1',
    })
    expect(xml).toContain('<w:tabs>')
    expect(xml).toContain('w:val="right"')
    expect(xml).toContain('w:pos="1440"')
    expect(xml).toContain('w:leader="dot"')
    expect(xml).toContain('w:val="left"')
    expect(xml).toContain('w:pos="2880"')
  })
})
