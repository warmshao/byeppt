/**
 * One-time kernel environment bootstrap for the vsurf IPython kernel.
 *
 * Three paths, in priority order:
 * 1. VSURF_KERNEL_PYTHON set → user-supplied env, no provisioning.
 * 2. Bundled offline runtime (packaged builds; resources/kernel-runtime with
 *    pinned uv + CPython tarball + wheelhouse, fetched per platform/arch at
 *    pack time by tools/fetch-kernel-runtime.mjs): copy the bundled uv, seed
 *    uv's managed python dir, then run vsurf's normal bootstrap under
 *    UV_OFFLINE + UV_FIND_LINKS + UV_PYTHON_PREFERENCE=only-managed — zero
 *    network, strictly bundled-only (the user's uv/system Python are never
 *    used, and there is NO online fallback: a broken bundle is a packaging
 *    bug and must surface as an error). See provisionOfflineRuntime.
 * 3. Online path (dev checkouts without a fetched runtime, and linux builds
 *    that ship no runtime): `ensureUv` — make sure the `uv` binary exists
 *    (existing uv, then `pip install --user uv`, then the official Windows
 *    installer); then `provisionKernelSkills` — install `byeppt-pptx-py`
 *    (and its pyproject dependencies: python-pptx, skia-pathops, uharfbuzz,
 *    google-genai, ...) into the kernel venv. All spawns run under the
 *    net-policy env: the configured proxy when there is one, China mirrors
 *    otherwise.
 *
 * Progress is surfaced through the caller's `onProgress` callback; session.ts
 * forwards it to the renderer as `agent:event` with `byeppt:kernel-*` types.
 */
import { app } from 'electron'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, delimiter } from 'node:path'
import { spawn } from 'node:child_process'
import type { PythonSkillRuntimeInfo } from '@warmshao/vsurf'
import { spawnNetworkEnv } from '../net-policy'

/** Progress callback: a human-readable bootstrap message. */
export type KernelEnvProgress = (message: string) => void

/** Kernel-start / connection noise that users do not need to see. */
const KERNEL_NOISE = [
  /starting (ipython )?kernel/i,
  /restarting (ipython )?kernel/i,
  /connecting to kernel/i,
  /kernel ready/i,
]

/** Map a raw vsurf bootstrap message to a user-facing line, or null to skip. */
export function userProgressMessage(raw: string): string | null {
  const msg = raw.replace(ANSI_SGR, '')
  if (KERNEL_NOISE.some((re) => re.test(msg))) return null
  if (/installing uv/i.test(msg)) return '正在安装 Python 工具（uv，一次性）…'
  if (/setting up python kernel/i.test(msg)) return '正在准备 Python 运行环境（首次约 1 分钟）…'
  if (/rebuilding kernel venv/i.test(msg)) return '正在重建 Python 运行环境…'
  if (/^\s*\u2713\s*ready/i.test(msg)) return 'Python 运行环境就绪 ✓'
  return msg
}

/** App-private tool/runtime dirs. Never replace a user-installed uv or Python. */
const UV_DIR = join(app.getPath('userData'), 'agent', 'bin')
const UV_PYTHON_DIR = join(app.getPath('userData'), 'agent', 'uv-python')
const UV_EXE = process.platform === 'win32' ? 'uv.exe' : 'uv'
const UV_PATH = join(UV_DIR, UV_EXE)

/** <userData>/agent — kernel cwd + config dir. */
function agentDir(): string {
  return join(app.getPath('userData'), 'agent')
}

/**
 * Point the vsurf SDK at its asar-unpacked copy when packaged. The SDK
 * resolves everything (dist/vsurf-runtime, builtin python skills) from its
 * own package dir and hands those paths to external processes (uv/pip) —
 * which cannot read inside app.asar ("Not a directory", os error 20).
 * asarUnpack already ships the files at app.asar.unpacked; VSURF_PACKAGE_DIR
 * is the SDK's official override for exactly this. Idempotent.
 */
