/**
 * Image-generation IPC: renderer/agent → main service. Registered once from
 * slides-main (works in both standalone and shell-hosted mode).
 */
import { ipcMain } from 'electron'
import { generateImage, IMAGE_GEN_DEFAULTS, type ImageGenProvider, type ImageGenRequest } from './index'
import { imageGenApiKey } from './keys'

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
}
