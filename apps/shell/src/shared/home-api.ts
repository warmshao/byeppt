/** UI language; kept self-contained here (mirrors Lang in @byeppt/i18n) */
export type UiLanguage =
  | 'zh'
  | 'en'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'th'
  | 'id'
  | 'ru'
  | 'ar'
  | 'pt'
  | 'it'
  | 'pl'
  | 'nl'
  | 'ms'
  | 'he'
  | 'hi'
  | 'zh-TW'

/** UI theme preference */
export type UiTheme = 'light' | 'dark' | 'system'

/** a recent file entry shown on the home screen; type derives from the extension */
export interface RecentEntry {
  path: string
  name: string
  /** lowercased extension without the dot ('pptx') */
  ext: string
  /** last-modified time, ms since epoch */
  mtimeMs: number
  /** file size in bytes */
  sizeBytes: number
  /** whether the user starred this file */
  starred: boolean
}

/** paged query for the home file lists */
export interface RecentQuery {
  /** number of entries to skip (default 0) */
  offset?: number
  /** page size; 0 returns no entries but still reports totals (default 50) */
  limit?: number
  /** restrict to one extension ('pptx'); omit for all */
  ext?: string
}

export interface RecentPage {
  entries: RecentEntry[]
  /** total matching the query's ext filter */
  total: number
  /** total ignoring the ext filter (for the sidebar counters) */
  totalAll: number
}

export interface HomeApi {
  /** unified recents, newest first (paged) */
  recents(query?: RecentQuery): Promise<RecentPage>
  /** starred files (independent of the recent list), newest first (paged) */
  starred(query?: RecentQuery): Promise<RecentPage>
  /** stat a specific set of paths (project view); missing files are skipped */
  statPaths(paths: string[]): Promise<RecentEntry[]>
  /** star / unstar a file */
  toggleStar(path: string): Promise<void>
  /** open an existing file, routing by extension */
  openPath(path: string): Promise<void>
  /** open an http(s) URL in the system browser (About links, GitHub) */
  openExternal(url: string): Promise<void>
  /** file picker accepting every supported extension, then routes */
  browse(): Promise<void>
  /** open a slides tab at its start screen (open-a-pptx) */
  newSlide(opts?: { projectId?: string }): Promise<void>
  /** drop entries from the recent list (does not touch the files) */
  removeRecent(paths: string[]): Promise<void>
  /** reveal the file in Finder / Explorer */
  revealPath(path: string): Promise<void>
  /** rename the file on disk (same directory) and update the recent list */
  renameFile(path: string, newName: string): Promise<RenameResult>
  /** copy the file next to itself (localized "copy" suffix before .ext) and record it as recent */
  duplicateFile(path: string): Promise<void>
  /** move files to the trash and drop them from the recent list */
  deleteFiles(paths: string[]): Promise<void>
  /** open the OS trash, where deleted files can be restored */
  openTrash(): Promise<void>
  /** current UI language (persisted in userData/app-settings.json) */
  getLanguage(): Promise<UiLanguage>
  /** switch + persist the UI language; main rebuilds its menus to match */
  setLanguage(lang: UiLanguage): Promise<void>
  /** app version (from package.json / electron app.getVersion) */
  getAppVersion(): Promise<string>
  /** current UI theme preference (persisted in userData/app-settings.json) */
  getTheme(): Promise<UiTheme>
  /** switch + persist the UI theme; broadcasts 'app:theme-changed' to all web contents */
  setTheme(theme: UiTheme): Promise<void>
  /** effective default save folder for new/untitled files (configured in userData/app-settings.json, falls back to <Documents>/byeppt) */
  getDefaultSaveDir(): Promise<string>
  /** directory picker to change the default save folder; resolves to the new folder, or null when canceled or the pick was unusable */
  pickDefaultSaveDir(): Promise<string | null>
  /** theme switched anywhere (broadcast from the main process) */
  onThemeChanged(handler: (theme: UiTheme) => void): () => void
  /** a slides tab asked to open the agent model settings (AI panel link) */
  onOpenAgentSettings(handler: () => void): () => void
  /** proxy preference (persisted in userData/app-settings.json) + the auto-detected value for the UI hint */
  getProxy(): Promise<ProxyState>
  /** persist the proxy preference and re-apply it process-wide */
  setProxy(pref: ProxyPreference): Promise<void>
  /** connectivity probe through a candidate proxy URL (null/'' = direct) */
  testProxy(url: string): Promise<{ ok: boolean; error?: string }>
  /** manual update check; status changes are also pushed via onUpdateEvent */
  checkForUpdate(): Promise<UpdateStatus>
  /** start downloading the update found by checkForUpdate (win/linux only) */
  downloadUpdate(): Promise<UpdateStatus>
  /** restart into the downloaded installer (win/linux only) */
  quitAndInstall(): Promise<void>
  /** updater status pushes from the main process (download progress etc.) */
  onUpdateEvent(handler: (status: UpdateStatus) => void): () => void
}

