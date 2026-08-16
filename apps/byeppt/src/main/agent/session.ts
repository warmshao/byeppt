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
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAppSettings, updateAppSettings } from '../app-settings'
import type { AgentProviderConfig } from '../app-settings'
import { buildSlideCustomTools } from './slide-tools-main'

/** Short preamble appended to the vsurf system prompt: orients the agent inside byeppt. */
const BYEPPT_PREAMBLE = [
  'You are running inside byeppt, a desktop presentation app (a live PowerPoint editor).',
  'The user sees the deck canvas updating in real time as your slide tools run.',
  'Slide tools (get_deck_context, read_slide, execute_slide_script, add_*, set_element_*, generate_image, ask_clarification, import_pptx_slides, …) operate on the currently open deck — results appear on canvas immediately and are undoable by the user.',
  'For any deck creation/beautify/heavy-edit task, follow the byeppt-deck skill (its methodology, stage gates, and design references are authoritative).',
  'Never fabricate numbers as facts (the tools enforce dataSource); reply in the user’s language.',
].join('\n')

/** Locate the bundled skills dir (repo ./skills in dev, resources/skills when packaged). */
function resolveSkillsDir(): string | null {
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'skills'))
  let dir = app.getAppPath()
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, 'skills'))
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  for (const c of candidates) {
    if (existsSync(join(c, 'byeppt-deck', 'SKILL.md'))) return c
  }
  console.warn('[agent] skills dir not found; deck skill unavailable')
  return null
}

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
    await syncOpenAICompatible({ authStorage, modelRegistry })
  }
  return { authStorage, modelRegistry }
}

/**
 * The "OpenAI Compatible" provider: any endpoint speaking the OpenAI
 * chat-completions format (vLLM, Ollama, LM Studio, corporate gateways, …).
 *
 * vsurf only accepts a custom provider with models when an apiKey travels with
 * the definition, so this provider is materialized into models.json the moment
 * the user saves a key (the SDK's own models_json_key mechanism; the file is
 * mode 0600 like auth.json). Until then the settings list shows a synthetic row
 * so the user has somewhere to paste the key. model/baseUrl persist in
 * app-settings under agentProviders['openai-compatible'].
 */
export const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible'
const OPENAI_COMPATIBLE_NAME = 'OpenAI Compatible'
const OPENAI_COMPATIBLE_DEFAULT_URL = 'https://api.openai.com/v1'

