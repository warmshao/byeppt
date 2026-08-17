/**
 * Builds the vsurf customTools that expose the slide-editing tool set to the
 * embedded agent. Each tool is a thin forwarder: parameters are the shared JSON
 * schemas (wrapped in TypeBox Type.Unsafe), execution crosses the deck bridge
 * into the active slides renderer, and the executor result maps onto the SDK's
 * AgentToolResult text content.
 */
import type { TSchema } from 'typebox'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { savePptxToFile } from '@byeppt/pptx-engine'
import { SLIDE_TOOL_DEFS } from '../../shared/slide-tools'
import { invokeOnActiveSlidesWindow, resolveDeckWebContents, type DeckInvokeOutcome } from './deck-bridge'
import { sessions } from '../session-state'

type VsurfSdk = typeof import('@warmshao/vsurf')
type ToolDefinition = import('@warmshao/vsurf').ToolDefinition

/** Human-readable label per tool (UI display only). */
function labelOf(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Build the ToolDefinition array for createAgentSession's customTools.
 * Async because typebox is ESM-only (the main bundle is CJS; same dynamic-import
 * pattern as the vsurf SDK itself).
 *
 * `resolveWcId` pins deck-bridge invocations to the session's owning tab
 * (per-tab sessions); without it tools hit whatever slides window is active.
 */
export async function buildSlideCustomTools(
  sdk: VsurfSdk,
  resolveWcId?: () => number | undefined,
): Promise<ToolDefinition[]> {
  const { Type } = await import('typebox')
  const tools: ToolDefinition[] = SLIDE_TOOL_DEFS.map((def) =>
    sdk.defineTool({
      name: def.name,
      label: labelOf(def.name),
      description: def.description,
      parameters: Type.Unsafe(def.parameters) as TSchema,
      // Mutating tools must not interleave: each edits the shared document model
      ...(def.mutating ? { executionMode: 'sequential' as const } : {}),
      execute: async (_toolCallId, params, signal) => {
        try {
          const args = (params ?? {}) as Record<string, unknown>
          // export_deck_pptx runs main-side: the authoritative deck session
          // lives here, so there is nothing to forward into the renderer.
          // insert_web_image with a local path also runs main-side (the renderer
          // cannot read files): read the bytes here and place them through the
          // bridge's insert_image_bytes op.
          const r =
            def.name === 'export_deck_pptx'
              ? await exportDeckPptx(args, resolveWcId?.())
              : def.name === 'insert_web_image' && isLocalImagePath(args.url)
                ? await insertLocalImage(args, signal, resolveWcId?.())
                : await invokeOnActiveSlidesWindow(def.name, args, signal, resolveWcId?.())
          const text = r.isError ? `Error: ${r.output}` : r.output
          return {
            content: [{ type: 'text' as const, text }],
            details: {
              summary: r.summary,
              isError: r.isError === true,
              mutated: r.mutated === true,
            },
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: 'text' as const, text: `Error: ${msg}` }],
            details: { summary: undefined, isError: true, mutated: false },
          }
        }
      },
    }),
  )
  tools.push(buildViewSlideTool(sdk, Type, resolveWcId))
  return tools
}

/** True when insert_web_image's `url` is a local file path rather than http(s). */
function isLocalImagePath(url: unknown): url is string {
  return typeof url === 'string' && url.trim() !== '' && !/^https?:\/\//i.test(url)
}

/**
 * insert_web_image with a local path: the renderer cannot read files, so main
 * reads the image and forwards the bytes through the bridge's
 * insert_image_bytes op (same placement box semantics).
 */
async function insertLocalImage(
  args: Record<string, unknown>,
  signal?: AbortSignal,
  preferWcId?: number,
): Promise<DeckInvokeOutcome> {
  const path = String(args.url)
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png').toLowerCase()
  const { readFile } = await import('node:fs/promises')
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    throw new Error(`cannot read local image: ${path}`)
  }
  return invokeOnActiveSlidesWindow(
    'insert_image_bytes',
    {
      slideIndex: args.slideIndex,
      base64: buf.toString('base64'),
      ext: ext === 'jpg' ? 'jpeg' : ext,
      xPx: args.x,
      yPx: args.y,
      wPx: args.w,
      hPx: args.h,
    },
    signal,
    preferWcId,
  )
}

/** Export the owning tab's current deck to a .pptx (authoritative snapshot). */
async function exportDeckPptx(
  args: Record<string, unknown>,
  preferWcId?: number,
): Promise<DeckInvokeOutcome> {
  const wc = resolveDeckWebContents(preferWcId)
  if (!wc) throw new Error('No slides window is open - open or create a presentation first')
  const session = sessions.get(wc.id)
  if (!session) throw new Error('No deck session for the owning tab')
  const path = String(args.path ?? '').trim()
  if (!path) throw new Error('path is required (absolute .pptx path inside the deck workdir)')
  if (!path.toLowerCase().endsWith('.pptx')) throw new Error('path must end with .pptx')
  await mkdir(dirname(path), { recursive: true })
  await savePptxToFile(session.opened, path)
  return {
    output:
      `Exported the current deck (revision ${session.revision}) to ${path}. ` +
      'The canvas state is authoritative; re-derive SVG via pptx_to_svg before any SVG-level rework.',
    summary: 'Exported deck',
  }
}

/**
 * Render one page of the open deck to a PNG exactly as the user sees it and
 * return it as image content for visual inspection. Read-only; the renderer
 * does the offscreen Konva render (same pipeline as PNG export). Kept out of
 * SLIDE_TOOL_DEFS because its result maps to text + image content, not text only.
 */
function buildViewSlideTool(
  sdk: VsurfSdk,
  Type: typeof import('typebox').Type,
  resolveWcId?: () => number | undefined,
): ToolDefinition {
  return sdk.defineTool({
    name: 'view_slide',
    label: 'View Slide',
    description:
      'Render a page of the open deck to a PNG (exactly as the user sees it on canvas) and return it as an image you can see. ' +
      'Use it to VISUALLY verify your edits: after finishing a slide\'s execute_slide_script / set_element_* work, ' +
      'and during whole-deck QC — check alignment, spacing, overlap, text overflow, contrast, and visual hierarchy. ' +
      'Prefer this over inferring layout from read_slide coordinates alone. ' +
      'Omit slideIndex to view the page the user is currently looking at.',
    parameters: Type.Object({
      slideIndex: Type.Optional(
        Type.Number({ description: 'Page number (0-based); omit for the page currently shown' }),
      ),
    }) as unknown as TSchema,
    execute: async (_id, params, signal) => {
      const p = (params ?? {}) as { slideIndex?: number }
      try {
        const r = await invokeOnActiveSlidesWindow(
          'view_slide',
          p.slideIndex === undefined ? {} : { slideIndex: p.slideIndex },
          signal,
          resolveWcId?.(),
        )
        if (r.isError || !r.image) {
          return {
            content: [{ type: 'text' as const, text: r.isError ? `Error: ${r.output}` : r.output }],
            details: { summary: r.summary, isError: r.isError === true, mutated: false },
          }
        }
        return {
          content: [
            { type: 'text' as const, text: r.output },
            { type: 'image' as const, data: r.image, mimeType: 'image/png' },
          ],
          details: { summary: r.summary, isError: false, mutated: false },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          details: { summary: undefined, isError: true, mutated: false },
        }
      }
    },
  })
}
