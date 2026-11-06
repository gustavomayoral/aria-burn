// SPDX-License-Identifier: GPL-3.0-or-later
// Aria Burn project files (.ariaburn, BURN-55): plain functions over plain data
// that build a project from the SVG import's setup, tell whether the setup
// changed since it was saved, merge saved layer settings into a (re-)read
// document, and resolve the saved machine and material. project.svelte.ts holds
// the state and does the I/O; the schema lives in aria-burn-core's contract.

import { PROJECT_EXTENSION, PROJECT_FORMAT, PROJECT_VERSION, type AriaBurnProject, type MaterialProfile } from 'aria-burn-core/contract'
import type { SvgDocument } from 'aria-burn-core/svg'
import { findMachine, type MachineLibrary } from './machines.ts'
import { initialLayers, type LayerState } from './svg-layers.ts'
import type { Placement } from './svg-place.ts'

/** What the SVG import holds that a project saves. */
export interface ProjectSetup {
  /** SVG file name. */
  name: string
  /** SVG text. */
  text: string
  pxPerInch: number
  layers: readonly LayerState[]
  placement: Placement
}

export interface ProjectContext {
  machine: { id: string | null; name: string }
  material: { id: string; name: string }
  savedAt?: string
}

const cloneSettings = (s: LayerState['settings']) => ({ ...s, fill: { ...s.fill } })

/** The project file for a setup. */
export function buildProject(setup: ProjectSetup, ctx: ProjectContext): AriaBurnProject {
  const project: AriaBurnProject = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    svg: { fileName: setup.name, text: setup.text, pxPerInch: setup.pxPerInch },
    layers: setup.layers.map((l) => ({ id: l.id, settings: cloneSettings(l.settings) })),
    placement: { ...setup.placement },
    machine: { ...ctx.machine },
    material: { ...ctx.material },
  }
  if (ctx.savedAt) project.savedAt = ctx.savedAt
  return project
}

/**
 * A key that changes whenever what a project saves changes, except the SVG
 * text (compared on its own, as it can be megabytes). Machine and material are
 * app settings and don't make a project unsaved.
 */
export function setupKey(setup: Omit<ProjectSetup, 'text'>): string {
  return JSON.stringify([setup.name, setup.pxPerInch, setup.layers.map((l) => [l.id, l.settings]), setup.placement])
}

/** A project file name for an SVG: "logo.svg" → "logo.ariaburn". */
export function projectFileName(svgName: string | null): string {
  const base = (svgName ?? 'Untitled').replace(/\.svg$/i, '') || 'Untitled'
  return `${base}${PROJECT_EXTENSION}`
}

/**
 * A save path from a dialog, with the extension added when the user left it
 * out. The macOS save panel appends the filter's extension to a name typed
 * with it ("job.ariaburn" → "job.ariaburn.ariaburn"); that doubling is undone.
 */
export function withProjectExtension(path: string): string {
  const doubled = `${PROJECT_EXTENSION}${PROJECT_EXTENSION}`
  if (path.toLowerCase().endsWith(doubled)) return path.slice(0, -PROJECT_EXTENSION.length)
  return path.toLowerCase().endsWith(PROJECT_EXTENSION) ? path : `${path}${PROJECT_EXTENSION}`
}

export interface LayerMerge {
  layers: LayerState[]
  /** Layers kept with their settings (names). */
  kept: string[]
  /** Layers of the document with nothing saved: default settings (names). */
  added: string[]
  /** Saved layers whose colour the document no longer has (names, or ids when unnamed). */
  dropped: string[]
}

/**
 * The document's layers with saved settings applied: layers whose id (colour)
 * still exists keep their settings and order, new ones follow with defaults,
 * and saved layers that are gone are listed. Used to open a project and by
 * "Replace SVG…".
 */
export function mergeLayers(saved: readonly { id: string; name?: string; settings: LayerState['settings'] }[], doc: SvgDocument): LayerMerge {
  const fresh = initialLayers(doc)
  const byId = new Map(fresh.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const layers: LayerState[] = []
  const dropped: string[] = []
  for (const s of saved) {
    const f = byId.get(s.id)
    if (!f) {
      dropped.push(s.name ?? s.id)
      continue
    }
    if (seen.has(s.id)) continue
    seen.add(s.id)
    layers.push({ ...f, settings: cloneSettings(s.settings) })
  }
  const kept = layers.map((l) => l.name)
  const added = fresh.filter((l) => !seen.has(l.id))
  return { layers: [...layers, ...added], kept, added: added.map((l) => l.name), dropped }
}

/** One line for a merge that added or dropped layers; null when every layer carried over. */
export function mergeNote(m: Pick<LayerMerge, 'kept' | 'added' | 'dropped'>): string | null {
  if (!m.added.length && !m.dropped.length) return null
  const parts = [`${m.kept.length} layer${m.kept.length === 1 ? '' : 's'} kept their settings`]
  if (m.added.length) parts.push(`new with default settings: ${m.added.join(', ')}`)
  if (m.dropped.length) parts.push(`no longer in the SVG: ${m.dropped.join(', ')}`)
  return `${parts.join('; ')}.`
}

export type MachineChoice = { kind: 'keep' } | { kind: 'load'; id: string } | { kind: 'missing'; notice: string }

/** What to do with the saved machine: keep the active one, load the saved one, or keep the active one with a notice. */
export function resolveMachine(saved: AriaBurnProject['machine'], library: MachineLibrary, activeName: string): MachineChoice {
  if (saved.id === null) {
    if (library.activeId === null && saved.name === activeName) return { kind: 'keep' }
    return { kind: 'missing', notice: `This project was saved with an unsaved machine profile (“${saved.name}”). It opens with ${activeName}.` }
  }
  if (!findMachine(library, saved.id))
    return { kind: 'missing', notice: `This project was saved with the machine “${saved.name}”, which is no longer in your machines. It opens with ${activeName}.` }
  return library.activeId === saved.id ? { kind: 'keep' } : { kind: 'load', id: saved.id }
}

export type MaterialChoice = { kind: 'use'; id: string } | { kind: 'missing'; notice: string }

/** The saved material if it still exists; otherwise the current one with a notice. */
export function resolveMaterial(saved: AriaBurnProject['material'], materials: readonly MaterialProfile[], currentName: string): MaterialChoice {
  if (materials.some((m) => m.id === saved.id)) return { kind: 'use', id: saved.id }
  return { kind: 'missing', notice: `This project was saved with the material “${saved.name}”, which is no longer available. It opens with ${currentName}.` }
}
