// SPDX-License-Identifier: GPL-3.0-or-later
// App-wide state: settings, which screen is showing, the dummy stream run,
// and live jobs from the GRBL network emulator.

import { SAMPLE_FIELD_INDEX, decodeSampleBatch, type ChannelEvent } from 'aria-burn-core/contract'
import { configureEmulator, emulatorSettings, subscribeEmulator, type ConnectionStatus } from './emulator.ts'
import { isTauri, runDummyStream, type StreamRequest } from './ipc.ts'
import { preview } from './preview.svelte.ts'
import { defaultSettings, loadSettings, saveSettings, type Settings } from './settings.ts'

export type Screen = 'main' | 'settings'
export type JobSource = 'file' | 'live'

type EventOf<T extends ChannelEvent['event']['type']> = Extract<ChannelEvent['event'], { type: T }>
export type MachineStatus = EventOf<'machine.status'>

/** A job streamed over the emulator, as the webview has received it so far. */
export interface LiveJob {
  jobId: number
  batches: number
  samples: number
  /** From job.streaming. */
  name: string | null
  /** Latest job.progress: running totals while it streams. */
  progress: EventOf<'job.progress'> | null
  /** From job.loaded, when the stream ends. */
  lineCount: number | null
  bounds: { widthMm: number; heightMm: number } | null
  /** From plan.done. */
  done: EventOf<'plan.done'> | null
  errors: string[]
}

/** The demo job: 300 raster rows of the dummy pattern, one batch per row (~13 MB). */
export const DEMO_STREAM = { batchCount: 300, samplesPerBatch: 1600, paceMs: 8 } as const
/** Sample spacing of the dummy job (SAMPLE_DT_MAX_S). */
const DEMO_DT_S = 0.0005
export const DEMO_DURATION_S = DEMO_STREAM.batchCount * DEMO_STREAM.samplesPerBatch * DEMO_DT_S

export interface StreamStatus {
  state: 'idle' | 'running' | 'done' | 'error'
  batches: number
  samples: number
  mb: number
  seconds: number
  errors: string[]
}

class AppState {
  settings = $state<Settings>(defaultSettings())
  screen = $state<Screen>('main')
  loaded = $state(false)
  warnings = $state<string[]>([])
  stream = $state<StreamStatus>({ state: 'idle', batches: 0, samples: 0, mb: 0, seconds: 0, errors: [] })
  source = $state<JobSource>('file')
  connection = $state<ConnectionStatus>({ state: 'stopped' })
  machine = $state<MachineStatus | null>(null)
  live = $state<LiveJob | null>(null)
  private nextJobId = 1
  private nextEventSeq = 0

  async load() {
    const { settings, warnings } = await loadSettings()
    this.settings = settings
    this.warnings = warnings
    this.loaded = true
  }

  /** Persists the current settings; throws if the machine profile is invalid. */
  save = () => saveSettings(this.settings)

  /** UI preferences save as they change, no Save button needed. */
  async savePrefs() {
    try {
      await saveSettings(this.settings)
    } catch {
      // An invalid machine profile blocks saving; the settings screen reports it.
    }
  }

  /** Opens the emulator's Channels and applies the network settings. */
  async startEmulator() {
    if (!isTauri()) return
    await subscribeEmulator({
      event: (msg) => this.onLiveEvent(msg),
      batch: (buf) => this.onLiveBatch(buf),
      status: (status) => (this.connection = status),
    })
    await this.applyEmulator()
  }

  /** Starts, restarts or stops the emulator to match the settings. */
  async applyEmulator() {
    if (!isTauri()) return
    try {
      this.connection = await configureEmulator(emulatorSettings(this.settings.network, this.settings.machine))
    } catch (e) {
      this.connection = { state: 'failed', address: `port ${this.settings.network.port}`, message: String(e) }
    }
  }

  /** A live job's first sample (batch or plan.started, whichever comes first). */
  private beginLive(jobId: number) {
    if (this.live?.jobId === jobId) return
    preview.reset()
    this.source = 'live'
    this.live = { jobId, batches: 0, samples: 0, name: null, progress: null, lineCount: null, bounds: null, done: null, errors: [] }
  }

  private onLiveEvent(msg: ChannelEvent) {
    // Events and batches travel on separate Channels, so either can come first.
    if (msg.seq !== this.nextEventSeq && msg.event.type !== 'hello') this.live?.errors.push(`event seq ${msg.seq}, expected ${this.nextEventSeq}`)
    this.nextEventSeq = msg.seq + 1
    const e = msg.event
    switch (e.type) {
      case 'machine.status':
        this.machine = e
        break
      case 'job.streaming':
        this.beginLive(e.jobId)
        this.live!.name = e.name
        break
      case 'plan.started':
        this.beginLive(e.jobId)
        break
      case 'job.progress':
        if (this.live?.jobId === e.jobId) {
          this.live.progress = e
          this.live.lineCount = e.lineCount
        }
        break
      case 'job.loaded':
        if (this.live?.jobId === e.jobId) {
          const b = e.job.burnBounds ?? e.job.bounds
          this.live.name = e.job.source.name
          this.live.lineCount = e.job.source.lineCount
          this.live.bounds = { widthMm: b.maxXMm - b.minXMm, heightMm: b.maxYMm - b.minYMm }
        }
        break
      case 'plan.done':
        if (this.live?.jobId === e.jobId) this.live.done = e
        break
      case 'error':
        if (this.live && (e.jobId === null || e.jobId === this.live.jobId)) this.live.errors.push(e.message)
        else this.warnings = [...this.warnings, e.message]
        break
    }
  }

  private onLiveBatch(buffer: ArrayBuffer) {
    let b
    try {
      b = decodeSampleBatch(buffer)
    } catch (e) {
      this.live?.errors.push(String(e))
      return
    }
    this.beginLive(b.jobId)
    const live = this.live!
    if (b.sequence !== live.batches) live.errors.push(`batch sequence ${b.sequence}, expected ${live.batches}`)
    if (live.batches === 0 && b.sampleCount > 0) {
      // Placeholder preview window: centred on where the job starts burning.
      preview.recenter(b.f32[SAMPLE_FIELD_INDEX.xMm]!, b.f32[SAMPLE_FIELD_INDEX.yMm]!)
    }
    preview.add(b)
    live.batches++
    live.samples += b.sampleCount
  }

  /** Streams the demo job from Rust into the preview. */
  async runDemoStream(request: Partial<StreamRequest> = {}) {
    if (!isTauri()) {
      this.stream = { ...this.stream, state: 'error', errors: ['The sample stream needs the desktop app (pnpm tauri dev).'] }
      return
    }
    preview.reset()
    this.source = 'file'
    this.stream = { state: 'running', batches: 0, samples: 0, mb: 0, seconds: 0, errors: [] }
    try {
      const run = await runDummyStream(
        { jobId: this.nextJobId++, ...DEMO_STREAM, ...request },
        (batch) => {
          preview.add(batch)
          this.stream.batches++
          this.stream.samples += batch.sampleCount
        },
      )
      const { stats } = run.receiver
      this.stream = {
        state: run.errors.length ? 'error' : 'done',
        batches: stats.batches,
        samples: stats.samples,
        mb: stats.bytes / 1e6,
        seconds: run.seconds,
        errors: run.errors,
      }
    } catch (e) {
      this.stream = { ...this.stream, state: 'error', errors: [String(e)] }
    }
  }
}

export const app = new AppState()
