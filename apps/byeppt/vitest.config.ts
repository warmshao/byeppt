import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Pin resolution to this repo's workspace sources (matches tsconfig paths)
  resolve: {
    alias: {
      // Subpath before the bare name: string aliases are prefix replacements
      '@byeppt/pptx-engine/table-grid': resolve(
        here,
        '../../packages/pptx-engine/src/table-grid.ts',
      ),
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
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
