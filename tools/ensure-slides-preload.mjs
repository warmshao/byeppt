// Ensures apps/byeppt/out/preload/index.js exists before `npm run dev`.
//
// The shell's slides tab (WebContentsView) uses apps/byeppt/out/preload/index.js
// as its preload (see apps/shell/src/main/index.ts — SLIDES_OUT). The root dev
// script only starts the byeppt *renderer* dev server, so a fresh checkout (or a
// cleaned out/) leaves the preload missing: the tab page loads from the dev URL
// but the bridge APIs never inject, and the tab renders blank.
//
// Building @byeppt/app on every dev start costs ~40s (mostly the renderer, which
// dev mode never loads), so we only build when the preload bundle is absent.
// Staleness during dev is handled by the dev:preload watcher
// (tools/watch-slides-preload.mjs, part of the root dev script) — this hook
// just guarantees the bundle exists before the shell can create a tab.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const preloadBundle = join(root, 'apps', 'byeppt', 'out', 'preload', 'index.js')

if (existsSync(preloadBundle)) process.exit(0)

console.log('[predev] apps/byeppt/out/preload missing — building @byeppt/app once…')
const result = spawnSync('npm', ['run', 'build', '-w', '@byeppt/app'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
