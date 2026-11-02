// SPDX-License-Identifier: GPL-3.0-or-later
// App-wide state: settings, which screen is showing, and the dummy stream run.

import { isTauri, runDummyStream, type StreamRequest } from './ipc.ts'
import { preview } from './preview.svelte.ts'
import { defaultSettings, loadSettings, saveSettings, type Settings } from './settings.ts'

export type Screen = 'main' | 'settings'

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
  private nextJobId = 1

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

  /** Streams the demo job from Rust into the preview. */
  async runDemoStream(request: Partial<StreamRequest> = {}) {
    if (!isTauri()) {
      this.stream = { ...this.stream, state: 'error', errors: ['The sample stream needs the desktop app (pnpm tauri dev).'] }
      return
    }
    preview.reset()
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
