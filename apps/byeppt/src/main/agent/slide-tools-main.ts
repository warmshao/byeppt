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
import { generateImage } from '../imagegen'

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
 */
export async function buildSlideCustomTools(sdk: VsurfSdk): Promise<ToolDefinition[]> {
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
  tools.push(buildGenerateImageTool(sdk, Type))
  return tools
}

/**
 * AI image generation (Gemini banana / OpenAI gpt-image, configured in
 * Settings). Runs entirely in the main process; optionally places the result
 * onto a slide via the bridge's insert_image_bytes path.
 */
function buildGenerateImageTool(
  sdk: VsurfSdk,
  Type: typeof import('typebox').Type,
): ToolDefinition {
  return sdk.defineTool({
    name: 'generate_image',
    label: 'Generate Image',
    description:
      'Generate an image with the configured AI image backend (Gemini "banana" or OpenAI gpt-image). ' +
      'Returns the saved local PNG path. When slideIndex is provided the image is also placed on that ' +
      'slide (0-based) as an editable picture element at the given box (defaults: centered, ~60% width). ' +
      'Use for hero visuals, illustrations, icons-with-style; prefer real photos via web search + insert_web_image.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Image prompt (English works best); be specific about style, palette, composition' }),
      slideIndex: Type.Optional(Type.Number({ description: '0-based slide to place the image on; omit to only save the file' })),
      size: Type.Optional(Type.String({ description: "gemini: aspect like '16:9'; openai: '1536x1024' etc." })),
      quality: Type.Optional(Type.String({ description: "openai: 'low'|'medium'|'high'" })),
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
      let placed = ''
      let mutated = false
      if (p.slideIndex !== undefined) {
        try {
          const { readFile } = await import('node:fs/promises')
          const buf = await readFile(result.path)
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
          )
          mutated = r.mutated === true
          placed = r.isError ? `\nPlacement failed: ${r.output}` : `\nPlaced on slide ${p.slideIndex + 1}.`
        } catch (err) {
          placed = `\nPlacement failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
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
