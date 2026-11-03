// SPDX-License-Identifier: GPL-3.0-or-later
// Burn engine: the core simulator (aria-burn-core, COD-264/258) behind the
// canvas. Owns the WebGL2 context, the sample store of the current job, the
// hover reader and the burn view (COD-259), and decides what to run:
//   coarse  scrub drags, playback and live streaming: the ≤ 1024² preview
//   full    job load, scrub release, live plan.done: every tile at full res
//   detail  zoomed past the overview's resolution: a 1:1 window of the grid
// Nothing runs per frame. Runs happen on change, and draws only redraw.

import {
  CellReader,
  GlBurnView,
  GlSim,
  LiveJob,
  SampleStore,
  Verdict,
  decodeSampleBatch,
  fireSpots,
  overviewLayer,
  peakTemperatureModel,
  setupJob,
  visibleCells,
  type BurnLayer,
  type BurnViewport,
  type CellReadout,
  type ChannelEvent,
  type Diagnostic,
  type FireSpot,
  type Heightmap,
  type JobModel,
  type MachineProfile,
  type MaterialProfile,
  type SimSetup,
} from 'aria-burn-core'
import { isTauri, openJob, type JobInput } from './ipc.ts'

export type JobKind = 'file' | 'live'
/** What the canvas shows: no job, a job being read or simulated, a burn, or why there is none. */
export type BurnStatus = 'empty' | 'parsing' | 'planning' | 'thermal' | 'ready' | 'error'

export interface JobInfo {
  kind: JobKind
  jobId: number
  name: string
  model: JobModel | null
  /** Parser diagnostics (file jobs) or stream errors. */
  diagnostics: Diagnostic[]
  /** plan.done durationS; null while planning or streaming. */
  durationS: number | null
  samples: number
  batches: number
  /** plan.done counts didn't match what arrived. */
  mismatch: string | null
  /** Live: the stream was cut short (error code). */
  aborted: string | null
}

export interface GridInfo {
  widthMm: number
  heightMm: number
  pitchMm: number
  cells: [number, number]
  tiles: [number, number]
  /** Tile cores in mm, for the minimap. */
  tileRects: { col: number; row: number; minX: number; minY: number; maxX: number; maxY: number }[]
}

export interface ViewOptions {
  relief: boolean
  overlay: boolean
}

/** A view in CSS pixels; the engine scales by devicePixelRatio for the GL canvas. */
export interface View {
  centerXMm: number
  centerYMm: number
  /** mm per CSS pixel. */
  mmPerPx: number
}

/** Wall time of the last runs (ms, CPU submit + sync), for the performance report. */
export interface RunTimes {
  coarse: number | null
  full: number | null
  detail: number | null
  draw: number | null
}

/** Zoom limits: at most 12 device pixels per grid cell. */
const MAX_DEVICE_PX_PER_CELL = 12
/** Detail runs wait for the view to settle. */
const DETAIL_DELAY_MS = 120
/** Full-res pass after the scrub stops moving. */
const RELEASE_DELAY_MS = 180
/** Playback speed: whole job in this many seconds of wall time. */
const PLAY_SECONDS = 12

let nextFileJobId = 1_000_000

const DIAG_LIMIT = 200

class BurnEngine {
  status = $state<BurnStatus>('empty')
  job = $state<JobInfo | null>(null)
  /** Scrub position in [0, 1] of the job (file) or the streamed head (live). */
  progress = $state(1)
  /** Live: the scrub tracks the stream head. */
  follow = $state(true)
  playing = $state(false)
  /** The canvas shows the coarse preview (scrub, playback, live), not full resolution. */
  coarseShown = $state(false)
  /** A full-res or detail run is queued or running. */
  rendering = $state(false)
  view = $state<View>({ centerXMm: 0, centerYMm: 0, mmPerPx: 0.1 })
  /** Fit view's mm per CSS pixel; zoom is relative to it. */
  fitMmPerPx = $state(0.1)
  hover = $state<{ xMm: number; yMm: number; readout: CellReadout | null } | null>(null)
  grid = $state<GridInfo | null>(null)
  /** Largest fire-risk patch at the current cutoff, if any. */
  fire = $state<FireSpot | null>(null)
  /** Verdict buckets present at the current cutoff (legend). */
  verdicts = $state<number[]>([])
  /** Streamed head (s) of a live job; equals durationS once done. */
  headS = $state(0)
  /** Bumped after each run, for views that read results (Height view). */
  version = $state(0)
  /** Deepest cut in the Height view's heightmap (mm), for its depth scale. */
  depthMaxMm = $state(0)
  glError = $state<string | null>(null)
  times = $state<RunTimes>({ coarse: null, full: null, detail: null, draw: null })
  canvasSize = $state({ width: 0, height: 0 })

