import { execSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  session,
  shell,
  webContents,
} from 'electron'
import type { MenuItemConstructorOptions, NativeImage } from 'electron'
import menuPptxIcon1x from './assets/menu-pptx.png?asset'
import menuPptxIcon2x from './assets/menu-pptx@2x.png?asset'
import menuHomeIcon1x from './assets/menu-home.png?asset'
import menuHomeIcon2x from './assets/menu-home@2x.png?asset'
import { isLang, normalizeLang, setUiLang, type Lang } from '@byeppt/i18n'
import {
  DEFAULT_SAVE_DIR_KEY,
  appMenuLabels,
  configuredDefaultSaveDir,
  contextMenuLabels,
  editMenuTemplate,
  installContextMenu,
  installNavigationGuard,
  isUsableSaveDir,
  showOpenDialogWithMemory,
  windowMenuTemplate,
} from '@byeppt/electron-utils'
import { ProjectStore } from '@byeppt/project-store'
import { readAppSettings, writeAppSetting } from './app-settings'
import {
  configureSlidesRuntime,
  installSlidesMenu,
  registerProjectIpc as registerSlidesProjectChatIpc,
  registerSlidesIpc,
  replaceSlidesRecentFile,
  requestSlidesClose,
  setSlidesCloseTabHook,
  setSlidesExtraFileMenuItems,
  setSlidesOpenedHook,
  setSlidesShellWindow,
  setSlidesShowBleed,
  slidesFileRenamed,
} from '../../../byeppt/src/main/slides-main'
import { registerAgentIpc } from '../../../byeppt/src/main/agent/session'
import type { RecentEntry, RecentPage, RenameResult, UiTheme } from '../shared/home-api'
import { HOME_CHANNELS, PROJECT_CHANNELS } from '../shared/home-api'
import type { TabKind } from '../shared/tabs-api'
import { TABS_CHANNELS } from '../shared/tabs-api'
import { showErrorDialog } from './error-dialog'
import { tMain } from './menu-strings'
import {
  normalizeRecentQuery,
  pageRecentPaths,
  readRecentFiles,
  readStarredFiles,
  recordRecentFile,
  removeRecentFiles,
  replaceRecentFile,
  statExistingPaths,
  toggleStarredFile,
} from './recent-files'
import { TabManager } from './tab-manager'

/**
 * byeppt shell: ONE Electron app, ONE BrowserWindow, hosting the slides
 * module as WebContentsView tabs behind a WPS-style tab strip, plus a
 * home/launcher tab rendered by the shell window itself. The shell owns the
 * lifecycle — single-instance lock, file-association routing (.pptx), and
 * per-active-tab menu switching. The renderer loads from the slides module's
 * build output (apps/byeppt/out), so build it before running the shell
 * packaged/standalone; in dev, SLIDES_RENDERER_URL points at its dev server.
 */

// ANY unpacked run (`npm run dev`, `npx electron .`) must not share the
// installed app's userData or single-instance lock — otherwise a dev run
// silently quits and forwards its argv to the running installed byeppt.
// BYEPPT_USER_DATA: test drivers point this at a scratch dir so an automated
// instance can run alongside the dev instance (separate lock).
if (!app.isPackaged)
  app.setPath('userData', process.env.BYEPPT_USER_DATA ?? join(app.getPath('appData'), 'byeppt Dev'))

// module build outputs: packaged builds carry them as extraResources
// (resources/modules/*); dev/unpacked resolves them relative to apps/shell
// in the monorepo layout.
const APPS_ROOT = join(app.getAppPath(), '..')
const SLIDES_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'byeppt')
  : join(APPS_ROOT, 'byeppt', 'out')

configureSlidesRuntime({
  preloadPath: join(SLIDES_OUT, 'preload', 'index.js'),
  rendererDevUrl: process.env.SLIDES_RENDERER_URL,
  rendererFilePath: join(SLIDES_OUT, 'renderer', 'index.html'),
})

// ---- UI language ----
// Persisted in userData/app-settings.json so the editor module reads the same
// file. BYEPPT_LANG overrides for tests.

const APP_SETTINGS_PATH = () => join(app.getPath('userData'), 'app-settings.json')

let uiLang: Lang | null = null

