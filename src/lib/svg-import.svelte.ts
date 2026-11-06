// SPDX-License-Identifier: GPL-3.0-or-later
// An imported SVG (BURN-53, feature BURN-49): the document, its layer
// settings and the job they make. The SVG is read and turned into GRBL
// G-code by aria-burn-core in a worker (svg-work.ts); the G-code then opens
// through the same path as a G-code file (Rust parser → GRBL planner →
// simulator), named after the SVG. Every layer change re-simulates, debounced;
// a newer open cancels the running plan as opening another file does.
//
// Placement (BURN-54) lives here with the layers, so a project file (BURN-55)
// saves both. A design opens in Place mode at the default placement (the
// identity, as BURN-53 loaded it) while its burn simulates behind; placement
// edits in Place mode wait for "Simulate", edits outside it re-simulate like a
// layer change.
//
// A project file (BURN-55, project.svelte.ts) restores a saved setup through
// `open` with `restore`; "Replace SVG…" swaps the SVG and carries the layer
// settings over by colour.

import type { MachineProfile } from 'aria-burn-core/contract'
import type { SvgDiagnostic, SvgDocument, SvgJobDiagnostic } from 'aria-burn-core/svg'
import { burn } from './burn.svelte.ts'
import { mergeLayers, type LayerMerge } from './project.ts'
import { carryLayers, initialLayers, jobLayers, layerRows, nothingBurns, patchLayer, type LayerPatch, type LayerState } from './svg-layers.ts'
import { defaultPlacement, placeGeometry, samePlacement, type PlaceGeometry, type Placement } from './svg-place.ts'
import { SvgWork } from './svg-work.ts'

export const RESIMULATE_DELAY_MS = 300
export const DEFAULT_PX_PER_INCH = 96
export const ILLUSTRATOR_PX_PER_INCH = 72

/** A saved setup to open the SVG with instead of the defaults (a project file). */
export interface RestoreSetup {
  layers: readonly { id: string; settings: LayerState['settings'] }[]
  placement: Placement
}

const NOTHING_BURNS =
  'No layer burns anything: every layer is hidden, has its output off, or has no paths in its mode. Turn a layer’s output on in the Layers panel.'

class SvgImport {
  /** File name of the open SVG; null when the open job isn't an SVG. */
  name = $state<string | null>(null)
  doc = $state.raw<SvgDocument | null>(null)
  layers = $state<LayerState[]>([])
  selected = $state<string | null>(null)
  /** reading: the SVG is being read; building: its job is being made. */
  busy = $state<'reading' | 'building' | null>(null)
  jobDiagnostics = $state.raw<SvgJobDiagnostic[]>([])
  /** px per inch the document was read at. */
  pxPerInch = $state(DEFAULT_PX_PER_INCH)
  /** Where the design sits on the bed (aria-burn-core Placement, on the content box). */
  placement = $state.raw<Placement>({ xMm: 0, yMm: 0, anchor: 'bottom-left', scale: 1, rotationDeg: 0 })
  /** The document reduced for placement (hulls), made once per read. */
  geometry = $state.raw<PlaceGeometry | null>(null)
  /** Place mode: the canvas shows the bed and the design as vectors. */
  placing = $state(false)
  /** The burn on screen was made at another placement (edited in Place mode, not simulated yet). */
  placementStale = $state(false)
  /** How the last project open or "Replace SVG…" carried the layers over; null after a plain open. */
  layerMerge = $state.raw<LayerMerge | null>(null)
  /** The SVG text, as read (saved in a project). */
  text = $state.raw('')

  private machine: MachineProfile | null = null
  private work: SvgWork | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by every open and every simulation; a stale result is dropped. */
  private generation = 0
  private simulated = false
  /** The placement of the burn last opened. */
  private simulatedAt: Placement | null = null

  /** The SVG import is what the canvas shows (a G-code file or live job replaces it). */
  get active(): boolean {
    return this.doc !== null && burn.origin === 'svg' && burn.job?.kind === 'file'
  }

  get rows() {
    return this.doc ? layerRows(this.doc, this.layers) : []
  }

  get readDiagnostics(): SvgDiagnostic[] {
    return this.doc?.diagnostics ?? []
  }

  /** The size was px or unitless, so 96 DPI was assumed (72 is offered). */
  get dpiAssumed(): boolean {
    return this.readDiagnostics.some((d) => d.code === 'px-size-assumed-dpi')
  }

  private get worker(): SvgWork {
    return (this.work ??= new SvgWork())
  }

  /** The machine profile in effect; a change re-simulates an open SVG. */
  setMachine(machine: MachineProfile): void {
    const plain = JSON.parse(JSON.stringify(machine)) as MachineProfile
    const changed = this.machine !== null && JSON.stringify(plain) !== JSON.stringify(this.machine)
    this.machine = plain
    if (changed && this.active) this.schedule()
  }

