// SPDX-License-Identifier: GPL-3.0-or-later
// Verdict buckets as the UI names and draws them (colours from the core's
// burn view, so the legend matches the overlay).

import { FIRE_DARK_RGB, VERDICT_RGB, Verdict } from 'aria-burn-core'
import type { MaterialProfile } from 'aria-burn-core/contract'

const rgb = (c: readonly number[]) => `rgb(${c.join(' ')})`

export function verdictLabel(v: number, material: MaterialProfile | null): string {
  switch (v) {
    case Verdict.Under:
      return 'Under-burned'
    case Verdict.InRange:
      return 'In range'
    case Verdict.Over:
      return material?.response.kind === 'melt' ? 'Over (material removed)' : material?.response.kind === 'bleach' ? 'Over (coating damaged)' : 'Over-burned / charred'
    case Verdict.FireRisk:
      return 'Fire risk'
    default:
      return 'Unmarked'
  }
}

/** CSS background for a verdict swatch. */
export function verdictSwatch(v: number): string {
  if (v === Verdict.FireRisk) return `repeating-linear-gradient(45deg, ${rgb(VERDICT_RGB[4]!)} 0 2px, ${rgb(FIRE_DARK_RGB)} 2px 4px)`
  if (v === Verdict.Untouched) return 'transparent'
  return rgb(VERDICT_RGB[v]!)
}

/** Legend rows for a material: fire risk only when the material has a fire-risk rule. */
export function legendFor(material: MaterialProfile | null): number[] {
  const all = [Verdict.Under, Verdict.InRange, Verdict.Over, Verdict.FireRisk] as number[]
  return material?.fireRisk.kind === 'none' ? all.slice(0, 3) : all
}

/** "6m30s" / "42.1s". */
export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return '—'
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

/** Scale-bar length: a 1-2-5 step whose bar is 60–150 CSS px. */
export function scaleBar(mmPerPx: number): { mm: number; px: number; label: string } {
  const target = 100 * mmPerPx
  const pow = 10 ** Math.floor(Math.log10(target))
  const mm = [1, 2, 5, 10].map((k) => k * pow).find((v) => v / mmPerPx >= 60) ?? 10 * pow
  const label = mm >= 1 ? `${+mm.toPrecision(3)} mm` : `${+(mm * 1000).toPrecision(3)} µm`
  return { mm, px: mm / mmPerPx, label }
}