function currentLang(): Lang {
  if (uiLang) return uiLang
  if (process.env.BYEPPT_LANG) {
    uiLang = normalizeLang(process.env.BYEPPT_LANG)
    setUiLang(uiLang)
    return uiLang
  }
  const saved = readAppSettings(APP_SETTINGS_PATH()).language
  if (isLang(saved)) uiLang = saved
  uiLang ??= normalizeLang(app.getLocale())
  setUiLang(uiLang)
  return uiLang
}

function persistLang(lang: Lang): void {
  uiLang = lang
  setUiLang(lang)
  writeAppSetting(APP_SETTINGS_PATH(), 'language', lang)
}

let cachedTheme: UiTheme | null = null

function currentTheme(): UiTheme {
  if (cachedTheme) return cachedTheme
  const saved = readAppSettings(APP_SETTINGS_PATH()).theme
  cachedTheme = saved === 'light' || saved === 'dark' ? saved : 'system'
  return cachedTheme
}

const tm = (key: Parameters<typeof tMain>[1], params?: Parameters<typeof tMain>[2]) =>
  tMain(currentLang(), key, params)

// ---- the shell window + its tab manager (recreated if the user closes it on macOS) ----

let shellWindow: BrowserWindow | null = null
let tabManager: TabManager | null = null

/**
 * When the user creates a file from a specific project view, remember which
 * project the next save should belong to. key: 'slide', value: projectId.
 * Consumed by the slides opened hook once the file first hits disk.
 */
const pendingNewFileProject = new Map<string, string>()

/**
 * After a file first hits disk, if a pending project was set earlier via
 * "create from project view", move the new file into that project automatically.
 */
function applyPendingProject(filePath: string): void {
  if (extname(filePath).slice(1).toLowerCase() !== 'pptx') return
  const projectId = pendingNewFileProject.get('slide')
  if (!projectId) return
  pendingNewFileProject.delete('slide')
  try {
    const store = new ProjectStore(app.getPath('userData'))
    store.ensureDefaultProject()
    store.resolveProjectForFile(filePath) // assign to default first (idempotent)
    store.moveFileToProject(filePath, projectId)
  } catch (err) {
    console.warn('[shell] applyPendingProject failed:', err)
  }
}

function applyMenuFor(kind: TabKind): void {
  if (kind === 'slides') installSlidesMenu()
  else buildHomeMenu()
}

function createShellWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    title: 'ByePPT',
    // dev-mode window/taskbar icon (packaged builds get it from the exe /
    // electron-builder's build/icon.*); BrowserWindow icons are ignored on
    // macOS, where the unpackaged Electron runtime needs app.dock.setIcon.
    // Windows gets the .ico so the title bar picks the size-optimised 16/24/32
    // entries instead of downsampling the 1024px PNG (jagged diagonals).
    ...(process.platform === 'darwin' || app.isPackaged
      ? {}
      : {
          icon: join(
            __dirname,
            process.platform === 'win32' ? '../../build/icon.ico' : '../../build/icon.png',
          ),
        }),
    // vibrancy: the slides editor punches translucent regions (e.g. the
    // thumbnail pane) through to the desktop
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, vibrancy: 'sidebar' as const }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  shellWindow = win
  // dragging the window by the tab strip's blank (draggable) area produces no
  // DOM event anywhere — will-move is the only signal to dismiss popovers
  win.on('will-move', broadcastChromePressed)

  const manager = new TabManager(
    win,
    () => win.webContents.send(TABS_CHANNELS.changed, manager.list()),
    applyMenuFor,
    // no extension: the tab has no file on disk yet; the title becomes the
    // real filename (the localized untitled default + .pptx) once the first save lands
    () => tm('untitledDeck'),
  )
  tabManager = manager

  setSlidesShellWindow(win)
  setSlidesShowBleed((wc, on) => manager.setContentBleed(wc, on))
  setSlidesCloseTabHook(() => manager.closeActiveTab())
  // When ⌘O opens a file inside a tab, sync the tab title/path (used for de-dup by path) and record it as recent.
  // The first save / save-as fires this too, so applyPendingProject also runs here.
  setSlidesOpenedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    recordRecentFile(path)
    applyPendingProject(path)
  })

  // Closing the whole window walks every dirty slides tab through the same
  // save/don't-save/cancel prompt; any cancel aborts the close.
  let closeConfirmed = false
  win.on('close', (event) => {
    if (closeConfirmed) return
    const dirtySlides = manager.dirtySlidesTabs()
    if (dirtySlides.length === 0) return
    event.preventDefault()
    void (async () => {
      for (const tab of dirtySlides) {
        manager.activateTab(tab.id)
        if (!(await requestSlidesClose(tab.webContents, win))) return
      }
      closeConfirmed = true
      if (!win.isDestroyed()) win.close()
    })()
  })

  win.on('closed', () => {
    if (shellWindow === win) shellWindow = null
    if (tabManager === manager) tabManager = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- routing: one dispatch function for every open path ----

const PPTX_RE = /\.pptx$/i

/** presentation formats we recognize but don't open — surfaced as a dialog, not silently dropped */
const UNSUPPORTED_DECK_RE = /\.(ppt|pps|odp|key)$/i

/**
 * Single source of truth for the open-dialog filter. Includes the
 * legacy .ppt binary so it is selectable and surfaces the explicit
 * "not supported" dialog via openDocumentPath instead of being grayed out.
 */
const OPEN_DIALOG_EXTENSIONS = ['pptx', 'ppt']

function supportedFileIn(argv: string[]): string | null {
  return argv.find((arg) => PPTX_RE.test(arg) && existsSync(arg)) ?? null
}

function unsupportedFileIn(argv: string[]): string | null {
  return argv.find((arg) => UNSUPPORTED_DECK_RE.test(arg) && existsSync(arg)) ?? null
}

function notifyUnsupportedFile(filePath: string): void {
  const ext = extname(filePath).slice(1).toLowerCase() || basename(filePath)
  const options = { type: 'warning' as const, message: tm('errUnsupportedExt', { ext }) }
  if (shellWindow) {
    shellWindow.show()
    shellWindow.focus()
    void dialog.showMessageBox(shellWindow, options)
  } else {
    void dialog.showMessageBox(options)
  }
}

/** the single router: extension decides; false = nothing opened */
function openDocumentPath(filePath: string): boolean {
  if (!existsSync(filePath) || !tabManager) return false
  if (PPTX_RE.test(filePath)) {
    recordRecentFile(filePath)
    const existing = tabManager.findSlidesTabByPath(filePath)
    if (existing) {
      tabManager.activateTab(existing)
    } else {
      // For a new tab the path goes through the pending queue; the renderer consumes it after mounting
      tabManager.openSlidesTab(filePath)
    }
    return true
  }
  notifyUnsupportedFile(filePath)
  return false
}

/**
 * A throw anywhere in the create-tab path (view creation, renderer load)
 * used to be swallowed by `void`-ed promises and ipc-invoke rejections, so
 * the click looked like a pure no-op. Surface the failure instead.
 */
function surfaceNewTabError(err: unknown): void {
  console.error('[shell] new tab failed:', err)
  showErrorDialog(shellWindow, tm('errNewTabFailed'), err)
}

function newSlideTab(): void {
  try {
    tabManager?.openSlidesTab()
  } catch (err) {
    surfaceNewTabError(err)
  }
}

// ---- home IPC ----

function statEntries(paths: string[]): RecentEntry[] {
  return statExistingPaths(paths, new Set(readStarredFiles()))
}

function stringPaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
}

/** shell-side project store (home project list); file-backed, shared with the slides module */
let shellProjectStore: ProjectStore | null = null

function getProjectStore(): ProjectStore {
  if (!shellProjectStore) shellProjectStore = new ProjectStore(app.getPath('userData'))
  return shellProjectStore
}

function registerHomeIpc(): void {
  ipcMain.handle(HOME_CHANNELS.getAppVersion, (): string => app.getVersion())

  ipcMain.handle(HOME_CHANNELS.recents, (_event, query: unknown): RecentPage =>
    pageRecentPaths(readRecentFiles(), query, new Set(readStarredFiles())),
  )

  // Starred files sort by mtime, which requires stat-ing them all first; they are hand-picked and few, so this is fine
  ipcMain.handle(HOME_CHANNELS.starred, (_event, query: unknown): RecentPage => {
    const { offset, limit, ext } = normalizeRecentQuery(query)
    const all = statEntries(readStarredFiles()).sort((a, b) => b.mtimeMs - a.mtimeMs)
    const filtered = ext ? all.filter((entry) => entry.ext === ext) : all
    return {
      entries: limit === 0 ? [] : filtered.slice(offset, offset + limit),
      total: filtered.length,
      totalAll: all.length,
    }
  })

  ipcMain.handle(HOME_CHANNELS.statPaths, (_event, paths: unknown): RecentEntry[] =>
    statEntries(stringPaths(paths)),
  )

  ipcMain.handle(HOME_CHANNELS.toggleStar, (_event, path: unknown) => {
    if (typeof path === 'string') toggleStarredFile(path)
  })

  ipcMain.handle(HOME_CHANNELS.openPath, (_event, path: unknown) => {
    if (typeof path === 'string') openDocumentPath(path)
  })

  // About-pane links: https only, always in the system browser
  ipcMain.handle(HOME_CHANNELS.openExternal, (_event, url: unknown) => {
    if (typeof url !== 'string') return
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:') void shell.openExternal(parsed.toString())
    } catch {
      /* not a URL — ignore */
    }
  })

  ipcMain.handle(HOME_CHANNELS.browse, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? shellWindow
    if (!win) return
    const result = await showOpenDialogWithMemory(dialog, win, {
      title: tm('dlgOpenTitle'),
      filters: [
        { name: tm('filterSupported'), extensions: OPEN_DIALOG_EXTENSIONS },
        { name: tm('filterPpt'), extensions: ['pptx', 'ppt'] },
      ],
      properties: ['openFile'],
    })
    if (!result.canceled && result.filePaths[0]) openDocumentPath(result.filePaths[0])
  })

  ipcMain.handle(HOME_CHANNELS.newSlide, (_event, opts?: { projectId?: string }) => {
    if (opts?.projectId && opts.projectId !== 'default') {
      pendingNewFileProject.set('slide', opts.projectId)
    }
    newSlideTab()
  })

  ipcMain.handle(HOME_CHANNELS.removeRecent, (_event, paths: unknown) => {
    removeRecentFiles(stringPaths(paths))
  })

  ipcMain.handle(HOME_CHANNELS.revealPath, (_event, path: unknown) => {
    if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path)
  })

  ipcMain.handle(
    HOME_CHANNELS.renameFile,
    (_event, path: unknown, newName: unknown): RenameResult => {
      if (typeof path !== 'string' || typeof newName !== 'string')
        return { ok: false, error: tm('errBadArgs') }
      const name = newName.trim()
      if (!name || /[\\/:]/.test(name)) return { ok: false, error: tm('errBadName') }
      if (!existsSync(path)) return { ok: false, error: tm('errMissing') }
      const target = join(dirname(path), name)
      if (target === path) return { ok: true, path }
      if (existsSync(target)) return { ok: false, error: tm('errExists') }
      try {
        renameSync(path, target)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : tm('errRenameFailed') }
      }
      replaceRecentFile(path, target)
      // project-store's fileMap/chatIdByPath re-key too, so AI chat history follows the file
      try {
        getProjectStore().fileRenamed(path, target)
      } catch (err) {
        console.warn('[project-store] fileRenamed failed:', err)
      }
      // the slides module's own recent list switches to the new path as well (used by the start screen)
      if (/\.pptx$/i.test(target)) void replaceSlidesRecentFile(path, target)
      // open tabs sync their title/path; the editor then syncs its internal save path and title bar
      const affected = tabManager?.renameTabFile(path, target) ?? []
      for (const t of affected) {
        if (t.kind === 'slides') slidesFileRenamed(t.webContents, path, target)
      }
      return { ok: true, path: target }
    },
  )

  ipcMain.handle(HOME_CHANNELS.duplicateFile, (_event, path: unknown) => {
    if (typeof path !== 'string' || !existsSync(path)) return
    const ext = extname(path)
    const base = basename(path, ext)
    const dir = dirname(path)
    for (let i = 1; ; i++) {
      const target = join(dir, `${base} ${tm('copySuffix')}${i === 1 ? '' : ` ${i}`}${ext}`)
      if (existsSync(target)) continue
      copyFileSync(path, target)
      recordRecentFile(target)
      return
    }
  })

  ipcMain.handle(HOME_CHANNELS.deleteFiles, async (_event, paths: unknown) => {
    const list = stringPaths(paths)
    for (const p of list) {
      try {
        await shell.trashItem(p)
      } catch {
        // file already gone or trash unavailable; still drop it from the list
      }
    }
    removeRecentFiles(list)
  })

  ipcMain.handle(HOME_CHANNELS.openTrash, () => {
    if (process.platform === 'darwin') {
      void shell.openPath(join(app.getPath('home'), '.Trash'))
    } else if (process.platform === 'win32') {
      spawn('explorer.exe', ['shell:RecycleBin'], { detached: true }).unref()
    } else {
      void shell.openPath(join(app.getPath('home'), '.local', 'share', 'Trash', 'files'))
    }
  })

  ipcMain.handle(HOME_CHANNELS.getLanguage, (): Lang => currentLang())

  ipcMain.handle(HOME_CHANNELS.setLanguage, (_event, lang: unknown) => {
    if (!isLang(lang) || lang === currentLang()) return
    persistLang(lang)
    // the switcher lives on the home page, so the home menu is the active one
    buildHomeMenu()
    installDockMenu()
    installBackToHomeItems()
    for (const wc of webContents.getAllWebContents()) wc.send('app:language-changed', lang)
  })

  ipcMain.handle(HOME_CHANNELS.getTheme, (): UiTheme => currentTheme())
  // editor tabs ask via the app-wide channel (symmetric with app:get-language)
  ipcMain.handle('app:get-theme', (): UiTheme => currentTheme())

  ipcMain.handle(HOME_CHANNELS.setTheme, (_event, theme: unknown) => {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return
    if (theme === currentTheme()) return
    cachedTheme = theme
    writeAppSetting(APP_SETTINGS_PATH(), 'theme', theme)
    nativeTheme.themeSource = theme
    for (const wc of webContents.getAllWebContents()) wc.send('app:theme-changed', theme)
  })

  // effective folder where new/untitled files land
  ipcMain.handle(HOME_CHANNELS.getDefaultSaveDir, (): string => defaultSaveDir())

  ipcMain.handle(HOME_CHANNELS.pickDefaultSaveDir, async (): Promise<string | null> => {
    const result = await showOpenDialogWithMemory(dialog, shellWindow, {
      title: tm('dlgPickSaveDir'),
      defaultPath: defaultSaveDir(),
      properties: ['openDirectory', 'createDirectory'],
    })
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return null
    if (!isUsableSaveDir(picked)) {
      showErrorDialog(shellWindow, tm('errSaveDirUnusable'), picked)
      return null
    }
    writeAppSetting(APP_SETTINGS_PATH(), DEFAULT_SAVE_DIR_KEY, picked)
    return picked
  })
}

