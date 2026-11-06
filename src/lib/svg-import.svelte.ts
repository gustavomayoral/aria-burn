// SPDX-License-Identifier: GPL-3.0-or-later
// An imported SVG (BURN-53, feature BURN-49): the document, its layer
// settings and the job they make. The SVG is read and turned into GRBL
// G-code by aria-burn-core in a worker (svg-work.ts); the G-code then opens
// through the same path as a G-code file (Rust parser → GRBL planner →
// simulator), named after the SVG. Every layer change re-simulates, debounced;
// a newer open cancels the running plan as opening another file does.

import type { MachineProfile } from 'aria-burn-core/contract'
import type { SvgDiagnostic, SvgDocument, SvgJobDiagnostic } from 'aria-burn-core/svg'
import { burn } from './burn.svelte.ts'
import { carryLayers, initialLayers, jobLayers, layerRows, nothingBurns, patchLayer, type LayerPatch, type LayerState } from './svg-layers.ts'
import { SvgWork } from './svg-work.ts'

export const RESIMULATE_DELAY_MS = 300
export const DEFAULT_PX_PER_INCH = 96
export const ILLUSTRATOR_PX_PER_INCH = 72

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

  private text = ''
  private machine: MachineProfile | null = null
  private work: SvgWork | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by every open and every simulation; a stale result is dropped. */
  private generation = 0
  private simulated = false

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

  /** Opens an SVG's text: read it, set up its layers with defaults, simulate. */
  async open(name: string, text: string, pxPerInch = DEFAULT_PX_PER_INCH, keepLayers = false): Promise<void> {
    this.cancelTimer()
    const gen = ++this.generation
    const previous = keepLayers && this.doc ? $state.snapshot(this.layers) : null
    this.name = name
    this.text = text
    this.busy = 'reading'
    let doc: SvgDocument
    try {
      doc = await this.worker.read({ text, pxPerInch })
    } catch (e) {
      if (gen !== this.generation) return
      this.busy = null
      this.doc = null
      this.layers = []
      burn.failFile(name, `Can’t read this SVG: ${e instanceof Error ? e.message : String(e)}`, 'svg')
      return
    }
    if (gen !== this.generation) return
    this.doc = doc
    this.pxPerInch = pxPerInch
    this.layers = previous ? carryLayers(previous, doc) : initialLayers(doc)
    if (!this.layers.some((l) => l.id === this.selected)) this.selected = null
    this.jobDiagnostics = []
    this.simulated = false
    await this.simulate()
  }

  /** Re-reads the open SVG at another px-per-inch (72 for older Illustrator exports), keeping layer settings. */
  setPxPerInch(pxPerInch: number): Promise<void> {
    if (!this.name || pxPerInch === this.pxPerInch) return Promise.resolve()
    return this.open(this.name, this.text, pxPerInch, true)
  }

  select(id: string | null): void {
    this.selected = this.selected === id ? null : id
  }

  update(id: string, patch: LayerPatch): void {
    this.layers = patchLayer(this.layers, id, patch)
    this.schedule()
  }

  /** Re-simulate after the last change settles. */
  schedule(): void {
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.simulate()
    }, RESIMULATE_DELAY_MS)
  }

  /** Makes the job from the current layers and opens its G-code (named after the SVG). */
  async simulate(): Promise<void> {
    const doc = this.doc
    const name = this.name
    if (!doc || !name || !this.machine) return
    // A newer change, or another file opened since, wins.
    if (this.simulated && burn.origin !== 'svg') return
    const gen = ++this.generation
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
      result = await this.worker.job({ layers: jobLayers(this.layers), machine: this.machine, name })
    } catch (e) {
      if (gen !== this.generation) return
      this.busy = null
      burn.failFile(name, `Can’t make the moves for this SVG: ${e instanceof Error ? e.message : String(e)}`, 'svg')
      return
    }
    if (gen !== this.generation || (this.simulated && burn.origin !== 'svg')) return
    this.busy = null
    this.jobDiagnostics = result.diagnostics.filter((d) => d.code !== 'nothing-to-burn')
    const keepView = this.simulated
    this.simulated = true
    await burn.openFile({ kind: 'text', name, text: result.gcode }, false, { origin: 'svg', keepView })
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
  }

  private cancelTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

export const svgImport = new SvgImport()
