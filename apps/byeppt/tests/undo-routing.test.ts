import { describe, expect, it } from 'vitest'
import { isTextUndoTarget, shouldRouteUndoToDeck } from '../src/renderer/undo-routing'

function target(tagName: string, attributes: Record<string, string> = {}) {
  return {
    tagName,
    isContentEditable: false,
    getAttribute: (name: string) => attributes[name] ?? null,
  }
}

describe('Slides undo shortcut routing', () => {
  it('routes a cleared, untouched AI composer to deck undo', () => {
    const textarea = target('TEXTAREA', {
      'data-slides-ai-input': 'true',
      'data-deck-undo-ready': 'true',
    })
    expect(isTextUndoTarget(textarea)).toBe(true)
    expect(shouldRouteUndoToDeck(textarea)).toBe(true)
  })

  it('preserves native undo after the user types in the AI composer', () => {
    const textarea = target('TEXTAREA', {
      'data-slides-ai-input': 'true',
      'data-deck-undo-ready': 'false',
    })
    expect(shouldRouteUndoToDeck(textarea)).toBe(false)
  })

  it('preserves native undo in ordinary inputs and editable text', () => {
    expect(shouldRouteUndoToDeck(target('INPUT'))).toBe(false)
    expect(isTextUndoTarget({ isContentEditable: true })).toBe(true)
  })
})