/** home project panel channels (project:list/files/create/…); the slides chat channels come from the slides module */
function registerProjectPanelIpc(): void {
  ipcMain.handle(PROJECT_CHANNELS.list, () => getProjectStore().listProjectsSummary())

  ipcMain.handle(PROJECT_CHANNELS.files, (_event, args: { projectId?: unknown }) => {
    if (typeof args?.projectId !== 'string') return []
    return getProjectStore().listProjectFiles(args.projectId)
  })

  ipcMain.handle(PROJECT_CHANNELS.create, (_event, args: { name?: unknown }) => {
    const store = getProjectStore()
    const data = store.createProject(typeof args?.name === 'string' ? args.name : '')
    return store.listProjectsSummary().find((s) => s.id === data.id) ?? data
  })

  ipcMain.handle(PROJECT_CHANNELS.rename, (_event, args: { id?: unknown; name?: unknown }) => {
    if (typeof args?.id !== 'string' || typeof args?.name !== 'string') return
    getProjectStore().renameProject(args.id, args.name)
  })

  ipcMain.handle(PROJECT_CHANNELS.delete, (_event, args: { id?: unknown }) => {
    if (typeof args?.id !== 'string') return
    getProjectStore().deleteProject(args.id)
  })

  ipcMain.handle(
    PROJECT_CHANNELS.moveFile,
    (_event, args: { filePath?: unknown; projectId?: unknown }) => {
      if (typeof args?.filePath !== 'string' || typeof args?.projectId !== 'string') return
      getProjectStore().moveFileToProject(args.filePath, args.projectId)
    },
  )

  ipcMain.handle(PROJECT_CHANNELS.timeline, (_event, args: { projectId?: unknown; limit?: unknown }) => {
    if (typeof args?.projectId !== 'string') return []
    const limit = typeof args?.limit === 'number' ? args.limit : 20
    return getProjectStore().getProjectTimeline(args.projectId, limit)
  })
}

