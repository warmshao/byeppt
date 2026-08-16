/**
 * API key resolution for image generation: reads the vsurf AuthStorage
 * (agent/auth.json, also env-var aware). A dedicated lightweight instance is
 * fine — AuthStorage is file-backed and read-cached; writes go through the
 * settings UI's own instance with proper locking.
 */
import { app } from 'electron'
import { join } from 'node:path'
import type { ImageGenProvider } from './index'
import { IMAGE_GEN_KEY_PROVIDER } from './index'

type AuthStorageT = import('@warmshao/vsurf').AuthStorage

let auth: AuthStorageT | null = null

async function authStore(): Promise<AuthStorageT | null> {
  if (auth) return auth
  try {
    const sdk = await import('@warmshao/vsurf')
    auth = sdk.AuthStorage.create(join(app.getPath('userData'), 'agent', 'auth.json'))
    return auth
  } catch {
    return null
  }
}

export async function imageGenApiKey(provider: ImageGenProvider): Promise<string | null> {
  const store = await authStore()
  if (!store) return null
  const key = await store.getApiKey(IMAGE_GEN_KEY_PROVIDER[provider])
  return key ?? null
}