async function syncOpenAICompatible(stores: {
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
}): Promise<void> {
  const reg = stores.modelRegistry
  const modelsJson = reg.getModelsJsonPath()
  if (!modelsJson) return
  const cfg = readAppSettings().agentProviders?.[OPENAI_COMPATIBLE_PROVIDER]
  const key = await stores.authStorage.getApiKey(OPENAI_COMPATIBLE_PROVIDER)
  if (!key) {
    // no key → the provider must not exist (its models.json apiKey would count
    // as configured): drop the entry if a previous run left one
    if (!existsSync(modelsJson)) return
    try {
      const parsed = JSON.parse(readFileSync(modelsJson, 'utf8')) as {
        providers?: Record<string, unknown>
      }
      if (parsed.providers && OPENAI_COMPATIBLE_PROVIDER in parsed.providers) {
        delete parsed.providers[OPENAI_COMPATIBLE_PROVIDER]
        writeFileSync(modelsJson, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
        reg.refresh()
      }
    } catch (err) {
      console.warn('[agent] failed to strip openai-compatible from models.json:', err)
    }
    return
  }
  reg.upsertCustomProvider(OPENAI_COMPATIBLE_PROVIDER, {
    name: OPENAI_COMPATIBLE_NAME,
    baseUrl: cfg?.baseUrl || OPENAI_COMPATIBLE_DEFAULT_URL,
    api: 'openai-completions',
    apiKey: key,
    models: [{ id: cfg?.model || 'gpt-4o-mini', name: cfg?.model || 'gpt-4o-mini' }],
  })
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
    const skillsDir = resolveSkillsDir()
    const resourceLoader = new s.DefaultResourceLoader({
      cwd: agentDir(),
      agentDir: agentDir(),
      ...(skillsDir
        ? {
            additionalSkillPaths: [
              join(skillsDir, 'byeppt-deck'),
              join(skillsDir, 'byeppt-pptx-py'),
            ],
          }
        : {}),
      appendSystemPrompt: [BYEPPT_PREAMBLE],
    })
    const { session: created } = await s.createAgentSession({
      agentDir: agentDir(),
      cwd: agentDir(),
      authStorage: stores.authStorage,
      modelRegistry: stores.modelRegistry,
      model,
      resourceLoader,
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

  /** Read/merge the per-provider config map in app-settings.json. */
  const providerConfigs = () => readAppSettings().agentProviders ?? {}
  const patchProviderConfig = (
    provider: string,
    patch: Partial<AgentProviderConfig>,
  ): void => {
    const all = providerConfigs()
    const next = { ...all[provider], ...patch }
    // drop empty entries so the file stays clean
    if (!next.model && !next.baseUrl && !next.verified) delete all[provider]
    else all[provider] = next
    updateAppSettings({ agentProviders: all })
  }

  /** Mirror a base-URL override into the vsurf models.json (what the registry
   *  actually reads), or remove the override when cleared. */
  const applyBaseUrlOverride = (
    reg: ModelRegistry,
    provider: string,
    baseUrl: string | undefined,
  ): void => {
    const modelsJson = reg.getModelsJsonPath()
    if (!modelsJson) return
    if (baseUrl) {
      reg.upsertCustomProvider(provider, { baseUrl })
      return
    }
    // clearing: upsertCustomProvider can't express removal — edit the file
    if (!existsSync(modelsJson)) return
    try {
      const parsed = JSON.parse(readFileSync(modelsJson, 'utf8')) as {
        providers?: Record<string, Record<string, unknown>>
      }
      const entry = parsed.providers?.[provider]
      if (!entry) return
      delete entry.baseUrl
      if (Object.keys(entry).length === 0) delete parsed.providers![provider]
      writeFileSync(modelsJson, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
      reg.refresh()
    } catch (err) {
      console.warn('[agent] failed to clear base URL override:', err)
    }
  }

  ipcMain.handle('agent:list-providers', async () => {
    const stores = await ensureStores()
    if (!stores) return []
    const reg = stores.modelRegistry
    const all = reg.getAll()
    const configs = providerConfigs()
    const current = session?.model ?? pickModel(reg)
    const oauthIds = new Set(stores.authStorage.getOAuthProviders().map((p) => p.id))
    /** how the provider authenticates: subscription OAuth / AWS creds / plain key */
    const authKind = (id: string): 'oauth' | 'aws' | 'api_key' =>
      id === 'amazon-bedrock' ? 'aws' : oauthIds.has(id) ? 'oauth' : 'api_key'
    const ids = [...new Set(all.map((m) => m.provider))].sort()
    const rows = []
    for (const id of ids) {
      const status = reg.getProviderAuthStatus(id)
      rows.push({
        id,
        name:
          id === OPENAI_COMPATIBLE_PROVIDER
            ? OPENAI_COMPATIBLE_NAME
            : reg.getProviderDisplayName(id),
        hasKey: status.configured,
        source: status.source,
        auth: authKind(id),
        model: configs[id]?.model ?? '',
        baseUrl: configs[id]?.baseUrl ?? all.find((m) => m.provider === id)?.baseUrl ?? '',
        baseUrlOverride: configs[id]?.baseUrl ?? '',
        verified: configs[id]?.verified === true,
        active: current?.provider === id,
      })
    }
    // no key saved yet → the provider isn't materialized in the registry;
    // show a synthetic row so the user has somewhere to paste one
    if (!ids.includes(OPENAI_COMPATIBLE_PROVIDER)) {
      const cfg = configs[OPENAI_COMPATIBLE_PROVIDER]
      rows.push({
        id: OPENAI_COMPATIBLE_PROVIDER,
        name: OPENAI_COMPATIBLE_NAME,
        hasKey: false,
        auth: 'api_key',
        model: cfg?.model ?? '',
        baseUrl: cfg?.baseUrl ?? OPENAI_COMPATIBLE_DEFAULT_URL,
        baseUrlOverride: cfg?.baseUrl ?? '',
        verified: false,
        active: false,
      })
      rows.sort((a, b) => a.id.localeCompare(b.id))
    }
    return rows
  })

  /** Full catalog of known models for one provider (auth not required) — the
   *  settings dialog offers these in its model picker. */
  ipcMain.handle('agent:list-provider-models', async (_e, provider: string) => {
    const stores = await ensureStores()
    if (!stores) return []
    return stores.modelRegistry
      .getAll()
      .filter((m) => m.provider === provider)
      .map((m) => ({ id: m.id, name: m.name ?? m.id }))
  })

  /** Persist the edit-dialog fields: model pick + (openai-compatible only) base
   *  URL override. Changing the endpoint invalidates the last connectivity test. */
  ipcMain.handle(
    'agent:save-provider-config',
    async (_e, provider: string, cfg: { model?: string; baseUrl?: string }) => {
      const stores = await ensureStores()
      if (!stores) return { ok: false, error: sdkError ?? 'sdk-load-failed' }
      const prev = providerConfigs()[provider]
      const patch: Partial<AgentProviderConfig> = { model: cfg.model || undefined }
      // baseUrl only travels for providers whose dialog exposes the field —
      // undefined here means "left alone", not "cleared"
      const touchesUrl = typeof cfg.baseUrl === 'string'
      if (touchesUrl) {
        const baseUrl = cfg.baseUrl!.trim() || undefined
        patch.baseUrl = baseUrl
        if (prev?.baseUrl !== baseUrl) patch.verified = false
      }
      patchProviderConfig(provider, patch)
      try {
        if (provider === OPENAI_COMPATIBLE_PROVIDER) await syncOpenAICompatible(stores)
        else if (touchesUrl) applyBaseUrlOverride(stores.modelRegistry, provider, patch.baseUrl)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      broadcast('agent:status', await getStatus())
      return { ok: true }
    },
  )

  /** 启用: point the agent at this provider's configured (or first catalog) model.
   *  Gated on a passing connectivity test (verified flag). */
  ipcMain.handle('agent:enable-provider', async (_e, provider: string) => {
    const stores = await ensureStores()
    if (!stores) return { ok: false, error: sdkError ?? 'sdk-load-failed' }
    const cfg = providerConfigs()[provider]
    if (cfg?.verified !== true) return { ok: false, error: 'not-verified' }
    const modelId =
      cfg?.model || stores.modelRegistry.getAll().find((m) => m.provider === provider)?.id
    const m = modelId ? stores.modelRegistry.find(provider, modelId) : undefined
    if (!m) return { ok: false, error: 'unknown-model' }
    updateAppSettings({ agentModel: { provider, id: m.id } })
    if (session) await session.setModel(m)
    broadcast('agent:status', await getStatus())
    return { ok: true }
  })

  // ── OAuth login (subscription providers: Claude Pro/Max, ChatGPT Codex, Copilot) ──
  // The vsurf login flow is callback-driven; bridge those callbacks to the
  // settings dialog over 'agent:oauth' events + 'agent:oauth-respond' answers.

  let oauthAbort: AbortController | null = null
  const oauthWaiters = new Map<string, (value: string | undefined) => void>()
  let oauthSeq = 0

  ipcMain.handle('agent:oauth-login', async (event, provider: string) => {
    const stores = await ensureStores()
    if (!stores) return { ok: false, error: sdkError ?? 'sdk-load-failed' }
    if (!stores.authStorage.getOAuthProviders().some((p) => p.id === provider)) {
      return { ok: false, error: 'not-an-oauth-provider' }
    }
    if (oauthAbort) return { ok: false, error: 'oauth-busy' }
    const wc = event.sender
    const send = (payload: Record<string, unknown>) => {
      if (!wc.isDestroyed()) wc.send('agent:oauth', { provider, ...payload })
    }
    const ask = (payload: Record<string, unknown>): Promise<string | undefined> => {
      const reqId = `oauth-${++oauthSeq}`
      return new Promise((resolve) => {
        oauthWaiters.set(reqId, resolve)
        if (wc.isDestroyed()) {
          oauthWaiters.delete(reqId)
          resolve(undefined)
        } else {
          send({ type: 'ask', reqId, ...payload })
        }
      })
    }
    oauthAbort = new AbortController()
    try {
      await stores.authStorage.login(provider, {
        signal: oauthAbort.signal,
        onAuth: (info) => {
          void shell.openExternal(info.url)
          send({ type: 'auth', url: info.url, instructions: info.instructions })
        },
        onProgress: (message) => send({ type: 'progress', message }),
        onPrompt: (prompt) =>
          ask({
            kind: 'text',
            message: prompt.message,
            placeholder: prompt.placeholder,
            allowEmpty: prompt.allowEmpty === true,
          }).then((v) => v ?? ''),
        onManualCodeInput: () =>
          ask({ kind: 'text', message: '', manual: true }).then((v) => v ?? ''),
        onSelect: (prompt) => ask({ kind: 'select', message: prompt.message, options: prompt.options }),
      })
      // a fresh login still owes a connectivity proof before 启用 lights up
      patchProviderConfig(provider, { verified: false })
      broadcast('agent:status', await getStatus())
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      oauthAbort = null
    }
  })

  ipcMain.handle('agent:oauth-respond', (_e, reqId: string, value: string | null) => {
    const resolve = oauthWaiters.get(reqId)
    if (resolve) {
      oauthWaiters.delete(reqId)
      resolve(value ?? undefined)
    }
    return { ok: true }
  })

  ipcMain.handle('agent:oauth-cancel', () => {
    oauthAbort?.abort()
    for (const resolve of oauthWaiters.values()) resolve(undefined)
    oauthWaiters.clear()
    return { ok: true }
  })

  ipcMain.handle('agent:set-key', async (_e, provider: string, key: string) => {
    const stores = await ensureStores()
    if (!stores) return { ok: false, error: sdkError ?? 'sdk-load-failed' }
    if (!provider || !key.trim()) return { ok: false, error: 'empty-key' }
    stores.authStorage.set(provider, { type: 'api_key', key: key.trim() })
    // new credentials must re-prove connectivity before the provider can be enabled
    patchProviderConfig(provider, { verified: false })
    if (provider === OPENAI_COMPATIBLE_PROVIDER) await syncOpenAICompatible(stores)
    broadcast('agent:status', await getStatus())
    return { ok: true }
  })

  ipcMain.handle('agent:clear-key', async (_e, provider: string) => {
    const stores = await ensureStores()
    if (!stores) return { ok: false }
    stores.authStorage.remove(provider)
    patchProviderConfig(provider, { verified: false })
    if (provider === OPENAI_COMPATIBLE_PROVIDER) await syncOpenAICompatible(stores)
    broadcast('agent:status', await getStatus())
    return { ok: true }
  })

  ipcMain.handle('agent:test-key', async (_e, provider: string) => {
    const stores = await ensureStores()
    if (!stores) return { ok: false, error: sdkError ?? 'sdk-load-failed' }
    const apiKey = await stores.authStorage.getApiKey(provider)
    if (!apiKey) return { ok: false, error: 'no-key' }
    // Ping with the configured model, else the provider's first available model.
    const configured = providerConfigs()[provider]?.model
    const available = stores.modelRegistry.getAvailable().filter((m) => m.provider === provider)
    const model =
      (configured && available.find((m) => m.id === configured)) ||
      available[0] ||
      stores.modelRegistry.getAll().find((m) => m.provider === provider)
    if (!model) return { ok: false, error: 'no-model-for-provider' }
    try {
      const ai = await import('vsurf-ai')
      await ai.completeSimple(
        model,
        { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] },
        { apiKey, maxTokens: 8 },
      )
      patchProviderConfig(provider, { verified: true })
      return { ok: true }
    } catch (err) {
      patchProviderConfig(provider, { verified: false })
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
    }
  })
}
