// SPDX-License-Identifier: GPL-3.0-or-later
// Material fit from a photographed test grid (BURN-15), the app side: the
// dialog's state from grid to saved profile. The core (aria-burn-core
// calibration) does detection, colour correction and the fit; this decodes the
// photo, runs the grid through the same parser and planner as any file, keeps
// the user's inputs (depths, flames), saves the fitted profile in the user's
// material library and writes the calibration record (photo, G-code, machine
// profile, fit) to the app's data folder.
//
// Without a laser, a synthetic photo (developer builds) renders the grid from
// a known "true" material and photographs it; the review then shows the truth
// beside the fit.

import {
  PhotoAnalysisError,
  analysePhoto,
  cardSvg,
  cellFields,
  fitMaterial,
  renderPattern,
  syntheticPhoto,
  type CalibrationPattern,
  type DepthEntry,
  type FitResult,
  type Photo,
  type PhotoAnalysis,
  type PhotoConditions,
  type Point,
} from 'aria-burn-core/calibration'
import { SampleStore, interimSampler, type ThermalStep } from 'aria-burn-core'
import { decodeSampleBatch, type MachineProfile, type MaterialProfile } from 'aria-burn-core/contract'
import { app } from './app.svelte.ts'
import { burn } from './burn.svelte.ts'
import { calibration, patternFileName } from './calibration.svelte.ts'
import { isTauri, saveCalibrationFile, saveExport } from './ipc.ts'
import { MATERIALS, allMaterials, useUserMaterials } from './materials.ts'
import { loadUserMaterials, saveUserMaterials } from './settings.ts'
import { addUserMaterial, emptyUserMaterials, materialId, removeUserMaterial, type UserMaterial, type UserMaterialsLibrary } from './user-materials.ts'

export type FitStep = 'grid' | 'photo' | 'review'
export type ManualMode = 'card' | 'fiducials'

/** Largest photo side kept for analysis (px); bigger photos are scaled down. */
export const MAX_PHOTO_SIDE = 4000

/** Marks show lighter than the bare material (melt, bleach) or darker (char). */
export function marksLighter(m: MaterialProfile): boolean {
  const r = m.response
  const top = r.kind === 'char' ? r.charColor : r.kind === 'melt' ? r.frostColor : r.markColor
  return top.l > r.baseColor.l
}

/**
 * A "true" material for a synthetic photo: the starting profile moved well
 * away from its values, so the fit has something to find.
 */
export function syntheticTruth(start: MaterialProfile): MaterialProfile {
  const m = structuredClone(start)
  const r = m.response
  switch (r.kind) {
    case 'char':
      r.toneStartJPerMm2 *= 1.3
      r.toneEndJPerMm2 *= 0.8
      r.toneGamma = Math.min(1, r.toneGamma * 1.35)
      r.charColor = { l: r.charColor.l - 4, a: r.charColor.a + 1, b: r.charColor.b - 1 }
      r.baseColor = { l: r.baseColor.l - 4, a: r.baseColor.a + 1.5, b: r.baseColor.b + 3 }
      r.ablationThresholdJPerMm2 *= 1.4
      r.depthMmPerJPerMm2 *= 0.7
      break
    case 'melt':
      r.frostStartJPerMm2 *= 1.4
      r.frostFullJPerMm2 *= 1.25
      r.frostColor = { ...r.frostColor, l: r.frostColor.l + 5 }
      r.removalThresholdJPerMm2 *= 0.75
      r.depthMmPerJPerMm2 *= 0.85
      break
    case 'bleach':
      r.markStartJPerMm2 *= 1.3
      r.markFullJPerMm2 *= 0.8
      r.markColor = { l: r.markColor.l - 7, a: r.markColor.a + 1, b: r.markColor.b + 2 }
      r.baseColor = { l: r.baseColor.l + 4, a: r.baseColor.a + 0.5, b: r.baseColor.b - 1 }
      break
  }
  if (m.thermal.kind === 'peakTemperature') m.thermal.rampOnsetK = m.thermal.ambientK + (m.thermal.rampOnsetK - m.thermal.ambientK) * 1.12
  if (m.fireRisk.kind === 'temperature') m.fireRisk.thresholdK = m.thermal.kind === 'peakTemperature' ? m.thermal.ambientK + (m.fireRisk.thresholdK - m.thermal.ambientK) * 0.85 : m.fireRisk.thresholdK
  m.provenance = { source: 'user', notes: 'Synthetic truth for a photo-fit demo (BURN-15)' }
  return m
}