export function ensureVsurfPackageDirEnv(): void {
  // Isolate the packaged app's kernel venv from a possible standalone vsurf
  // installation. An explicit user override still wins.
  if (app.isPackaged && !process.env.VSURF_KERNEL_VENV) {
    process.env.VSURF_KERNEL_VENV = join(agentDir(), 'kernel-venv')
  }
  if (process.env.VSURF_PACKAGE_DIR) return
  if (!app.isPackaged || !process.resourcesPath) return
  const dir = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@warmshao',
    'vsurf',
  )
  if (existsSync(join(dir, 'package.json'))) {
    process.env.VSURF_PACKAGE_DIR = dir
  } else {
    console.warn('[kernel-env] asar-unpacked vsurf SDK not found at', dir)
  }
}

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
  console.warn('[kernel-env] skills dir not found; python skills unavailable')
  return null
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/**
 * Temporarily overlay vars onto process.env; returns a restore function.
 * vsurf spawns uv with `env: process.env`, so this is how the offline
 * (UV_OFFLINE/UV_FIND_LINKS) and mirror/proxy settings reach the bootstrap.
 */
function patchEnv(vars: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

// ---- bundled offline runtime -------------------------------------------------

interface KernelRuntimeManifest {
  uvVersion: string
  pbsTag: string
  pbsPython: string
  platform: string
  arch: string
}

/**
 * Locate the bundled offline kernel runtime (uv + CPython tarball + wheelhouse,
 * fetched per target at pack time by tools/fetch-kernel-runtime.mjs). Packaged:
 * resources/kernel-runtime; dev: repo runtime/kernel/<platform>-<arch>.
 * Returns null when absent (dev checkouts without a fetched runtime → online path).
 */
function resolveKernelRuntimeDir(): string | null {
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'kernel-runtime'))
  let dir = app.getAppPath()
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, 'runtime', 'kernel', `${process.platform}-${process.arch}`))
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  for (const c of candidates) {
    if (
      existsSync(join(c, 'manifest.json')) &&
      existsSync(join(c, 'python.tar.gz')) &&
      existsSync(join(c, 'wheelhouse')) &&
      existsSync(join(c, UV_EXE))
    ) {
      return c
    }
  }
  return null
}

function readRuntimeManifest(runtimeDir: string): KernelRuntimeManifest {
  return JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8')) as KernelRuntimeManifest
}

/** uv's managed-python dir naming: cpython-<ver>-<os>-<arch>-none. */
function uvPythonDirName(pbsPython: string): string {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  // uv-platform spells the arm64 arch "aarch64" (e.g. cpython-3.11.16-macos-aarch64-none)
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return `cpython-${pbsPython}-${os}-${arch}-none`
}

/**
 * Remove Gatekeeper's quarantine bit from app-owned executables.
 *
 * The distributed macOS app is currently unsigned. Clearing the bundle alone
 * does not reliably cover executables copied/extracted into uv's user-level
 * managed directories; without this, macOS can block `uv` or `python3.11`
 * during first-run provisioning and make the "one-time" setup retry forever.
 * Failure is non-fatal: xattr is a best-effort workaround until the app is
 * signed/notarized.
 */
