/**
 * Image-generation IPC: renderer/agent → main service. Registered once from
 * slides-main (works in both standalone and shell-hosted mode).
 *
 * Enable flow state machine (mirrors the LLM providers pane):
 *   configure key/baseUrl/model → 测试 connectivity → verified → 启用.
 * Editing config or the key resets `verified`; a failed test sets
 * `testFailed` (broken-link button state in the UI). Nothing is active by
 * default — the user must explicitly enable a backend.
 */
import { ipcMain } from 'electron'
import {
  activeImageGenProvider,
  IMAGE_GEN_PROVIDERS,
  isImageGenProvider,
  resolveImageGenConfig,
  testImageGenConnection,
  type ImageGenProvider,
} from './index'
import { clearImageGenApiKey, imageGenApiKey, setImageGenApiKey } from './keys'
import { syncImageGenEnvFile } from './env'
import { readAppSettings, updateAppSettings, type ImageGenProviderConfig } from '../app-settings'

let registered = false

/** merge a patch into one backend's config block */
function patchProviderConfig(
  provider: ImageGenProvider,
  patch: Partial<ImageGenProviderConfig>,
): void {
  const saved = readAppSettings().imageGen
  const prev = saved?.providers?.[provider] ?? {}
  updateAppSettings({
    imageGen: { ...saved, providers: { ...saved?.providers, [provider]: { ...prev, ...patch } } },
  })
}

export function registerImageGenIpc(): void {
  if (registered) return
  registered = true

  /** Card rows for the settings pane: per-backend config + key/test state + active flag */
  ipcMain.handle('imagegen:status', async () => {
    const active = activeImageGenProvider()
    const saved = readAppSettings().imageGen
    const providers = []
    for (const id of Object.keys(IMAGE_GEN_PROVIDERS) as ImageGenProvider[]) {
      const info = IMAGE_GEN_PROVIDERS[id]
      const cfg = resolveImageGenConfig(id)
      const stored = saved?.providers?.[id]
      const hasKey = !!(await imageGenApiKey(id))
      providers.push({
        id,
        label: info.label,
        defaultModel: info.defaultModel,
        models: info.models,
        defaultBaseUrl: info.defaultBaseUrl,
        baseUrl: cfg.baseUrl ?? '',
        model: cfg.model,
        hasKey,
        verified: stored?.verified === true,
        testFailed: stored?.testFailed === true,
        // a stored-but-keyless pick (e.g. legacy default) is not "in use" —
        // generation would fail anyway, so don't pretend it's active
        active: id === active && hasKey,
      })
    }
    return { providers }
  })

  /** 启用: only a backend that passed its connectivity test can be enabled */
  ipcMain.handle('imagegen:set-active', async (_e, provider: string) => {
    if (!isImageGenProvider(provider)) return { ok: false, error: 'unknown-provider' }
    if (readAppSettings().imageGen?.providers?.[provider]?.verified !== true) {
      return { ok: false, error: 'not-verified' }
    }
    if (!(await imageGenApiKey(provider))) return { ok: false, error: 'no-api-key' }
    const imageGen = { ...readAppSettings().imageGen, provider }
    updateAppSettings({ imageGen })
    await syncImageGenEnvFile()
    return { ok: true }
  })

  /** Per-backend non-secret prefs; empty strings clear the override.
   *  Any config change invalidates the last test result. */
  ipcMain.handle(
    'imagegen:set-config',
    (_e, provider: string, cfg: { baseUrl?: string; model?: string }) => {
      if (!isImageGenProvider(provider)) return { ok: false, error: 'unknown-provider' }
      const prev = readAppSettings().imageGen?.providers?.[provider] ?? {}
      const next: ImageGenProviderConfig = { ...prev, verified: false, testFailed: false }
      if (cfg.baseUrl !== undefined) {
        const v = cfg.baseUrl.trim()
        if (v) next.baseUrl = v
        else delete next.baseUrl
      }
      if (cfg.model !== undefined) {
        const v = cfg.model.trim()
        if (v) next.model = v
        else delete next.model
      }
      const saved = readAppSettings().imageGen
      updateAppSettings({
        imageGen: { ...saved, providers: { ...saved?.providers, [provider]: next } },
      })
      void syncImageGenEnvFile()
      return { ok: true }
    },
  )

  ipcMain.handle('imagegen:set-key', async (_e, provider: string, key: string) => {
    if (!isImageGenProvider(provider)) return { ok: false, error: 'unknown-provider' }
    if (!key.trim()) return { ok: false, error: 'empty-key' }
    const ok = await setImageGenApiKey(provider, key.trim())
    if (!ok) return { ok: false, error: 'sdk-load-failed' }
    // new key → previous test result no longer meaningful
    patchProviderConfig(provider, { verified: false, testFailed: false })
    await syncImageGenEnvFile()
    return { ok: true }
  })

  ipcMain.handle('imagegen:clear-key', async (_e, provider: string) => {
    if (!isImageGenProvider(provider)) return { ok: false, error: 'unknown-provider' }
    await clearImageGenApiKey(provider)
    patchProviderConfig(provider, { verified: false, testFailed: false })
    await syncImageGenEnvFile()
    return { ok: true }
  })

  ipcMain.handle('imagegen:test', async (_e, provider: string) => {
    if (!isImageGenProvider(provider)) return { ok: false, error: 'unknown-provider' }
    const res = await testImageGenConnection(provider)
    patchProviderConfig(provider, { verified: res.ok, testFailed: !res.ok })
    return res
  })
}
