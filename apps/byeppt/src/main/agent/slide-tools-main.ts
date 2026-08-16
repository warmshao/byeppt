/**
 * Builds the vsurf customTools that expose the slide-editing tool set to the
 * embedded agent. Each tool is a thin forwarder: parameters are the shared JSON
 * schemas (wrapped in TypeBox Type.Unsafe), execution crosses the deck bridge
 * into the active slides renderer, and the executor result maps onto the SDK's
 * AgentToolResult text content.
 */
import type { TSchema } from 'typebox'
import { SLIDE_TOOL_DEFS } from '../../shared/slide-tools'
import { invokeOnActiveSlidesWindow } from './deck-bridge'
import { editImage, generateImage } from '../imagegen'

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
          const r = await invokeOnActiveSlidesWindow(
            def.name,
            (params ?? {}) as Record<string, unknown>,
            signal,
            resolveWcId?.(),
          )
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
  tools.push(buildGenerateImageTool(sdk, Type, resolveWcId))
  tools.push(buildEditImageTool(sdk, Type, resolveWcId))
  return tools
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

interface PlaceParams {
  slideIndex?: number
  xPx?: number
  yPx?: number
  wPx?: number
  hPx?: number
}

/** Optionally place a generated image file onto a slide via insert_image_bytes. */
async function placeOnSlide(
  path: string,
  p: PlaceParams,
  signal?: AbortSignal,
  resolveWcId?: () => number | undefined,
): Promise<{ placed: string; mutated: boolean }> {
  if (p.slideIndex === undefined) return { placed: '', mutated: false }
  try {
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(path)
    const r = await invokeOnActiveSlidesWindow(
      'insert_image_bytes',
      {
        slideIndex: p.slideIndex,
        base64: buf.toString('base64'),
        ext: 'png',
        ...(p.xPx !== undefined ? { xPx: p.xPx } : {}),
        ...(p.yPx !== undefined ? { yPx: p.yPx } : {}),
        ...(p.wPx !== undefined ? { wPx: p.wPx } : {}),
        ...(p.hPx !== undefined ? { hPx: p.hPx } : {}),
      },
      signal,
      resolveWcId?.(),
    )
    return {
      placed: r.isError ? `\nPlacement failed: ${r.output}` : `\nPlaced on slide ${p.slideIndex + 1}.`,
      mutated: r.mutated === true,
    }
  } catch (err) {
    return { placed: `\nPlacement failed: ${err instanceof Error ? err.message : String(err)}`, mutated: false }
  }
}

/**
 * AI image generation (Gemini banana / OpenAI gpt-image, configured in
 * Settings). Runs entirely in the main process; optionally places the result
 * onto a slide via the bridge's insert_image_bytes path.
 */
function buildGenerateImageTool(
  sdk: VsurfSdk,
  Type: typeof import('typebox').Type,
  resolveWcId?: () => number | undefined,
): ToolDefinition {
  return sdk.defineTool({
    name: 'generate_image',
    label: 'Generate Image',
    description:
      'Generate an image from a text prompt with the configured AI image backend (Gemini "banana" or OpenAI gpt-image). ' +
      'Returns the saved local PNG path. When slideIndex is provided the image is also placed on that ' +
      'slide (0-based) as an editable picture element at the given box (defaults: centered, ~60% width). ' +
      'Use for hero visuals, illustrations, icons-with-style; prefer real photos via web search + insert_web_image. ' +
      'To edit / transform an existing image (including a previously generated one), use edit_image instead.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Image prompt (English works best); be specific about style, palette, composition' }),
      slideIndex: Type.Optional(Type.Number({ description: '0-based slide to place the image on; omit to only save the file' })),
      size: Type.Optional(Type.String({ description: "gemini: aspect like '16:9'; openai: '1536x1024' etc." })),
      quality: Type.Optional(Type.String({ description: "openai: 'low'|'medium'|'high'|'auto'" })),
      xPx: Type.Optional(Type.Number()),
      yPx: Type.Optional(Type.Number()),
      wPx: Type.Optional(Type.Number()),
      hPx: Type.Optional(Type.Number()),
    }) as unknown as TSchema,
    execute: async (_id, params, signal) => {
      const p = (params ?? {}) as {
        prompt?: string
        slideIndex?: number
        size?: string
        quality?: string
        xPx?: number
        yPx?: number
        wPx?: number
        hPx?: number
      }
      if (!p.prompt?.trim()) {
        return { content: [{ type: 'text' as const, text: 'Error: prompt is required' }], details: { summary: undefined, isError: true, mutated: false } }
      }
      const result = await generateImage({
        prompt: p.prompt,
        size: p.size,
        quality: p.quality,
        signal,
      })
      if (!result.ok || !result.path) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'image generation failed'}` }],
          details: { summary: undefined, isError: true, mutated: false },
        }
      }
      const { placed, mutated } = await placeOnSlide(result.path, p, signal, resolveWcId)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Image generated (${result.provider}/${result.model}): ${result.path}${placed}`,
          },
        ],
        details: { summary: undefined, isError: false, mutated },
      }
    },
  })
}