async function clearMacQuarantine(path: string): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    await runChecked('/usr/bin/xattr', ['-r', '-d', 'com.apple.quarantine', path])
  } catch (err) {
    console.warn(
      '[kernel-env] failed to clear macOS quarantine for',
      path,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Extract the bundled python-build-standalone tarball into uv's managed python
 * dir, so the bootstrap's `uv python install 3.11` becomes a no-op offline.
 * Idempotent: an existing dir that `uv python find 3.11` resolves is kept.
 */
async function seedBundledPython(runtimeDir: string, manifest: KernelRuntimeManifest): Promise<void> {
  const uvDir = (await runCapture(UV_PATH, ['python', 'dir'])).trim()
  const target = join(uvDir, uvPythonDirName(manifest.pbsPython))
  const found = async () => {
    try {
      await runChecked(UV_PATH, ['python', 'find', '3.11'])
      return true
    } catch {
      return false
    }
  }
  // A prior attempt may have extracted Python but been blocked by Gatekeeper
  // before marking provisioning complete. Clear it before uv probes the binary.
  if (existsSync(target)) await clearMacQuarantine(target)
  if (existsSync(target) && (await found())) return
  const staging = join(uvDir, 'python')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(uvDir, { recursive: true })
  // tar is bsdtar on macOS and Windows 10+ — both handle .tar.gz
  await runChecked('tar', ['-xzf', join(runtimeDir, 'python.tar.gz'), '-C', uvDir])
  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
  await clearMacQuarantine(target)
  if (!(await found())) {
    throw new Error(`bundled python extracted to ${target} but uv python find 3.11 does not see it`)
  }
}

/**
 * PATH for the offline bootstrap with every directory containing a `uv`
 * binary removed — except UV_DIR (which we just populated with the pinned
 * bundled build, prepended). This keeps provisioning on the bundled build even
 * when the user has uv installed elsewhere (e.g. Homebrew), without replacing
 * their executable.
 */
function bundledOnlyPath(): string {
  const exe = process.platform === 'win32' ? 'uv.exe' : 'uv'
  const dirs = (process.env.PATH || '')
    .split(delimiter)
    .filter((dir) => dir && dir !== UV_DIR && !existsSync(join(dir, exe)))
  return [UV_DIR, ...dirs].join(delimiter)
}

/**
 * Offline first-run assembly from the bundled runtime: pinned uv → seed managed
 * python → vsurf's normal bootstrap under UV_OFFLINE + UV_FIND_LINKS (venv
 * creation, dependency + editable skill installs all resolve from the
 * wheelhouse; vsurf's .bootstrap-version fingerprinting stays authoritative
 * for later skill updates, which also resolve offline from the new package's
 * wheelhouse).
 *
 * Strictly bundled-only: the user's own uv is always overwritten with the
 * pinned build, and UV_PYTHON_PREFERENCE=only-managed keeps uv from ever
 * picking up a system/user Python. There is NO online fallback — a broken
 * bundle is a packaging bug and must surface as an error, not a silent
 * 100MB download on a metered/blocked network. Never throws.
 */
async function provisionOfflineRuntime(
  runtimeDir: string,
  onProgress?: KernelEnvProgress,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const manifest = readRuntimeManifest(runtimeDir)
    // Managed pythons only (a system/user python must never leak into the
    // kernel env), fully offline from the wheelhouse. Scoped to this call.
    const restore = patchEnv({
      UV_OFFLINE: '1',
      UV_FIND_LINKS: join(runtimeDir, 'wheelhouse'),
      UV_PYTHON_INSTALL_DIR: UV_PYTHON_DIR,
      UV_PYTHON_PREFERENCE: 'only-managed',
      PATH: bundledOnlyPath(),
    })
    try {
      // 1. uv binary: always the pinned bundled build (never the user's own)
      mkdirSync(UV_DIR, { recursive: true })
      copyFileSync(join(runtimeDir, UV_EXE), UV_PATH)
      try {
        chmodSync(UV_PATH, 0o755)
      } catch {
        // Windows: chmod is a no-op
      }
      await clearMacQuarantine(UV_PATH)
      process.env.VSURF_INSTALL_UV = '1'
      // 2. managed python
      onProgress?.('正在解压内置 Python 运行环境(一次性)…')
      await seedBundledPython(runtimeDir, manifest)
      // 3. venv + deps + skills
      onProgress?.('正在组装 Python 运行环境(离线,首次约 1 分钟)…')
      return await provisionKernelSkills(onProgress)
    } finally {
      restore()
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}


/** Kernel venv python (mirrors vsurf's getKernelVenvDir/getVenvPythonPath, honoring overrides). */
export function resolveKernelPython(): string {
  if (process.env.VSURF_KERNEL_PYTHON) return resolve(expandHome(process.env.VSURF_KERNEL_PYTHON))
  const venv = process.env.VSURF_KERNEL_VENV
    ? resolve(expandHome(process.env.VSURF_KERNEL_VENV))
    : app.isPackaged
      ? join(agentDir(), 'kernel-venv')
      : join(homedir(), '.vsurf', 'agent', 'kernel-venv')
  return process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
}

/** Strip ANSI SGR escape sequences (colors). uv colorizes output even when
 * piped in some environments; captured text used as a PATH or shown in the UI
 * must never carry them (a colored `uv python dir` once became a real
 * directory named "<ESC>[36m" under the cwd). */
// eslint-disable-next-line no-control-regex
const ANSI_SGR = /(?:)?\[\d+(?:;\d+)*m/g

/** Spawn env for child tools: inherit everything, but disable color at the source. */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', UV_NO_COLOR: '1' }
}

function runChecked(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore', env: childEnv() })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`)),
    )
  })
}

