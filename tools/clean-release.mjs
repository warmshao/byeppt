#!/usr/bin/env node
/**
 * Remove electron-builder output before a local distribution build.
 *
 * The release directory contains large DMG/NSIS/AppImage artifacts and an
 * unpacked macOS app. Stale output from a previous build can make a new build
 * fail or leave mixed-version artifacts behind, so distribution scripts clean
 * it explicitly. The path is hard-coded to apps/shell/release to keep this
 * safe; it never accepts an arbitrary directory from the command line.
 */
import { lstatSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dryRun = process.argv.includes('--dry-run')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'apps', 'shell', 'release')

if (resolve(releaseDir) !== join(root, 'apps', 'shell', 'release')) {
  throw new Error(`refusing unsafe release path: ${releaseDir}`)
}

let stat
try {
  stat = lstatSync(releaseDir)
} catch (err) {
  if (err?.code === 'ENOENT') {
    console.log('[clean-release] no previous release output')
    process.exit(0)
  }
  throw err
}

console.log(`${dryRun ? '[clean-release] would remove' : '[clean-release] removing'} ${releaseDir}`)
if (!dryRun) rmSync(releaseDir, { recursive: true, force: true })
