#!/usr/bin/env node
/**
 * Pack-time fetch of the offline kernel runtime, per target platform/arch.
 *
 * The packaged app assembles the vsurf IPython kernel venv on first launch
 * with zero network access (see apps/byeppt/src/main/agent/kernel-env.ts).
 * That only works if the installer carries everything the bootstrap would
 * otherwise download from GitHub Releases / PyPI — this script downloads
 * those artifacts on the BUILD machine (where a proxy is acceptable):
 *
 *   runtime/kernel/<platform>-<arch>/
 *     uv | uv.exe        pinned uv binary (GitHub Releases, sha256-verified)
 *     python.tar.gz      python-build-standalone CPython 3.11 install_only
 *                        (matches vsurf's PYTHON_VERSION; sha256-verified
 *                        against the release's SHA256SUMS)
 *     wheelhouse/*.whl   every dependency of the kernel venv + the bundled
 *                        python skills, downloaded for the TARGET platform
 *                        (pip download --platform ...) plus the build
 *                        backends (hatchling / setuptools) needed for the
 *                        offline source/editable installs and pip for
 *                        `uv venv --seed`
 *     manifest.json      versions; re-runs skip when it matches
 *
 * Usage: node tools/fetch-kernel-runtime.mjs --platform darwin --arch arm64
 *        (--force to rebuild from scratch)
 *
 * Honors HTTPS_PROXY/HTTP_PROXY for all downloads (curl + pip both do).
 * Bump UV_VERSION / PBS_* here to upgrade the shipped runtime.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- pinned upstream versions ------------------------------------------------
const UV_VERSION = '0.12.5'
const PBS_TAG = '20260814'
const PBS_PYTHON = '3.11.16'
const PBS_BASE = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}`
const UV_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`

// ---- target matrix -----------------------------------------------------------
// pipPlatforms: values passed to `pip download --platform` (several widen compat).
const TARGETS = {
  // macOS: request macosx_12_0 — pip accepts any wheel tagged <= the request,
  // so this admits 10_9/10_15/11_0/12_0 wheels while forcing the resolver to
  // pick the newest package VERSION that still ships a ≤12_0 wheel (e.g. an
  // older numpy instead of the 14_0-only latest). This mirrors what uv's
  // online resolver picks on macOS 12 machines and keeps the wheelhouse
  // installable on every macOS we support (12+; scipy has no <12_0 arm64
  // wheels at all, so 11_0 cannot be satisfied). universal2 listed explicitly
  // for packages that only ship that tag.
  'darwin-arm64': {
    uvAsset: 'uv-aarch64-apple-darwin.tar.gz',
    pbsTriple: 'aarch64-apple-darwin',
    pipPlatforms: ['macosx_12_0_arm64', 'macosx_12_0_universal2'],
  },
  'darwin-x64': {
    uvAsset: 'uv-x86_64-apple-darwin.tar.gz',
    pbsTriple: 'x86_64-apple-darwin',
    pipPlatforms: ['macosx_12_0_x86_64', 'macosx_12_0_universal2'],
  },
  'win32-x64': {
    uvAsset: 'uv-x86_64-pc-windows-msvc.zip',
    pbsTriple: 'x86_64-pc-windows-msvc',
    pipPlatforms: ['win_amd64'],
  },
  'win32-arm64': {
    uvAsset: 'uv-aarch64-pc-windows-msvc.zip',
    pbsTriple: 'aarch64-pc-windows-msvc',
    pipPlatforms: ['win_arm64'],
  },
  // Linux: request up to manylinux_2_28 — pip accepts wheels tagged <= the
  // request, so this admits 2_17/2014/2_28 wheels while forcing older-version
  // fallbacks for anything only shipping >2_28. That keeps the wheelhouse
  // installable on glibc 2.28+ distros (Ubuntu 20.04+, Debian 11+, Fedora 34+,
  // RHEL 9+). musllinux (Alpine) is intentionally unsupported.
  'linux-x64': {
    uvAsset: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    pbsTriple: 'x86_64-unknown-linux-gnu',
    pipPlatforms: ['manylinux_2_28_x86_64', 'manylinux2014_x86_64', 'manylinux_2_17_x86_64'],
  },
  'linux-arm64': {
    uvAsset: 'uv-aarch64-unknown-linux-gnu.tar.gz',
    pbsTriple: 'aarch64-unknown-linux-gnu',
    pipPlatforms: ['manylinux_2_28_aarch64', 'manylinux2014_aarch64', 'manylinux_2_17_aarch64'],
  },
}

// Kernel venv requirements: vsurf's bootstrap list (ipykernel + dill + its 13
// default extras) and vsurf-runtime's deps, plus the tooling needed offline:
// pip/setuptools/wheel for `uv venv --seed` and editable builds, hatchling for
// building vsurf-runtime from source. The skill's own runtime deps are read
// from skills/byeppt-pptx-py/pyproject.toml below.
const BASE_REQUIREMENTS = [
  'ipykernel', 'dill', 'nest-asyncio', 'tyro',
  'requests', 'httpx', 'pyyaml', 'tomli', 'python-dotenv', 'pandas', 'openpyxl',
  'numpy', 'scipy', 'beautifulsoup4', 'lxml', 'pydantic',
  'pip', 'setuptools', 'wheel', 'hatchling',
]

function parseArgs() {
  const args = process.argv.slice(2)
  const opt = { platform: process.platform, arch: process.arch, force: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform') opt.platform = args[++i]
    else if (args[i] === '--arch') opt.arch = args[++i]
    else if (args[i] === '--force') opt.force = true
    else if (args[i] === '--host') { opt.platform = process.platform; opt.arch = process.arch }
  }
  return opt
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`)
}

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}: ${r.stderr}`)
  return r.stdout.trim()
}

/** Download url -> dest via curl (honors HTTPS_PROXY), returning dest. Skips if dest exists. */
function download(url, dest) {
  if (existsSync(dest)) return dest
  mkdirSync(dirname(dest), { recursive: true })
  console.log(`  ↓ ${url}`)
  run('curl', ['-fL', '--retry', '3', '--connect-timeout', '30', '-o', dest, url])
  return dest
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** pip's cache dir for the host interpreter used to run `pip download`. */
function hostPython() {
  const key = `${process.platform}-${process.arch}`
  const t = TARGETS[key]
  if (!t) throw new Error(`no python-build-standalone triple known for build host ${key}`)
  const dir = join(ROOT, 'runtime', 'host', key)
  const exe = process.platform === 'win32' ? join(dir, 'python', 'python.exe') : join(dir, 'python', 'bin', 'python3')
  if (!existsSync(exe)) {
    const asset = `cpython-${PBS_PYTHON}+${PBS_TAG}-${t.pbsTriple}-install_only.tar.gz`
    const tar = download(`${PBS_BASE}/${encodeURIComponent(asset)}`, join(dir, asset))
    console.log(`  extracting host python (${asset})`)
    run('tar', ['-xzf', tar, '-C', dir])
    rmSync(tar, { force: true })
  }
  return exe
}

/** Runtime deps of the bundled python skill, read from its pyproject (avoids
 * building a 60MB wheel of it — icons stay in the skills tree, installed editable). */
function skillRequirements() {
  const pyproject = readFileSync(join(ROOT, 'skills', 'byeppt-pptx-py', 'pyproject.toml'), 'utf8')
  const m = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(pyproject)
  if (!m) throw new Error('could not parse skill dependencies from pyproject.toml')
  return [...m[1].matchAll(/"([^"]+)"/g)].map((g) => g[1])
}

function dirSize(dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? dirSize(p) : statSync(p).size
  }
  return total
}