/** Run a command and capture its stdout (trimmed, ANSI-stripped). */
function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: childEnv() })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolvePromise(out.replace(ANSI_SGR, '').trim())
        : reject(new Error(`${cmd} exited ${code}`)),
    )
  })
}

/** First python launcher on PATH ('python', then the Windows 'py' launcher). */
async function findSystemPython(): Promise<string | null> {
  for (const cmd of ['python', 'py']) {
    try {
      await runChecked(cmd, ['-c', 'import sys'])
      return cmd
    } catch {
      // try the next candidate
    }
  }
  return null
}

async function pythonCanImport(python: string, modules: string[]): Promise<boolean> {
  if (!existsSync(python)) return false
  try {
    await runChecked(python, ['-c', `import ${modules.join(',')}`])
    return true
  } catch {
    return false
  }
}

/**
 * Ensure `uv` exists for the kernel bootstrap. No-op when already available;
 * otherwise installs it at runtime — `pip install --user uv` first (no bundled
 * binary in the repo), then the official Windows installer as a fallback.
 * Never throws — vsurf's own error path stays authoritative.
 */
export async function ensureUv(onProgress?: KernelEnvProgress): Promise<void> {
  if (process.env.VSURF_KERNEL_PYTHON) return // user-supplied kernel env, no uv needed
  if (existsSync(UV_PATH)) {
    process.env.VSURF_INSTALL_UV = process.env.VSURF_INSTALL_UV || '1'
    return
  }
  onProgress?.('正在安装 uv（Python 环境管理工具，一次性）…')
  const py = await findSystemPython()
  if (py) {
    try {
      await runChecked(py, ['-m', 'pip', 'install', '--user', 'uv'])
      // The wheel drops the real binary in the user Scripts dir; mirror it to
      // ~/.local/bin where vsurf's bootstrap looks for it.
      const scheme = process.platform === 'win32' ? 'nt_user' : 'posix_user'
      const scripts = await runCapture(py, [
        '-c',
        `import sysconfig; print(sysconfig.get_path('scripts', '${scheme}'))`,
      ])
      const installed = join(scripts, UV_EXE)
      if (existsSync(installed)) {
        mkdirSync(UV_DIR, { recursive: true })
        copyFileSync(installed, UV_PATH)
        try {
          chmodSync(UV_PATH, 0o755)
        } catch {
          // Windows: chmod is a no-op
        }
      }
      if (existsSync(UV_PATH)) {
        process.env.VSURF_INSTALL_UV = '1'
        return
      }
    } catch {
      // pip path failed — try the official installer next
    }
  }
  if (process.platform === 'win32') {
    try {
      await runChecked('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'irm https://astral.sh/uv/install.ps1 | iex',
      ])
      if (existsSync(UV_PATH)) {
        process.env.VSURF_INSTALL_UV = '1'
        return
      }
    } catch {
      // uv install failed; vsurf's own error message will surface the requirement
    }
  }
  process.env.VSURF_INSTALL_UV = '1'
}

/** Detected vsurf python skills (e.g. byeppt-pptx-py) from the skills dir. */
async function detectPythonSkills(): Promise<PythonSkillRuntimeInfo[]> {
  const skillsDir = resolveSkillsDir()
  if (!skillsDir) return []
  const sdk = await import('@warmshao/vsurf')
  const { skills } = sdk.loadSkillsFromDir({ dir: skillsDir, source: 'project' })
  return sdk.getPythonSkillRuntimeInfo(skills)
}

/** Fingerprint of every bundled Python skill's pyproject.toml (name + full
 * bytes), plus the skills dir itself: skills are pip-installed editable, so
 * the venv bakes in absolute source paths — the same content at a different
 * location (dev repo vs packaged resources/skills) needs a venv rebuild. */