  private canvas: HTMLCanvasElement | null = null
  private sim: GlSim | null = null
  private burn: GlBurnView | null = null
  private store: SampleStore | null = null
  private setup: SimSetup | null = null
  private reader: CellReader | null = null
  private live: LiveJob | null = null
  private machine: MachineProfile | null = null
  private material: MaterialProfile | null = null
  private options: ViewOptions = { relief: true, overlay: false }
  private dpr = 1
  private frame = 0
  private pending = { coarse: false, full: false, detail: false, draw: false }
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private detailTimer: ReturnType<typeof setTimeout> | null = null
  private liveTimer: ReturnType<typeof setTimeout> | null = null
  private lastLiveRunMs = 0
  private playStart: { t: number; progress: number } | null = null
  private userMoved = false
  /** Measure GPU time with a sync after each run (costs a stall); on for the perf report. */
  measure = false

  // ── Setup ────────────────────────────────────────────────────────────

  /** Binds the canvas (once per mount). WebGL2 + EXT_color_buffer_float are required. */
  attach(canvas: HTMLCanvasElement): void {
    if (this.canvas === canvas) return
    this.detach()
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true })
    if (!gl) {
      this.glError = 'WebGL2 is not available, so the burn can’t be simulated on this computer.'
      return
    }
    try {
      this.sim = new GlSim(gl)
      this.burn = new GlBurnView(this.sim)
      this.glError = null
    } catch (e) {
      this.glError = String(e instanceof Error ? e.message : e)
      return
    }
    if (this.material) this.burn.setMaterial(this.material)
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.glError = 'The graphics context was lost. Reopen the job to continue.'
    })
    if (this.store && this.setup) this.queue('full')
    else this.queue('draw')
  }

  detach(): void {
    this.burn?.dispose()
    this.sim?.releaseTargets()
    this.burn = null
    this.sim = null
    this.canvas = null
  }

  /** Canvas size changed (CSS px). */
  resize(width: number, height: number, dpr: number): void {
    if (!this.canvas) return
    this.dpr = dpr
    this.canvas.width = Math.max(1, Math.round(width * dpr))
    this.canvas.height = Math.max(1, Math.round(height * dpr))
    this.canvasSize = { width, height }
    this.updateFit()
    if (!this.userMoved) this.fit()
    this.queue('draw')
    this.scheduleDetail()
  }

  /** Machine profile or material changed: new pitch, kernel or response, so rerun. */
  configure(machine: MachineProfile, material: MaterialProfile): void {
    const machineChanged = JSON.stringify(machine) !== JSON.stringify(this.machine)
    const materialChanged = material.id !== this.material?.id
    if (!machineChanged && !materialChanged) return
    this.machine = $state.snapshot(machine) as MachineProfile
    this.material = material
    this.burn?.setMaterial(material)
    this.rebuildSetup()
    if (this.setup) this.queue(this.live?.streaming ? 'coarse' : 'full')
    else this.queue('draw')
  }

  setOptions(options: ViewOptions): void {
    this.options = { ...options }
    if (options.overlay) this.refreshSummary()
    this.queue('draw')
  }

  // ── File jobs ────────────────────────────────────────────────────────

  /** Opens a G-code file: Rust parses and plans it (aria-burn-gcode → GRBL planner), samples stream back. */
  async openFile(input: JobInput, planErrors = false): Promise<void> {
    if (!this.machine) return
    if (!isTauri()) {
      this.fail('file', input.kind === 'path' ? input.path : input.name, 'Opening G-code needs the desktop app (pnpm tauri dev).')
      return
    }
    const jobId = nextFileJobId++
    this.reset()
    const name = input.kind === 'path' ? (input.path.split(/[\\/]/).pop() ?? input.path) : input.name
    this.job = { kind: 'file', jobId, name, model: null, diagnostics: [], durationS: null, samples: 0, batches: 0, mismatch: null, aborted: null }
    this.status = 'parsing'
    const store = (this.store = new SampleStore(jobId))
    this.lastInput = input
    this.planErrors = planErrors
    try {
      await openJob(
        { jobId, input, profile: this.machine, planErrors },
        (msg) => this.onFileEvent(jobId, msg),
        (buf) => {
          if (this.store !== store) return
          const b = decodeSampleBatch(buf)
          if (b.jobId !== jobId) return
          store.append(b)
          this.job!.samples = store.count
          this.job!.batches = store.batchCount
        },
      )
    } catch (e) {
      if (this.job?.jobId === jobId) this.fail('file', name, String(e))
    }
  }

  private lastInput: JobInput | null = null
  private planErrors = false

  /** Re-opens the last file with its failing lines dropped (as GRBL drops them). */
  simulateAnyway(): Promise<void> {
    return this.lastInput ? this.openFile(this.lastInput, true) : Promise.resolve()
  }

  private onFileEvent(jobId: number, msg: ChannelEvent): void {
    const job = this.job
    if (!job || job.jobId !== jobId) return
    const e = msg.event
    switch (e.type) {
      case 'job.loaded': {
        job.model = e.job
        job.name = e.job.source.name
        job.diagnostics = e.job.diagnostics.slice(0, DIAG_LIMIT)
        const errors = e.job.diagnostics.some((d) => d.severity === 'error')
        if (!e.job.burnBounds) {
          this.status = 'error'
          job.diagnostics = [
            ...job.diagnostics,
            { severity: 'error', code: 'nothing-burns', line: 0, message: 'No move fires the laser (G1 with M3/M4 and S > 0), so there is nothing to simulate.' },
          ]
        } else if (errors && !this.planErrors) this.status = 'error'
        break
      }
      case 'plan.started':
        this.status = 'planning'
        break
      case 'plan.done': {
        job.durationS = e.durationS
        this.headS = e.durationS
        const store = this.store!
        // Events and batches share no ordering across Channels; wait for the last batch.
        const settle = () => {
          if (this.job?.jobId !== jobId) return
          if (store.count < e.sampleCount && !store.lastBatchSeen) return void setTimeout(settle, 16)
          if (store.count !== e.sampleCount || store.batchCount !== e.batchCount)
            job.mismatch = `${store.batchCount}/${e.batchCount} batches, ${store.count}/${e.sampleCount} samples arrived`
          void this.loaded()
        }
        settle()
        break
      }
      case 'error':
        job.diagnostics = [...job.diagnostics, { severity: 'error', code: e.code, line: 0, message: e.message }]
        this.status = 'error'
        break
    }
  }

  /** All samples are in: set up the grid and run full resolution at the end of the job. */
  private async loaded(): Promise<void> {
    this.progress = 1
    this.rebuildSetup()
    if (!this.setup) return
    if (this.material && peakTemperatureModel(this.material)) {
      this.status = 'thermal'
      // Let the "Computing heat build-up" state paint before the thermal step blocks.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    }
    this.userMoved = false
    this.updateFit()
    this.fit()
    this.queue('full')
  }

  private fail(kind: JobKind, name: string, message: string): void {
    this.job = { kind, jobId: 0, name, model: null, diagnostics: [{ severity: 'error', code: 'open-failed', line: 0, message }], durationS: null, samples: 0, batches: 0, mismatch: null, aborted: null }
    this.status = 'error'
  }

  /** Back to the empty state (drops the job and its GPU results). */
  reset(): void {
    this.stopPlay()
    this.clearTimers()
    this.store = null
    this.setup = null
    this.reader = null
    this.live = null
    this.job = null
    this.grid = null
    this.fire = null
    this.verdicts = []
    this.hover = null
    this.headS = 0
    this.progress = 1
    this.follow = true
    this.coarseShown = false
    this.rendering = false
    this.status = 'empty'
    this.burn?.dispose()
    this.sim?.releaseTargets()
    if (this.sim) {
      this.burn = new GlBurnView(this.sim)
      if (this.material) this.burn.setMaterial(this.material)
    }
    this.queue('draw')
  }

  // ── Live jobs (GRBL emulator) ────────────────────────────────────────

  /** Every event from the emulator's event channel. */
  liveEvent(msg: ChannelEvent): void {
    const e = msg.event
    if (e.type === 'job.streaming' || e.type === 'plan.started') this.beginLive(e.jobId, e.type === 'job.streaming' ? e.name : null)
    const live = this.live
    if (!live || !('jobId' in e) || e.jobId !== live.jobId) return
    live.onEvent(e)
    const job = this.job!
    switch (e.type) {
      case 'job.loaded':
        job.model = e.job
        job.name = e.job.source.name
        // Keep stream errors (an abort comes before job.loaded) after the parser's diagnostics.
        job.diagnostics = [...e.job.diagnostics.slice(0, DIAG_LIMIT), ...job.diagnostics.filter((d) => d.line === 0)]
        break
      case 'plan.done':
        job.durationS = e.durationS
        this.headS = live.headS()
        if (live.store.count !== e.sampleCount) job.mismatch = `${live.store.count}/${e.sampleCount} samples arrived`
        this.rebuildSetup()
        // The job is complete: full resolution at whatever cutoff the scrub shows.
        if (this.follow) this.progress = 1
        this.queue('full')
        break
      case 'error':
        job.aborted = e.code
        job.diagnostics = [...job.diagnostics, { severity: 'error', code: e.code, line: 0, message: e.message }]
        break
    }
  }

  /** Every buffer from the emulator's sample channel. */
  liveBatch(buffer: ArrayBuffer): void {
    const b = decodeSampleBatch(buffer)
    this.beginLive(b.jobId, null)
    const live = this.live!
    if (b.jobId !== live.jobId) return
    live.store.append(b)
    this.job!.samples = live.store.count
    this.job!.batches = live.store.batchCount
    this.headS = live.headS()
    this.scheduleLive()
  }

  /** A new network job replaces whatever was shown (reset between jobs). */
  private beginLive(jobId: number, name: string | null): void {
    if (this.live?.jobId === jobId) {
      if (name) this.job!.name = name
      return
    }
    if (!this.machine || !this.material) return
    this.reset()
    this.live = new LiveJob(jobId, name ?? `Live job ${jobId}`, this.machine, this.material)
    this.store = this.live.store
    this.job = { kind: 'live', jobId, name: this.live.name, model: null, diagnostics: [], durationS: null, samples: 0, batches: 0, mismatch: null, aborted: null }
    this.status = 'ready'
    this.follow = true
  }

  /**
   * Live refresh, throttled to the cost of the last run: the next one waits at
   * least twice as long as the last took, so the GPU is busy ≤ 1/3 of the time
   * (thermal materials rerun the thermal step on every refresh, COD-258).
   */
  private scheduleLive(): void {
    if (this.liveTimer) return
    const wait = Math.max(100, 2 * this.lastLiveRunMs)
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null
      const grew = this.rebuildSetup()
      if (grew && !this.userMoved) {
        this.updateFit()
        this.fit()
      }
      if (this.follow) this.progress = 1
      this.queue('coarse')
    }, wait)
  }

  // ── Scrub and playback ───────────────────────────────────────────────

  /** Timeline length (s): the job's duration, or the streamed head while live. */
  get totalS(): number {
    return this.job?.durationS ?? this.headS
  }

  cutoffS(): number {
    if (this.live && !this.job?.durationS) return this.live.cutoffS(this.progress, this.follow)
    return this.progress >= 1 ? Infinity : this.progress * this.totalS
  }

  /** Scrub drag: coarse preview now, full resolution once it settles. */
  scrub(progress: number): void {
    this.stopPlay()
    this.progress = Math.min(1, Math.max(0, progress))
    if (this.job?.kind === 'live') this.follow = this.progress >= 1
    this.queue('coarse')
    this.scheduleRelease()
  }

  setFollow(follow: boolean): void {
    this.follow = follow
    if (follow) this.scrub(1)
  }

  togglePlay(): void {
    if (this.playing) return this.stopPlay(true)
    if (!this.setup || this.job?.kind === 'live') return
    if (this.progress >= 1) this.progress = 0
    this.playing = true
    this.playStart = { t: performance.now(), progress: this.progress }
    const step = () => {
      if (!this.playing || !this.playStart) return
      const p = this.playStart.progress + (performance.now() - this.playStart.t) / 1000 / PLAY_SECONDS
      this.progress = Math.min(1, p)
      this.queue('coarse')
      if (p >= 1) this.stopPlay(true)
      else requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  private stopPlay(release = false): void {
    if (!this.playing) return
    this.playing = false
    this.playStart = null
    if (release) this.scheduleRelease()
  }

  private scheduleRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.rendering = true
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null
      if (!this.playing) this.queue('full')
    }, RELEASE_DELAY_MS)
  }

  // ── View: pan, zoom, fit ─────────────────────────────────────────────

  private updateFit(): void {
    const b = this.setup?.grid
    const { width, height } = this.canvasSize
    if (!b || width <= 0 || height <= 0) return
    const wMm = b.width * b.pitchMm
    const hMm = b.height * b.pitchMm
    this.fitMmPerPx = Math.max(wMm / width, hMm / height) * 1.06
  }

  fit(): void {
    const g = this.setup?.grid
    if (!g) return
    this.setView({ centerXMm: g.originXMm + (g.width * g.pitchMm) / 2, centerYMm: g.originYMm + (g.height * g.pitchMm) / 2, mmPerPx: this.fitMmPerPx }, false)
  }

  /** Smallest mm per CSS pixel allowed. */
  get minMmPerPx(): number {
    const pitch = this.setup?.grid.pitchMm ?? 0.01
    return pitch / (MAX_DEVICE_PX_PER_CELL / this.dpr)
  }

  /** mm per CSS pixel at which one grid cell is one device pixel (1:1 grid pitch). */
  get pitchMmPerPx(): number {
    return (this.setup?.grid.pitchMm ?? 0.01) * this.dpr
  }

  setView(v: View, user = true): void {
    const mmPerPx = Math.min(this.fitMmPerPx * 2, Math.max(this.minMmPerPx, v.mmPerPx))
    this.view = { centerXMm: v.centerXMm, centerYMm: v.centerYMm, mmPerPx }
    if (user) this.userMoved = true
    this.queue('draw')
    this.scheduleDetail()
  }

  /** Zoom by `factor` keeping the mm point under (px, py) (CSS px from the canvas top-left) fixed. */
  zoomAt(factor: number, px?: number, py?: number): void {
    const v = this.view
    const { width, height } = this.canvasSize
    const ax = px ?? width / 2
    const ay = py ?? height / 2
    const target = Math.min(this.fitMmPerPx * 2, Math.max(this.minMmPerPx, v.mmPerPx / factor))
    const mx = v.centerXMm + (ax - width / 2) * v.mmPerPx
    const my = v.centerYMm - (ay - height / 2) * v.mmPerPx
    this.setView({ centerXMm: mx - (ax - width / 2) * target, centerYMm: my + (ay - height / 2) * target, mmPerPx: target })
  }

  panBy(dxPx: number, dyPx: number): void {
    const v = this.view
    this.setView({ ...v, centerXMm: v.centerXMm - dxPx * v.mmPerPx, centerYMm: v.centerYMm + dyPx * v.mmPerPx })
  }

  /** Centres a mm rect, zoomed so it fills about 60 % of the canvas. */
  focus(rect: { minX: number; minY: number; maxX: number; maxY: number }, minSizeMm = 2): void {
    const { width, height } = this.canvasSize
    const w = Math.max(minSizeMm, rect.maxX - rect.minX)
    const h = Math.max(minSizeMm, rect.maxY - rect.minY)
    this.setView({ centerXMm: (rect.minX + rect.maxX) / 2, centerYMm: (rect.minY + rect.maxY) / 2, mmPerPx: Math.max(w / width, h / height) / 0.6 })
  }

  /** CSS px → machine mm. */
  toMm(px: number, py: number): { xMm: number; yMm: number } {
    const v = this.view
    const { width, height } = this.canvasSize
    return { xMm: v.centerXMm + (px - width / 2) * v.mmPerPx, yMm: v.centerYMm - (py - height / 2) * v.mmPerPx }
  }

  /** Machine mm → CSS px. */
  toPx(xMm: number, yMm: number): { x: number; y: number } {
    const v = this.view
    const { width, height } = this.canvasSize
    return { x: width / 2 + (xMm - v.centerXMm) / v.mmPerPx, y: height / 2 - (yMm - v.centerYMm) / v.mmPerPx }
  }

  private scheduleDetail(): void {
    if (this.detailTimer) clearTimeout(this.detailTimer)
    this.burn?.clearDetail()
    if (!this.wantsDetail()) return
    this.rendering = true
    this.detailTimer = setTimeout(() => {
      this.detailTimer = null
      this.queue('detail')
    }, DETAIL_DELAY_MS)
  }

  /** Zoomed in past what the overview resolves (or the job is small enough to show 1:1 anyway). */
  private wantsDetail(): boolean {
    if (!this.burn || !this.setup || this.coarseShown) return false
    const full = overviewLayer(this.burn.full)
    if (!full) return false
    return this.view.mmPerPx / this.dpr < full.texelMm * 0.999
  }

  /** Head position at the cutoff: the last sample that has burned. */
  headAt(): { xMm: number; yMm: number } | null {
    const s = this.store
    const n = s ? s.countUntil(this.cutoffS()) : 0
    if (!s || n <= 0) return null
    return { xMm: s.xye[(n - 1) * 3]!, yMm: s.xye[(n - 1) * 3 + 1]! }
  }

  // ── Hover ────────────────────────────────────────────────────────────

  hoverAt(px: number, py: number): void {
    const { xMm, yMm } = this.toMm(px, py)
    const readout = this.reader?.readAt(xMm, yMm, this.cutoffS()) ?? null
    this.hover = { xMm, yMm, readout }
  }

  clearHover(): void {
    this.hover = null
  }

  // ── Results for other views ──────────────────────────────────────────

  /** The layer the canvas shows. */
  private baseLayer(): BurnLayer | null {
    if (!this.burn) return null
    return (this.coarseShown ? overviewLayer(this.burn.coarse) : null) ?? overviewLayer(this.burn.full)
  }

  heightmap(maxSide = 768): Heightmap | null {
    const layer = this.baseLayer()
    return layer && this.burn ? this.burn.heightmap(layer, maxSide) : null
  }

  /** The shaded burn at the overview's resolution (≤ 4096²), rows top-down. */
  colorImage(): { width: number; height: number; rgba: Uint8Array } | null {
    const layer = this.burn ? overviewLayer(this.burn.full) : null
    return layer && this.burn ? this.burn.renderImage(layer, { ...this.options, halo: true }) : null
  }

  // ── Run loop ─────────────────────────────────────────────────────────

  private queue(what: keyof BurnEngine['pending']): void {
    this.pending[what] = true
    if (!this.frame) this.frame = requestAnimationFrame(() => this.tick())
  }

  private clearTimers(): void {
    for (const t of [this.releaseTimer, this.detailTimer, this.liveTimer]) if (t) clearTimeout(t)
    this.releaseTimer = this.detailTimer = this.liveTimer = null
  }

  /** Returns true when the job grid grew (live). */
  private rebuildSetup(): boolean {
    const store = this.store
    if (!store || !this.machine || !this.material) return false
    const before = this.setup?.grid
    // Live jobs tile on the absolute lattice until job.loaded (contract live.ts), like LiveJob.setup().
    const model = this.live ? this.live.job : this.job?.model
    const bounds = model?.burnBounds ?? store.burnBounds
    this.setup = bounds ? setupJob(bounds, this.machine, this.material, { tiling: this.live && !model ? 'live' : 'regular' }) : null
    const setup = this.setup
    if (!setup) return false
    if (this.reader) this.reader.setSetup(setup)
    else this.reader = new CellReader(store, setup)
    const { grid, plan } = setup
    this.grid = {
      widthMm: grid.width * grid.pitchMm,
      heightMm: grid.height * grid.pitchMm,
      pitchMm: grid.pitchMm,
      cells: [grid.width, grid.height],
      tiles: [plan.cols, plan.rows],
      tileRects: plan.tiles.map((t) => ({
        col: t.col,
        row: t.row,
        minX: grid.originXMm + t.core.x * grid.pitchMm,
        minY: grid.originYMm + t.core.y * grid.pitchMm,
        maxX: grid.originXMm + (t.core.x + t.core.width) * grid.pitchMm,
        maxY: grid.originYMm + (t.core.y + t.core.height) * grid.pitchMm,
      })),
    }
    return !before || before.width !== grid.width || before.height !== grid.height || before.originXMm !== grid.originXMm
  }

  private timed(work: () => void): number {
    const t0 = performance.now()
    work()
    if (this.measure) this.sim?.sync()
    return performance.now() - t0
  }

  private tick(): void {
    this.frame = 0
    const p = this.pending
    const burn = this.burn
    if (!burn || this.glError) return
    const store = this.store
    const setup = this.setup
    try {
      if (store && setup && store.count > 0) {
        if (p.full) {
          p.full = p.coarse = false
          this.times.full = this.timed(() => burn.runFull(store, setup, this.cutoffS()))
          this.coarseShown = false
          this.status = 'ready'
          this.refreshSummary()
          this.version++
          this.scheduleDetail()
          if (!this.detailTimer) this.rendering = false
          p.draw = true
        } else if (p.coarse) {
          p.coarse = false
          burn.clearDetail()
          const ms = this.timed(() => burn.runCoarse(store, setup, this.cutoffS()))
          this.times.coarse = ms
          if (this.live) this.lastLiveRunMs = ms
          this.coarseShown = true
          if (this.status === 'thermal') this.status = 'ready'
          if (this.live) this.refreshSummary()
          this.version++
          p.draw = true
        }
        if (p.detail) {
          p.detail = false
          const rect = this.canvasSize.width ? visibleCells(setup.grid, this.deviceView(), this.canvas!.width, this.canvas!.height) : null
          if (rect && this.wantsDetail()) this.times.detail = this.timed(() => burn.runDetail(store, setup, rect, this.cutoffS()))
          this.rendering = false
          p.draw = true
        }
      }
      if (p.draw) {
        p.draw = false
        const t0 = performance.now()
        burn.draw(this.baseLayer(), this.coarseShown ? null : burn.detail, this.deviceView(), { ...this.options, halo: true })
        this.times.draw = performance.now() - t0
      }
    } catch (e) {
      this.glError = String(e instanceof Error ? e.message : e)
      console.error(e)
    }
  }

  private deviceView(): BurnViewport {
    return { centerXMm: this.view.centerXMm, centerYMm: this.view.centerYMm, mmPerPx: this.view.mmPerPx / this.dpr }
  }

  /** Fire-risk spot and legend buckets from a small readback of the shown layer. */
  private refreshSummary(): void {
    const layer = this.baseLayer()
    if (!layer || !this.burn) return
    const s = this.burn.summary(layer, 256)
    const present = new Set<number>()
    for (const v of s.verdict) present.add(v)
    present.delete(Verdict.Untouched)
    this.verdicts = [...present].sort()
    this.fire = present.has(Verdict.FireRisk) ? (fireSpots(s.verdict, s.width, s.height, s.originXMm, s.originYMm, s.texelMm)[0] ?? null) : null
  }
}

export const burn = new BurnEngine()

/** For the performance report and debugging from the devtools console. */
if (typeof window !== 'undefined') (window as unknown as { __burn: BurnEngine }).__burn = burn
