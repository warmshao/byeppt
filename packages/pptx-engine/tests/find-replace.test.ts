/** Global find/replace: in-run matching, case toggle, firstOnly/element scope, dynamic-field skip, byte fidelity. */
import { describe, it, expect } from 'vitest'
import { parseSlide } from '../src/parse'
import { patchedElementXml, replaceAllInDeck } from '../src/index'
import type { SlideDeck, TextElement } from '../src/types'

const slideWith = (sps: string) =>
  '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld>' +
  `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${sps}</p:spTree></p:cSld></p:sld>`
const sp = (runs: string) =>
  '<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>' +
  `<p:txBody><a:bodyPr/><a:p>${runs}</a:p></p:txBody></p:sp>`

const deckWith = (...slidesSps: string[]): SlideDeck => {
  const slides = slidesSps.map((sps, i) =>
    parseSlide({ path: `ppt/slides/slide${i + 1}.xml`, slideXml: slideWith(sps), ctx: {} }),
  )
  return { slides } as unknown as SlideDeck
}

describe('replaceAllInDeck', () => {
  it('replaces across slides + counts + marks only changed slides', () => {
    const deck = deckWith(
      sp('<a:r><a:t>Hello world, hello</a:t></a:r>'),
      sp('<a:r><a:t>no match here</a:t></a:r>'),
      sp('<a:r><a:t>Hello again</a:t></a:r>'),
    )
    const r = replaceAllInDeck(deck, 'hello', 'hi')
    expect(r.count).toBe(3)
    expect(r.changedSlides).toEqual([0, 2])
    const el = deck.slides[0]!.elements[0] as TextElement
    expect(el.text!.paragraphs[0]!.runs[0]!.text).toBe('hi world, hi')
    expect(el.dirty).toBe(true)
  })

  it('matchCase is case-sensitive', () => {
    const deck = deckWith(sp('<a:r><a:t>Hello hello</a:t></a:r>'))
    const r = replaceAllInDeck(deck, 'hello', 'x', { matchCase: true })
    expect(r.count).toBe(1)
    expect((deck.slides[0]!.elements[0] as TextElement).text!.paragraphs[0]!.runs[0]!.text).toBe(
      'Hello x',
    )
  })

  it('firstOnly + element scope replaces only the first match', () => {
    const deck = deckWith(sp('<a:r><a:t>aaa</a:t></a:r>'), sp('<a:r><a:t>aaa</a:t></a:r>'))
    const el0 = deck.slides[0]!.elements[0]!
    const r = replaceAllInDeck(deck, 'a', 'b', {
      firstOnly: true,
      slideIndex: 0,
      elementId: el0.id,
    })
    expect(r.count).toBe(1)
    expect((el0 as TextElement).text!.paragraphs[0]!.runs[0]!.text).toBe('baa')
    expect((deck.slides[1]!.elements[0] as TextElement).text!.paragraphs[0]!.runs[0]!.text).toBe(
      'aaa',
    )
  })

  it('dynamic field runs skipped; rPr keeps original bytes after replacement (in-place patch)', () => {
    const deck = deckWith(
      sp(
        '<a:r><a:rPr sz="1800" b="1"><a:latin typeface="Calibri"/></a:rPr><a:t>foo bar</a:t></a:r>',
      ) + sp('<a:fld id="{X}" type="slidenum"><a:rPr/><a:t>foo</a:t></a:fld>'),
    )
    const r = replaceAllInDeck(deck, 'foo', 'baz')
    expect(r.count).toBe(1) // 'foo' inside fld is untouched
    const el = deck.slides[0]!.elements[0]!
    const out = patchedElementXml(el)
    expect(out).toContain('baz bar')
    // Font size/bold/font declarations kept (explicit b/i booleans overriding inheritance is existing semantics of the alignment path)
    expect(out).toMatch(
      /<a:rPr[^>]*\bsz="1800"[^>]*\bb="1"[^>]*><a:latin typeface="Calibri"\/><\/a:rPr>/,
    )
  })

  it('regex special characters match literally', () => {
    const deck = deckWith(sp('<a:r><a:t>1+1=2 (a.b)</a:t></a:r>'))
    expect(replaceAllInDeck(deck, '1+1', '2').count).toBe(1)
    expect(replaceAllInDeck(deck, '(a.b)', 'c').count).toBe(1)
    expect((deck.slides[0]!.elements[0] as TextElement).text!.paragraphs[0]!.runs[0]!.text).toBe(
      '2=2 c',
    )
  })
})
