/**
 * Kernel env bridge for the batch image path.
 *
 * The interactive image tool (generate_image) runs in the main process with
 * the Settings → 图片生成 backend. ppt-master's batch path (image_gen.py,
 * image_search.py provider keys) runs inside the vsurf IPython kernel and
 * reads its config from process env or the first `.env` at the kernel cwd —
 * which is `<userData>/agent`. Writing the active backend there keeps ONE
 * configuration surface: the user configures Settings once and both the
 * interactive tool and the kernel scripts see the same backend/key/model.
 *
 * We deliberately do NOT set process.env.OPENAI_API_KEY / GEMINI_API_KEY in
 * the main process: the image-gen keys are intentionally separate from the
 * LLM provider keys, and ambient env keys would make the vsurf ModelRegistry
 * treat the LLM provider as configured.
 *
 * Only the managed keys below are rewritten; any other lines the user added
 * (e.g. PEXELS_API_KEY for image_search) are preserved.
 */
import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAppSettings } from '../app-settings'
import { activeImageGenProvider, resolveImageGenConfig } from './index'
import { imageGenApiKey } from './keys'

const MANAGED_KEYS = [
  'IMAGE_BACKEND',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const

function envFilePath(): string {
  return join(app.getPath('userData'), 'agent', '.env')
}

/**
 * Rewrite the managed lines of `<userData>/agent/.env` from the current
 * Settings. Removes them when no backend is active so the kernel never sees
 * a stale IMAGE_BACKEND. Never throws — a missing/unwritable file must not
 * break settings save or session start.
 */
export async function syncImageGenEnvFile(): Promise<void> {
  try {
    const path = envFilePath()
    const kept: string[] = []
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)\s*=/.exec(line)
        if (m && (MANAGED_KEYS as readonly string[]).includes(m[1]!)) continue
        kept.push(line)
      }
    }
    while (kept.length && kept[kept.length - 1]!.trim() === '') kept.pop()

    const provider = activeImageGenProvider()
    if (provider) {
      const cfg = resolveImageGenConfig(provider)
      const key = await imageGenApiKey(provider)
      const lines: string[] = [`IMAGE_BACKEND=${provider}`]
      const prefix = provider === 'gemini' ? 'GEMINI' : 'OPENAI'
      if (key) lines.push(`${prefix}_API_KEY=${key}`)
      if (cfg.baseUrl) lines.push(`${prefix}_BASE_URL=${cfg.baseUrl}`)
      if (cfg.model) lines.push(`${prefix}_MODEL=${cfg.model}`)
      kept.push(...lines)
    }

    const tmp = `${path}.tmp`
    writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    console.warn('[imagegen] failed to sync kernel .env:', err)
  }
}
