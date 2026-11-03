// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { Verdict } from 'aria-burn-core'
import { MATERIALS } from './materials.ts'
import { fmtDuration, legendFor, scaleBar, verdictLabel } from './verdicts.ts'

describe('verdict labels and legend', () => {
  it('drops fire risk for materials without a fire-risk rule', () => {
    const aluminium = MATERIALS.find((m) => m.response.kind === 'bleach')!
    const birch = MATERIALS.find((m) => m.response.kind === 'char')!
    expect(legendFor(aluminium)).not.toContain(Verdict.FireRisk)
    expect(legendFor(birch)).toContain(Verdict.FireRisk)
    expect(verdictLabel(Verdict.Over, birch)).toBe('Over-burned / charred')
  })
})

describe('scale bar', () => {
  it('picks a 1-2-5 length 60–150 px long', () => {
    for (const mmPerPx of [0.0007, 0.003, 0.02, 0.13, 0.9]) {
      const s = scaleBar(mmPerPx)
      expect(s.px).toBeGreaterThanOrEqual(60)
      expect(s.px).toBeLessThanOrEqual(150)
      expect(Number(s.mm.toPrecision(1))).toBeCloseTo(s.mm, 12)
    }
    expect(scaleBar(0.0007).label).toMatch(/µm$/)
  })

  it('formats durations', () => {
    expect(fmtDuration(42.14)).toBe('42.1s')
    expect(fmtDuration(390)).toBe('6m30s')
  })
})
