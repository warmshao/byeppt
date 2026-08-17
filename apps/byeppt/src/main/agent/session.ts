/**
 * byeppt agent host — embeds the vsurf RLM agent (`@warmshao/vsurf` SDK) in the
 * Electron main process.
 *
 * Sessions are per-tab: each chat panel (shell tab / standalone window) binds
 * its deck via 'agent:bind' and gets a lazily created AgentSession keyed by
 * chatId (project-store's stable per-file id; unsaved decks use a temp id).
 * Each deck's session runs with cwd = its own workdir
 * (projects/<pid>/agent/<chatId>/): vsurf session files, kernel artifacts and
 * the imagegen .env all stay inside that folder, so history and materials are
 * naturally per-tab. Events are delivered only to the owning tab's
 * webContents, tagged with deckKey so the renderer can filter on the broadcast
 * fallback. Slide-editing tools bridge in as customTools targeting the owning
 * tab (Phase 2, deck-bridge); image generation as a customTool (Phase 4).
 *
 * History: the chat panel lists a deck's past sessions straight from the
 * workdir (SessionManager.list) and resumes one via SessionManager.open(file).
 *
 * Credentials: vsurf AuthStorage at <userData>/agent/auth.json (the only
 * secret store). The non-secret "last selected model" lives in app-settings.
 */
import { app, ipcMain, shell, webContents } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAppSettings, updateAppSettings } from '../app-settings'
import type { AgentProviderConfig } from '../app-settings'
import { syncImageGenEnvFile, syncImageGenEnvFileTo } from '../imagegen/env'
import { buildSlideCustomTools } from './slide-tools-main'
import { prepareKernelEnvironment } from './kernel-env'
import type { ProjectStore } from '@byeppt/project-store'

/** Short preamble appended to the vsurf system prompt: orients the agent inside byeppt. */
const BYEPPT_PREAMBLE = [
  'You are running inside byeppt, a desktop presentation app (a live PowerPoint editor).',
  'Routing: NEW decks are generated through the ppt-master SVG pipeline (byeppt-deck skill Route A): author svg_output/*.svg in the deck workdir, quality-gate and convert each page deterministically via the byeppt-pptx-py kernel skill, then import it with import_pptx_slides so the user watches pages appear live (append new pages, replace_at for revised ones).',
  'EDITS to the open deck use the native slide tools (get_deck_context, read_slide, execute_slide_script, add_*, set_element_*, insert_web_image, ask_clarification, view_slide) - results appear on canvas immediately and are undoable by the user. export_deck_pptx snapshots the authoritative canvas to a pptx file (returns the deck revision); get_deck_context reports the live revision - before SVG-level rework of an imported deck, compare it to project.json lastImportedDeckRevision and re-derive via pptx_to_svg if the canvas moved on.',
  'view_slide renders a page to a PNG you can see - use it to visually verify edits and generated pages (alignment, spacing, overflow, contrast), especially during whole-deck QC.',
  'For any deck task, follow the byeppt-deck skill (its routing, methodology, stage gates, and design references are authoritative).',
  "Never fabricate numbers as facts (the tools enforce dataSource); reply in the user's language.",
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
let authStorage: AuthStorage | null = null
let modelRegistry: ModelRegistry | null = null

/** A bound deck tab: chatId (stable per file) + its private agent workdir. */
interface DeckBinding {
  deckKey: string
  workdir: string
}
/** webContents.id → deck the tab is bound to (via 'agent:bind') */
const tabDeck = new Map<number, DeckBinding>()
/** deckKey → live AgentSession */
const live = new Map<string, AgentSession>()
const starting = new Map<string, Promise<AgentSession | null>>()
/** deckKey → session file to resume on next ensureSession (temp→saved rebind) */
const pendingResume = new Map<string, string>()
/** project-store accessor injected by registerAgentIpc (avoids a slides-main import cycle) */
let getStore: (() => ProjectStore) | null = null

/** First-run kernel env bootstrap runs once per app, not once per deck session. */
let kernelPrep: Promise<unknown> | null = null

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
  // NOT BrowserWindow.getAllWindows(): in shell mode the editor lives in a
  // WebContentsView, whose webContents owns no BrowserWindow — window-only
  // delivery silently drops every agent event before it reaches the chat panel
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send(channel, payload)
  }
}

