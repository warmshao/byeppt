/**
 * Image generation service (Phase 4): thin multi-provider layer.
 * OpenAI (gpt-image series) goes through the Vercel AI SDK
 * (`@ai-sdk/openai` + `ai`'s generateImage) for text-to-image AND editing;
 * Gemini ("banana" series) calls the Generative Language `generateContent`
 * endpoint directly — the only Gemini path OpenAI-style relays proxy.
 *
 * Each backend is configured independently in Settings → 图片生成: its own API
 * key (vsurf AuthStorage under `imagegen-<id>`, NOT shared with the LLM
 * provider keys), an optional base-URL override (empty = official endpoint),
 * and a model pick. Non-secret prefs live in userData/app-settings.json.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { readAppSettings } from '../app-settings'
import { generateGeminiImage } from './gemini'
import { editOpenAIImage, generateOpenAIImage } from './openai'
import { imageGenApiKey } from './keys'

export type ImageGenProvider = 'gemini' | 'openai'

export interface ImageGenProviderInfo {
  id: ImageGenProvider
  label: string
  defaultModel: string
  /** preset model choices for the settings picker (custom ids stay possible) */
  models: string[]
  defaultBaseUrl: string
}

export const IMAGE_GEN_PROVIDERS: Record<ImageGenProvider, ImageGenProviderInfo> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-3.1-flash-image',
    models: ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-image-2',
    models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'],
    defaultBaseUrl: 'https://api.openai.com',
  },
}

export interface ImageGenRequest {
  provider?: ImageGenProvider
  model?: string
  prompt: string
  /** e.g. '16:9' (gemini) or '1536x1024' (openai); provider-specific, optional */
  size?: string
  /** openai: 'low'|'medium'|'high'|'auto'; gemini: ignored */
  quality?: string
  /**
   * Source image(s) for editing / image-to-image / composition
   * (absolute paths, data URLs, or raw base64). Required for editImage().
   */
  referenceImages?: string[]
  /** Inpainting mask (OpenAI only): transparent areas are the edit region. */
  mask?: string
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

/**
 * Which backend the agent's image tool currently uses, or null when the user
 * hasn't explicitly enabled one yet (nothing is active by default).
 */
export function activeImageGenProvider(): ImageGenProvider | null {
  const p = readAppSettings().imageGen?.provider
  return p === 'gemini' || p === 'openai' ? p : null
}

/**
 * Effective config for one backend: explicit per-provider settings win, then
 * the legacy flat `imageGen.model` (only for the provider it was saved with),
 * then the catalog defaults. `baseUrl` stays undefined when unconfigured so
 * the provider module can fall back to its env var / official endpoint.
 */
export function resolveImageGenConfig(provider: ImageGenProvider): {
  model: string
  baseUrl?: string
} {
  const saved = readAppSettings().imageGen
  const info = IMAGE_GEN_PROVIDERS[provider]
  const cfg = saved?.providers?.[provider]
  const legacyModel = saved?.provider === provider ? saved?.model : undefined
  return {
    model: cfg?.model || legacyModel || info.defaultModel,
    baseUrl: cfg?.baseUrl?.trim() || undefined,
  }
}

async function saveImageBytes(
  bytes: Uint8Array,
  provider: ImageGenProvider,
  model: string,
): Promise<ImageGenResult> {
  const dir = join(app.getPath('userData'), 'generated-images')
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `img-${Date.now()}.png`)
  await writeFile(path, bytes)
  return { ok: true, path, provider, model }
}

/** Text-to-image using the active backend. */
export async function generateImage(req: ImageGenRequest): Promise<ImageGenResult> {
  const provider = req.provider ?? activeImageGenProvider()
  if (!provider) {
    return {
      ok: false,
      error:
        'no-active-provider: no image backend enabled — the user can enable one in Settings → Image generation',
    }
  }
  const cfg = resolveImageGenConfig(provider)
  const model = req.model || cfg.model
  try {
    const bytes =
      provider === 'gemini'
        ? await generateGeminiImage({ ...req, model, baseUrl: cfg.baseUrl })
        : await generateOpenAIImage({ ...req, model, baseUrl: cfg.baseUrl })
    return await saveImageBytes(bytes, provider, model)
  } catch (err) {
    return {
      ok: false,
      provider,
      model,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Image-to-image / editing (reference images required; mask optional, OpenAI only). */
export async function editImage(req: ImageGenRequest): Promise<ImageGenResult> {
  const provider = req.provider ?? activeImageGenProvider()
  if (!provider) {
    return {
      ok: false,
      error:
        'no-active-provider: no image backend enabled — the user can enable one in Settings → Image generation',
    }
  }
  if (!req.referenceImages?.length) {
    return { ok: false, provider, error: 'edit requires at least one input image' }
  }
  const cfg = resolveImageGenConfig(provider)
  const model = req.model || cfg.model
  try {
    const bytes =
      provider === 'gemini'
        ? await generateGeminiImage({ ...req, model, baseUrl: cfg.baseUrl })
        : await editOpenAIImage({ ...req, model, baseUrl: cfg.baseUrl })
    return await saveImageBytes(bytes, provider, model)
  } catch (err) {
    return {
      ok: false,
      provider,
      model,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Connectivity check for the settings UI. OpenAI-compatible relays commonly do
 * not implement per-model metadata reads (some even return HTTP 200 with an
 * error body), so exercise the same generation path used by the product with a
 * minimal low-quality request.
 */
export async function testImageGenConnection(
  provider: ImageGenProvider,
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = await imageGenApiKey(provider)
  if (!apiKey) return { ok: false, error: 'no-api-key' }
  const cfg = resolveImageGenConfig(provider)
  try {
    if (provider === 'gemini') {
      // A minimal generateContent ping: relays (new-api etc.) implement only
      // this endpoint — model metadata reads and the Interactions API 404.
      const base = (cfg.baseUrl || process.env.GEMINI_BASE_URL || IMAGE_GEN_PROVIDERS.gemini.defaultBaseUrl).replace(/\/$/, '')
      const resp = await fetch(`${base}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
      })
      if (!resp.ok) throw new Error(`gemini ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`)
    } else {
      await generateOpenAIImage({
        prompt: 'connectivity test',
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        size: '1024x1024',
        quality: 'low',
      })
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
