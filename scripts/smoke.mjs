// SPDX-License-Identifier: GPL-3.0-or-later
// IPC throughput smoke test: launches the built app with ARIA_BURN_SMOKE set.
// The webview streams full sample batches from Rust over a Channel, checks them
// against plan.done, and reports; the app exits 0 on success.
//
//   pnpm tauri build --debug --no-bundle && pnpm smoke [batches] [--profile release]

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'debug'
const batches = args.find((a) => /^\d+$/.test(a)) ?? '256'
const exe = fileURLToPath(new URL(`../target/${profile}/aria-burn${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
const PREFIX = 'ARIA_BURN_SMOKE_RESULT '
// Must exceed the app's own watchdog (180 s) so its report wins.
const TIMEOUT_MS = 240_000

if (!existsSync(exe)) {
  console.error(`smoke: ${exe} not found. Build it first: pnpm tauri build --${profile === 'debug' ? 'debug ' : ''}--no-bundle`)
  process.exit(1)
}

const child = spawn(exe, [], { env: { ...process.env, ARIA_BURN_SMOKE: batches }, stdio: ['ignore', 'pipe', 'inherit'] })
let out = ''
child.stdout.on('data', (d) => {
  out += d
  process.stdout.write(d)
})
const timer = setTimeout(() => {
  console.error(`smoke: no exit after ${TIMEOUT_MS / 1000}s, killing the app`)
  child.kill()
}, TIMEOUT_MS)

child.on('exit', (code) => {
  clearTimeout(timer)
  const line = out.split(/\r?\n/).find((l) => l.startsWith(PREFIX))
  if (!line) {
    console.error(`smoke: FAIL, app exited with ${code} and no result line`)
    process.exit(1)
  }
  const r = JSON.parse(line.slice(PREFIX.length))
  if (r.ok) {
    console.log(
      `smoke: PASS, ${r.batches} batches / ${r.samples} samples / ${(r.bytes / 1e6).toFixed(1)} MB in ${r.seconds.toFixed(2)}s` +
        ` = ${r.mbPerS.toFixed(1)} MB/s, ${r.batchesPerS.toFixed(0)} batches/s\n  ${r.userAgent}`,
    )
  } else {
    console.error(`smoke: FAIL\n  ${(r.errors ?? [r.error]).join('\n  ')}`)
  }
  process.exit(r.ok && code === 0 ? 0 : 1)
})
