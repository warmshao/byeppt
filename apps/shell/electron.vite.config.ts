import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  // Bundle everything into the shell main (same policy as apps/byeppt): the
  // imported slides main modules are TS source with no build artifacts, so
  // externalizing them would break Node ESM resolution at runtime.
  // '@warmshao/vsurf' stays external: the agent session imports it lazily.
  // In dev it resolves from the repo-root node_modules; packaged builds get it
  // via electron-builder's production-dependency collection (it is a
  // `dependencies` entry of this package — keep it there, devDeps are NOT packed).
  main: {
    build: {
      rollupOptions: {
        external: ['@warmshao/vsurf'],
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [react()],
    server: {
      port: Number(process.env.SHELL_DEV_PORT) || 5199,
      strictPort: Boolean(process.env.SHELL_DEV_PORT),
    },
  },
})
