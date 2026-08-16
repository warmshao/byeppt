/**
 * Pending ask_clarification request (pub/sub). The executor's DeckAccess
 * askClarification publishes the questions here and awaits; ChatPanel subscribes,
 * renders the survey card, and resolves on submit/skip.
 */
import type { ClarifyQuestion } from './deck-access'

export interface PendingClarification {
  questions: ClarifyQuestion[]
  resolve: (r: { answers: string; cancelled?: boolean }) => void
}

let pending: PendingClarification | null = null
const listeners = new Set<() => void>()

export function getPendingClarification(): PendingClarification | null {
  return pending
}

export function subscribeClarification(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const l of listeners) l()
}

/** Called by the DeckAccess askClarification implementation. */
export function requestClarification(
  questions: ClarifyQuestion[],
): Promise<{ answers: string; cancelled?: boolean }> {
  // One card at a time: a second request auto-skips the orphaned first one
  pending?.resolve({ answers: '', cancelled: true })
  return new Promise((resolve) => {
    pending = { questions, resolve }
    notify()
  })
}

/** Called by the survey card (submit or skip). */
export function settleClarification(r: { answers: string; cancelled?: boolean }): void {
  const p = pending
  pending = null
  notify()
  p?.resolve(r)
}
