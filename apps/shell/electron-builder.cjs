/**
 * electron-builder configuration (moved out of package.json "build").
 *
 * The shell packages only its own out/** plus the slides module build output
 * (apps/byeppt/out) as an extraResource under resources/modules/byeppt — the
 * shell main resolves it from there when packaged.
 */

const { existsSync } = require('node:fs')
const { join } = require('node:path')

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
  for (const rel of ['../byeppt/out']) {
    if (!existsSync(join(__dirname, rel))) {
      throw new Error(
        `electron-builder extraResources source missing: ${rel} (run npm run build -w @byeppt/app first)`,
      )
    }
  }
}

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.byeppt.app',
  productName: 'byeppt',
  // Resolved from the installed electron package so dependency bumps can
  // never leave a stale hard-coded pin behind (packaging would silently ship
  // the old runtime).
  electronVersion: require('electron/package.json').version,
  directories: {
    output: 'release',
  },
  files: ['out/**'],
  extraResources: [
    {
      from: '../../node_modules/electron/dist/LICENSES.chromium.html',
      to: 'LICENSES.chromium.html',
    },
    {
      from: '../byeppt/out',
      to: 'modules/byeppt',
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
    identity: null,
  },
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Office',
    // mac and win name the binary from productName; linux instead derives it
    // from package.json "name", and "@byeppt/shell" sanitizes to an invalid
    // value — set it explicitly.
    executableName: 'byeppt',
    syncDesktopName: true,
  },
  beforePack: async () => {
    assertModuleTreesPresent()
  },
}

module.exports = config
