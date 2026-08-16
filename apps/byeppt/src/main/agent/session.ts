/**
 * byeppt agent host — embeds the vsurf RLM agent (`@warmshao/vsurf` SDK) in the
 * Electron main process.
 *
 * The session is created lazily on first prompt. Every AgentSessionEvent is
 * forwarded to all renderer windows ('agent:event'); the chat panel renders
 * straight from that stream. Slide-editing tools bridge in as customTools
 * (Phase 2, deck-bridge); image generation as a customTool (Phase 4).
 *
 * Credentials: vsurf AuthStorage at <userData>/agent/auth.json (the only
 * secret store). The non-secret "last selected model" lives in app-settings.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { readAppSettings, updateAppSettings } from '../app-settings'
import { buildSlideCustomTools } from './slide-tools-main'

type VsurfSdk = typeof import('@warmshao/vsurf')
type AgentSession = import('@warmshao/vsurf').AgentSession
type AuthStorage = import('@warmshao/vsurf').AuthStorage
type ModelRegistry = import('@warmshao/vsurf').ModelRegistry

export interface AgentModelInfo {
  provider: string
  id: string
  name: string
}

export interface AgentStatus {
  /** SDK loaded and a session can be created */
  sdkReady: boolean
  /** A model with credentials is configured and selected */
  ready: boolean
  streaming: boolean
  model?: AgentModelInfo
  /** Models that have credentials configured */
  availableModels: AgentModelInfo[]
  /** Human-readable blocker (e.g. 'no-model') */
  error?: string
}

let sdk: VsurfSdk | null = null
let sdkError: string | null = null
let session: AgentSession | null = null
let authStorage: AuthStorage | null = null
let modelRegistry: ModelRegistry | null = null
let starting: Promise<AgentSession | null> | null = null

const agentDir = (): string => join(app.getPath('userData'), 'agent')

async function loadSdk(): Promise<VsurfSdk | null> {
  if (sdk) return sdk
  if (sdkError) return null
  try {
    // ESM-only package; the main bundle is CJS, so this resolves through
    // Node's ESM-from-CJS dynamic import (externalized, not bundled).
    sdk = await import('@warmshao/vsurf')
    console.log('[agent] vsurf sdk loaded')
    return sdk
  } catch (err) {
    sdkError = err instanceof Error ? err.message : String(err)
    console.error('[agent] failed to load @warmshao/vsurf:', sdkError)
    return null
  }
}

