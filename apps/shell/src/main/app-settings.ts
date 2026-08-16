import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Helpers for userData/app-settings.json — a flat JSON object holding
 * cross-module app preferences (UI language, first-run onboarding flag).
 * Editor modules read the same file, so the shape must stay a plain object.
 */

export function readAppSettings(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>
    }
  } catch {
    // missing or corrupt file: treat as empty settings
  }
  return {}
}

export function writeAppSetting(path: string, key: string, value: unknown): void {
  const settings = { ...readAppSettings(path), [key]: value }
  writeFileSync(path, JSON.stringify(settings, null, 2))
}
