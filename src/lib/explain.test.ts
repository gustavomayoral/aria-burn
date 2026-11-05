// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CellReader, SampleStore, Verdict, decodeSampleBatch, explainAt, interimSampler, loadMachineProfile, loadMaterialProfile, setupJob } from 'aria-burn-core'
import { CONTRACT_VERSION, type JobModel, type Move } from 'aria-burn-core/contract'
import { describe, expect, it } from 'vitest'
import { describeCause, describeMode, describeReason, fmtJ } from './explain.ts'

const core = (rel: string) => readFileSync(fileURLToPath(new URL(`../../node_modules/aria-burn-core/src/profiles/provisional/${rel}`, import.meta.url)), 'utf8')
const machine = loadMachineProfile(core('machine-10w-diode.json'))
const wood = loadMaterialProfile(core('birch-ply.json'))
const woodFluence = { ...wood, thermal: { kind: 'none' as const }, fireRisk: { kind: 'none' as const } }

// A 2 mm M3 square: in range along the edges, over-burned at the corners.
function square(): JobModel {
  const at = (x: number, y: number, line: number): Move => ({ kind: 'g1', xMm: x, yMm: y, feedMmPerMin: 3000, s: 400, laser: 'm3', line })
  const moves: Move[] = [{ kind: 'g0', xMm: 1, yMm: 1, feedMmPerMin: 3000, s: 0, laser: 'off', line: 1 }, at(3, 1, 2), at(3, 3, 3), at(1, 3, 4), at(1, 1, 5)]
  const b = { minXMm: 1, minYMm: 1, maxXMm: 3, maxYMm: 3 }
  return { contractVersion: CONTRACT_VERSION, source: { kind: 'file', name: 'square', lineCount: 5 }, startMm: { xMm: 0, yMm: 0 }, moves, passes: [{ index: 0, firstMove: 0, moveCount: 5 }], bounds: b, burnBounds: b, diagnostics: [] }
}

describe('explanation text', () => {
  const job = square()
  const store = new SampleStore(1)
  for (const b of interimSampler.plan(job, machine, 1).batches) store.append(decodeSampleBatch(b))
  const reader = new CellReader(store, setupJob(job.burnBounds!, machine, woodFluence))

  it('names the threshold and the corner slowdown', () => {
    const e = explainAt(reader, store, 3, 1, Infinity, job)!
    expect(e.readout.verdict).toBe(Verdict.Over)
    expect(describeReason(e.reason, woodFluence)).toMatch(/^Fluence .* is past the full-char threshold of 1\.80 J\/mm²\.$/)
    const t = describeCause(e.causes[0]!, e, woodFluence)
    expect(t.title).toBe('Head slowed down')
    expect(t.body).toMatch(/^Lines [23] and [23] ran at \d+% of the commanded speed/)
    expect(describeMode(e.moves[0]!)).toBe('M3 · S 400 (40%)')
  })

  it('an edge cell is inside the mark window', () => {
    const e = explainAt(reader, store, 2, 1, Infinity, job)!
    expect(describeReason(e.reason, woodFluence)).toContain('inside the mark window, 0.140–1.80 J/mm²')
    expect(e.causes).toEqual([])
  })

  it('formats fluence', () => {
    expect(fmtJ(0.1234)).toBe('0.123 J/mm²')
    expect(fmtJ(2.5)).toBe('2.50 J/mm²')
    expect(fmtJ(12.34)).toBe('12.3 J/mm²')
  })
})