/** manual "检查更新" flow state (Settings → 通用). */
export interface UpdateStatus {
  /** 'idle' before any check; 'dev' for unpackaged dev builds */
  state:
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'dev'
  platform: 'darwin' | 'win32' | 'linux'
  /** false on macOS (unsigned build → manual install via the release page) and in dev */
  canAutoUpdate: boolean
  /** app.getVersion() */
  current: string
  /** latest version when state is up-to-date/available/downloading/downloaded */
  version?: string
  /** 0-100 while downloading */
  percent?: number
  /** GitHub release page URL (macOS 前往下载; manual fallback on error) */
  releaseUrl?: string
  /** error detail when state === 'error' */
  message?: string
}

/** User's proxy preference: enabled=false → direct; url empty → auto (env/system). */
export interface ProxyPreference {
  enabled: boolean
  url: string
}

export interface ProxyState extends ProxyPreference {
  /** the proxy auto-detection would use when url is empty (null = none found) */
  detected: string | null
}

export interface RenameResult {
  ok: boolean
  /** the new absolute path when ok */
  path?: string
  error?: string
}

// ── Project-related APIs ────────────────────────────────

export interface ProjectSummaryEntry {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  fileCount: number
  lastActiveAt: string
  isDefault: boolean
}

export interface TimelineEntryItem {
  filePath: string
  fileName: string
  chatId: string
  ts: string
  role: 'user' | 'assistant'
  preview: string
  seq: number
}

export interface ProjectHomeApi {
  /** list all projects (with file count + last-active time) */
  listProjects(): Promise<ProjectSummaryEntry[]>
  /** list existing files currently belonging to a project */
  listFiles(projectId: string): Promise<string[]>
  /** create a project */
  createProject(name: string): Promise<ProjectSummaryEntry>
  /** rename a project */
  renameProject(id: string, name: string): Promise<void>
  /** soft-delete a project */
  deleteProject(id: string): Promise<void>
  /** move a file into the given project */
  moveFile(filePath: string, projectId: string): Promise<void>
  /** fetch the project timeline */
  getTimeline(projectId: string, limit?: number): Promise<TimelineEntryItem[]>
}

export const HOME_CHANNELS = {
  recents: 'home:recents',
  starred: 'home:starred',
  statPaths: 'home:stat-paths',
  toggleStar: 'home:toggle-star',
  openPath: 'home:open-path',
  openExternal: 'home:open-external',
  browse: 'home:browse',
  newSlide: 'home:new-slide',
  removeRecent: 'home:remove-recent',
  revealPath: 'home:reveal-path',
  renameFile: 'home:rename-file',
  duplicateFile: 'home:duplicate-file',
  deleteFiles: 'home:delete-files',
  openTrash: 'home:open-trash',
  getLanguage: 'home:get-language',
  setLanguage: 'home:set-language',
  getAppVersion: 'home:get-app-version',
  getTheme: 'home:get-theme',
  setTheme: 'home:set-theme',
  getProxy: 'home:get-proxy',
  setProxy: 'home:set-proxy',
  testProxy: 'home:test-proxy',
  getDefaultSaveDir: 'home:get-default-save-dir',
  pickDefaultSaveDir: 'home:pick-default-save-dir',
  checkUpdate: 'home:check-update',
  downloadUpdate: 'home:download-update',
  quitAndInstall: 'home:quit-and-install',
  updateEvent: 'home:update-event',
} as const

export const PROJECT_CHANNELS = {
  list: 'project:list',
  files: 'project:files',
  create: 'project:create',
  rename: 'project:rename',
  delete: 'project:delete',
  moveFile: 'project:moveFile',
  timeline: 'project:timeline',
} as const

// ── Agent / image-generation settings (bridged to the slides main process) ──