/** default folder where new files land on their first save (app-settings.json, falls back to <Documents>/byeppt) */
function defaultSaveDir(): string {
  return configuredDefaultSaveDir(app)
}

// electron-vite emits ?asset files under hashed names, which breaks nativeImage's
// automatic `@2x` sibling lookup — attach the retina representation by hand
function loadMenuIcon(path1x: string, path2x: string): NativeImage {
  const icon = nativeImage.createFromPath(path1x)
  icon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(path2x) })
  return icon
}

// loaded once, not on every menu open
interface MenuIconSet {
  pptx: NativeImage
  home: NativeImage
}
let menuIconCache: MenuIconSet | null = null
function menuIcons(): MenuIconSet {
  menuIconCache ??= {
    pptx: loadMenuIcon(menuPptxIcon1x, menuPptxIcon2x),
    home: loadMenuIcon(menuHomeIcon1x, menuHomeIcon2x),
  }
  return menuIconCache
}

const TAB_MENU_ICON: Record<TabKind, keyof MenuIconSet> = {
  home: 'home',
  slides: 'pptx',
}

// tab views see neither DOM events nor a focus change when the user clicks the
// shell chrome — relay the press so open popovers in documents can dismiss
function broadcastChromePressed(): void {
  for (const wc of webContents.getAllWebContents()) wc.send('app:chrome-pressed')
}

