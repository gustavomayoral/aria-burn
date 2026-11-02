// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="vitest/config" />
import { realpathSync } from 'node:fs'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// aria-burn-core is linked from the sibling checkout; let the dev server read it.
const core = realpathSync(new URL('./node_modules/aria-burn-core', import.meta.url))

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    fs: { allow: ['.', core] },
    watch: { ignored: ['**/src-tauri/**', '**/target/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    sourcemap: true,
    // three.js alone is ~530 kB; it is lazy-loaded with the Height view, and this is a local desktop app.
    chunkSizeWarningLimit: 700,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