/** Photo conditions of the synthetic photo: a handheld shot under a desk lamp. */
export const SYNTHETIC_CONDITIONS: PhotoConditions = {
  seed: 7,
  widthPx: 2400,
  heightPx: 1800,
  rotationDeg: -6,
  perspective: 0.04,
  cardSide: 'right',
  cardAngleDeg: 4,
  whiteBalance: [1.18, 1, 0.8],
  exposure: 0.85,
  gradient: { strength: 0.1, angleDeg: 35 },
  vignette: 0.05,
  blurPx: 1.1,
  noise: { read: 0.002, shot: 0.012 },
  texture: 0.02,
}

const tick = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)))

/** RGBA pixels of an image file, scaled down to MAX_PHOTO_SIDE. */
async function decodeImage(blob: Blob): Promise<Photo> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })!
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const img = ctx.getImageData(0, 0, width, height, { colorSpace: 'srgb' })
  return { width, height, data: img.data }
}

async function encodePng(photo: Photo): Promise<Blob> {
  const canvas = new OffscreenCanvas(photo.width, photo.height)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })!
  ctx.putImageData(new ImageData(new Uint8ClampedArray(photo.data), photo.width, photo.height, { colorSpace: 'srgb' }), 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

/** What a depth gauge would read on three cells of a synthetic burn (the truth's mean depth over the middle). */
function syntheticDepths(store: Parameters<typeof cellFields>[0], machine: MachineProfile, truth: MaterialProfile, pattern: CalibrationPattern, step: Parameters<typeof cellFields>[4]): { depths: DepthEntry[]; fire: string[] } {
  const fields = cellFields(store, machine, truth, pattern.cells, step)
  const r = truth.response
  const fire = truth.fireRisk.kind === 'temperature' ? fields.cells.filter((c) => c.bulkMaxK >= (truth.fireRisk as { thresholdK: number }).thresholdK).map((c) => c.id) : []
  if (r.kind === 'bleach') return { depths: [], fire }
  const thr = r.kind === 'char' ? r.ablationThresholdJPerMm2 : r.removalThresholdJPerMm2
  const start = r.kind === 'char' ? r.toneStartJPerMm2 : r.frostStartJPerMm2
  const flashK = truth.thermal.kind === 'peakTemperature' ? (truth.thermal.rampOnsetK - truth.thermal.ambientK) / start : null
  const ranked = fields.cells
    .map((c) => {
      let s = 0
      for (let i = 0; i < c.flash.length; i++) s += Math.max(0, (flashK === null ? c.flash[i]! : c.flash[i]! + c.bulk[i]! / flashK) - thr)
      return { id: c.id, d: (r.depthMmPerJPerMm2 * s) / c.flash.length }
    })
    .sort((a, b) => b.d - a.d)
  const picks = [ranked[0]!, ranked[Math.floor(ranked.length / 4)]!, ranked[Math.floor(ranked.length / 2)]!]
  return { depths: picks.map((p) => ({ cellId: p.id, depthMm: Number(p.d.toFixed(3)) })), fire }
}

export interface DepthRow {
  cellId: string
  depthMm: string
}

class PhotoFitState {
  open = $state(false)
  step = $state<FitStep>('grid')
  pattern = $state.raw<CalibrationPattern | null>(null)
  patternError = $state<string | null>(null)
  /** The profile the fit starts from and the machine, as they were when the dialog opened. */
  start = $state.raw<MaterialProfile | null>(null)
  machine = $state.raw<MachineProfile | null>(null)

  photo = $state.raw<Photo | null>(null)
  photoUrl = $state<string | null>(null)
  photoBytes = $state.raw<{ bytes: Uint8Array; ext: string } | null>(null)
  /** Set for a synthetic photo: the material it was rendered from. */
  truth = $state.raw<MaterialProfile | null>(null)

  analysis = $state.raw<PhotoAnalysis | null>(null)
  analysisError = $state<{ message: string; stage: 'card' | 'pattern' | 'colour' } | null>(null)
  manual = $state<ManualMode | null>(null)
  manualPoints = $state<Point[]>([])
  manualCard = $state.raw<Point[] | null>(null)
  manualFiducials = $state.raw<Point[] | null>(null)

  depths = $state<DepthRow[]>([])
  fireCellIds = $state<string[]>([])
  askFire = $state(false)
  fitPowerCurve = $state(false)

  busy = $state<string | null>(null)
  result = $state.raw<FitResult | null>(null)
  error = $state<string | null>(null)
  name = $state('')
  note = $state<string | null>(null)

  library = $state<UserMaterialsLibrary>(emptyUserMaterials())

  constructor() {
    useUserMaterials(() => this.library.materials.map((m) => m.profile))
  }

  async load(): Promise<void> {
    const { library, warnings } = await loadUserMaterials()
    this.library = library
    if (warnings.length) app.warnings = [...app.warnings, ...warnings]
  }

  /** Opens the dialog for the active machine and material, with a fresh grid. */
  begin(machine: MachineProfile, material: MaterialProfile): void {
    this.reset()
    this.machine = machine
    this.start = material
    const { pattern, error } = calibration.generate(machine, material, 'grid')
    this.pattern = pattern
    this.patternError = error
    this.askFire = material.fireRisk.kind === 'temperature'
    this.depths = material.response.kind === 'bleach' ? [] : [0, 1, 2].map(() => ({ cellId: '', depthMm: '' }))
    this.name = `${material.name.replace(/\s*\(.*\)\s*$/, '')} — my batch, ${new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`
    this.open = true
  }

  reset(): void {
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl)
    this.step = 'grid'
    this.photo = null
    this.photoUrl = null
    this.photoBytes = null
    this.truth = null
    this.analysis = null
    this.analysisError = null
    this.manual = null
    this.manualPoints = []
    this.manualCard = null
    this.manualFiducials = null
    this.fireCellIds = []
    this.fitPowerCurve = false
    this.busy = null
    this.result = null
    this.error = null
    this.note = null
  }

  close(): void {
    this.open = false
  }

  get fileName(): string | null {
    return this.pattern ? patternFileName(this.pattern) : null
  }

  async saveGcode(): Promise<void> {
    if (!this.pattern) return
    this.note = `Saved ${await calibration.saveGcode(this.pattern)}`
  }

  /** The reference card as an SVG to print at 100 %. */
  async saveCard(): Promise<void> {
    const bytes = new TextEncoder().encode(cardSvg())
    const name = 'aria-burn-reference-card.svg'
    if (isTauri()) this.note = `Saved ${await saveExport(name, bytes)} — print at 100 %`
    else {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }))
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      this.note = `Downloaded ${name} — print at 100 %`
    }
  }

  private browserSamples: { pattern: CalibrationPattern; store: SampleStore } | null = null

  /**
   * The grid's samples: opened in the burn view (Rust parser + GRBL planner)
   * in the desktop app. The browser build has no planner, so there the core's
   * interim sampler stands in (the same job model, simpler motion).
   */
  async samples(): Promise<{ store: SampleStore; thermalStep: ThermalStep | undefined }> {
    const name = this.fileName
    if (!name || !this.pattern || !this.machine) throw new Error('No grid')
    if (!isTauri()) {
      if (this.browserSamples?.pattern !== this.pattern) {
        const plan = interimSampler.plan(this.pattern.job, this.machine, 1)
        const store = new SampleStore(1)
        for (const b of plan.batches) store.append(decodeSampleBatch(b))
        this.browserSamples = { pattern: this.pattern, store }
      }
      return { store: this.browserSamples.store, thermalStep: burn.gpuThermalStep }
    }
    let s = burn.samplesFor(name)
    if (s) return s
    calibration.previewed = this.pattern
    app.source = 'file'
    await burn.openFile({ kind: 'text', name, text: this.pattern.gcode })
    for (let t = 0; t < 1200 && !(s = burn.samplesFor(name)); t++) {
      if (burn.status === 'error') throw new Error('The grid failed to open in the sim')
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!s) throw new Error('Timed out waiting for the grid’s samples')
    return s
  }

  async loadFile(file: File): Promise<void> {
    this.busy = 'Reading the photo…'
    try {
      const photo = await decodeImage(file)
      this.setPhoto(photo, new Uint8Array(await file.arrayBuffer()), (file.name.split('.').pop() ?? 'jpg').toLowerCase(), URL.createObjectURL(file))
      this.truth = null
      await this.analyse()
    } catch (e) {
      this.error = `Couldn’t read the photo: ${String(e)}`
    } finally {
      this.busy = null
    }
  }

  private setPhoto(photo: Photo, bytes: Uint8Array, ext: string, url: string): void {
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl)
    this.photo = photo
    this.photoBytes = { bytes, ext }
    this.photoUrl = url
    this.step = 'photo'
    this.analysis = null
    this.analysisError = null
    this.manualCard = null
    this.manualFiducials = null
    this.result = null
  }

  /** Developer builds: render the grid from a known material and photograph it. */
  async makeSynthetic(): Promise<void> {
    if (!this.pattern || !this.machine || !this.start) return
    this.error = null
    try {
      this.busy = 'Simulating the grid…'
      const { store, thermalStep } = await this.samples()
      this.busy = 'Rendering the burned grid and taking the photo…'
      await tick()
      const truth = syntheticTruth(this.start)
      const b = this.pattern.boundsMm
      const render = renderPattern(store, this.machine, truth, { minXMm: b.minXMm - 14, minYMm: b.minYMm - 14, maxXMm: b.maxXMm + 14, maxYMm: b.maxYMm + 14 }, { finePitchMm: 0.025, ...(thermalStep ? { thermalStep } : {}) })
      const shot = syntheticPhoto(render, truth.response.baseColor, SYNTHETIC_CONDITIONS)
      const png = await encodePng(shot.photo)
      this.setPhoto(shot.photo, new Uint8Array(await png.arrayBuffer()), 'png', URL.createObjectURL(png))
      this.truth = truth
      const synth = syntheticDepths(store, this.machine, truth, this.pattern, thermalStep ? { thermalStep } : {})
      if (this.depths.length) this.depths = synth.depths.map((d) => ({ cellId: d.cellId, depthMm: String(d.depthMm) }))
      if (this.askFire) this.fireCellIds = synth.fire
      this.busy = 'Finding the card and the grid…'
      await tick()
      await this.analyse()
    } catch (e) {
      this.error = String(e)
    } finally {
      this.busy = null
    }
  }

  async analyse(): Promise<void> {
    if (!this.photo || !this.pattern || !this.start) return
    try {
      this.analysis = analysePhoto(this.photo, this.pattern, {
        marksLighter: marksLighter(this.start),
        ...(this.manualCard ? { cardCorners: this.manualCard } : {}),
        ...(this.manualFiducials ? { fiducials: this.manualFiducials } : {}),
      })
      this.analysisError = null
    } catch (e) {
      this.analysis = null
      this.analysisError = e instanceof PhotoAnalysisError ? { message: e.message, stage: e.stage } : { message: String(e), stage: 'colour' }
    }
  }

  /** Start placing corners by hand: the card's frame (TL, TR, BR, BL as printed) or the fiducials (BL, BR, TR, TL as burned). */
  beginManual(mode: ManualMode): void {
    this.manual = mode
    this.manualPoints = []
  }

  async addManualPoint(p: Point): Promise<void> {
    if (!this.manual) return
    this.manualPoints = [...this.manualPoints, p]
    if (this.manualPoints.length < 4) return
    if (this.manual === 'card') this.manualCard = this.manualPoints
    else this.manualFiducials = this.manualPoints
    this.manual = null
    this.manualPoints = []
    await this.analyse()
  }

  toggleFire(id: string): void {
    this.fireCellIds = this.fireCellIds.includes(id) ? this.fireCellIds.filter((x) => x !== id) : [...this.fireCellIds, id]
  }

  depthEntries(): DepthEntry[] {
    return this.depths
      .filter((d) => d.cellId && d.depthMm.trim() !== '' && Number.isFinite(Number(d.depthMm)) && Number(d.depthMm) >= 0)
      .map((d) => ({ cellId: d.cellId, depthMm: Number(d.depthMm) }))
  }

  async fit(): Promise<void> {
    const { pattern, machine, start, analysis } = this
    if (!pattern || !machine || !start || !analysis) return
    this.error = null
    try {
      this.busy = 'Simulating the grid…'
      const { store, thermalStep } = await this.samples()
      this.busy = start.thermal.kind === 'peakTemperature' ? 'Fitting (heat build-up runs a few times)…' : 'Fitting…'
      await tick()
      const t0 = performance.now()
      this.result = fitMaterial({
        cells: pattern.cells,
        store,
        machine,
        material: start,
        observations: analysis.observations,
        base: analysis.base,
        depths: this.depthEntries(),
        fireCellIds: this.askFire ? this.fireCellIds : undefined,
        fitPowerCurve: this.fitPowerCurve,
        forward: thermalStep ? { thermalStep } : {},
        name: this.name,
      })
      this.fitMs = performance.now() - t0
      this.step = 'review'
    } catch (e) {
      this.error = `Fit failed: ${String(e)}`
    } finally {
      this.busy = null
    }
  }

  fitMs = $state(0)

  /** Saves the fitted profile under `name`, selects it, and writes the calibration record. */
  async save(): Promise<void> {
    const { result, machine, start, pattern, analysis } = this
    if (!result || !machine || !start || !pattern || !analysis) return
    this.busy = 'Saving…'
    try {
      const name = this.name.trim() || result.material.name
      const id = materialId(name, allMaterials().map((m) => m.id))
      const profile: MaterialProfile = { ...result.material, id, name }
      const createdAt = new Date().toISOString()
      const calibrationId = `cal-${createdAt.slice(0, 10)}-${id}`.slice(0, 110)
      let folder: string | undefined
      if (isTauri()) {
        const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2))
        const write = (file: string, bytes: Uint8Array) => saveCalibrationFile(calibrationId, file, bytes)
        if (this.photoBytes) await write(`photo.${this.photoBytes.ext.replace(/[^a-z0-9]/g, '') || 'jpg'}`, this.photoBytes.bytes)
        await write('grid.gcode', new TextEncoder().encode(pattern.gcode))
        await write('machine.json', json(machine))
        const path = await write('fit.json', json(this.record(profile, createdAt)))
        folder = path.replace(/[/\\]fit\.json$/, '')
      }
      const entry: UserMaterial = {
        profile,
        calibrationId,
        machine: { name: machine.name, ...(machine.frameId ? { frameId: machine.frameId } : {}), ...(machine.moduleId ? { moduleId: machine.moduleId } : {}) },
        fromId: start.id,
        createdAt,
        ...(folder ? { folder } : {}),
      }
      const next = addUserMaterial(this.library, entry)
      await saveUserMaterials(next)
      this.library = next
      app.settings.ui.materialId = id
      void app.savePrefs()
      this.note = folder ? `Saved “${name}”. Calibration record in ${folder}` : `Saved “${name}”. (The browser build keeps no photo or record files.)`
    } catch (e) {
      this.error = `Couldn’t save: ${String(e)}`
    } finally {
      this.busy = null
    }
  }

  /** fit.json: everything needed to redo or audit the fit, without the photo and G-code (separate files). */
  record(profile: MaterialProfile, createdAt: string) {
    const { result, pattern, analysis, start } = this
    const arr = (h: Float64Array) => Array.from(h)
    return {
      format: 'aria-burn-calibration',
      version: 1,
      createdAt,
      sharing: 'local only — sharing is not implemented; the licence for shared calibration data is open (BURN-8)',
      material: profile,
      startMaterialId: start?.id,
      synthetic: this.truth ? { truth: this.truth } : null,
      pattern: pattern && { kind: pattern.kind, title: pattern.title, options: pattern.options, machine: pattern.machine, cells: pattern.cells, marks: pattern.marks, burnBoundsMm: pattern.burnBoundsMm },
      photo: this.photo && { width: this.photo.width, height: this.photo.height },
      analysis: analysis && {
        cardH: arr(analysis.cardH),
        cardCorners: analysis.cardCorners,
        patternH: arr(analysis.patternH),
        marks: analysis.marks,
        colourMatrix: arr(analysis.correction.matrix),
        flatField: analysis.correction.flat,
        meanPatchDeltaE: analysis.correction.meanPatchDeltaE,
        observations: analysis.observations,
        base: analysis.base,
        warnings: analysis.warnings,
        manual: { card: this.manualCard, fiducials: this.manualFiducials },
      },
      inputs: { depths: this.depthEntries(), fireCellIds: this.askFire ? this.fireCellIds : null, fitPowerCurve: this.fitPowerCurve },
      fit: result && {
        cells: result.cells,
        meanDeltaE: result.meanDeltaE,
        maxDeltaE: result.maxDeltaE,
        parameters: result.parameters,
        depth: result.depth,
        fire: result.fire,
        powerCurve: result.powerCurve,
        powerFactors: result.powerFactors,
        thermalIterations: result.thermalIterations,
        notes: result.notes,
      },
    }
  }

  async removeMaterial(id: string): Promise<void> {
    const next = removeUserMaterial(this.library, id)
    await saveUserMaterials(next)
    this.library = next
    if (app.settings.ui.materialId === id) {
      app.settings.ui.materialId = MATERIALS[0]!.id
      void app.savePrefs()
    }
  }

  isUser(id: string): boolean {
    return this.library.materials.some((m) => m.profile.id === id)
  }
}