/**
 * Send to the tab that owns this deck; falls back to broadcast when the tab is
 * gone (reload, mid-rebind) — the payload always carries deckKey so renderers
 * filter out events for other tabs either way.
 */
function sendToDeck(deckKey: string, channel: string, payload: unknown): void {
  for (const [wcId, deck] of tabDeck) {
    if (deck.deckKey !== deckKey) continue
    const wc = webContents.fromId(wcId)
    if (wc && !wc.isDestroyed()) {
      wc.send(channel, payload)
      return
    }
  }
  broadcast(channel, payload)
}

// ── Interactive UI bridge (ExtensionUIContext → chat panel) ─────────────────
// The vsurf browser skill (and any extension) asks the user for choices via
// ui.select/confirm/input. In the TUI these render as terminal dialogs; here
// they travel as byeppt:ui-request events to the owning tab's chat panel, which
// answers via the 'agent:ui-respond' IPC. Without this bridge a select() would
// pend forever and the run would look stuck with a spinner.

type ExtensionUIContext = import('@warmshao/vsurf').ExtensionUIContext

const uiWaiters = new Map<string, { deckKey: string; resolve: (value: unknown) => void }>()
let uiSeq = 0

function uiAsk(deckKey: string, payload: Record<string, unknown>): Promise<unknown> {
  const reqId = `ui-${++uiSeq}`
  console.log('[agent] ui-request issued:', reqId, payload.kind, payload.title)
  return new Promise((resolve) => {
    uiWaiters.set(reqId, { deckKey, resolve })
    sendToDeck(deckKey, 'agent:event', { type: 'byeppt:ui-request', deckKey, reqId, ...payload })
  })
}

function settleUiRequest(reqId: string, value: unknown): void {
  const waiter = uiWaiters.get(reqId)
  if (!waiter) return
  uiWaiters.delete(reqId)
  console.log('[agent] ui-request settled:', reqId, value === undefined ? '(declined)' : '(answered)')
  waiter.resolve(value)
  sendToDeck(waiter.deckKey, 'agent:event', { type: 'byeppt:ui-resolved', deckKey: waiter.deckKey, reqId })
}

/** Decline every pending UI request (abort / session teardown), optionally one deck only. */
function declineAllUiRequests(deckKey?: string): void {
  for (const [reqId, w] of [...uiWaiters]) {
    if (deckKey === undefined || w.deckKey === deckKey) settleUiRequest(reqId, undefined)
  }
}

function buildExtensionUiContext(deckKey: string): ExtensionUIContext {
  const noop = () => {}
  return {
    select: (title: string, options: string[]) =>
      uiAsk(deckKey, { kind: 'select', title, options }).then((v) =>
        typeof v === 'string' ? v : undefined,
      ),
    confirm: (title: string, message: string) =>
      uiAsk(deckKey, { kind: 'confirm', title, message }).then((v) => v === true),
    input: (title: string, placeholder?: string) =>
      uiAsk(deckKey, { kind: 'input', title, placeholder }).then((v) =>
        typeof v === 'string' && v.trim() ? v.trim() : undefined,
      ),
    notify: (message: string, type?: 'info' | 'warning' | 'error') =>
      sendToDeck(deckKey, 'agent:event', { type: 'byeppt:ui-notify', deckKey, message, level: type ?? 'info' }),
    // TUI-only surfaces — no-ops in the Electron host
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: async () => {
      throw new Error('custom overlay UI is not supported in the byeppt host')
    },
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => '',
    editor: async () => undefined,
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    theme: undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'theme is owned by byeppt' }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  } as unknown as ExtensionUIContext
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