/**
 * Image-to-image / editing with the configured AI backend. Feed a source image
 * as an absolute local path (e.g. one returned by generate_image), a data URL,
 * or raw base64. OpenAI also supports inpainting masks and up to 16 input
 * images for composition; Gemini ignores masks (conversational editing only).
 */
function buildEditImageTool(
  sdk: VsurfSdk,
  Type: typeof import('typebox').Type,
  resolveWcId?: () => number | undefined,
): ToolDefinition {
  return sdk.defineTool({
    name: 'edit_image',
    label: 'Edit Image',
    description:
      'Edit or transform an existing image with the configured AI image backend (Gemini "banana" or OpenAI gpt-image). ' +
      'Pass `image` as an absolute local path (e.g. a path returned by generate_image), a data URL, or raw base64. ' +
      'OpenAI supports an optional `mask` for inpainting (transparent areas are the edit region) and extra `images` ' +
      'for multi-image composition (up to 16 total). Gemini does not support masks. ' +
      'Returns the saved local PNG path; with slideIndex the result is also placed on that slide (0-based) at the given box.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Edit instruction (what to change / restyle / add, English works best)' }),
      image: Type.String({ description: 'Source image to edit: absolute path, data URL, or base64' }),
      images: Type.Optional(Type.Array(Type.String({ description: 'Additional reference images (OpenAI multi-image composition; path/data-url/base64)' }))),
      mask: Type.Optional(Type.String({ description: 'Inpainting mask (OpenAI only): path/data-url; transparent areas are edited' })),
      slideIndex: Type.Optional(Type.Number({ description: '0-based slide to place the result on; omit to only save the file' })),
      size: Type.Optional(Type.String({ description: "gemini: aspect like '16:9'; openai: '1536x1024' etc." })),
      quality: Type.Optional(Type.String({ description: "openai: 'low'|'medium'|'high'|'auto'" })),
      xPx: Type.Optional(Type.Number()),
      yPx: Type.Optional(Type.Number()),
      wPx: Type.Optional(Type.Number()),
      hPx: Type.Optional(Type.Number()),
    }) as unknown as TSchema,
    execute: async (_id, params, signal) => {
      const p = (params ?? {}) as {
        prompt?: string
        image?: string
        images?: string[]
        mask?: string
        slideIndex?: number
        size?: string
        quality?: string
        xPx?: number
        yPx?: number
        wPx?: number
        hPx?: number
      }
      if (!p.prompt?.trim()) {
        return { content: [{ type: 'text' as const, text: 'Error: prompt is required' }], details: { summary: undefined, isError: true, mutated: false } }
      }
      if (!p.image?.trim()) {
        return { content: [{ type: 'text' as const, text: 'Error: image is required (path, data URL, or base64)' }], details: { summary: undefined, isError: true, mutated: false } }
      }
      const result = await editImage({
        prompt: p.prompt,
        referenceImages: [p.image, ...(p.images ?? [])],
        mask: p.mask,
        size: p.size,
        quality: p.quality,
        signal,
      })
      if (!result.ok || !result.path) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'image editing failed'}` }],
          details: { summary: undefined, isError: true, mutated: false },
        }
      }
      const { placed, mutated } = await placeOnSlide(result.path, p, signal, resolveWcId)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Image edited (${result.provider}/${result.model}): ${result.path}${placed}`,
          },
        ],
        details: { summary: undefined, isError: false, mutated },
      }
    },
  })
}
