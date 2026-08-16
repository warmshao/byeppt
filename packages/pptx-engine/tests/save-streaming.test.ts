import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { openPptx, savePptx, savePptxToFile, commitSaved, addElement } from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(join(here, 'fixtures', name))
const out = () => join(mkdtempSync(join(tmpdir(), 'save-stream-')), 'out.pptx')

describe('savePptxToFile', () => {
  it('writes a package that reopens with the same slides as the in-memory save', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const target = out()
    await savePptxToFile(opened, target)

    const fromDisk = await openPptx(readFileSync(target))
    const fromMemory = await openPptx(
      await savePptx(await openPptx(fx('01_standard_business.pptx'))),
    )
    expect(fromDisk.deck.slides.length).toBe(fromMemory.deck.slides.length)
    expect([...fromDisk.archive.entries.keys()].sort()).toEqual(
      [...fromMemory.archive.entries.keys()].sort(),
    )
  })

  it('carries unsaved edits into the streamed file', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    addElement(opened.deck.slides[0]!, {
      kind: 'textbox',
      offset: { x: 914400, y: 914400, cx: 6096000, cy: 914400 },
      paragraphs: [{ runs: [{ text: 'streamed edit', bold: true, fontSize: 28 }] }],
    })
    const target = out()
    await savePptxToFile(opened, target)

    const reopened = await openPptx(readFileSync(target))
    const xml = reopened.archive.readText(reopened.deck.slides[0]!.path)!
    expect(xml).toContain('streamed edit')
  })

  it('stores already-compressed media instead of deflating it again', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const target = out()
    await savePptxToFile(opened, target)

    const zip = await JSZip.loadAsync(readFileSync(target))
    const sizes = (name: string) =>
      (
        zip.files[name] as unknown as {
          _data: { compressedSize: number; uncompressedSize: number }
        }
      )._data
    const media = Object.keys(zip.files).filter((name) => /\.(png|jpe?g|gif)$/i.test(name))
    expect(media.length).toBeGreaterThan(0)
    // STORE leaves the bytes untouched, so the two sizes match exactly
    for (const name of media) {
      const { compressedSize, uncompressedSize } = sizes(name)
      expect(compressedSize, name).toBe(uncompressedSize)
    }
    // xml parts are still deflated
    const xml = sizes('ppt/presentation.xml')
    expect(xml.compressedSize).toBeLessThan(xml.uncompressedSize)
  })

  // commitSaved replaces the post-save reopen; a stale anchor would silently
  // revert the first edit on the second save.
  it('commitSaved: two consecutive edit+save cycles keep both edits', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    const slide = opened.deck.slides[0]!
    addElement(slide, {
      kind: 'textbox',
      offset: { x: 914400, y: 914400, cx: 6096000, cy: 914400 },
      paragraphs: [{ runs: [{ text: 'FIRST_CYCLE_EDIT' }] }],
    })
    await savePptx(opened)
    commitSaved(opened)
    expect(slide.structureDirty).toBeUndefined()

    addElement(slide, {
      kind: 'textbox',
      offset: { x: 914400, y: 2286000, cx: 6096000, cy: 914400 },
      paragraphs: [{ runs: [{ text: 'SECOND_CYCLE_EDIT' }] }],
    })
    const finalBytes = await savePptx(opened)

    const reopened = await openPptx(finalBytes)
    const xml = reopened.archive.readText(slide.path)!
    expect(xml).toContain('FIRST_CYCLE_EDIT')
    expect(xml).toContain('SECOND_CYCLE_EDIT')
  })
})

describe('savePptxToFile error containment', () => {
  it('rejects instead of throwing past the caller when the target is unwritable', async () => {
    const opened = await openPptx(fx('01_standard_business.pptx'))
    let uncaught: unknown = null
    const onUncaught = (error: unknown) => {
      uncaught = error
    }
    process.on('uncaughtException', onUncaught)
    try {
      await expect(savePptxToFile(opened, '/definitely/not/a/directory/out.pptx')).rejects.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    expect(uncaught).toBeNull()
  })
})
