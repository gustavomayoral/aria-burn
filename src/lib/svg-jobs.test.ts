// SPDX-License-Identifier: GPL-3.0-or-later
// SVG import jobs (BURN-51) for the Rust parser and planner check: every SVG
// fixture of aria-burn-core, at a few placements and layer setups, on one
// module of every catalog frame. Each entry is the G-code the core writes and
// the JobModel it says the parser makes of it. `svg_jobs_parse_into_the_core_job_model`
// in src-tauri/src/job.rs parses each file with the real parser and checks the
// moves, passes and diagnostics match exactly and every planned sample stays
// on the bed.
//
// The files are generated, so they go to target/ (gitignored); `pnpm check`
// runs vitest before cargo test.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { combineMachine } from 'aria-burn-core/contract'
import { CATALOG_FRAMES, modulesForFrame } from 'aria-burn-core/profiles/catalog/index.ts'
import { usableBedMm } from 'aria-burn-core/calibration'
import { readSvg, svgJob, svgJobLayers, type Placement, type SvgDocument, type SvgJobLayer } from 'aria-burn-core/svg'
import { describe, expect, it } from 'vitest'

const OUT = fileURLToPath(new URL('../../target/svg-jobs/', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./', import.meta.resolve('aria-burn-core/svg/fixtures/holes.svg')))

/** Placements that keep the design on the bed: true size when it fits, else scaled down; and turned about the bed centre. */
function placements(doc: SvgDocument, bed: { x: number; y: number }): [string, Placement][] {
  const fit = Math.min(1, (0.9 * bed.x) / doc.widthMm, (0.9 * bed.y) / doc.heightMm)
  const diag = Math.hypot(doc.widthMm, doc.heightMm)
  const turnFit = Math.min(1.5, (0.9 * Math.min(bed.x, bed.y)) / diag)
  return [
    ['placed', { xMm: 5, yMm: 5, anchor: 'bottom-left', scale: fit, rotationDeg: 0 }],
    ['turned', { xMm: bed.x / 2, yMm: bed.y / 2, anchor: 'center', scale: turnFit, rotationDeg: 30 }],
  ]
}

/**
 * Every layer in line mode; `passes` also gives the first layer two passes and
 * turns the last one's output off. `fill` and `hatch` put every layer in fill
 * mode: back-and-forth at 0°, and one direction at 30° with crosshatch.
 */
function layerSetups(doc: SvgDocument): [string, SvgJobLayer[]][] {
  const line = svgJobLayers(doc).map((l) => ({ id: l.id, settings: { ...l.settings, mode: 'line' as const } }))
  const passes = line.map((l, i) => ({
    id: l.id,
    settings: { ...l.settings, passes: i === 0 ? 2 : 1, output: line.length < 2 || i < line.length - 1, maxPowerPct: 20 + 10 * (i % 5), speedMmPerMin: 900 + 300 * i },
  }))
  // Fill (BURN-52) at coarse intervals: the check is exact per move, so density adds files, not coverage.
  const fill = line.map((l) => ({ id: l.id, settings: { ...l.settings, mode: 'fill' as const, fill: { ...l.settings.fill, intervalMm: 0.5, overscanMm: 2 } } }))
  const hatch = line.map((l) => ({
    id: l.id,
    settings: { ...l.settings, mode: 'fill' as const, fill: { intervalMm: 1, angleDeg: 30, bidirectional: false, overscanMm: 1, crosshatch: true } },
  }))
  return [
    ['line', line],
    ['passes', passes],
    ['fill', fill],
    ['hatch', hatch],
  ]
}

describe('SVG import jobs for the Rust parser and planner check', () => {
  it('writes every fixture × catalog frame × placement × layer setup', () => {
    rmSync(OUT, { recursive: true, force: true })
    mkdirSync(OUT, { recursive: true })
    const docs = readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.svg'))
      .sort()
      .map((f) => [f.replace(/\.svg$/, ''), readSvg(readFileSync(FIXTURES + f, 'utf8'))] as const)
    expect(docs.length).toBeGreaterThanOrEqual(10)
    const profiles: Record<string, unknown> = {}
    const jobs: unknown[] = []
    for (const frame of CATALOG_FRAMES) {
      const module = modulesForFrame(frame)[0]!
      const id = `${frame.id}+${module.id}`
      const machine = combineMachine(frame, module)
      profiles[id] = machine
      const bed = usableBedMm(machine)
      for (const [name, doc] of docs)
        for (const [pName, placement] of placements(doc, bed))
          for (const [lName, layers] of layerSetups(doc)) {
            const r = svgJob(doc, layers, placement, machine)
            if (!r.job.burnBounds) continue
            expect(r.diagnostics.filter((d) => d.code === 'off-bed' || d.code === 'overscan-off-bed')).toEqual([])
            const file = `${id}.${name}.${pName}.${lName}.gcode`
            writeFileSync(OUT + file, r.gcode)
            writeFileSync(OUT + file.replace(/\.gcode$/, '.job.json'), JSON.stringify(r.job))
            jobs.push({ file, job: file.replace(/\.gcode$/, '.job.json'), machine: id, bedMm: r.bedMm })
          }
    }
    writeFileSync(OUT + 'index.json', JSON.stringify({ profiles, jobs }))
    expect(jobs.length).toBeGreaterThan(CATALOG_FRAMES.length * 30)
  }, 120_000)
})
