// Dev-mode watcher: keeps apps/byeppt/out/preload/index.js fresh.
//
// The shell bundles byeppt's main sources directly and the renderer comes from
// the vite dev server, so out/preload/index.js is the ONLY build artifact the
// running dev app reads from disk (the shell resolves it by file path when a
// slides tab is created). A stale preload against a fresh dev-server renderer
// blanks the tab (renderer calls slidesApi methods the old preload never
// injected). electron-vite 5 dropped `build --watch`, so we watch the preload
// inputs ourselves and rerun the (sub-second, BYEPPT_PRELOAD_ONLY=1) build.
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(root, 'apps', 'byeppt')
const watchDirs = [join(appDir, 'src', 'preload'), join(appDir, 'src', 'shared')]

let building = false
let queued = false

function rebuild(reason) {
  if (building) {
    queued = true
    return
  }
  building = true
  console.log(`[preload-watch] rebuilding (${reason})…`)
  const child = spawn(
    'npx',
    ['electron-vite', 'build', '--logLevel', 'warn', '--ignoreConfigWarning'],
    {
      cwd: appDir,
      env: { ...process.env, BYEPPT_PRELOAD_ONLY: '1' },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  )
  child.on('exit', (code) => {
    building = false
    console.log(
      code === 0
        ? '[preload-watch] out/preload/index.js is fresh — new slides tabs pick it up'
        : `[preload-watch] build failed (exit ${code})`,
    )
    if (queued) {
      queued = false
      rebuild('queued change')
    }
  })
}

// fs.watch recursive is unsupported on Linux; fall back to per-directory watchers.
function watchDir(dir) {
  try {
    watch(dir, { recursive: true }, (_event, filename) => {
      if (filename && !filename.endsWith('.ts')) return
      rebuild(filename ?? 'change')
    })
  } catch {
    import('node:fs').then(({ readdirSync }) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) watchDir(p)
      }
      watch(dir, (_event, filename) => {
        if (filename && !filename.endsWith('.ts')) return
        rebuild(filename ?? 'change')
      })
    })
  }
}

for (const dir of watchDirs) watchDir(dir)
console.log(`[preload-watch] watching ${watchDirs.map((d) => d.replace(`${root}/`, '')).join(', ')}`)
rebuild('startup')