function registerTabsIpc(): void {
  ipcMain.on(TABS_CHANNELS.chromePressed, broadcastChromePressed)
  // AI panel "模型设置" link (invoked from a slides tab): jump to the Home tab
  // and tell the home renderer to open the settings modal on the providers pane
  ipcMain.handle('shell:open-agent-settings', () => {
    if (!tabManager || !shellWindow) return { ok: false }
    tabManager.openHomeTab()
    shellWindow.webContents.send('home:open-agent-settings')
    return { ok: true }
  })
  ipcMain.handle(TABS_CHANNELS.list, () => tabManager?.list() ?? [])
  ipcMain.handle(TABS_CHANNELS.activate, (_event, id: string) => tabManager?.activateTab(id))
  ipcMain.handle(TABS_CHANNELS.close, (_event, id: string) => tabManager?.closeTab(id))
  ipcMain.handle(TABS_CHANNELS.reorder, (_event, id: string, toIndex: number) => {
    if (typeof id === 'string' && Number.isInteger(toIndex)) tabManager?.reorderTab(id, toIndex)
  })
  // "all tabs" overflow menu — native popup because the editor's WebContentsView
  // would cover any DOM dropdown the shell renderer draws below the tab strip
  ipcMain.handle(TABS_CHANNELS.showMenu, (_event, x: unknown, y: unknown) => {
    if (!tabManager || !shellWindow) return
    const menu = Menu.buildFromTemplate(
      tabManager.list().map((tab) => ({
        // the home tab's stored title is a placeholder — always show the localized name
        label: tab.kind === 'home' ? tm('menuHome') : tab.title,
        type: 'checkbox' as const,
        checked: tab.active,
        icon: menuIcons()[TAB_MENU_ICON[tab.kind]],
        click: () => tabManager?.activateTab(tab.id),
      })),
    )
    menu.popup({
      window: shellWindow,
      ...(typeof x === 'number' && typeof y === 'number'
        ? { x: Math.round(x), y: Math.round(y) }
        : {}),
    })
  })
  // "+" new-file menu — native for the same reason as the tab list above
  ipcMain.handle(TABS_CHANNELS.showNewMenu, (_event, x: unknown, y: unknown) => {
    if (!tabManager || !shellWindow) return
    const menu = Menu.buildFromTemplate([
      // enabled:false so pre-Sonoma macOS / Windows (no 'header' support) degrade
      // to an inert label instead of a clickable no-op item
      { label: tm('menuSectionNew'), type: 'header', enabled: false },
      {
        label: tm('menuNewSlide'),
        icon: menuIcons().pptx,
        click: () => newSlideTab(),
      },
      { type: 'separator' },
      { label: tm('menuOpen'), click: () => void openFileViaDialog() },
    ])
    menu.popup({
      window: shellWindow,
      ...(typeof x === 'number' && typeof y === 'number'
        ? { x: Math.round(x), y: Math.round(y) }
        : {}),
    })
  })
}

