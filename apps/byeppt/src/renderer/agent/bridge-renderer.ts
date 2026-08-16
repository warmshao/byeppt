/**
 * Renderer half of the deck bridge: the main-process agent sends 'deck:invoke'
 * {id, tool, args}; we run the executor against the registered DeckAccess and
 * post 'deck:result' {id, result|error} back. 'deck:abort' {id} rejects the
 * pending call (the main side cancels on AbortSignal).
 *
 * Mutating tools flow through the executor's applySlide/applyDeck calls exactly
 * like manual editing (main applies, renderer state follows).
 */
import { executeSlideTool, type SlideToolResult } from './executors'

interface DeckInvokeRequest {
  id: string
  tool: string
  args: Record<string, unknown>
}

let installed = false

/** Install once from App.tsx. Returns nothing; safe to call repeatedly. */
export function installDeckBridge(): void {
  if (installed) return
  installed = true
  const bridge = window.deckBridge
  if (!bridge) return

  const pending = new Map<string, AbortController>()

  bridge.onAbort((id) => {
    pending.get(id)?.abort()
    pending.delete(id)
  })

  bridge.onInvoke((req: DeckInvokeRequest) => {
    const controller = new AbortController()
    pending.set(req.id, controller)
    const finish = (msg: { id: string; result?: SlideToolResult; error?: string }) => {
      pending.delete(req.id)
      bridge.sendResult(msg)
    }
    controller.signal.addEventListener('abort', () =>
      finish({ id: req.id, error: 'aborted' }),
    )
    executeSlideTool(req.tool, req.args ?? {}, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) finish({ id: req.id, result })
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          finish({ id: req.id, error: err instanceof Error ? err.message : String(err) })
        }
      })
  })
}
