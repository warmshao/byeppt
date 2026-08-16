/**
 * API key storage for image generation: dedicated entries in the vsurf
 * AuthStorage (agent/auth.json) under `imagegen-<provider>` ids — deliberately
 * NOT shared with the LLM provider keys (`google` / `openai`), so the image
 * backend can point at a different account/relay than the chat model.
 * A dedicated lightweight instance is fine — AuthStorage persists each change
 * with a read-modify-write under a file lock, so the agent session's own
 * instance is not clobbered.
 */
import { app } from 'electron'
import { join } from 'node:path'
import type { ImageGenProvider } from './index'

type AuthStorageT = import('@warmshao/vsurf').AuthStorage

/** AuthStorage credential ids holding the image-gen keys */
const KEY_IDS: Record<ImageGenProvider, string> = {
  gemini: 'imagegen-gemini',
  openai: 'imagegen-openai',
}

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
  const key = await store.getApiKey(KEY_IDS[provider])
  return key ?? null
}

export async function setImageGenApiKey(
  provider: ImageGenProvider,
  key: string,
): Promise<boolean> {
  const store = await authStore()
  if (!store) return false
  store.set(KEY_IDS[provider], { type: 'api_key', key })
  return true
}

export async function clearImageGenApiKey(provider: ImageGenProvider): Promise<boolean> {
  const store = await authStore()
  if (!store) return false
  store.remove(KEY_IDS[provider])
  return true
}
