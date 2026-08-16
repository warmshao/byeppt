/**
 * Image generation service (Phase 4): thin multi-provider layer.
 * Gemini "banana" series (generateContent image modality) and OpenAI gpt-image
 * series (Images API). Plain fetch, no SDKs. Keys come from the vsurf
 * AuthStorage (google / openai credentials) — the single secret store.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { generateGeminiImage } from './gemini'
import { generateOpenAIImage } from './openai'

export type ImageGenProvider = 'gemini' | 'openai'

export interface ImageGenRequest {
  provider?: ImageGenProvider
  model?: string
  prompt: string
  /** e.g. '16:9' (gemini) or '1536x1024' (openai); provider-specific, optional */
  size?: string
  quality?: string
  /** Reference images for editing/composition (absolute paths or data URLs) */
  referenceImages?: string[]
  signal?: AbortSignal
}

export interface ImageGenResult {
  ok: boolean
  /** Absolute path of the saved PNG */
  path?: string
  provider?: ImageGenProvider
  model?: string
  error?: string
}

export const IMAGE_GEN_DEFAULTS: Record<ImageGenProvider, { model: string; label: string }> = {
  gemini: { model: 'gemini-2.5-flash-image', label: 'Gemini (banana)' },
  openai: { model: 'gpt-image-1', label: 'OpenAI gpt-image' },
}

/** vsurf provider id holding the key for each image provider */
export const IMAGE_GEN_KEY_PROVIDER: Record<ImageGenProvider, string> = {
  gemini: 'google',
  openai: 'openai',
}

export async function generateImage(req: ImageGenRequest): Promise<ImageGenResult> {
  const provider: ImageGenProvider = req.provider ?? 'gemini'
  const model = req.model || IMAGE_GEN_DEFAULTS[provider].model
  try {
    const bytes =
      provider === 'gemini'
        ? await generateGeminiImage({ ...req, model })
        : await generateOpenAIImage({ ...req, model })
    const dir = join(app.getPath('userData'), 'generated-images')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `img-${Date.now()}.png`)
    await writeFile(path, bytes)
    return { ok: true, path, provider, model }
  } catch (err) {
    return {
      ok: false,
      provider,
      model,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
