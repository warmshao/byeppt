/**
 * Image generation backends (Settings → 图片生成): registry + config only.
 *
 * byeppt keeps NO generation protocol code in the main process. All image
 * generation runs through the bundled byeppt-pptx-py toolchain
 * (image_gen.py — gemini/openai/qwen/zhipu/volcengine/... backends) inside the
 * kernel python environment, one implementation shared by the interactive
 * chat flow and the deck batch flow. The agent invokes it via
 * `pm.run('image_gen', ...)`; this module owns:
 *   - the backend registry exposed to the settings pane,
 *   - per-backend settings resolution (model / baseUrl; keys live in keys.ts),
 *   - the connectivity test, which performs a REAL minimal generation through
 *     image_gen.py so relays/protocol mismatches surface exactly as they
 *     would in production.
 *
 * Each backend is configured independently: its own API key (vsurf AuthStorage
 * under `imagegen-<id>`, NOT shared with the LLM provider keys), an optional
 * base-URL override (empty = official endpoint), and a model pick. Non-secret
 * prefs live in userData/app-settings.json.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAppSettings } from '../app-settings'
import { provisionKernelSkills, resolveKernelPython } from '../agent/kernel-env'
import { imageGenApiKey } from './keys'

export type ImageGenProvider = 'gemini' | 'openai' | 'qwen' | 'zhipu' | 'volcengine'

export interface ImageGenProviderInfo {
  id: ImageGenProvider
  label: string
  defaultModel: string
  /** preset model choices for the settings picker (custom ids stay possible) */
  models: string[]
  defaultBaseUrl: string
  /**
   * Env var prefix image_gen.py reads for this backend:
   * `<PREFIX>_API_KEY` / `<PREFIX>_BASE_URL` / `<PREFIX>_MODEL`.
   */
  envPrefix: string
}

/**
 * The settings pane mirrors image_gen.py's CORE backends. Defaults here track
 * `BACKEND_REGISTRY` / `backend_*.py` in
 * skills/byeppt-pptx-py/src/byeppt_pptx_py/scripts — keep them in sync.
 */
export const IMAGE_GEN_PROVIDERS: Record<ImageGenProvider, ImageGenProviderInfo> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-3.1-flash-image',
    models: ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    envPrefix: 'GEMINI',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-image-2',
    models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'],
    defaultBaseUrl: 'https://api.openai.com',
    envPrefix: 'OPENAI',
  },
  qwen: {
    id: 'qwen',
    label: 'Alibaba Qwen',
    defaultModel: 'qwen-image-2.0-pro',
    models: ['qwen-image-2.0-pro', 'qwen-image-3.0-pro', 'qwen-image-2.0', 'qwen-image'],
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    envPrefix: 'QWEN',
  },
  zhipu: {
    id: 'zhipu',
    label: 'Zhipu GLM-Image',
    defaultModel: 'glm-image',
    models: ['glm-image'],
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
    envPrefix: 'ZHIPU',
  },
  volcengine: {
    id: 'volcengine',
    label: 'Volcengine Seedream',
    defaultModel: 'doubao-seedream-4-5-251128',
    models: ['doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'],
    defaultBaseUrl: 'https://operator.las.cn-beijing.volces.com/api/v1/images/generations',
    envPrefix: 'VOLCENGINE',
  },
}

export function isImageGenProvider(id: unknown): id is ImageGenProvider {
  return typeof id === 'string' && id in IMAGE_GEN_PROVIDERS
}

/**
 * Which backend the agent's image generation currently uses, or null when the
 * user hasn't explicitly enabled one yet (nothing is active by default).
 */
export function activeImageGenProvider(): ImageGenProvider | null {
  const p = readAppSettings().imageGen?.provider
  return isImageGenProvider(p) ? p : null
}

/**
 * Effective config for one backend: explicit per-provider settings win, then
 * the legacy flat `imageGen.model` (only for the provider it was saved with),
 * then the catalog defaults. `baseUrl` stays undefined when unconfigured so
 * image_gen.py falls back to the backend's official endpoint.
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

/** <userData>/agent — kernel cwd; image_gen.py reads its .env as fallback. */
function agentDir(): string {
  return join(app.getPath('userData'), 'agent')
}

const TEST_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Connectivity check for the settings UI: a real minimal generation through
 * image_gen.py, using the tested backend's own stored key/baseUrl/model
 * (injected as process env, which beats the .env fallback — so ANY configured
 * backend can be tested, not just the active one, and the kernel is never
 * polluted). Spawning the kernel venv python directly keeps this independent
 * of any agent session.
 */
export async function testImageGenConnection(
  provider: ImageGenProvider,
): Promise<{ ok: boolean; error?: string }> {
  const info = IMAGE_GEN_PROVIDERS[provider]
  if (!info) return { ok: false, error: 'unknown-provider' }
  const apiKey = await imageGenApiKey(provider)
  if (!apiKey) return { ok: false, error: 'no-api-key' }

  // The test runs image_gen.py — make sure the kernel venv + skills exist
  // (idempotent: a quick import check when already provisioned).
  const provision = await provisionKernelSkills()
  if (!provision.ok) return { ok: false, error: provision.error ?? 'kernel-env-not-ready' }
  const python = resolveKernelPython()
  if (!existsSync(python)) return { ok: false, error: 'kernel-env-not-ready' }

  const cfg = resolveImageGenConfig(provider)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    [`${info.envPrefix}_API_KEY`]: apiKey,
  }
  if (cfg.baseUrl) env[`${info.envPrefix}_BASE_URL`] = cfg.baseUrl
  if (cfg.model) env[`${info.envPrefix}_MODEL`] = cfg.model

  const outDir = join(tmpdir(), `byeppt-imagegen-test-${process.pid}`)
  const code = [
    'import asyncio, byeppt_pptx_py as pm',
    `asyncio.run(pm.run('image_gen', prompt='connectivity test: a plain solid blue square',` +
      ` output=${JSON.stringify(outDir)}, backend=${JSON.stringify(provider)}, aspect_ratio='1:1'))`,
  ].join('\n')

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(python, ['-c', code], {
        cwd: agentDir(),
        env,
        windowsHide: true,
      })
      let out = ''
      child.stdout.on('data', (d) => (out += String(d)))
      child.stderr.on('data', (d) => (out += String(d)))
      const timer = setTimeout(() => {
        child.kill()
        rejectPromise(new Error('timeout: image generation took too long'))
      }, TEST_TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        rejectPromise(err)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        // image_gen.py prints its errors to stdout; the tail has the cause
        if (code === 0) resolvePromise()
        else rejectPromise(new Error(out.trim().slice(-300) || `exited ${code}`))
      })
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    void rm(outDir, { recursive: true, force: true }).catch(() => {})
  }
}
