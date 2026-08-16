/**
 * Image generation service (Phase 4): thin multi-provider layer.
 * Gemini ("banana" series, generateContent image modality) and OpenAI
 * (gpt-image series, Images API). Plain fetch, no SDKs.
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
import { generateOpenAIImage } from './openai'
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
    defaultModel: 'gemini-2.5-flash-image',
    models: ['gemini-2.5-flash-image', 'gemini-3-pro-image'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-image-1',
    models: ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-2'],
    defaultBaseUrl: 'https://api.openai.com',
  },
}

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

/**
 * Connectivity check for the settings UI: authenticated read of the configured
 * model's metadata (no image generated, no tokens spent beyond the ping).
 */
export async function testImageGenConnection(
  provider: ImageGenProvider,
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = await imageGenApiKey(provider)
  if (!apiKey) return { ok: false, error: 'no-api-key' }
  const cfg = resolveImageGenConfig(provider)
  try {
    if (provider === 'gemini') {
      const base = (cfg.baseUrl || process.env.GEMINI_BASE_URL || IMAGE_GEN_PROVIDERS.gemini.defaultBaseUrl).replace(/\/$/, '')
      const resp = await fetch(`${base}/v1beta/models/${encodeURIComponent(cfg.model)}`, {
        headers: { 'x-goog-api-key': apiKey },
      })
      if (!resp.ok) throw new Error(`gemini ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`)
    } else {
      const base = (cfg.baseUrl || process.env.OPENAI_BASE_URL || IMAGE_GEN_PROVIDERS.openai.defaultBaseUrl).replace(/\/$/, '')
      const resp = await fetch(`${base}/v1/models/${encodeURIComponent(cfg.model)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!resp.ok) throw new Error(`openai ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`)
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