function pythonSkillsFingerprint(skillsDir: string | null): string {
  if (!skillsDir) return ''
  const hash = createHash('sha256')
  hash.update(skillsDir)
  hash.update('\0')
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pyproject = join(skillsDir, entry.name, 'pyproject.toml')
    if (!existsSync(pyproject)) continue
    hash.update(entry.name)
    hash.update('\0')
    hash.update(readFileSync(pyproject))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Marker proving which skill dependency set the kernel venv was built with. */
function kernelSkillsMarkerPath(): string {
  return join(agentDir(), 'kernel-python-skills.json')
}

function kernelSkillsMarkerMatches(fingerprint: string): boolean {
  try {
    return JSON.parse(readFileSync(kernelSkillsMarkerPath(), 'utf8'))?.fingerprint === fingerprint
  } catch {
    return false
  }
}

/**
 * Provision the kernel venv with the bundled python skills (installs the
 * packages and their pyproject dependencies via vsurf's uv bootstrap). Uses a
 * throwaway kernel so the venv is ready before the model's first ipython call;
 * the kernel process is disposed afterwards. Skipped once the deps import.
 */
export async function provisionKernelSkills(
  onProgress?: KernelEnvProgress,
): Promise<{ ok: boolean; error?: string }> {
  // Direct callers (image generation tests, package updates) must land in the
  // same isolated packaged venv as prepareKernelEnvironment.
  if (!process.env.VSURF_KERNEL_PYTHON) ensureVsurfPackageDirEnv()
  const pythonSkills = await detectPythonSkills()
  if (pythonSkills.length === 0) return { ok: true }
  // Skip only when the dependency fingerprint matches AND the packages import:
  // adding pyproject deps later must trigger a reinstall on upgraded machines.
  const fingerprint = pythonSkillsFingerprint(resolveSkillsDir())
  if (
    kernelSkillsMarkerMatches(fingerprint) &&
    (await pythonCanImport(resolveKernelPython(), ['byeppt_pptx_py', 'pptx']))
  ) {
    return { ok: true }
  }
  const sdk = await import('@warmshao/vsurf')
  const provisioner = new sdk.IpythonKernelProvisioner(agentDir(), {
    pythonSkills,
  })
  try {
    // no path-specific message here — the caller (offline assembly vs online
    // bootstrap) announces what is actually happening
    await provisioner.ensure(onProgress)
    mkdirSync(agentDir(), { recursive: true })
    writeFileSync(
      kernelSkillsMarkerPath(),
      JSON.stringify({ fingerprint, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await provisioner.dispose().catch(() => {})
  }
}

/**
 * Full one-time kernel env setup. Packaged builds use ONLY the bundled
 * offline runtime (zero network, no fallback — a broken bundle must surface
 * as an error); dev checkouts without a fetched runtime use the online
 * bootstrap with the proxy/mirror network policy applied. Never throws;
 * failures are returned so the caller can surface them without breaking
 * session startup.
 */
export async function prepareKernelEnvironment(
  onProgress?: KernelEnvProgress,
): Promise<{ ok: boolean; error?: string }> {
  // Only surface meaningful steps; hide kernel-start / connection noise.
  const progress: KernelEnvProgress = onProgress
    ? (raw) => {
        const msg = userProgressMessage(raw)
        if (msg) onProgress(msg)
      }
    : () => {}
  // A user-supplied kernel python (VSURF_KERNEL_PYTHON) needs no provisioning.
  if (process.env.VSURF_KERNEL_PYTHON) return { ok: true }
  ensureVsurfPackageDirEnv()
  const runtimeDir = resolveKernelRuntimeDir()
  if (runtimeDir) {
    const r = await provisionOfflineRuntime(runtimeDir, progress)
    if (!r.ok) {
      console.error('[kernel-env] bundled runtime provisioning failed:', r.error)
      progress('内置 Python 环境组装失败,请重新安装应用')
    }
    return r
  }
  // Dev checkout without a fetched runtime: online bootstrap under the
  // unified network policy (proxy when configured, China mirrors otherwise).
  progress('正在准备 Python 运行环境（首次需下载 Python 与依赖，可能需要几分钟）…')
  const restore = patchEnv(await spawnNetworkEnv())
  const out: { ok: boolean; error?: string } = { ok: true }
  try {
    await ensureUv(progress)
    const r = await provisionKernelSkills(progress)
    if (!r.ok) {
      out.ok = false
      out.error = r.error
    }
  } catch (err) {
    out.ok = false
    out.error = err instanceof Error ? err.message : String(err)
  } finally {
    restore()
  }
  return out
}
