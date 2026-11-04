// SPDX-License-Identifier: GPL-3.0-or-later
// End to end (BURN-31): picking a catalog machine changes the planner's timing
// and the sim's spot and power.
//
// The chain is split across the two languages the app runs: this test picks
// the machines through the same session code the settings screen calls, checks
// the profiles it builds against fixtures/picked-machines.json, and runs the
// core's CPU sim with them; `picked_machines_change_planner_timing` in
// src-tauri/src/job.rs plans real G-code with the GRBL planner for each
// profile in that file. The file is written here, so the two can't drift: a
// change to the catalog or the picker fails this test until the file is
// regenerated (`pnpm vitest run -u`), and the Rust test then runs on the new
// profiles.

import { describe, expect, it } from 'vitest'
import { CONTRACT_VERSION, decodeSampleBatch, gridPitchMm, kernelSigma, type JobModel, type MachineProfile, type Move } from 'aria-burn-core/contract'
import { SampleStore, interimSampler, setupJob, simulateCpu } from 'aria-burn-core'
import { emulatorSettings } from './emulator.ts'
import * as session from './machine-session.ts'
import { emptyLibrary, type MachineLibrary } from './machines.ts'
import { findMaterial } from './materials.ts'
import { defaultSettings, useBackend } from './settings.ts'

const wood = findMaterial('birch-ply-provisional')

/** A 2 mm square outline at constant S, like the G-code the Rust test plans. */
function squareJob(): JobModel {
  const pts: [number, number][] = [
    [3, 1],
    [3, 3],
    [1, 3],
    [1, 1],
  ]
  const moves: Move[] = [{ kind: 'g0', xMm: 1, yMm: 1, feedMmPerMin: 1200, s: 0, laser: 'off', line: 1 }]
  pts.forEach(([x, y], i) => moves.push({ kind: 'g1', xMm: x, yMm: y, feedMmPerMin: 1200, s: 600, laser: 'm4', line: i + 2 }))
  return {
    contractVersion: CONTRACT_VERSION,
    source: { kind: 'file', name: 'square', lineCount: moves.length },
    startMm: { xMm: 0, yMm: 0 },
    moves,
    passes: [{ index: 0, firstMove: 0, moveCount: moves.length }],
    bounds: { minXMm: 0, minYMm: 0, maxXMm: 3, maxYMm: 3 },
    burnBounds: { minXMm: 1, minYMm: 1, maxXMm: 3, maxYMm: 3 },
    diagnostics: [],
  }
}

function simulate(machine: MachineProfile) {
  const job = squareJob()
  const plan = interimSampler.plan(job, machine, 1)
  const store = new SampleStore(1)
  for (const b of plan.batches) store.append(decodeSampleBatch(b))
  const setup = setupJob(job.burnBounds!, machine, wood)
  return { setup, run: simulateCpu(store, setup) }
}

async function pick(frameId: string | null, moduleId?: string): Promise<MachineProfile> {
  const store = new Map<string, unknown>()
  useBackend({ read: async (k) => store.get(k), write: async (k, v) => void store.set(k, v) })
  const sent: MachineProfile[] = []
  const host = {
    settings: defaultSettings(),
    library: emptyLibrary() as MachineLibrary,
    warnings: [] as string[],
    async applyEmulator() {
      sent.push(emulatorSettings(this.settings.network, this.settings.machine).profile)
    },
  }
  await session.loadMachines(host)
  if (frameId) await session.pickCatalog(host, frameId, moduleId!)
  useBackend(null)
  // What the emulator and the file planner get is the live profile.
  if (frameId) expect(sent.at(-1)).toEqual(host.settings.machine)
  return structuredClone(host.settings.machine)
}

describe('picking a catalog machine (end to end)', () => {
  it('changes the spot, the power and the profile the planner runs', async () => {
    const before = await pick(null)
    const after = await pick('creality-falcon2', 'creality-falcon2-40w')

    // The profiles the Rust planner test runs.
    await expect(JSON.stringify({ default: before, falcon2: after }, null, 2) + '\n').toMatchFileSnapshot('./fixtures/picked-machines.json')
    // Every catalog frame has $120 = 1000 mm/s² (provisional), so the timing difference comes from $110/$111.
    expect(after.maxRateMmPerMin.x).toBeGreaterThan(before.maxRateMmPerMin.x)

    const a = simulate(before)
    const b = simulate(after)

    // Spot: the deposit kernel and the detail pitch follow the module's spot.
    expect(b.setup.kernel).toEqual(kernelSigma(after.spot, wood.sigmaHeatMm))
    expect(b.setup.kernel).not.toEqual(a.setup.kernel)
    expect(b.setup.detailPitchMm).toBeCloseTo(gridPitchMm(after.spot), 12)
    expect(b.setup.detailPitchMm).not.toBeCloseTo(a.setup.detailPitchMm, 6)

    // Power: the same job at the same S deposits about 40 W / 10 W as much energy (the curves differ a little).
    const ratio = b.run.energy.expectedJ / a.run.energy.expectedJ
    expect(ratio).toBeGreaterThan(2.5)
    expect(ratio).toBeLessThan(6)
    expect(Math.abs(b.run.energy.depositJ - b.run.energy.expectedJ) / b.run.energy.expectedJ).toBeLessThan(0.01)
  })
})
