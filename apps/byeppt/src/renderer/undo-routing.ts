type UndoTarget = {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?: (name: string) => string | null
} | null

export function isTextUndoTarget(target: UndoTarget): boolean {
  return (
    !!target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable === true)
  )
}

/**
 * The empty AI composer yields undo to the deck after a run. Once the user types again, native
 * input undo wins even if they later delete their draft back to an empty string.
 */
export function shouldRouteUndoToDeck(target: UndoTarget): boolean {
  return (
    !!target &&
    target.getAttribute?.('data-slides-ai-input') === 'true' &&
    target.getAttribute('data-deck-undo-ready') === 'true'
  )
}