function modelInfo(m: { provider: string; id: string; name?: string }): AgentModelInfo {
  return { provider: m.provider, id: m.id, name: m.name ?? m.id }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

async function ensureStores(): Promise<{
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
} | null> {
  const s = await loadSdk()
  if (!s) return null
  if (!authStorage) authStorage = s.AuthStorage.create(join(agentDir(), 'auth.json'))
  if (!modelRegistry) {
    modelRegistry = s.ModelRegistry.create(authStorage, join(agentDir(), 'models.json'))
  }
  return { authStorage, modelRegistry }
}

/** Pick the model: last explicit selection (if still usable) → first model with credentials. */
function pickModel(reg: ModelRegistry): ReturnType<ModelRegistry['getAvailable']>[number] | undefined {
  const saved = readAppSettings().agentModel
  if (saved) {
    const m = reg.find(saved.provider, saved.id)
    if (m && reg.hasConfiguredAuth(m)) return m
  }
  return reg.getAvailable()[0]
}

async function ensureSession(): Promise<AgentSession | null> {
  if (session) return session
  if (starting) return starting
  starting = (async () => {
    const s = await loadSdk()
    const stores = await ensureStores()
    if (!s || !stores) return null
    const model = pickModel(stores.modelRegistry)
    if (!model) {
      console.warn('[agent] no model with credentials configured yet')
      return null
    }
    const { session: created } = await s.createAgentSession({
      agentDir: agentDir(),
      cwd: agentDir(),
      authStorage: stores.authStorage,
      modelRegistry: stores.modelRegistry,
      model,
      // Slide-editing tools: each forwards over the deck bridge into the active
      // slides renderer (see slide-tools-main.ts / deck-bridge.ts)
      customTools: await buildSlideCustomTools(s),
    })
    created.subscribe((event) => {
      try {
        broadcast('agent:event', event)
      } catch (err) {
        console.warn('[agent] failed to forward event', event?.type, err)
      }
    })
    session = created
    broadcast('agent:status', await getStatus())
    return created
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

async function getStatus(): Promise<AgentStatus> {
  const stores = await ensureStores()
  if (!stores) {
    return { sdkReady: false, ready: false, streaming: false, availableModels: [], error: sdkError ?? 'sdk-load-failed' }
  }
  const available = stores.modelRegistry.getAvailable().map(modelInfo)
  const current = session?.model ?? pickModel(stores.modelRegistry)
  return {
    sdkReady: true,
    ready: !!current,
    streaming: session?.isStreaming ?? false,
    model: current ? modelInfo(current) : undefined,
    availableModels: available,
    ...(current ? {} : { error: 'no-model' }),
  }
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:status', () => getStatus())

  ipcMain.handle('agent:prompt', async (_e, text: string) => {
    const s = await ensureSession()
    if (!s) return { ok: false, error: sdkError ?? 'no-model' }
    const wasIdle = !s.isStreaming
    // Fire and settle in the background; the event stream carries progress.
    void s.prompt(String(text)).catch(async (err) => {
      broadcast('agent:event', {
        type: 'byeppt:error',
        message: err instanceof Error ? err.message : String(err),
      })
      broadcast('agent:status', await getStatus())
    })
    if (wasIdle) broadcast('agent:status', await getStatus())
    return { ok: true }
  })

  ipcMain.handle('agent:abort', async () => {
    if (!session) return { ok: true }
    await session.abort()
    broadcast('agent:status', await getStatus())
    return { ok: true }
  })

  ipcMain.handle('agent:set-model', async (_e, sel: { provider: string; id: string }) => {
    const stores = await ensureStores()
    if (!stores) return { ok: false, error: sdkError ?? 'sdk-load-failed' }
    const m = stores.modelRegistry.find(sel.provider, sel.id)
    if (!m) return { ok: false, error: 'unknown-model' }
    updateAppSettings({ agentModel: { provider: sel.provider, id: sel.id } })
    if (session) await session.setModel(m)
    broadcast('agent:status', await getStatus())
    return { ok: true }
  })

  ipcMain.handle('agent:new-session', async () => {
    if (session) {
      const old = session
      session = null
      try {
        await old.disposeAsync()
      } catch (err) {
        console.warn('[agent] dispose failed:', err)
      }
    }
    await ensureSession()
    broadcast('agent:status', await getStatus())
    return { ok: true }
  })

  // ── Provider key management (settings UI) ─────────────────────────────

  ipcMain.handle('agent:list-providers', async () => {
    const stores = await ensureStores()
    if (!stores) return []
    const reg = stores.modelRegistry
    const ids = [...new Set(reg.getAll().map((m) => m.provider))].sort()
    const rows = []
    for (const id of ids) {
      const status = reg.getProviderAuthStatus(id)
      rows.push({
        id,
        name: reg.getProviderDisplayName(id),
        hasKey: status.configured,
        source: status.source,
      })
    }
    return rows
  })

  ipcMain.handle('agent:set-key', async (_e, provider: string, key: string) => {
    const stores = await ensureStores()
    if (!stores) return { ok: false, error: sdkError ?? 'sdk-load-failed' }
    if (!provider || !key.trim()) return { ok: false, error: 'empty-key' }
    stores.authStorage.set(provider, { type: 'api_key', key: key.trim() })
    broadcast('agent:status', await getStatus())
    return { ok: true }
  })

  ipcMain.handle('agent:clear-key', async (_e, provider: string) => {
    const stores = await ensureStores()
    if (!stores) return { ok: false }
    stores.authStorage.remove(provider)
    broadcast('agent:status', await getStatus())
    return { ok: true }
  })

  ipcMain.handle('agent:test-key', async (_e, provider: string) => {
    const stores = await ensureStores()
    if (!stores) return { ok: false, error: sdkError ?? 'sdk-load-failed' }
    const apiKey = await stores.authStorage.getApiKey(provider)
    if (!apiKey) return { ok: false, error: 'no-key' }
    // Ping with the provider's cheapest available model (or any catalog model).
    const models = stores.modelRegistry.getAvailable().filter((m) => m.provider === provider)
    const fallback = stores.modelRegistry.getAll().find((m) => m.provider === provider)
    const model = models[0] ?? fallback
    if (!model) return { ok: false, error: 'no-model-for-provider' }
    try {
      const ai = await import('vsurf-ai')
      await ai.completeSimple(
        model,
        { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] },
        { apiKey, maxTokens: 8 },
      )
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
    }
  })
}
