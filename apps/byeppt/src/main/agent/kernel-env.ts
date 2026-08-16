/**
 * One-time kernel environment bootstrap for the vsurf IPython kernel.
 *
 * 1. `ensureUv` — make sure the `uv` binary exists so vsurf can build its
 *    kernel venv. vsurf refuses to bootstrap on Windows when uv is missing
 *    (its auto-installer is a POSIX `sh` script and the non-TTY default
 *    throws). We try existing uv, then `pip install --user uv` (no bundled
 *    binary in the repo), then the official Windows installer.
 * 2. `provisionKernelSkills` — install `byeppt-pptx-py` (and its pyproject
 *    dependencies: python-pptx, skia-pathops, uharfbuzz, google-genai, ...)
 *    into the kernel venv by bootstrapping it with the detected python skills.
 *    Runs once per machine (skipped when the deps are already importable).
 *
 * Progress is surfaced through the caller's `onProgress` callback; session.ts
 * forwards it to the renderer as `agent:event` with `byeppt:kernel-*` types.
 */
import { app } from 'electron'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { PythonSkillRuntimeInfo } from '@warmshao/vsurf'

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
  if (KERNEL_NOISE.some((re) => re.test(raw))) return null
  if (/installing uv/i.test(raw)) return '正在安装 Python 工具（uv，一次性）…'
  if (/setting up python kernel/i.test(raw)) return '正在准备 Python 运行环境（首次需联网，约 30 秒）…'
  if (/rebuilding kernel venv/i.test(raw)) return '正在重建 Python 运行环境…'
  if (/^\s*\u2713\s*ready/i.test(raw)) return 'Python 运行环境就绪 ✓'
  return raw
}

const UV_DIR = join(homedir(), '.local', 'bin')
const UV_EXE = process.platform === 'win32' ? 'uv.exe' : 'uv'
const UV_PATH = join(UV_DIR, UV_EXE)

/** <userData>/agent — kernel cwd + config dir. */
function agentDir(): string {
  return join(app.getPath('userData'), 'agent')
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

/** Kernel venv python (mirrors vsurf's getKernelVenvDir/getVenvPythonPath, honoring overrides). */
export function resolveKernelPython(): string {
  if (process.env.VSURF_KERNEL_PYTHON) return resolve(expandHome(process.env.VSURF_KERNEL_PYTHON))
  const venv = process.env.VSURF_KERNEL_VENV
    ? resolve(expandHome(process.env.VSURF_KERNEL_VENV))
    : join(homedir(), '.vsurf', 'agent', 'kernel-venv')
  return process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
}

function runChecked(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`)),
    )
  })
}

/** Run a command and capture its stdout (trimmed). */
function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolvePromise(out.trim()) : reject(new Error(`${cmd} exited ${code}`)),
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

/**
 * Provision the kernel venv with the bundled python skills (installs the
 * packages and their pyproject dependencies via vsurf's uv bootstrap). Uses a
 * throwaway kernel so the venv is ready before the model's first ipython call;
 * the kernel process is disposed afterwards. Skipped once the deps import.
 */
export async function provisionKernelSkills(
  onProgress?: KernelEnvProgress,
): Promise<{ ok: boolean; error?: string }> {
  const pythonSkills = await detectPythonSkills()
  if (pythonSkills.length === 0) return { ok: true }
  // One-time per machine: skip when the skills + key dep are already installed.
  if (await pythonCanImport(resolveKernelPython(), ['byeppt_pptx_py', 'pptx'])) {
    return { ok: true }
  }
  const sdk = await import('@warmshao/vsurf')
  const provisioner = new sdk.IpythonKernelProvisioner(agentDir(), {
    pythonSkills,
  })
  try {
    onProgress?.('正在准备 Python 运行环境（首次需下载 Python 与依赖，请稍候）…')
    await provisioner.ensure(onProgress)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await provisioner.dispose().catch(() => {})
  }
}

/**
 * Full one-time kernel env setup: uv + python skills. Never throws; failures are
 * returned so the caller can surface them without breaking session startup.
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
  }
  return out
}