// ---- home menu ----

async function openFileViaDialog(): Promise<void> {
  const win = shellWindow ?? BrowserWindow.getFocusedWindow()
  if (!win) return
  const result = await showOpenDialogWithMemory(dialog, win, {
    filters: [{ name: tm('filterSupported'), extensions: OPEN_DIALOG_EXTENSIONS }],
    properties: ['openFile'],
  })
  if (!result.canceled && result.filePaths[0]) openDocumentPath(result.filePaths[0])
}

function buildHomeMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: tm('menuFile'),
      submenu: [
        { label: tm('menuSectionNew'), type: 'header', enabled: false },
        {
          label: tm('menuNewSlide'),
          accelerator: 'CmdOrCtrl+N',
          click: () => newSlideTab(),
        },
        { type: 'separator' },
        {
          label: tm('menuOpen'),
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFileViaDialog(),
        },
        { type: 'separator' },
        { role: 'close', label: tm('menuClose') },
      ],
    },
    editMenuTemplate(process.platform, appMenuLabels(currentLang())),
    windowMenuTemplate(process.platform, appMenuLabels(currentLang())),
    {
      role: 'help',
      label: tm('menuHelp'),
      submenu: [{ label: tm('thirdPartyNotices'), click: () => void openThirdPartyNotices() }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function openThirdPartyNotices(): Promise<string> {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'THIRD-PARTY-NOTICES.txt')
    : join(app.getAppPath(), 'build', 'THIRD-PARTY-NOTICES.txt')
  return shell.openPath(path)
}

/** the editor's File menu gets a way back to the launcher */
function installBackToHomeItems(): void {
  const backToHomeItem: MenuItemConstructorOptions = {
    label: tm('backToHome'),
    accelerator: 'Shift+CmdOrCtrl+H',
    click: () => tabManager?.openHomeTab(),
  }
  setSlidesExtraFileMenuItems([backToHomeItem])
}

function installDockMenu(): void {
  if (process.platform !== 'darwin') return
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      { label: tm('menuHome'), click: () => tabManager?.openHomeTab() },
      { label: tm('menuNewSlide'), click: () => newSlideTab() },
    ]),
  )
}

// On mainland-China networks the main process's Node fetch (undici) bypasses the system proxy,
// so direct calls to overseas LLM APIs time out or get region-blocked. Prefer proxy env vars
// (terminal launch); a packaged app launched from Finder inherits no shell env vars, so fall
// back to the system HTTP proxy. The renderer uses Chromium's system proxy and is unaffected.
// Same bootstrap as slides-main startSlidesStandalone.
async function installMainProcessProxy(): Promise<void> {
  let proxyUrl = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ].find((v) => v && /^https?:\/\//.test(v))
  if (!proxyUrl) {
    try {
      // PAC/rule proxies answer per-host: probe a host the agent's LLM calls target
      const resolved = await session.defaultSession.resolveProxy('https://api.anthropic.com/')
      const m = /PROXY\s+([^;\s]+)/.exec(resolved)
      if (m) proxyUrl = `http://${m[1]}`
    } catch {
      /* no system proxy */
    }
  }
  if (!proxyUrl) return
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici')
    setGlobalDispatcher(new ProxyAgent(proxyUrl))
    // strip user:pass credentials before logging
    console.log('[proxy] main-process fetch via', proxyUrl.replace(/\/\/[^@/]*@/, '//***@'))
  } catch (e) {
    console.warn('[proxy] failed to set ProxyAgent:', e)
  }
}

// ---- lifecycle (the shell is the only owner) ----

let pendingLaunchPath = supportedFileIn(process.argv) ?? unsupportedFileIn(process.argv)

// show() does not un-minimize, and on macOS ⌘W destroys the shell window while the
// app keeps running — either way a file opened from Finder would land out of sight.
function revealShellWindow(): void {
  if (!shellWindow) createShellWindow()
  if (shellWindow?.isMinimized()) shellWindow.restore()
  shellWindow?.show()
  shellWindow?.focus()
}

// On macOS a file opened from Finder is not in argv; it arrives via the open-file event (before ready).
// If another instance already holds the lock, this process exits, and the path must ride along in
// the lock request's additionalData to the surviving instance — so the lock request is deferred
// until ready, after the path is known.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (!app.isReady()) {
    pendingLaunchPath = filePath
    return
  }
  revealShellWindow()
  if (!openDocumentPath(filePath)) tabManager?.openHomeTab()
})