/** The agent's model is ALWAYS an explicit user choice (启用 in Settings):
 *  the saved selection, if it still exists and has credentials. No silent
 *  fallback — an unconfigured agent must surface 'no-model', not quietly run
 *  on whatever provider happens to have a key. */
function pickModel(reg: ModelRegistry): ReturnType<ModelRegistry['getAvailable']>[number] | undefined {
  const saved = readAppSettings().agentModel
  if (saved) {
    const m = reg.find(saved.provider, saved.id)
    if (m && reg.hasConfiguredAuth(m)) return m
  }
  return undefined
}

/** deckKey → auto-naming already attempted for its live session */
const namingAttempted = new Set<string>()

/** text of a session message (string content or text blocks) */
function sessionMessageText(m: { content?: unknown } | undefined): string {
  const c = m?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return (c as Array<{ type?: string; text?: unknown }>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => String(b.text))
    .join('')
}

/**
 * Claude-Code-style session titling: after a session's first run, ask the model
 * for a one-line title and store it as the session name (a SessionManager
 * session_info entry — the history popover lists it via SessionManager.list).
 * Falls back to the truncated first user message. Never throws.
 */
async function maybeNameSession(deckKey: string, s: AgentSession): Promise<void> {
  if (namingAttempted.has(deckKey)) return
  namingAttempted.add(deckKey)
  try {
    if (s.sessionName) return
    const firstUser = (s.messages as Array<{ role?: string; content?: unknown }>).find(
      (m) => m?.role === 'user',
    )
    const raw = sessionMessageText(firstUser)
      // the composer appends an attachment-path trailer to the wire prompt
      .replace(/\n*The user attached these files for this turn[\s\S]*$/, '')
      .trim()
    if (!raw) return
    let title = ''
    const stores = await ensureStores()
    const model = s.model
    const apiKey = stores && model ? await stores.authStorage.getApiKey(model.provider) : undefined
    if (model && apiKey) {
      try {
        // ESM-only sibling of @warmshao/vsurf (same release); dynamic import
        // like loadSdk so the CJS main bundle can reach it
        const { completeSimple } = await import('vsurf-ai')
        const res = await completeSimple(
          model,
          {
            systemPrompt:
              "You title chat sessions. Reply with ONLY a very short title (max 8 words) capturing the user's request, in the user's language. No quotes, no trailing punctuation.",
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: raw.slice(0, 2000) }],
                timestamp: Date.now(),
              },
            ],
          },
          { apiKey, maxTokens: 100 },
        )
        if (res.stopReason !== 'error') {
          title = res.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join(' ')
        }
      } catch (err) {
        console.warn('[agent] session title generation failed:', err)
      }
    }
    title = title
      .split('\n')[0]!
      .trim()
      .replace(/^["'`*#\s]+|["'`*。\s]+$/g, '')
    if (!title) title = raw.split('\n')[0]!.trim()
    if (title.length > 40) title = `${title.slice(0, 40)}…`
    if (title) s.setSessionName(title)
  } catch (err) {
    console.warn('[agent] maybeNameSession failed:', err)
  }
}

/** Dispose a deck's live session (if any): decline its UI waiters, release the kernel. */
async function disposeDeck(deckKey: string): Promise<void> {
  declineAllUiRequests(deckKey)
  // a later session for this deck must get its own naming attempt
  namingAttempted.delete(deckKey)
  const cur = live.get(deckKey)
  if (!cur) return
  live.delete(deckKey)
  try {
    await cur.disposeAsync()
  } catch (err) {
    console.warn('[agent] dispose failed:', err)
  }
}

/** Push the deck-scoped status to its tab (streaming flag is per session). */
async function pushStatus(deckKey: string): Promise<void> {
  sendToDeck(deckKey, 'agent:status', { ...(await getStatus(deckKey)), deckKey })
}

