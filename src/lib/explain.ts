// SPDX-License-Identifier: GPL-3.0-or-later
// Words for the core's outcome explanation (BURN-45): why a clicked cell got
// its verdict, and what over-burned it. The numbers come from the core
// (explainCell); this only phrases them.

import { Verdict, type CellExplanation, type MoveContribution, type OverburnCause, type VerdictReason } from 'aria-burn-core'
import type { MaterialProfile } from 'aria-burn-core/contract'
import { verdictLabel } from './verdicts.ts'

const kelvinToC = (k: number) => `${Math.round(k - 273.15)} °C`

/** J/mm² with enough digits to tell thresholds apart. */
export function fmtJ(v: number): string {
  const a = Math.abs(v)
  return `${a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3)} J/mm²`
}

export const fmtPct = (f: number) => `${Math.round(f * 100)}%`

function lineList(lines: number[]): string {
  if (lines.length === 0) return 'the moves here'
  const shown = lines.map((l) => l.toLocaleString('en-US'))
  return lines.length === 1 ? `line ${shown[0]}` : `lines ${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

function thresholdNames(material: MaterialProfile): { start: string; top: string } {
  switch (material.response.kind) {
    case 'melt':
      return { start: 'frost start', top: 'removal threshold' }
    case 'bleach':
      return { start: 'mark start', top: 'coating damage threshold' }
    default:
      return { start: 'tone start', top: 'full-char threshold' }
  }
}

/** One sentence: the measured value against the threshold that set the verdict. */
export function describeReason(r: VerdictReason, material: MaterialProfile): string {
  const q = r.quantity === 'dose' ? 'Thermal dose' : 'Fluence'
  const names = thresholdNames(material)
  switch (r.bound) {
    case 'fire':
      return r.quantity === 'bulkTemperature'
        ? `Built-up heat reaches ${kelvinToC(r.value)}, past this material’s fire-risk limit of ${kelvinToC(r.threshold)}.`
        : `${q} ${fmtJ(r.value)} is at or past the fire-risk limit of ${fmtJ(r.threshold)}.`
    case 'over':
      return `${q} ${fmtJ(r.value)} is past the ${names.top} of ${fmtJ(r.threshold)}.`
    case 'inRange':
      return `${q} ${fmtJ(r.value)} is inside the mark window, ${fmtJ(r.underBelow).replace(' J/mm²', '')}–${fmtJ(r.overAbove)}.`
    case 'under':
      return `${q} ${fmtJ(r.value)} is under the ${names.start} of ${fmtJ(r.threshold)}, so it barely marks.`
    default:
      return 'Too little energy reached this cell to mark it.'
  }
}

export interface CauseText {
  title: string
  body: string
}

/** A heading and a sentence per over-burn cause. */
export function describeCause(c: OverburnCause, e: CellExplanation, material: MaterialProfile): CauseText {
  const without = `${fmtJ(c.withoutValue)} (${verdictLabel(c.verdictWithout, material).toLowerCase()})`
  switch (c.kind) {
    case 'slowdown':
      return {
        title: 'Head slowed down',
        body: `${cap(lineList(c.lines))} ran at ${fmtPct(c.speedRatio ?? 1)} of the commanded speed here (a corner, a short move or a turnaround), and M3 keeps the power constant, so energy piled up. At the commanded speed it would be ${without}. M4 scales power with speed.`,
      }
    case 'heat-build-up':
      return e.preheatDoseJPerMm2
        ? {
            title: 'Heat build-up',
            body: `${fmtPct(c.share)} of the dose is heat left by earlier lines nearby, not this cell’s own exposure. Without it, it would be ${without}.`,
          }
        : { title: 'Heat build-up', body: `Heat from the lines around it raised the material past its fire-risk limit, though the cell’s own dose is ${fmtJ(e.doseJPerMm2 ?? 0)}.` }
    case 'overlap':
      return {
        title: 'Moves add up',
        body: `${cap(lineList(c.lines))} overlap on this cell. The strongest alone would give ${without}.`,
      }
    case 'passes':
      return {
        title: `${c.passCount ?? 2} passes`,
        body: `More than one pass burned this cell. The strongest pass alone would give ${without}.`,
      }
    case 'settings':
      return {
        title: 'Too hot for the speed',
        body: `${cap(lineList(c.lines))} alone, at its commanded speed and without preheat, already gives ${fmtJ(c.withoutValue)}. Lower its power or raise its speed.`,
      }
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "M4 · S 800 (80%)" */
export function describeMode(m: MoveContribution): string {
  if (m.laser === null) return '—'
  const mode = m.laser === 'm4' ? 'M4' : m.laser === 'm3' ? 'M3' : 'Off'
  return m.s === null ? mode : `${mode} · S ${+m.s.toFixed(1)}${m.powerFraction === null ? '' : ` (${fmtPct(m.powerFraction)})`}`
}

/** True when a move ran well under its commanded speed at this cell. */
export const slowed = (m: MoveContribution) => m.commandedMmPerMin !== null && m.minActualMmPerMin < 0.7 * m.commandedMmPerMin

/** Marked: anything the verdict overlay draws. */
export const isMarked = (e: CellExplanation | null) => !!e && e.readout.verdict !== Verdict.Untouched
