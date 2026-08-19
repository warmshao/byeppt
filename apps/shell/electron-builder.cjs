/**
 * electron-builder configuration (moved out of package.json "build").
 *
 * The shell packages only its own out/** plus the slides module build output
 * (apps/byeppt/out) as an extraResource under resources/modules/byeppt — the
 * shell main resolves it from there when packaged.
 *
 * It also ships the agent skills tree (resources/skills — the vsurf agent main
 * code is bundled into the shell and resolves skills from process.resourcesPath)
 * and the offline kernel runtime (resources/kernel-runtime —
 * uv + CPython + dependency wheels, fetched per target arch by
 * tools/fetch-kernel-runtime.mjs from beforePack).
 */

const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

// LICENSES.chromium.html only exists after the Electron binary download —
// since Electron 42 that no longer happens during `npm ci` (the postinstall
// script was replaced by the lazy `install-electron` bin), and electron-builder
// exits 0 on a missing extraResources source, so without this check the
// installer would silently ship without the Chromium license.
for (const rel of ['../../node_modules/electron/dist/LICENSES.chromium.html']) {
  if (!existsSync(join(__dirname, rel))) {
    throw new Error(
      `electron-builder extraResources source missing: ${rel} (npm hoisting changed?)`,
    )
  }
}

// The slides module tree is the electron-vite output of apps/byeppt; a missing
// one means that build did not run or failed. electron-builder only logs
// "file source doesn't exist" for an absent extraResources source and still
// exits 0, so without this the installer launches normally and is simply
// missing the editor — it surfaces only when a user opens a tab.
function assertModuleTreesPresent() {
  for (const rel of ['../byeppt/out', '../../skills/byeppt-deck/SKILL.md']) {
    if (!existsSync(join(__dirname, rel))) {
      throw new Error(
        `electron-builder extraResources source missing: ${rel} (run npm run build -w @byeppt/app first)`,
      )
    }
  }
}

// electron-builder Arch enum (from builder-util): 0=ia32, 1=x64, 2=armv7l,
// 3=arm64, 4=universal.
const ARCH_NAME = { 1: 'x64', 3: 'arm64' }

/**
 * Ensure the offline kernel runtime for the pack target exists (downloading it
 * on the build machine when missing), then verify the artifacts — electron-builder
 * only logs a missing extraResources source and still exits 0, so without this
 * the installer would silently ship without the runtime and fall back to the
 * online bootstrap on the user's machine.
 */
function ensureKernelRuntime(context) {
  const platform = context.electronPlatformName
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') return
  const arch = ARCH_NAME[context.arch]
  if (!arch) throw new Error(`unsupported pack arch enum value: ${context.arch}`)
  const key = `${platform}-${arch}`
  const dir = join(__dirname, '..', '..', 'runtime', 'kernel', key)
  const uvExe = join(dir, platform === 'win32' ? 'uv.exe' : 'uv')
  if (!existsSync(uvExe) || !existsSync(join(dir, 'python.tar.gz'))) {
    console.log(`[beforePack] fetching offline kernel runtime for ${key}…`)
    const r = spawnSync(
      process.execPath,
      [join(__dirname, '..', '..', 'tools', 'fetch-kernel-runtime.mjs'), '--platform', platform, '--arch', arch],
      { stdio: 'inherit' },
    )
    if (r.status !== 0) throw new Error(`fetch-kernel-runtime failed for ${key}`)
  }
  for (const rel of [uvExe, join(dir, 'python.tar.gz')]) {
    if (!existsSync(rel)) throw new Error(`kernel runtime artifact missing: ${rel}`)
  }
  const wheelhouse = join(dir, 'wheelhouse')
  if (!existsSync(wheelhouse) || readdirSync(wheelhouse).length === 0) {
    throw new Error(`kernel runtime wheelhouse missing or empty: ${wheelhouse}`)
  }
}

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.byeppt.app',
  productName: 'ByePPT',
  // Resolved from the installed electron package so dependency bumps can
  // never leave a stale hard-coded pin behind (packaging would silently ship
  // the old runtime).
  electronVersion: require('electron/package.json').version,
  directories: {
    output: 'release',
  },
  files: ['out/**'],
  // The kernel pip-installs the vsurf SDK's builtin python skills at runtime,
  // and pip cannot read inside an asar archive — ship the package unpacked.
  asarUnpack: ['node_modules/@warmshao/vsurf/**'],
  extraResources: [
    {
      from: '../../node_modules/electron/dist/LICENSES.chromium.html',
      to: 'LICENSES.chromium.html',
    },
    {
      from: '../byeppt/out',
      to: 'modules/byeppt',
    },
    {
      from: '../../skills',
      to: 'skills',
      // Top-level *.py only (skills/check_links.py is a maintenance tool);
      // nested skill sources must survive — the kernel installs the python
      // skill editable from this tree.
      filter: ['**/*', '!*.py'],
    },
    // ${platform}/${arch} macros resolve per pack target (darwin-x64, win32-x64,
    // … matching tools/fetch-kernel-runtime.mjs's output layout); absent on
    // linux (no bundled runtime there) where electron-builder just logs and skips.
    {
      from: '../../runtime/kernel/${platform}-${arch}',
      to: 'kernel-runtime',
    },
  ],
  fileAssociations: [
    {
      ext: 'pptx',
      name: 'PowerPoint Presentation',
      role: 'Editor',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
  ],
  npmRebuild: false,
  mac: {
    target: ['dmg'],
    category: 'public.app-category.productivity',
    // ByePPT-0.1.0-arm64.dmg / ByePPT-0.1.0-x64.dmg
    artifactName: `ByePPT-\${version}-\${arch}.\${ext}`,
    // Signing is opt-in via CI secrets: when CSC_LINK (base64 .p12) is present
    // electron-builder picks the identity up automatically; locally it stays
    // explicitly unsigned. Notarization likewise activates when the App Store
    // Connect API key env vars (APPLE_API_KEY/_ID/_ISSUER) are set.
    ...(process.env.CSC_LINK ? {} : { identity: null }),
    ...(process.env.APPLE_API_KEY ? { notarize: true } : {}),
    // the bundled kernel wheelhouse is resolved for macosx_12_0 wheels
    // (scipy has no older arm64 wheels), so don't install below 12.0
    minimumSystemVersion: '12.0',
  },
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
  },
  // ByePPT-0.1.0-setup.exe
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    artifactName: `ByePPT-\${version}-setup.\${ext}`,
  },
  linux: {
    // the bundled kernel wheelhouse is resolved for <=manylinux_2_28 wheels,
    // so the floor is glibc 2.28 (Ubuntu 20.04+, Debian 11+, Fedora 34+, RHEL 9+).
    // AppImage only — the single most distro-universal format.
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Office',
    // mac and win name the binary from productName; linux instead derives it
    // from package.json "name", and "@byeppt/shell" sanitizes to an invalid
    // value — set it explicitly.
    executableName: 'byeppt',
    syncDesktopName: true,
  },
  // ByePPT-0.1.0.AppImage
  appImage: {
    artifactName: `ByePPT-\${version}.\${ext}`,
  },
  beforePack: async (context) => {
    assertModuleTreesPresent()
    ensureKernelRuntime(context)
  },
}

module.exports = config
