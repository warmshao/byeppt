import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app } from 'electron'
import type { RecentEntry, RecentPage, RecentQuery } from '../shared/home-api'

function userDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    /* corrupted state file: fall back to defaults */
  }
  return fallback
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

// ---- recent files (the shell owns this store; the home screen lists them) ----

const RECENT_PATH = () => userDataPath('recent.json')

// the home screen lists all of these
const RECENT_LIMIT = 100

function pushRecent(filePath: string): void {
  const recent = readJson<string[]>(RECENT_PATH(), [])
  // Every save lands here (autosave): skip the write when the file is already
  // at the head of the list
  if (recent[0] === filePath) return
  const next = [filePath, ...recent.filter((p) => p !== filePath)].slice(0, RECENT_LIMIT)
  writeJson(RECENT_PATH(), next)
}

/** unified recents for the shell home screen (paths only; type = extension) */
export function readRecentFiles(): string[] {
  return readJson<string[]>(RECENT_PATH(), []).filter((p) => existsSync(p))
}

export function recordRecentFile(filePath: string): void {
  pushRecent(filePath)
}

export function removeRecentFiles(filePaths: string[]): void {
  const drop = new Set(filePaths)
  const recent = readJson<string[]>(RECENT_PATH(), [])
  writeJson(
    RECENT_PATH(),
    recent.filter((p) => !drop.has(p)),
  )
}

/** keep a renamed file at its old position in the recent/starred lists */
export function replaceRecentFile(oldPath: string, newPath: string): void {
  const recent = readJson<string[]>(RECENT_PATH(), [])
  writeJson(
    RECENT_PATH(),
    recent.map((p) => (p === oldPath ? newPath : p)),
  )
  const starred = readJson<string[]>(STARRED_PATH(), [])
  if (starred.includes(oldPath)) {
    writeJson(
      STARRED_PATH(),
      starred.map((p) => (p === oldPath ? newPath : p)),
    )
  }
}

// ---- starred files (home screen favorites) ----

const STARRED_PATH = () => userDataPath('starred.json')

export function readStarredFiles(): string[] {
  return readJson<string[]>(STARRED_PATH(), []).filter((p) => existsSync(p))
}

export function toggleStarredFile(filePath: string): void {
  const starred = readJson<string[]>(STARRED_PATH(), [])
  const next = starred.includes(filePath)
    ? starred.filter((p) => p !== filePath)
    : [...starred, filePath]
  writeJson(STARRED_PATH(), next)
}


const RECENT_PAGE_DEFAULT = 50
const RECENT_PAGE_MAX = 200

function toRecentEntry(path: string, starredPaths: ReadonlySet<string>): RecentEntry | null {
  try {
    const stat = statSync(path)
    return {
      path,
      name: basename(path),
      ext: extname(path).slice(1).toLowerCase(),
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      starred: starredPaths.has(path),
    }
  } catch {
    return null
  }
}

export function statExistingPaths(
  paths: readonly string[],
  starredPaths: ReadonlySet<string>,
): RecentEntry[] {
  return paths
    .map((path) => toRecentEntry(path, starredPaths))
    .filter((entry): entry is RecentEntry => entry !== null)
}

export function normalizeRecentQuery(
  raw: unknown,
): Required<Omit<RecentQuery, 'ext'>> & { ext?: string } {
  const query = (raw ?? {}) as RecentQuery
  const offset = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset!)) : 0
  const limit = Number.isFinite(query.limit)
    ? Math.min(RECENT_PAGE_MAX, Math.max(0, Math.floor(query.limit!)))
    : RECENT_PAGE_DEFAULT
  const ext = typeof query.ext === 'string' && query.ext ? query.ext.toLowerCase() : undefined
  return { offset, limit, ext }
}

/** Page over existing paths only, preserving the source's newest-first order. */
export function pageRecentPaths(
  paths: readonly string[],
  raw: unknown,
  starredPaths: ReadonlySet<string>,
): RecentPage {
  const { offset, limit, ext } = normalizeRecentQuery(raw)
  const all = statExistingPaths(paths, starredPaths)
  const filtered = ext ? all.filter((entry) => entry.ext === ext) : all
  return {
    entries: limit === 0 ? [] : filtered.slice(offset, offset + limit),
    total: filtered.length,
    totalAll: all.length,
  }
}