/** The webContents currently hosting a deck's tab (for deck-bridge targeting). */
function wcIdForDeck(deckKey: string): number | undefined {
  for (const [wcId, d] of tabDeck) if (d.deckKey === deckKey) return wcId
  return undefined
}

async function ensureSession(deck: DeckBinding, resumeFile?: string): Promise<AgentSession | null> {
  if (!resumeFile) {
    const cur = live.get(deck.deckKey)
    if (cur) return cur
    // temp→saved rebind: continue the moved session instead of starting fresh
    const resume = pendingResume.get(deck.deckKey)
    if (resume) {
      pendingResume.delete(deck.deckKey)
      if (existsSync(resume)) resumeFile = resume
    }
  }
  const pending = starting.get(deck.deckKey)
  if (pending) return pending
  const p = (async () => {
    const s = await loadSdk()
    const stores = await ensureStores()
    if (!s || !stores) return null
    const model = pickModel(stores.modelRegistry)
    if (!model) {
      console.warn('[agent] no model with credentials configured yet')
      return null
    }
    const skillsDir = resolveSkillsDir()
    // The kernel's batch image path (image_gen.py) reads <cwd>/.env — the
    // kernel cwd is the deck workdir, so mirror the Settings backend there
    // (and keep the global agent/.env in sync for anything still reading it).
    mkdirSync(deck.workdir, { recursive: true })
    await syncImageGenEnvFile()
    await syncImageGenEnvFileTo(deck.workdir)
    // First-run kernel env: ensure uv + install byeppt-pptx-py (and its deps) into
    // the vsurf kernel venv. Runs once per app in the background and streams
    // progress to the renderer; never blocks session creation and never throws here.
    if (!kernelPrep) {
      kernelPrep = prepareKernelEnvironment((message) =>
        broadcast('agent:event', { type: 'byeppt:kernel-progress', message }),
      ).then((r) => {
        broadcast('agent:event', { type: 'byeppt:kernel-ready', ok: r.ok, error: r.error })
      })
    }
    const sessionDir = join(deck.workdir, 'sessions')
    const resourceLoader = new s.DefaultResourceLoader({
      cwd: deck.workdir,
      agentDir: agentDir(),
      ...(skillsDir
        ? {
            additionalSkillPaths: [
              join(skillsDir, 'byeppt-deck'),
              join(skillsDir, 'byeppt-pptx-py'),
            ],
          }
        : {}),
      // MCP-integration skills the user can never authenticate inside byeppt —
      // keep them out of the system prompt (the SDK's own CLI wires this to
      // its MCP manager; a custom resourceLoader must opt in explicitly).
      extraBuiltinSkillOverrides: () => ['-notion/SKILL.md', '-linear/SKILL.md'],
      // vsurf also scans the cross-agent shared dirs (~/.agents/skills and
      // ancestor .agents/skills) — on a dev machine those hold unrelated CLI
      // skills (arkcli-*, 24 of them here) that flood <available_skills> and
      // drown the byeppt/vsurf skills the model should actually pick from.
      skillsOverride: (base) => ({
        ...base,
        skills: base.skills.filter(
          (skill) => !/[\\/]\.agents[\\/]skills[\\/]/.test(skill.filePath),
        ),
      }),
      appendSystemPrompt: [BYEPPT_PREAMBLE],
    })
    // createAgentSession only reloads a resource loader it created itself — a
    // host-provided loader stays unloaded: getSkills() returns [], so no
    // <available_skills> in the system prompt, no kernel skill imports, and NO
    // browser host handlers (kernel browser.* calls fail with "not available
    // in this session" before the connection picker can ever fire).
    await resourceLoader.reload()
    const { session: created } = await s.createAgentSession({
      agentDir: agentDir(),
      cwd: deck.workdir,
      authStorage: stores.authStorage,
      modelRegistry: stores.modelRegistry,
      model,
      resourceLoader,
      // Per-deck session storage: fresh sessions and resumes alike live under
      // the deck workdir, never in the shared agent dir.
      sessionManager: resumeFile
        ? s.SessionManager.open(resumeFile, sessionDir, deck.workdir)
        : s.SessionManager.create(deck.workdir, sessionDir),
      // Slide-editing tools: each forwards over the deck bridge into the OWNING
      // tab's slides renderer (see slide-tools-main.ts / deck-bridge.ts)
      customTools: await buildSlideCustomTools(s, () => wcIdForDeck(deck.deckKey)),
    })
    const deckKey = deck.deckKey
    created.subscribe((event) => {
      try {
        sendToDeck(deckKey, 'agent:event', { ...event, deckKey })
        // Run started: isStreaming is already true here (the SDK flips it in
        // runWithLifecycle before emitting agent_start) — the prompt handler's
        // own push races the async run start and would report a stale false,
        // leaving the composer's send button in "send" mode for the whole run.
        if (event?.type === 'agent_start') {
          void pushStatus(deckKey)
        }
        // streaming flips back to false here — without this push the panel's
        // send button stays in "stop" mode after a successful run
        if (event?.type === 'agent_end') {
          void pushStatus(deckKey)
          // first run done → auto-title the session for the history list
          void maybeNameSession(deckKey, created)
        }
      } catch (err) {
        console.warn('[agent] failed to forward event', event?.type, err)
      }
    })
    live.set(deckKey, created)
    // Wire the interactive UI bridge (browser connection picker, extension
    // select/confirm/input dialogs) into the chat panel — without it a
    // ui.select() pends forever and the run looks stuck.
    await created.bindExtensions({ uiContext: buildExtensionUiContext(deckKey) })
    console.log('[agent] extension UI bridge bound for deck', deckKey)
    await pushStatus(deckKey)
    return created
  })()
  starting.set(deck.deckKey, p)
  try {
    return await p
  } finally {
    starting.delete(deck.deckKey)
  }
}