export const photoFit = new PhotoFitState()

export interface FieldRow {
  label: string
  unit: string
  start: string
  fitted: string
  truth: string | null
  sigma: string | null
}

const fmtNum = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3))
const fmtLab = (c: { l: number; a: number; b: number }) => `${c.l.toFixed(1)} / ${c.a.toFixed(1)} / ${c.b.toFixed(1)}`

/** Rows for the review table: every field the fit can change, start → fitted (→ truth for a synthetic photo). */
export function fieldRows(start: MaterialProfile, fitted: MaterialProfile, truth: MaterialProfile | null, result: FitResult | null = null): FieldRow[] {
  const rows: FieldRow[] = []
  const r0 = start.response as unknown as Record<string, unknown>
  const r1 = fitted.response as unknown as Record<string, unknown>
  const rt = truth?.response as unknown as Record<string, unknown> | undefined
  const sigmaFor = (key: string) => {
    const p = result?.parameters.find((x) => x.name === key || x.name.startsWith(`${key} `))
    return p?.sigma != null && !p.name.includes('−') ? `±${fmtNum(p.sigma)}${p.constrained ? '' : ' (weak)'}` : null
  }
  const label = (k: string) =>
    k
      .replace(/MmPerJPerMm2$|JPerMm2$/, '')
      .replace(/([A-Z])/g, ' $1')
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase())
  for (const k of Object.keys(r1)) {
    if (k === 'kind') continue
    const v0 = r0[k]
    const v1 = r1[k]
    const vt = rt?.[k]
    if (typeof v1 === 'number')
      rows.push({ label: label(k), unit: k.endsWith('MmPerJPerMm2') ? 'mm per J/mm²' : k.endsWith('JPerMm2') ? 'J/mm²' : '', start: fmtNum(v0 as number), fitted: fmtNum(v1), truth: typeof vt === 'number' ? fmtNum(vt) : null, sigma: sigmaFor(k) })
    else if (v1 && typeof v1 === 'object')
      rows.push({ label: label(k), unit: 'L* / a* / b*', start: fmtLab(v0 as never), fitted: fmtLab(v1 as never), truth: vt ? fmtLab(vt as never) : null, sigma: null })
  }
  if (start.thermal.kind === 'peakTemperature' && fitted.thermal.kind === 'peakTemperature') {
    const p = result?.parameters.find((x) => x.name.startsWith('rampOnsetK'))
    rows.push({
      label: 'Ramp onset (thermal)',
      unit: 'K',
      start: fmtNum(start.thermal.rampOnsetK),
      fitted: fmtNum(fitted.thermal.rampOnsetK),
      truth: truth?.thermal.kind === 'peakTemperature' ? fmtNum(truth.thermal.rampOnsetK) : null,
      sigma: p?.sigma != null ? `±${fmtNum(p.sigma)}${p.constrained ? '' : ' (weak)'}` : null,
    })
  }
  if (start.fireRisk.kind === 'temperature' && fitted.fireRisk.kind === 'temperature')
    rows.push({
      label: 'Fire risk (bulk)',
      unit: 'K',
      start: fmtNum(start.fireRisk.thresholdK),
      fitted: fmtNum(fitted.fireRisk.thresholdK),
      truth: truth?.fireRisk.kind === 'temperature' ? fmtNum(truth.fireRisk.thresholdK) : null,
      sigma: result?.fire && Number.isFinite(result.fire.upperK) ? `in ${fmtNum(result.fire.lowerK)}–${fmtNum(result.fire.upperK)}` : null,
    })
  return rows
}

/**
 * Developer demo (VITE_ARIA_DEMO=photo-fit): the whole flow on a synthetic
 * photo for the active machine and a material, then save. Lets the desktop
 * app's path (planner samples, GPU thermal step, record files) be checked
 * without clicking.
 */
export async function runPhotoFitDemo(materialId: string | undefined): Promise<void> {
  const material = allMaterials().find((m) => m.id === materialId) ?? MATERIALS[0]!
  photoFit.begin(app.settings.machine, material)
  photoFit.name = `${material.name.replace(/\s*\(.*\)\s*$/, '')} — synthetic demo`
  await photoFit.makeSynthetic()
  if (!photoFit.analysis) return
  await photoFit.fit()
  if (!photoFit.result) return
  await photoFit.save()
}
