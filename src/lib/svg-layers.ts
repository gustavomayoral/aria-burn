// SPDX-License-Identifier: GPL-3.0-or-later
// Layer panel state for an imported SVG (BURN-53): the rows the panel shows
// and the edits it makes, as plain functions over plain data so they test
// without the UI. svg-import.svelte.ts holds the state; LayerPanel.svelte
// shows it.

import { lineShapes, type FillSettings, type LayerSettings, type SvgDocument, type SvgJobLayer } from 'aria-burn-core/svg'

/** One layer as the panel edits it. Order in the list is the burn order. */
export interface LayerState {
  id: string
  name: string
  /** #rrggbb */
  color: string
  settings: LayerSettings
}

export interface LayerRow extends LayerState {
  /** Paths the layer burns in its current mode (line: stroke members and unstroked shapes; fill: shapes with a closed subpath). */
  paths: number
  /** Their length (mm). */
  lengthMm: number
  /** Shapes on the layer that its mode leaves out (stroked in another colour, or open paths in fill mode). */
  skipped: number
}

/** A change from the settings form. `fill` merges into the layer's fill settings. */
export type LayerPatch = Partial<Omit<LayerSettings, 'fill'>> & { fill?: Partial<FillSettings> }

export const MAX_PASSES = 50
export const MIN_SPEED_MM_PER_MIN = 1
export const MIN_INTERVAL_MM = 0.01

const cloneSettings = (s: LayerSettings): LayerSettings => ({ ...s, fill: { ...s.fill } })

/** The document's layers in document order, with their default settings. */
export function initialLayers(doc: SvgDocument): LayerState[] {
  return doc.layers.map((l) => ({ id: l.id, name: l.name, color: l.color, settings: cloneSettings(l.settings) }))
}

/**
 * Layers of a re-read document (e.g. at 72 DPI) keeping the settings, and
 * the order, the user gave layers that still exist; new layers go last.
 */
export function carryLayers(previous: readonly LayerState[], doc: SvgDocument): LayerState[] {
  const fresh = initialLayers(doc)
  const byId = new Map(fresh.map((l) => [l.id, l]))
  const kept = previous.filter((l) => byId.has(l.id)).map((l) => ({ ...byId.get(l.id)!, settings: cloneSettings(l.settings) }))
  const keptIds = new Set(kept.map((l) => l.id))
  return [...kept, ...fresh.filter((l) => !keptIds.has(l.id))]
}

/** The shapes a layer burns in a mode (indices into doc.shapes). */
export function burnedShapes(doc: SvgDocument, layerId: string, mode: LayerSettings['mode']): number[] {
  const index = doc.layers.findIndex((l) => l.id === layerId)
  if (index < 0) return []
  if (mode === 'line') return lineShapes(doc, index)
  return doc.layers[index]!.shapes.filter((si) => doc.shapes[si]!.subpaths.some((sp) => sp.closed))
}

/** The panel's rows: each layer with what it burns in its current mode. */
export function layerRows(doc: SvgDocument, layers: readonly LayerState[]): LayerRow[] {
  return layers.map((l) => {
    const shapes = burnedShapes(doc, l.id, l.settings.mode)
    const total = doc.layers.find((d) => d.id === l.id)?.shapes.length ?? 0
    const lengthMm = shapes.reduce((n, si) => n + doc.shapes[si]!.lengthMm, 0)
    return { ...l, paths: shapes.length, lengthMm, skipped: total - shapes.length }
  })
}

const finite = (v: number | undefined, fallback: number) => (v !== undefined && Number.isFinite(v) ? v : fallback)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Applies a form change to one layer's settings and keeps them valid: power
 * 0–100 % with min ≤ max (the field just edited wins), speed ≥ 1 mm/min,
 * whole passes 1–50, interval ≥ 0.01 mm, overscan ≥ 0. A value that isn't a
 * number (an emptied field) keeps the old one.
 */
export function applyPatch(s: LayerSettings, patch: LayerPatch): LayerSettings {
  const out = cloneSettings(s)
  if (patch.mode !== undefined) out.mode = patch.mode
  if (patch.output !== undefined) out.output = patch.output
  if (patch.visible !== undefined) out.visible = patch.visible
  if (patch.maxPowerPct !== undefined) {
    out.maxPowerPct = clamp(finite(patch.maxPowerPct, s.maxPowerPct), 0, 100)
    out.minPowerPct = Math.min(out.minPowerPct, out.maxPowerPct)
  }
  if (patch.minPowerPct !== undefined) {
    out.minPowerPct = clamp(finite(patch.minPowerPct, s.minPowerPct), 0, 100)
    out.maxPowerPct = Math.max(out.maxPowerPct, out.minPowerPct)
  }
  if (patch.speedMmPerMin !== undefined) out.speedMmPerMin = Math.max(MIN_SPEED_MM_PER_MIN, finite(patch.speedMmPerMin, s.speedMmPerMin))
  if (patch.passes !== undefined) out.passes = clamp(Math.round(finite(patch.passes, s.passes)), 1, MAX_PASSES)
  const f = patch.fill
  if (f) {
    if (f.intervalMm !== undefined) out.fill.intervalMm = Math.max(MIN_INTERVAL_MM, finite(f.intervalMm, s.fill.intervalMm))
    if (f.angleDeg !== undefined) out.fill.angleDeg = finite(f.angleDeg, s.fill.angleDeg)
    if (f.overscanMm !== undefined) out.fill.overscanMm = Math.max(0, finite(f.overscanMm, s.fill.overscanMm))
    if (f.bidirectional !== undefined) out.fill.bidirectional = f.bidirectional
    if (f.crosshatch !== undefined) out.fill.crosshatch = f.crosshatch
  }
  return out
}

/** The layers with one changed; an unknown id changes nothing. */
export function patchLayer(layers: readonly LayerState[], id: string, patch: LayerPatch): LayerState[] {
  return layers.map((l) => (l.id === id ? { ...l, settings: applyPatch(l.settings, patch) } : l))
}

/** What svgJob burns: every layer, in list order. Hidden and output-off layers write no moves there. */
export const jobLayers = (layers: readonly LayerState[]): SvgJobLayer[] => layers.map((l) => ({ id: l.id, settings: cloneSettings(l.settings) }))

/** Nothing would burn: every layer is hidden, has output off, or has no paths in its mode. */
export function nothingBurns(rows: readonly LayerRow[]): boolean {
  return !rows.some((r) => r.settings.visible && r.settings.output && r.paths > 0)
}