async function main() {
  const { platform, arch, force } = parseArgs()
  const key = `${platform}-${arch}`
  const target = TARGETS[key]
  if (!target) throw new Error(`unknown target ${key} (known: ${Object.keys(TARGETS).join(', ')})`)
  const outDir = join(ROOT, 'runtime', 'kernel', key)
  if (force) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const manifestPath = join(outDir, 'manifest.json')
  // The requirements fingerprint goes into the manifest: a skill pyproject
  // dep change (e.g. swapping PyMuPDF for pdfplumber) must rebuild the
  // wheelhouse even when the pinned uv/python versions are unchanged.
  const reqs = [...BASE_REQUIREMENTS, ...skillRequirements()]
  const reqsHash = createHash('sha256').update(reqs.join('\n')).digest('hex')
  const manifest = { uvVersion: UV_VERSION, pbsTag: PBS_TAG, pbsPython: PBS_PYTHON, platform, arch, reqsHash }
  const upToDate =
    existsSync(manifestPath) &&
    JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8')), null, 0) ===
      JSON.stringify(manifest, null, 0)

  // 1. uv binary ---------------------------------------------------------------
  const uvExe = join(outDir, platform === 'win32' ? 'uv.exe' : 'uv')
  if (!upToDate || !existsSync(uvExe)) {
    console.log(`[1/3] uv ${UV_VERSION} (${key})`)
    const assetUrl = `${UV_BASE}/${target.uvAsset}`
    const archive = download(assetUrl, join(outDir, target.uvAsset))
    const expected = runCapture('curl', ['-fsL', `${assetUrl}.sha256`]).split(/\s+/)[0]
    const actual = sha256File(archive)
    if (actual !== expected) throw new Error(`uv sha256 mismatch: ${actual} != ${expected}`)
    // Layout differs per archive: mac/linux tarballs nest the binaries in a
    // named top dir, the windows zip has them at the root — extract to a temp
    // dir and move the binaries out instead of guessing strip-components.
    const tmp = join(outDir, '.uv-extract')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    run('tar', ['-xf', archive, '-C', tmp])
    const findIn = (dir, name) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isFile() && e.name === name) return p
        if (e.isDirectory()) {
          const hit = findIn(p, name)
          if (hit) return hit
        }
      }
      return null
    }
    for (const name of platform === 'win32' ? ['uv.exe', 'uvx.exe'] : ['uv', 'uvx']) {
      const found = findIn(tmp, name)
      if (found) renameSync(found, join(outDir, name))
    }
    rmSync(tmp, { recursive: true, force: true })
    rmSync(archive, { force: true })
    if (!existsSync(uvExe)) throw new Error(`uv binary not found after extracting ${target.uvAsset}`)
  } else console.log('[1/3] uv up to date, skipping')

  // 2. CPython tarball (shipped compressed; extracted on the user's machine) ---
  const pyTar = join(outDir, 'python.tar.gz')
  if (!upToDate || !existsSync(pyTar)) {
    console.log(`[2/3] CPython ${PBS_PYTHON} (${target.pbsTriple})`)
    const asset = `cpython-${PBS_PYTHON}+${PBS_TAG}-${target.pbsTriple}-install_only.tar.gz`
    download(`${PBS_BASE}/${encodeURIComponent(asset)}`, pyTar)
    const sums = runCapture('curl', ['-fsL', `${PBS_BASE}/SHA256SUMS`])
    const line = sums.split('\n').find((l) => l.endsWith(`  ${asset}`) || l.endsWith(` ${asset}`))
    if (!line) throw new Error(`no SHA256SUMS entry for ${asset}`)
    const actual = sha256File(pyTar)
    if (actual !== line.split(/\s+/)[0]) throw new Error(`python sha256 mismatch for ${asset}`)
  } else console.log('[2/3] python tarball up to date, skipping')

  // 3. wheelhouse ---------------------------------------------------------------
  const wheelhouse = join(outDir, 'wheelhouse')
  if (!upToDate || !existsSync(wheelhouse) || readdirSync(wheelhouse).length === 0) {
    console.log(`[3/3] wheelhouse for ${key}`)
    rmSync(wheelhouse, { recursive: true, force: true })
    mkdirSync(wheelhouse, { recursive: true })
    const pipArgs = [
      '-m', 'pip', 'download', '--only-binary=:all:', '--python-version', '3.11',
      ...target.pipPlatforms.flatMap((p) => ['--platform', p]),
      '-d', wheelhouse, '-q', ...reqs,
    ]
    run(hostPython(), pipArgs)
  } else console.log('[3/3] wheelhouse up to date, skipping')

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const mb = (dirSize(outDir) / 1024 / 1024).toFixed(1)
  console.log(`✓ runtime/kernel/${key} ready (${mb} MB)`)
}

main().catch((err) => {
  console.error(`fetch-kernel-runtime: ${err.message}`)
  process.exit(1)
})
