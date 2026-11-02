// SPDX-License-Identifier: GPL-3.0-or-later
// Placeholder preview: bins streamed samples' energy into a coarse grid so the
// Color and Height views show the dummy stream arriving. The real deposit,
// blur and response pipeline is the core's job (COD-264) and replaces this.
// The grid is a fixed 60 × 50 mm window; live jobs centre it where they start
// burning, so a job larger than that is clipped until COD-264's live tiling.

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
  /** Machine area the grid covers; live jobs move it to where they burn. */
  bounds = $state({ ...PREVIEW_BOUNDS_MM })

  reset() {
    this.bounds = { ...PREVIEW_BOUNDS_MM }
    this.energy.fill(0)
    this.max = 0
    this.samples = 0
    this.head = null
    this.jobTimeS = 0
    this.version++
  }

  /** Centres the (empty) grid on a point, keeping its size. */
  recenter(xMm: number, yMm: number) {
    const w = PREVIEW_BOUNDS_MM.maxX - PREVIEW_BOUNDS_MM.minX
    const h = PREVIEW_BOUNDS_MM.maxY - PREVIEW_BOUNDS_MM.minY
    const minX = Math.round(xMm - w / 2)
    const minY = Math.round(yMm - h / 2)
    this.bounds = { minX, minY, maxX: minX + w, maxY: minY + h }
  }

  add(b: SampleBatchView) {
    const { xMm, yMm, powerW, dtS, tRelS } = SAMPLE_FIELD_INDEX
    const { minX, maxY } = this.bounds
    let max = this.max
    for (let i = 0; i < b.sampleCount; i++) {
      const o = i * SAMPLE_FIELD_COUNT
      const cx = cell(b.f32[o + xMm]! - minX)
      const cy = cell(maxY - b.f32[o + yMm]!)
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
