/**
 * App-level settings (userData/app-settings.json): non-secret preferences only.
 * LLM credentials live in the vsurf AuthStorage (agent/auth.json), never here.
 */
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type UiThemePref = 'light' | 'dark' | 'system'

export interface AppSettings {
  theme?: UiThemePref
  /** Last explicitly selected agent model */
  agentModel?: { provider: string; id: string }
  /** Image generation defaults */
  imageGen?: { provider?: 'gemini' | 'openai'; model?: string }
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