async function getStatus(deckKey?: string): Promise<AgentStatus> {
  const stores = await ensureStores()
  if (!stores) {
    return { sdkReady: false, ready: false, streaming: false, availableModels: [], error: sdkError ?? 'sdk-load-failed' }
  }
  const available = stores.modelRegistry.getAvailable().map(modelInfo)
  const own = deckKey ? live.get(deckKey) : undefined
  const current = own?.model ?? [...live.values()][0]?.model ?? pickModel(stores.modelRegistry)
  return {
    sdkReady: true,
    ready: !!current,
    streaming: own?.isStreaming ?? false,
    model: current ? modelInfo(current) : undefined,
    availableModels: available,
    ...(current ? {} : { error: 'no-model' }),
  }
}

/**
 * Cap / strip heavy payloads before session messages cross IPC for a history
 * replay: view_slide PNG data URLs are huge and render as '[image]' anyway.
 */
function sanitizeMessages(messages: unknown[]): unknown[] {
  const CAP = 12_000
  const clean = (content: unknown): unknown => {
    if (typeof content === 'string') {
      return content.length > CAP ? `${content.slice(0, CAP)}\n…` : content
    }
    if (!Array.isArray(content)) return content
    return content.map((b) => {
      if (!b || typeof b !== 'object') return b
      const block = { ...(b as Record<string, unknown>) }
      if (block.type === 'image') return { type: 'text', text: '[image]' }
      for (const k of ['text', 'thinking'] as const) {
        const v = block[k]
        if (typeof v === 'string' && v.length > CAP) block[k] = `${v.slice(0, CAP)}\n…`
      }
      return block
    })
  }
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m
    const msg = m as Record<string, unknown>
    return { ...msg, content: clean(msg.content) }
  })
}

