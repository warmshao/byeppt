/**
 * App-level settings (userData/app-settings.json): non-secret preferences only.
 * LLM credentials live in the vsurf AuthStorage (agent/auth.json), never here.
 */
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type UiThemePref = 'light' | 'dark' | 'system'

/** Per-provider configuration edited in Settings → 模型供应商 */
export interface AgentProviderConfig {
  /** model picked for this provider (empty/absent = registry default) */
  model?: string
  /** base URL override (also mirrored into the vsurf models.json) */
  baseUrl?: string
  /** last connectivity test passed — gates the 启用 (enable) button */
  verified?: boolean
}

/** Per-backend image-generation preferences (non-secret; keys live in AuthStorage) */
export interface ImageGenProviderConfig {
  /** custom API base URL; empty/undefined → the provider's official endpoint */
  baseUrl?: string
  /** model id; empty/undefined → the provider's default model */
  model?: string
  /** last connectivity test passed — gates the 启用 (enable) button */
  verified?: boolean
  /** last connectivity test failed — shows the broken-link state on 测试 */
  testFailed?: boolean
}

export interface AppSettings {
  theme?: UiThemePref
  /**
   * UI language preference: a concrete language, or 'system' to follow the OS
   * display language (the default when absent).
   */
  language?: string
  /** Last explicitly selected agent model */
  agentModel?: { provider: string; id: string }
  /** per-provider model/baseUrl/test state, keyed by provider id */
  agentProviders?: Record<string, AgentProviderConfig>
  /**
   * Network proxy (Settings → 通用). enabled=false → always direct;
   * enabled (default) + url → that proxy; enabled + empty url → env vars,
   * then the OS system proxy.
   */
  proxy?: { enabled?: boolean; url?: string }
  /** Image generation defaults */
  imageGen?: {
    /** active backend (one of the imagegen registry ids: gemini/openai/qwen/zhipu/volcengine) */
    provider?: string
    /** legacy single-model field (pre per-provider config); still honored as a fallback */
    model?: string
    providers?: Record<string, ImageGenProviderConfig | undefined>
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

export function readAppSettings(): AppSettings {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8')) as AppSettings
  } catch {
    return {}
  }
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...readAppSettings(), ...patch }
  mkdirSync(dirname(settingsPath()), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  return next
}
