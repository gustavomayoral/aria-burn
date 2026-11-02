// SPDX-License-Identifier: GPL-3.0-or-later
// Placeholder preview: bins streamed samples' energy into a coarse grid so the
// Color and Height views show the dummy stream arriving. The real deposit,
// blur and response pipeline is the core's job (COD-264) and replaces this.

import { SAMPLE_FIELD_COUNT, SAMPLE_FIELD_INDEX, type SampleBatchView } from 'aria-burn-core/contract'

export const PREVIEW_BOUNDS_MM = { minX: 0, minY: 0, maxX: 60, maxY: 50 }
export const PREVIEW_PITCH_MM = 0.1

// Raster rows often sit exactly on cell edges; nudge so float error can't split them.
const cell = (mm: number) => Math.floor(mm / PREVIEW_PITCH_MM + 1e-3)

export class Preview {
  readonly width = Math.round((PREVIEW_BOUNDS_MM.maxX - PREVIEW_BOUNDS_MM.minX) / PREVIEW_PITCH_MM)
  readonly height = Math.round((PREVIEW_BOUNDS_MM.maxY - PREVIEW_BOUNDS_MM.minY) / PREVIEW_PITCH_MM)
  /** Energy per cell (J), row-major from the top-left (y grows downwards on screen). */
  readonly energy = new Float32Array(this.width * this.height)
  /** Bumped after each batch; views redraw on change. */
  version = $state(0)
  max = $state(0)
  samples = $state(0)
  /** Latest head position, for the canvas marker. */
  head = $state<{ xMm: number; yMm: number } | null>(null)
  jobTimeS = $state(0)

  reset() {
    this.energy.fill(0)
    this.max = 0
    this.samples = 0
    this.head = null
    this.jobTimeS = 0
    this.version++
  }

  add(b: SampleBatchView) {
    const { xMm, yMm, powerW, dtS, tRelS } = SAMPLE_FIELD_INDEX
    let max = this.max
    for (let i = 0; i < b.sampleCount; i++) {
      const o = i * SAMPLE_FIELD_COUNT
      const cx = cell(b.f32[o + xMm]! - PREVIEW_BOUNDS_MM.minX)
      const cy = cell(PREVIEW_BOUNDS_MM.maxY - b.f32[o + yMm]!)
      if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) continue
      const k = cy * this.width + cx
      const v = (this.energy[k]! += b.f32[o + powerW]! * b.f32[o + dtS]!)
      if (v > max) max = v
    }
    if (b.sampleCount > 0) {
      const o = (b.sampleCount - 1) * SAMPLE_FIELD_COUNT
      this.head = { xMm: b.f32[o + xMm]!, yMm: b.f32[o + yMm]! }
      this.jobTimeS = b.t0S + b.f32[o + tRelS]!
    }
    this.max = max
    this.samples += b.sampleCount
    this.version++
  }
}

export const preview = new Preview()