export interface AgentProviderRow {
  id: string
  name: string
  hasKey: boolean
  /** where the current credential came from: stored | environment | ... */
  source?: string
  /** how the provider authenticates: subscription OAuth (browser login), AWS
   *  credentials (bedrock), or a plain API key */
  auth: 'oauth' | 'aws' | 'api_key'
  /** model picked for this provider in Settings ('' = registry default) */
  model: string
  /** effective base URL (user override or catalog default) */
  baseUrl: string
  /** the user's own base URL override ('' = catalog default) — the edit field's initial value */
  baseUrlOverride: string
  /** last connectivity test passed — gates the 启用 button */
  verified: boolean
  /** the agent currently runs on a model from this provider */
  active: boolean
}

export interface AgentModelRow {
  provider: string
  id: string
  name: string
}

/** events pushed by the main process during an OAuth login flow */
export type AgentOAuthEvent = {
  provider: string
} & (
  | { type: 'auth'; url: string; instructions?: string }
  | { type: 'progress'; message: string }
  | {
      type: 'ask'
      reqId: string
      kind: 'text' | 'select'
      message: string
      placeholder?: string
      allowEmpty?: boolean
      manual?: boolean
      options?: Array<{ id: string; label: string }>
    }
)

export interface ImageGenProviderRow {
  id: string
  label: string
  defaultModel: string
  /** preset model choices for the edit form */
  models: string[]
  defaultBaseUrl: string
  /** configured base URL override ('' = official endpoint) */
  baseUrl: string
  /** effective model (configured or default) */
  model: string
  hasKey: boolean
  /** last connectivity test passed — gates the 启用 button */
  verified: boolean
  /** last connectivity test failed — shows the broken-link state on 测试 */
  testFailed: boolean
  /** the backend currently mirrored into the kernel .env */
  active: boolean
}

/** AI settings bridge: LLM provider keys (vsurf AuthStorage) + image-gen prefs. */
export interface AgentSettingsApi {
  listProviders(): Promise<AgentProviderRow[]>
  /** Every catalog model a provider offers (from the agent SDK's model registry;
   *  no credentials required) — powers the edit dialog's model picker */
  listProviderModels(provider: string): Promise<Array<{ id: string; name: string }>>
  /** Persist the edit dialog's model pick + base URL override */
  saveProviderConfig(
    provider: string,
    cfg: { model?: string; baseUrl?: string },
  ): Promise<{ ok: boolean; error?: string }>
  /** 启用: switch the agent to this provider's configured model (verified only) */
  enableProvider(provider: string): Promise<{ ok: boolean; error?: string }>
  setProviderKey(provider: string, key: string): Promise<{ ok: boolean; error?: string }>
  clearProviderKey(provider: string): Promise<{ ok: boolean }>
  /** Minimal live ping against the provider with the stored key */
  testProviderKey(provider: string): Promise<{ ok: boolean; error?: string }>
  /** Start the subscription OAuth login (Claude Pro/Max, ChatGPT Codex, Copilot).
   *  Progress arrives via onOAuthEvent; text/select prompts must be answered
   *  with respondOAuth(reqId, …). */
  loginOAuth(provider: string): Promise<{ ok: boolean; error?: string }>
  respondOAuth(reqId: string, value: string | null): Promise<{ ok: boolean }>
  cancelOAuth(): Promise<{ ok: boolean }>
  onOAuthEvent(handler: (event: AgentOAuthEvent) => void): () => void
  getModel(): Promise<AgentModelRow | null>
  /** Models with configured credentials (selectable as the agent's model) */
  listModels(): Promise<AgentModelRow[]>
  setModel(sel: { provider: string; id: string }): Promise<{ ok: boolean; error?: string }>
  imageGenStatus(): Promise<{ providers: ImageGenProviderRow[] }>
  /** 启用: mark one backend as the agent's image tool provider */
  setImageGenActive(provider: string): Promise<{ ok: boolean; error?: string }>
  /** Per-backend base URL / model overrides (empty string clears) */
  setImageGenConfig(
    provider: string,
    cfg: { baseUrl?: string; model?: string },
  ): Promise<{ ok: boolean; error?: string }>
  /** Image-gen keys are stored separately from the LLM provider keys */
  setImageGenKey(
    provider: string,
    key: string,
  ): Promise<{ ok: boolean; error?: string }>
  clearImageGenKey(provider: string): Promise<{ ok: boolean; error?: string }>
  /** Real minimal generation through image_gen.py with the backend's current config */
  testImageGen(provider: string): Promise<{ ok: boolean; error?: string }>
}
