/**
 * Image-generation IPC: renderer/agent → main service. Registered once from
 * slides-main (works in both standalone and shell-hosted mode).
 */
import { ipcMain } from 'electron'
import { generateImage, IMAGE_GEN_DEFAULTS, type ImageGenProvider, type ImageGenRequest } from './index'
import { imageGenApiKey } from './keys'
import { readAppSettings, updateAppSettings } from '../app-settings'

let registered = false

export function registerImageGenIpc(): void {
  if (registered) return
  registered = true

  ipcMain.handle('imagegen:generate', (_e, req: ImageGenRequest) => generateImage(req))

  ipcMain.handle('imagegen:status', async () => {
    const providers = (Object.keys(IMAGE_GEN_DEFAULTS) as ImageGenProvider[]).map((id) => ({
      id,
      label: IMAGE_GEN_DEFAULTS[id].label,
      defaultModel: IMAGE_GEN_DEFAULTS[id].model,
    }))
    const keys: Record<string, boolean> = {}
    for (const p of providers) keys[p.id] = !!(await imageGenApiKey(p.id))
    return { providers, keys }
  })

  ipcMain.handle('imagegen:get-settings', () => readAppSettings().imageGen ?? {})

  ipcMain.handle('imagegen:set-settings', (_e, s: { provider?: string; model?: string }) => {
    const provider = s.provider === 'openai' ? 'openai' : 'gemini'
    updateAppSettings({ imageGen: { provider, ...(s.model ? { model: s.model } : {}) } })
    return { ok: true }
  })
}