app.on('second-instance', (_event, argv, _cwd, additionalData) => {
  const file =
    supportedFileIn(argv) ??
    unsupportedFileIn(argv) ??
    (additionalData as { launchPath?: string } | null)?.launchPath
  revealShellWindow()
  if (!file || !openDocumentPath(file)) tabManager?.openHomeTab()
})

installNavigationGuard(app)
installContextMenu(app, () => contextMenuLabels(currentLang()))
// home first: registerSlidesIpc removeHandler()s the shared 'app:get-theme' /
// 'app:get-language' channels before re-registering its equivalents, so it
// must run after the shell's own registrations (a duplicate plain handle()
// would throw).
registerHomeIpc()
registerTabsIpc()
registerSlidesIpc()
registerAgentIpc(getProjectStore)
registerSlidesProjectChatIpc()
registerProjectPanelIpc()

/** Dev-only pid marker for the takeover below; scoped to userData like the lock itself. */
const devPidFile = () => join(app.getPath('userData'), 'dev-instance.pid')

app.whenReady().then(async () => {
  // keep the dev taskbar icon grouping identical to the packaged app
  // (electron-builder sets this AUMID in the installer; dev needs it explicit)
  app.setAppUserModelId('com.byeppt.app')
  const lockData = () => (pendingLaunchPath ? { launchPath: pendingLaunchPath } : {})
  let hasLock = app.requestSingleInstanceLock(lockData())
  if (!hasLock && !app.isPackaged) {
    // Dev watch restart: electron-vite SIGTERMs the previous instance and spawns this
    // one immediately. Chromium turns that SIGTERM into a graceful quit (Node's
    // process.on('SIGTERM') never fires in the main process), and the quit can wedge
    // in the close-confirmation flow — the zombie then keeps the single-instance lock,
    // this instance quits, and electron-vite's on-close handler exits with it, killing
    // the renderer dev server (blank shell window until a manual dev restart).
    // The previous instance is doomed either way: kill it and take over the lock.
    try {
      const oldPid = Number(readFileSync(devPidFile(), 'utf-8').trim())
      if (Number.isFinite(oldPid) && oldPid > 0 && oldPid !== process.pid) {
        // pid-recycling guard: only kill if that pid is still an Electron process
        const cmd = execSync(`ps -o command= -p ${oldPid}`).toString()
        if (cmd.includes('Electron')) process.kill(oldPid, 'SIGKILL')
      }
    } catch {
      // no previous instance recorded / already gone (ps exits non-zero)
    }
    for (let i = 0; i < 20 && !hasLock; i++) {
      await new Promise((r) => setTimeout(r, 150))
      hasLock = app.requestSingleInstanceLock(lockData())
    }
  }
  if (!hasLock) {
    app.quit()
    return
  }
  if (!app.isPackaged) {
    try {
      writeFileSync(devPidFile(), String(process.pid))
    } catch {
      // best-effort: without the marker the next restart just retries the lock
    }
  }

  // An unpackaged macOS run is Electron.app, not ByePPT.app, so its bundle
  // icon is Electron's default. BrowserWindow.icon cannot override the Dock
  // icon on macOS; set the development Dock icon explicitly. Packaged builds
  // continue to use build/icon.icns from the .app bundle.
  if (!app.isPackaged && process.platform === 'darwin')
    app.dock?.setIcon(join(__dirname, '../../build/icon-mac.png'))

  void installMainProcessProxy()
  app.setAccessibilitySupportEnabled(true)
  // Settle the shared uiLang from saved settings BEFORE any tab renderer can
  // ask 'app:get-language': the editor handlers return the i18n module's
  // mutable lang, whose 'zh' default otherwise wins the race for whichever
  // tab loads first.
  currentLang()
  // native menus/dialogs/scrollbars follow the persisted theme from first paint
  nativeTheme.themeSource = currentTheme()
  createShellWindow()
  // deferred to ready: labels need currentLang(), which reads app.getLocale()
  installBackToHomeItems()
  installDockMenu()

  if (!pendingLaunchPath || !openDocumentPath(pendingLaunchPath)) tabManager?.openHomeTab()
  pendingLaunchPath = null

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createShellWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
