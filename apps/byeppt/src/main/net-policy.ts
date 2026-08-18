/**
 * Unified network policy for the whole suite (byeppt standalone + shell).
 *
 * Resolution order (Settings → 通用 → 网络代理 maps onto `proxy` in
 * app-settings.json):
 *   1. proxy.enabled === false        → direct, always
 *   2. proxy.enabled + proxy.url      → that URL
 *   3. proxy.enabled, no url (default)→ HTTPS_PROXY-style env vars, then the
 *                                       OS system proxy (session.resolveProxy)
 *
 * The effective proxy is applied to:
 *   - the main process's global fetch (undici dispatcher) — Node fetch does
 *     not use the system proxy by default
 *   - Chromium (session.setProxy) only for explicit choices; the default
 *     "auto" path leaves Chromium on its native system-proxy behavior
 *   - child processes we spawn (uv / pip) via spawnNetworkEnv()
 *
 * When NO proxy is in effect, spawnNetworkEnv() instead points uv at China
 * mirrors (Tsinghua PyPI + npmmirror's python-build-standalone mirror) so the
 * online kernel bootstrap fallback still works on mainland direct connections.
 * The packaged app's primary path is the bundled offline runtime
 * (agent/kernel-env.ts), which needs no network at all.
 */
import { app, session } from 'electron'
import { readAppSettings } from './app-settings'

/** China mirrors used when the kernel bootstrap runs online without a proxy. */
export const PYPI_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple'
export const PYTHON_BUILD_STANDALONE_MIRROR =
  'https://registry.npmmirror.com/-/binary/python-build-standalone'

const ENV_PROXY_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const

function envProxy(): string | null {
  for (const k of ENV_PROXY_KEYS) {
    const v = process.env[k]
    if (v) return v
  }
  return null
}

/** Redact user:pass credentials for logging. */
function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@')
}

/**
 * Read the OS system proxy (requires app ready). PAC/rule proxies answer
 * per-host, so probe a representative API host. Returns null on DIRECT.
 */
export async function detectSystemProxy(): Promise<string | null> {
  try {
    await app.whenReady()
    const resolved = await session.defaultSession.resolveProxy('https://api.openai.com/')
    // resolveProxy returns strings like "PROXY 127.0.0.1:1087" or "DIRECT"
    const m = /PROXY\s+([^;]+)/i.exec(resolved || '')
    return m ? `http://${m[1].trim()}` : null
  } catch (e) {
    console.warn('[proxy] resolveProxy failed:', e)
    return null
  }
}

export interface EffectiveProxy {
  /** proxy URL in effect, or null for direct */
  url: string | null
  /** where the decision came from (drives the settings UI hint text) */
  source: 'disabled' | 'manual' | 'env' | 'system' | 'direct'
}

/** The effective proxy per the user's setting; see file header for the order. */
export async function resolveEffectiveProxy(): Promise<EffectiveProxy> {
  const setting = readAppSettings().proxy
  if (setting?.enabled === false) return { url: null, source: 'disabled' }
  if (setting?.url) return { url: setting.url, source: 'manual' }
  const env = envProxy()
  if (env) return { url: env, source: 'env' }
  const sys = await detectSystemProxy()
  if (sys) return { url: sys, source: 'system' }
  return { url: null, source: 'direct' }
}

/**
 * Apply the effective proxy to the main process's fetch and (for explicit
 * choices) Chromium. Also mirrors the URL into HTTPS_PROXY/HTTP_PROXY so the
 * vsurf kernel's child processes inherit it. Call once at startup and again
 * whenever the proxy setting changes.
 */
export async function applyProxyToMainProcess(): Promise<EffectiveProxy> {
  const effective = await resolveEffectiveProxy()
  const { url, source } = effective
  try {
    const { Agent, ProxyAgent, setGlobalDispatcher } = await import('undici')
    if (url) {
      setGlobalDispatcher(new ProxyAgent(url))
      console.log(`[proxy] main-process fetch via ${redact(url)} (${source})`)
    } else if (source === 'disabled') {
      // reset any dispatcher set earlier this session back to plain direct
      setGlobalDispatcher(new Agent({}))
      console.log('[proxy] disabled by setting, direct connections')
    }
  } catch (e) {
    console.warn('[proxy] failed to configure fetch dispatcher:', e)
  }
  // Chromium: only override for explicit choices (manual URL or hard disable);
  // "auto" leaves Chromium on its native system-proxy handling.
  try {
    if (source === 'manual' && url) {
      await session.defaultSession.setProxy({ proxyRules: url })
    } else if (source === 'disabled') {
      await session.defaultSession.setProxy({ mode: 'direct' })
    }
  } catch (e) {
    console.warn('[proxy] setProxy failed:', e)
  }
  // Child processes (vsurf spawns uv with env: process.env): give them the
  // proxy too — but never clobber vars the user set in their own environment.
  if (url && source !== 'env') {
    process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || url
    process.env.HTTP_PROXY = process.env.HTTP_PROXY || url
  }
  return effective
}

/**
 * Environment additions for child processes we spawn ourselves (kernel-env's
 * uv/pip calls): the effective proxy when there is one, otherwise the China
 * mirrors so the online bootstrap fallback survives mainland direct networks.
 */
export async function spawnNetworkEnv(): Promise<Record<string, string>> {
  const { url } = await resolveEffectiveProxy()
  if (url) return { HTTPS_PROXY: url, HTTP_PROXY: url }
  return {
    UV_INDEX_URL: PYPI_MIRROR,
    UV_PYTHON_INSTALL_MIRROR: PYTHON_BUILD_STANDALONE_MIRROR,
    PIP_INDEX_URL: PYPI_MIRROR,
  }
}

/**
 * Connectivity probe for the settings 测试 button: fetch a representative API
 * host through the candidate proxy (or directly when url is null). Any HTTP
 * response — even 401 — means the network path works.
 */
export async function testProxyConnection(url: string | null): Promise<{ ok: boolean; error?: string }> {
  try {
    let dispatcher
    if (url) {
      const { ProxyAgent } = await import('undici')
      dispatcher = new ProxyAgent(url)
    }
    const resp = await fetch('https://api.anthropic.com/', {
      dispatcher,
      signal: AbortSignal.timeout(8000),
    } as RequestInit)
    return { ok: resp.status > 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
