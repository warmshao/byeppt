/**
 * Manual "检查更新" flow (Settings → 通用).
 *
 * Windows (nsis) / Linux (AppImage) use electron-updater against the GitHub
 * Releases feed (see the `publish` block in electron-builder.cjs — unsigned
 * builds auto-update fine on those platforms). macOS builds are unsigned and
 * Squirrel.Mac refuses to update them, so the mac path only *checks* (the
 * /releases/latest HTML redirect via global fetch — the net-policy undici
 * dispatcher covers proxy users) and points the user at the release page.
 *
 * electron-updater is lazy-require()d and only ever touched on win/linux, so
 * the unsigned mac build never loads it.
 */
import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { HOME_CHANNELS } from '../shared/home-api'
import type { UpdateStatus } from '../shared/home-api'

const RELEASES_PAGE = 'https://github.com/warmshao/byeppt/releases/latest'

/** compare '0.1.2' vs 'v0.1.3': -1/0/1; leading v stripped, pre-release suffix ignored */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

type ElectronUpdater = typeof import('electron-updater')
type AutoUpdater = ElectronUpdater['autoUpdater']

function baseStatus(): UpdateStatus {
  return {
    state: 'idle',
    platform: process.platform as UpdateStatus['platform'],
    canAutoUpdate: app.isPackaged && process.platform !== 'darwin',
    current: app.getVersion(),
    releaseUrl: RELEASES_PAGE,
  }
}

export function registerUpdaterIpc(getWindow: () => BrowserWindow | null): void {
  let lastStatus: UpdateStatus = baseStatus()
  let autoUpdater: AutoUpdater | null = null

  const setStatus = (patch: Partial<UpdateStatus>): UpdateStatus => {
    lastStatus = { ...lastStatus, ...patch }
    getWindow()?.webContents.send(HOME_CHANNELS.updateEvent, lastStatus)
    return lastStatus
  }

  const errorStatus = (err: unknown): UpdateStatus =>
    setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })

  function loadAutoUpdater(): AutoUpdater | null {
    if (process.platform === 'darwin') return null
    if (autoUpdater) return autoUpdater
    // electron-updater is external in the vite config and packed as a real
    // dependency — require it at runtime, not through the bundler.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron-updater') as ElectronUpdater
    autoUpdater = mod.autoUpdater
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('update-not-available', (info) =>
      setStatus({ state: 'up-to-date', version: info.version }),
    )
    autoUpdater.on('update-available', (info) =>
      setStatus({ state: 'available', version: info.version }),
    )
    autoUpdater.on('download-progress', (progress) =>
      setStatus({ state: 'downloading', percent: Math.round(progress.percent) }),
    )
    autoUpdater.on('update-downloaded', (info) =>
      setStatus({ state: 'downloaded', version: info.version, percent: 100 }),
    )
    autoUpdater.on('error', (err) => errorStatus(err))
    return autoUpdater
  }

  /**
   * macOS check: resolve /releases/latest's 302 to /releases/tag/vX.Y.Z and
   * read the version from the final URL. Deliberately NOT the api.github.com
   * releases endpoint: unauthenticated API calls are rate-limited to 60/hr
   * per IP, and users behind shared proxy exits blow through that in
   * minutes — the HTML redirect has no such limit. (net-policy's undici
   * dispatcher still covers proxy users.)
   */
  async function checkViaGitHub(): Promise<UpdateStatus> {
    setStatus({ state: 'checking' })
    try {
      const res = await fetch(RELEASES_PAGE, {
        headers: { 'User-Agent': 'byeppt-updater' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`GitHub ${res.status}`)
      const m = /\/releases\/tag\/([^/?#]+)/.exec(res.url)
      if (!m) throw new Error('could not resolve latest release tag')
      const latest = decodeURIComponent(m[1]).replace(/^v/i, '')
      if (!latest) throw new Error('empty tag in latest release URL')
      const releaseUrl = res.url
      return compareVersions(latest, app.getVersion()) > 0
        ? setStatus({ state: 'available', version: latest, releaseUrl })
        : setStatus({ state: 'up-to-date', version: latest, releaseUrl })
    } catch (err) {
      return errorStatus(err)
    }
  }

  ipcMain.handle(HOME_CHANNELS.checkUpdate, async (): Promise<UpdateStatus> => {
    if (!app.isPackaged) return setStatus({ state: 'dev', canAutoUpdate: false })
    if (lastStatus.state === 'checking' || lastStatus.state === 'downloading') return lastStatus
    if (process.platform === 'darwin') return checkViaGitHub()
    setStatus({ state: 'checking' })
    try {
      const updater = loadAutoUpdater()
      if (!updater) throw new Error('auto-updater unavailable on this platform')
      await updater.checkForUpdates()
      // the events above have already settled lastStatus
      return lastStatus
    } catch (err) {
      return errorStatus(err)
    }
  })

  ipcMain.handle(HOME_CHANNELS.downloadUpdate, async (): Promise<UpdateStatus> => {
    if (lastStatus.state === 'downloading' || lastStatus.state === 'downloaded') return lastStatus
    if (lastStatus.state !== 'available' || !lastStatus.canAutoUpdate) return lastStatus
    try {
      const updater = loadAutoUpdater()
      if (!updater) throw new Error('auto-updater unavailable on this platform')
      setStatus({ state: 'downloading', percent: 0 })
      await updater.downloadUpdate()
      return lastStatus
    } catch (err) {
      return errorStatus(err)
    }
  })

  ipcMain.handle(HOME_CHANNELS.quitAndInstall, () => {
    if (lastStatus.state !== 'downloaded' || !autoUpdater) return
    // nsis is oneClick:false — this relaunches into the assisted installer
    // wizard (not silent), keeping the user's install-dir choice flow.
    autoUpdater.quitAndInstall(false, true)
  })
}
