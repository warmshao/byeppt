import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const here = dirname(fileURLToPath(import.meta.url))

// Pin resolution to this repo's workspace sources (matches tsconfig paths;
// avoids bundling stale implementations when node_modules links point elsewhere)
const workspaceAlias = {
  // Subpath before the bare name: string aliases are prefix replacements
  '@byeppt/pptx-engine/table-grid': resolve(here, '../../packages/pptx-engine/src/table-grid.ts'),
  '@byeppt/pptx-engine/background-promote': resolve(
    here,
    '../../packages/pptx-engine/src/background-promote.ts',
  ),
  '@byeppt/pptx-engine': resolve(here, '../../packages/pptx-engine/src/index.ts'),
  '@byeppt/pptx-render/preset-geometry': resolve(
    here,
    '../../packages/pptx-render/src/preset-geometry.ts',
  ),
  '@byeppt/pptx-render': resolve(here, '../../packages/pptx-render/src/index.ts'),
}

export default defineConfig(
  // BYEPPT_PRELOAD_ONLY=1: dev-mode watch build for the shell flow. The shell
  // bundles byeppt's main sources directly and the renderer comes from the
  // dev server, so the ONLY stale-prone artifact is out/preload/index.js
  // (loaded by file path when a slides tab is created). Rebuilding just the
  // preload is near-instant, so it can watch continuously.
  process.env.BYEPPT_PRELOAD_ONLY === '1'
    ? {
        preload: {
          plugins: [externalizeDepsPlugin()],
        },
      }
    : {
        // Main process/preload must bundle @byeppt/* sources (they are pulled in as TS
        // source with extensionless relative imports; externalizing them under Node
        // yields ERR_MODULE_NOT_FOUND).
        main: {
          resolve: { alias: workspaceAlias },
          // Bundle opentype.js too (the packaged app ships only out/**, so external deps are unresolvable at runtime)
          plugins: [
            externalizeDepsPlugin({
              exclude: [
                '@byeppt/pptx-engine',
                '@byeppt/pptx-render',
                '@byeppt/file-parse',
                '@byeppt/electron-utils',
                'opentype.js',
              ],
            }),
          ],
        },
        preload: {
          plugins: [externalizeDepsPlugin()],
        },
        renderer: {
          resolve: { alias: workspaceAlias },
          plugins: [react()],
          server: {
            port: Number(process.env.SLIDES_DEV_PORT) || 5175,
            strictPort: Boolean(process.env.SLIDES_DEV_PORT),
          },
        },
      },
)