export function registerAgentIpc(storeAccessor: () => ProjectStore): void {
  getStore = storeAccessor

  /**
   * Bind a chat panel's webContents to its deck. Resolves the stable chatId via
   * project-store (filePath → chatId mapping; unsaved decks keep their temp id)
   * and the deck's private agent workdir. When an unsaved deck first gets a
   * real path, the temp chat's data (chats / attachments / agent workdir) is
   * folded into the file's chat and the live session resumes from the moved
   * session file on next ensureSession.
   */
  ipcMain.handle('agent:bind', async (e, args: { filePath: string | null; tempChatId?: string }) => {
    try {
      const store = getStore?.()
      if (!store) return { ok: false, error: 'store-unavailable' }
      store.ensureDefaultProject()
      const { projectId, chatId } = args.filePath
        ? store.resolveChatForFile(args.filePath)
        : { projectId: 'default', chatId: args.tempChatId ?? `unsaved-${Date.now()}` }
      const wcId = e.sender.id
      const prev = tabDeck.get(wcId)
      if (args.filePath && prev && prev.deckKey !== chatId && prev.deckKey.startsWith('unsaved-')) {
        const oldFile = live.get(prev.deckKey)?.sessionManager.getSessionFile()
        await disposeDeck(prev.deckKey)
        store.rebindChatToFile('default', prev.deckKey, args.filePath)
        if (oldFile) {
          const moved = join(
            store.agentWorkDir(projectId, chatId),
            'sessions',
            oldFile.split(/[\\/]/).pop()!,
          )
          if (existsSync(moved)) pendingResume.set(chatId, moved)
        }
      }
      tabDeck.set(wcId, { deckKey: chatId, workdir: store.agentWorkDir(projectId, chatId) })
      if (!prev) {
        // Session survives a reload (the next bind re-attaches); just drop the routing entry
        e.sender.once('destroyed', () => tabDeck.delete(wcId))
      }
      return { ok: true, deckKey: chatId }
    } catch (err) {
      console.error('[agent] bind failed:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('agent:status', (e) => getStatus(tabDeck.get(e.sender.id)?.deckKey))

  ipcMain.handle('agent:prompt', async (e, text: string) => {
    const deck = tabDeck.get(e.sender.id)
    if (!deck) return { ok: false, error: 'unbound' }
    const s = await ensureSession(deck)
    if (!s) return { ok: false, error: sdkError ?? 'no-model' }
    // The kernel may spawn lazily on this prompt — keep the batch image
    // path's .env in sync with Settings (cheap no-op when unchanged).
    await syncImageGenEnvFileTo(deck.workdir)
    const wasIdle = !s.isStreaming
    const deckKey = deck.deckKey
    // Fire and settle in the background; the event stream carries progress.
    void s
      .prompt(String(text))
      .catch(async (err) => {
        sendToDeck(deckKey, 'agent:event', {
          type: 'byeppt:error',
          deckKey,
          message: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(async () => {
        // isStreaming only flips in finishRun(), AFTER agent_end listeners
        // settle — the agent_end status push is still stale-true; the prompt
        // promise settling is the only reliable "run really over" signal.
        await pushStatus(deckKey)
      })
    if (wasIdle) await pushStatus(deckKey)
    return { ok: true }
  })

  ipcMain.handle('agent:abort', async (e) => {
    const deck = tabDeck.get(e.sender.id)
    const s = deck ? live.get(deck.deckKey) : undefined
    if (!deck || !s) return { ok: true }
    declineAllUiRequests(deck.deckKey)
    await s.abort()
    await pushStatus(deck.deckKey)
    return { ok: true }
  })

  /** Chat panel answering a byeppt:ui-request card (select/confirm/input). */
  ipcMain.handle('agent:ui-respond', (_e, reqId: string, value: unknown) => {
    settleUiRequest(String(reqId), value ?? undefined)
    return { ok: true }
  })

  ipcMain.handle('agent:set-model', async (_e, sel: { provider: string; id: string }) => {
    const stores = await ensureStores()
    if (!stores) return { ok: false, error: sdkError ?? 'sdk-load-failed' }
    const m = stores.modelRegistry.find(sel.provider, sel.id)
    if (!m) return { ok: false, error: 'unknown-model' }
    updateAppSettings({ agentModel: { provider: sel.provider, id: sel.id } })
    for (const sess of live.values()) await sess.setModel(m)
    broadcast('agent:status', await getStatus())
    return { ok: true }
  })

  ipcMain.handle('agent:new-session', async (e) => {
    const deck = tabDeck.get(e.sender.id)
    if (!deck) return { ok: false, error: 'unbound' }
    try {
      await disposeDeck(deck.deckKey)
      // Eager create: surfaces 'no-model' through the status push immediately
      await ensureSession(deck)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    await pushStatus(deck.deckKey)
    return { ok: true }
  })

  /** History list for one tab: every past session in this deck's workdir. */
  ipcMain.handle('agent:list-sessions', async (e) => {
    const deck = tabDeck.get(e.sender.id)
    const s = await loadSdk()
    if (!deck || !s) return []
    try {
      const infos = await s.SessionManager.list(deck.workdir, join(deck.workdir, 'sessions'))
      const currentFile = live.get(deck.deckKey)?.sessionManager.getSessionFile()
      return infos
        .filter((i) => i.messageCount > 0)
        .sort((a, b) => +new Date(b.modified) - +new Date(a.modified))
        .map((i) => ({
          sessionFile: i.path,
          title: i.name ?? '',
          createdAt: new Date(i.created).toISOString(),
          modifiedAt: new Date(i.modified).toISOString(),
          messageCount: i.messageCount,
          current: i.path === currentFile,
        }))
    } catch (err) {
      console.warn('[agent] list-sessions failed:', err)
      return []
    }
  })

  /** Resume a past session: dispose the live one, reopen from its JSONL, replay messages. */
  ipcMain.handle('agent:resume-session', async (e, sessionFile: string) => {
    const deck = tabDeck.get(e.sender.id)
    if (!deck) return { ok: false, error: 'unbound' }
    const file = String(sessionFile ?? '')
    // only files inside this deck's own sessions dir are resumable
    if (!file.startsWith(join(deck.workdir, 'sessions')) || !existsSync(file)) {
      return { ok: false, error: 'session-not-found' }
    }
    await disposeDeck(deck.deckKey)
    let s: AgentSession | null
    try {
      s = await ensureSession(deck, file)
    } catch (err) {
      // a corrupt/partial JSONL must not kill the tab's chat — fall back to fresh
      console.warn('[agent] resume failed, starting fresh:', err)
      try {
        s = await ensureSession(deck)
      } catch {
        s = null
      }
      if (!s) return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (!s) return { ok: false, error: sdkError ?? 'no-model' }
    await pushStatus(deck.deckKey)
    return { ok: true, messages: sanitizeMessages(s.messages as unknown[]) }
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
    const current = [...live.values()][0]?.model ?? pickModel(reg)
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
      // a different model was never connectivity-tested
      if (prev?.model !== patch.model) patch.verified = false
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
    for (const sess of live.values()) await sess.setModel(m)
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
      // pull provider/model request headers too — OAuth subscription tokens
      // (sk-ant-oat…, codex account headers) don't authenticate with a bare key
      const resolved = await stores.modelRegistry.getApiKeyAndHeaders(model)
      // completeSimple does NOT throw on API errors — they come back as an
      // assistant message with stopReason 'error' (401, model-missing, …)
      const res = await ai.completeSimple(
        model,
        { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] },
        {
          apiKey,
          // generous enough for reasoning models (a tiny cap can be rejected
          // outright when the thinking budget exceeds it)
          maxTokens: 512,
          ...(resolved.ok && resolved.headers ? { headers: resolved.headers } : {}),
        },
      )
      if (res.stopReason === 'error') {
        patchProviderConfig(provider, { verified: false })
        return { ok: false, error: (res.errorMessage ?? 'unknown error').slice(0, 300) }
      }
      patchProviderConfig(provider, { verified: true })
      return { ok: true }
    } catch (err) {
      console.warn('[agent] connectivity test failed for', provider, err)
      patchProviderConfig(provider, { verified: false })
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
    }
  })
}
