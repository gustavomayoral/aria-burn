// SPDX-License-Identifier: GPL-3.0-or-later
// Photo fit in the app (BURN-15): calibrated materials survive a restart and
// join the material list, invalid stored ones are dropped, and the review's
// helpers behave. The fit itself is tested in aria-burn-core (round trips on
// synthetic photos).

import { checkMaterialProfile, validate, MaterialProfile } from 'aria-burn-core/contract'
import { afterEach, describe, expect, it } from 'vitest'
import { allMaterials, findMaterial, MATERIALS } from './materials.ts'
import { fieldRows, marksLighter, photoFit, syntheticTruth } from './photo-fit.svelte.ts'
import { loadUserMaterials, saveUserMaterials, useBackend, type Backend } from './settings.ts'
import { addUserMaterial, emptyUserMaterials, materialId, readUserMaterials, type UserMaterial } from './user-materials.ts'

function storeFile() {
  const data = new Map<string, string>()
  return {
    boot(): Backend {
      return {
        read: async (k) => (data.has(k) ? JSON.parse(data.get(k)!) : undefined),
        write: async (k, v) => void data.set(k, JSON.stringify(v)),
      }
    },
  }
}

const birch = findMaterial('birch-ply-provisional')

function calibrated(name: string): UserMaterial {
  const profile = { ...structuredClone(birch), id: materialId(name, allMaterials().map((m) => m.id)), name, provenance: { source: 'calibrated' as const, fittedAt: '2026-11-06T00:00:00.000Z', meanDeltaE: 0.4 } }
  return { profile, calibrationId: `cal-2026-11-06-${profile.id}`, machine: { name: 'Generic 10 W diode' }, fromId: birch.id, createdAt: '2026-11-06T00:00:00.000Z' }
}

afterEach(() => {
  useBackend(null)
  photoFit.library = emptyUserMaterials()
})

describe('calibrated materials', () => {
  it('are saved, survive a restart and join the material list', async () => {
    const file = storeFile()
    useBackend(file.boot())
    const m = calibrated('Birch ply — Home Depot batch, Nov 2026')
    expect(m.profile.id).toBe('birch-ply-home-depot-batch-nov-2026-calibrated')
    await saveUserMaterials(addUserMaterial(emptyUserMaterials(), m))
    useBackend(file.boot())
    await photoFit.load()
    expect(photoFit.library.materials).toHaveLength(1)
    expect(findMaterial(m.profile.id).name).toBe(m.profile.name)
    expect(allMaterials().map((x) => x.id)).toEqual([...MATERIALS.map((x) => x.id), m.profile.id])
    const loaded = await loadUserMaterials()
    expect(loaded.warnings).toEqual([])
  })

  it('drop invalid stored entries with a warning', () => {
    const good = calibrated('Good')
    const bad = calibrated('Bad')
    ;(bad.profile.response as { toneStartJPerMm2: number }).toneStartJPerMm2 = 5 // after toneEnd
    const { library, warnings } = readUserMaterials({ version: 1, materials: [good, bad, { nope: 1 }] })
    expect(library.materials.map((m) => m.profile.name)).toEqual(['Good'])
    expect(warnings).toHaveLength(2)
  })

  it('get unique ids', () => {
    expect(materialId('Birch', ['birch-calibrated'])).toBe('birch-calibrated-2')
    expect(materialId('  ', [])).toBe('calibrated-calibrated')
  })
})

describe('review helpers', () => {
  it('synthetic truths are valid profiles that differ from the start', () => {
    for (const m of MATERIALS) {
      const t = syntheticTruth(m)
      expect(validate(MaterialProfile, t)).toEqual([])
      expect(checkMaterialProfile(t)).toEqual([])
      expect(JSON.stringify(t.response)).not.toEqual(JSON.stringify(m.response))
    }
  })

  it('knows which way marks go', () => {
    expect(MATERIALS.map(marksLighter)).toEqual([false, true, true])
  })

  it('lists every fitted field, with the truth when there is one', () => {
    const t = syntheticTruth(birch)
    const rows = fieldRows(birch, t, t)
    expect(rows.map((r) => r.label)).toEqual(
      expect.arrayContaining(['Base color', 'Char color', 'Tone start', 'Tone end', 'Tone gamma', 'Ablation threshold', 'Depth', 'Ramp onset (thermal)', 'Fire risk (bulk)']),
    )
    expect(rows.every((r) => r.truth !== null)).toBe(true)
  })
})
