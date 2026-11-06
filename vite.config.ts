// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="vitest/config" />
import { readFileSync, realpathSync } from 'node:fs'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// aria-burn-core and @aria/theme (BURN-28) are linked from sibling checkouts; let the dev server read them.
const core = realpathSync(new URL('./node_modules/aria-burn-core', import.meta.url))
const theme = realpathSync(new URL('./node_modules/@aria/theme', import.meta.url))
// The theme's fonts.css imports @fontsource packages that pnpm keeps outside the theme folder.
const themeDeps = Object.keys(JSON.parse(readFileSync(`${theme}/package.json`, 'utf8')).dependencies ?? {}).map((dep) =>
  realpathSync(`${theme}/node_modules/${dep}`),
)

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    fs: { allow: ['.', core, theme, ...themeDeps] },
    watch: { ignored: ['**/src-tauri/**', '**/target/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // The SVG import worker (BURN-53) is an ES module worker.
  worker: { format: 'es' },
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
