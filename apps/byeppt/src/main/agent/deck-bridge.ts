/**
 * Main-process half of the deck bridge: invokes a slide tool on the active
 * slides renderer and awaits its result.
 *
 * Channel protocol (plain ipcRenderer.send/on, not invoke/handle — the target
 * webContents is chosen here, not by the sender):
 *   main → renderer  'deck:invoke'  { id, tool, args }
 *   renderer → main  'deck:result'  { id, result | error }
 *   main → renderer  'deck:abort'   id        (AbortSignal cancellation)
 *
 * Target selection: prefer the shell-tracked active slides webContents
 * (session-state.windowRefs.activeWebContents); standalone mode falls back to
 * the single open slides session.
 */
import { ipcMain, webContents } from 'electron'
import type { WebContents } from 'electron'
import { sessions, windowRefs } from '../session-state'
import type { DeckBridgeResult } from '../../shared/ipc'

const INVOKE_TIMEOUT_MS = 120_000

let seq = 0
let listenerInstalled = false

interface PendingCall {
  senderId: number
  resolve: (r: DeckBridgeResult) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingCall>()

function ensureListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  ipcMain.on('deck:result', (e, msg: DeckBridgeResult) => {
    const p = pending.get(msg?.id)
    if (!p || e.sender.id !== p.senderId) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    p.resolve(msg)
  })
}

/** Pick the slides renderer to run tools against; null when none is open. */
function targetWebContents(): WebContents | null {
  const active = windowRefs.activeWebContents
  if (active && !active.isDestroyed() && sessions.has(active.id)) return active
  if (sessions.size === 1) {
    const id = [...sessions.keys()][0]!
    const wc = webContents.fromId(id)
    if (wc && !wc.isDestroyed()) return wc
  }
  return null
}

export interface DeckInvokeOutcome {
  output: string
  isError?: boolean
  mutated?: boolean
  summary?: string
}

/**
 * Run one slide tool in the active slides renderer. Throws when no slides
 * window/tab is open, on timeout, on abort, or when the renderer reports an
 * execution-level error (tool-level failures come back as isError results).
 */
export function invokeOnActiveSlidesWindow(
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<DeckInvokeOutcome> {
  const wc = targetWebContents()
  if (!wc) {
    return Promise.reject(
      new Error('No slides window is open — open or create a presentation first'),
    )
  }
  ensureListener()
  const id = `deck-${Date.now()}-${++seq}`
  return new Promise<DeckInvokeOutcome>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Slide tool ${tool} timed out after ${INVOKE_TIMEOUT_MS / 1000}s`))
    }, INVOKE_TIMEOUT_MS)
    pending.set(id, {
      senderId: wc.id,
      timer,
      resolve: (msg) => {
        if (msg.error) reject(new Error(msg.error))
        else if (msg.result) resolve(msg.result)
        else reject(new Error('empty deck bridge result'))
      },
    })
    const onAbort = () => {
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      clearTimeout(p.timer)
      if (!wc.isDestroyed()) wc.send('deck:abort', id)
      reject(new Error('aborted'))
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    wc.send('deck:invoke', { id, tool, args })
  })
}