  /**
   * Opens an SVG's text: read it, set up its layers (defaults, the current
   * ones with `keepLayers`, or a project's with `restore`), simulate.
   * Resolves to false when the SVG couldn't be read.
   */
  async open(name: string, text: string, pxPerInch = DEFAULT_PX_PER_INCH, keepLayers = false, restore: RestoreSetup | null = null): Promise<boolean> {
    this.cancelTimer()
    const gen = ++this.generation
    const previous = keepLayers && this.doc ? $state.snapshot(this.layers) : null
    if (!keepLayers) this.layerMerge = null
    this.name = name
    this.text = text
    this.busy = 'reading'
    let doc: SvgDocument
    try {
      doc = await this.worker.read({ text, pxPerInch })
    } catch (e) {
      if (gen !== this.generation) return false
      this.busy = null
      this.doc = null
      this.layers = []
      burn.failFile(name, `Can’t read this SVG: ${e instanceof Error ? e.message : String(e)}`, 'svg')
      return false
    }
    if (gen !== this.generation) return false
    const oldGeometry = this.geometry
    const geometry = placeGeometry(doc)
    // A re-read keeps a placement the user set; an untouched one follows the new size.
    const keepPlacement = previous !== null && oldGeometry !== null && !samePlacement(this.placement, defaultPlacement(oldGeometry))
    this.doc = doc
    this.geometry = geometry
    this.pxPerInch = pxPerInch
    if (restore) {
      const merge = mergeLayers(restore.layers, doc)
      this.layers = merge.layers
      this.layerMerge = merge
      this.placement = { ...restore.placement }
      this.placing = false
    } else {
      this.layers = previous ? carryLayers(previous, doc) : initialLayers(doc)
      if (!keepPlacement) this.placement = defaultPlacement(geometry)
      if (!previous) this.placing = true
    }
    this.placementStale = false
    if (!this.layers.some((l) => l.id === this.selected)) this.selected = null
    this.jobDiagnostics = []
    this.simulated = false
    this.simulatedAt = null
    await this.simulate()
    return true
  }

  /**
   * "Replace SVG…" (BURN-55): another SVG takes this one's place. Layers whose
   * colour still exists keep their settings, new colours get defaults, and the
   * dropped ones are listed (layerMerge). A placement the user set is kept.
   */
  async replace(name: string, text: string): Promise<boolean> {
    if (!this.doc) return this.open(name, text)
    const previous = $state.snapshot(this.layers)
    const ok = await this.open(name, text, this.pxPerInch, true)
    if (ok && this.doc) this.layerMerge = mergeLayers(previous, this.doc)
    return ok
  }

  /** Re-reads the open SVG at another px-per-inch (72 for older Illustrator exports), keeping layer settings. */
  async setPxPerInch(pxPerInch: number): Promise<void> {
    if (!this.name || pxPerInch === this.pxPerInch) return
    await this.open(this.name, this.text, pxPerInch, true)
  }

  select(id: string | null): void {
    this.selected = this.selected === id ? null : id
  }

  update(id: string, patch: LayerPatch): void {
    this.layers = patchLayer(this.layers, id, patch)
    this.schedule()
  }

  /** A new placement: shown at once in Place mode, simulated on "Simulate"; elsewhere re-simulated like a layer change. */
  setPlacement(p: Placement): void {
    if (samePlacement(p, this.placement, 0)) return
    this.placement = p
    if (this.placing) this.placementStale = true
    else this.schedule()
  }

  /** Enter Place mode (the "Place" button). */
  place(): void {
    if (this.doc) this.placing = true
  }

  /** Leave Place mode ("Simulate"): runs the burn at the new placement if it changed. */
  finishPlacing(): void {
    if (!this.placing) return
    this.placing = false
    if (this.placementStale) {
      this.placementStale = false
      this.cancelTimer()
      void this.simulate()
    }
  }

  /** Re-simulate after the last change settles. */
  schedule(): void {
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.simulate()
    }, RESIMULATE_DELAY_MS)
  }

  /**
   * Makes the job from the current layers and placement and opens its G-code
   * (named after the SVG). The view is kept across layer changes and fitted
   * again when the placement changed, since the burn has moved.
   */
  async simulate(): Promise<void> {
    const doc = this.doc
    const name = this.name
    if (!doc || !name || !this.machine) return
    // A newer change, or another file opened since, wins.
    if (this.simulated && burn.origin !== 'svg') return
    const gen = ++this.generation
    const placement = this.placement
    if (nothingBurns(layerRows(doc, this.layers))) {
      this.busy = null
      this.jobDiagnostics = []
      this.simulated = true
      burn.failFile(name, NOTHING_BURNS, 'svg')
      return
    }
    this.busy = 'building'
    let result
    try {
      result = await this.worker.job({ layers: jobLayers(this.layers), machine: this.machine, name, placement: { ...placement } })
    } catch (e) {
      if (gen !== this.generation) return
      this.busy = null
      burn.failFile(name, `Can’t make the moves for this SVG: ${e instanceof Error ? e.message : String(e)}`, 'svg')
      return
    }
    if (gen !== this.generation || (this.simulated && burn.origin !== 'svg')) return
    this.busy = null
    this.jobDiagnostics = result.diagnostics.filter((d) => d.code !== 'nothing-to-burn')
    const keep = this.simulated && this.simulatedAt !== null && samePlacement(placement, this.simulatedAt, 0)
    this.simulated = true
    this.simulatedAt = placement
    if (samePlacement(placement, this.placement, 0)) this.placementStale = false
    await burn.openFile({ kind: 'text', name, text: result.gcode }, false, { origin: 'svg', keepView: keep })
  }

  /** Forget the SVG (another file was opened). */
  clear(): void {
    this.cancelTimer()
    this.generation++
    this.name = null
    this.doc = null
    this.layers = []
    this.selected = null
    this.busy = null
    this.jobDiagnostics = []
    this.text = ''
    this.simulated = false
    this.geometry = null
    this.simulatedAt = null
    this.placing = false
    this.placementStale = false
    this.layerMerge = null
  }

  private cancelTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

export const svgImport = new SvgImport()
