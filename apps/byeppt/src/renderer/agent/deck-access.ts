/**
 * DeckAccess: the agent-facing view of the currently open deck. App.tsx registers
 * one instance backed by live refs; the tool executors (executors.ts) and the
 * chat panel (snapshot rollback) read it through getDeckAccess().
 *
 * Trimmed port of the reference DeckAccess: only what the kept direct-editing
 * tools need (the HTML-pipeline / cloud / style-template hooks are gone).
 */
import type { RenderSlide } from '@byeppt/pptx-render'

/** Single survey question structure (with options). */
export interface ClarifyQuestion {
  id: string
  label: string
  description?: string
  /** Option text array (≤5 per question); the frontend automatically appends "Other (fill in)" */
  options: string[]
  /** Multi-select (single-select by default) */
  multi?: boolean
}

export interface DeckAccess {
  getSlides(): RenderSlide[]
  getCurrent(): number
  getSelectedIds(): string[]
  /** Monotonic deck revision (bumps on every canvas edit incl. undo/redo) */
  getRevision?(): number
  /** Loaded picture/background bitmaps (dataUrl key → element) for offscreen rendering */
  getImages(): Map<string, HTMLImageElement>
  applySlide(slideIndex: number, updated: RenderSlide): void
  /** Replace the whole deck (after adding/removing slides) and jump to the goTo slide */
  applyDeck(slides: RenderSlide[], goTo?: number): void
  /** Survey: shows a card with options and waits for the user's choices, returning an answer summary. */
  askClarification?(questions: ClarifyQuestion[]): Promise<{ answers: string; cancelled?: boolean }>
  /**
   * Optional image search hook (stub returns []; the agent's own search skills
   * cover discovery — insert_web_image only needs a URL).
   */
  searchImages?(query: string, maxResults: number): Promise<string[]>
  fitWidthPx: number
}

let current: DeckAccess | null = null

/** Called once by App.tsx (and by tests with a mock access). */
export function registerDeckAccess(access: DeckAccess | null): void {
  current = access
}

export function getDeckAccess(): DeckAccess | null {
  return current
}
