// SPDX-License-Identifier: GPL-3.0-or-later
// Calibration patterns (BURN-32) for every catalog frame + module and every
// provisional material, written out for the Rust side: the G-code the app would
// save, the machine profile the picker builds, and what the core's job-model
// twin says the parser should make of it. `calibration_patterns_parse_and_plan_clean`
// in src-tauri/src/job.rs parses and plans each file with the real parser and
// GRBL planner and checks there are no diagnostics, the moves match, and every
// planned sample stays on the bed.
//
// The files are generated (~25 MB), so they go to target/ (gitignored), not
// fixtures/; `pnpm check` runs vitest before cargo test.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PATTERN_KINDS, generatePattern } from 'aria-burn-core/calibration'
import { beamOn, combineMachine } from 'aria-burn-core/contract'
import { CATALOG_FRAMES, modulesForFrame } from 'aria-burn-core/profiles/catalog/index.ts'
import { describe, expect, it } from 'vitest'
import { MATERIALS } from './materials.ts'
import { patternFileName } from './calibration.svelte.ts'

const OUT = fileURLToPath(new URL('../../target/calibration-patterns/', import.meta.url))

describe('calibration patterns for the Rust parser and planner check', () => {
  it('writes every catalog machine × material × pattern', () => {
    rmSync(OUT, { recursive: true, force: true })
    mkdirSync(OUT, { recursive: true })
    const profiles: Record<string, unknown> = {}
    const jobs: unknown[] = []
    for (const frame of CATALOG_FRAMES)
      for (const module of modulesForFrame(frame)) {
        const id = `${frame.id}+${module.id}`
        const machine = combineMachine(frame, module)
        profiles[id] = machine
        for (const material of MATERIALS)
          for (const kind of PATTERN_KINDS) {
            const p = generatePattern(kind, machine, material)
            const file = `${id}.${patternFileName(p)}`
            writeFileSync(OUT + file, p.gcode)
            let beamOnMm = 0
            let x = 0
            let y = 0
            for (const m of p.job.moves) {
              if (beamOn(m)) beamOnMm += Math.hypot(m.xMm - x, m.yMm - y)
              x = m.xMm
              y = m.yMm
            }
            jobs.push({ file, machine: id, bedMm: p.machine.bedMm, moveCount: p.job.moves.length, burnBounds: p.job.burnBounds, beamOnMm })
          }
      }
    writeFileSync(OUT + 'index.json', JSON.stringify({ profiles, jobs }))
    expect(jobs.length).toBe(Object.keys(profiles).length * MATERIALS.length * PATTERN_KINDS.length)
    expect(Object.keys(profiles).length).toBe(CATALOG_FRAMES.reduce((n, f) => n + f.modules.length, 0))
  }, 120_000)
})
