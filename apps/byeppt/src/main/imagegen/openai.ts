/**
 * OpenAI image generation (gpt-image series) via the Vercel AI SDK
 * (`@ai-sdk/openai` + `ai`'s `generateImage`). Supports text-to-image
 * (`generateOpenAIImage`) and image editing / image-to-image
 * (`editOpenAIImage`) with optional mask inpainting and multi-image
 * composition. `baseUrl` (settings) overrides the endpoint, then
 * OPENAI_BASE_URL (relays), then the official endpoint.
 *
 * The AI SDK packages are ESM-only; the main process bundle is CJS, so they
 * are loaded with dynamic `await import()` (same pattern as vsurf/typebox).
 */
import type { GeneratedFile } from 'ai'
import type { ImageGenRequest } from './index'
import { imageGenApiKey } from './keys'
import { loadImageBytes } from './load-image'

const DEFAULT_BASE = 'https://api.openai.com'

type Quality = 'auto' | 'low' | 'medium' | 'high' | 'standard' | 'hd'

async function sdk() {
  const [{ createOpenAI }, { generateImage }] = await Promise.all([
    import('@ai-sdk/openai'),
    import('ai'),
  ])
  return { createOpenAI, generateImage }
}

/** OpenAI image model bound to the configured API key + base URL. */
async function buildImageModel(model: string, baseUrl?: string) {
  const apiKey = await imageGenApiKey('openai')
  if (!apiKey) throw new Error('no-api-key: configure an OpenAI API key in Settings first')
  const base = (baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
  // The AI SDK expects the full API prefix (default "https://api.openai.com/v1").
  const apiBase = base.endsWith('/v1') ? base : `${base}/v1`
  const { createOpenAI } = await sdk()
  return createOpenAI({ apiKey, baseURL: apiBase }).image(model)
}

function toBytes(file: GeneratedFile): Uint8Array {
  if (file.uint8Array) return new Uint8Array(file.uint8Array)
  if (file.base64) return Buffer.from(file.base64, 'base64')
  throw new Error('openai returned no image data')
}

/** Text-to-image. */
export async function generateOpenAIImage(
  req: ImageGenRequest & { model: string; baseUrl?: string },
): Promise<Uint8Array> {
  const model = await buildImageModel(req.model, req.baseUrl)
  const { generateImage } = await sdk()
  const { image } = await generateImage({
    model,
    prompt: req.prompt,
    ...(req.size ? { size: req.size as `${number}x${number}` } : {}),
    ...(req.quality ? { providerOptions: { openai: { quality: req.quality as Quality } } } : {}),
    abortSignal: req.signal,
  })
  return toBytes(image)
}

/** Image-to-image / editing with optional inpainting mask. */
export async function editOpenAIImage(
  req: ImageGenRequest & { model: string; baseUrl?: string },
): Promise<Uint8Array> {
  const images = req.referenceImages ?? []
  if (images.length === 0) throw new Error('edit requires at least one input image')
  const model = await buildImageModel(req.model, req.baseUrl)
  const loaded = await Promise.all(images.map(loadImageBytes))
  const mask = req.mask ? await loadImageBytes(req.mask) : undefined
  const { generateImage } = await sdk()
  const { image } = await generateImage({
    model,
    prompt: {
      text: req.prompt,
      images: loaded,
      ...(mask ? { mask } : {}),
    },
    ...(req.size ? { size: req.size as `${number}x${number}` } : {}),
    ...(req.quality ? { providerOptions: { openai: { quality: req.quality as Quality } } } : {}),
    abortSignal: req.signal,
  })
  return toBytes(image)
}
