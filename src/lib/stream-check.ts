// SPDX-License-Identifier: GPL-3.0-or-later
// Receiving end of the sample stream: decodes batches with the core's decoder
// and checks them against plan.done (contiguous sequence, counts, energy).
// Pure, so it is unit-tested without a webview.

import {
  SAMPLE_FIELD_COUNT,
  SAMPLE_FIELD_INDEX,
  decodeSampleBatch,
  type ChannelEvent,
  type SampleBatchView,
} from 'aria-burn-core/contract'

type PlanDone = Extract<ChannelEvent['event'], { type: 'plan.done' }>

export interface StreamStats {
  batches: number
  samples: number
  bytes: number
  energyJ: number
  firstAtMs: number | null
  lastAtMs: number | null
}

export class StreamReceiver {
  readonly stats: StreamStats = { batches: 0, samples: 0, bytes: 0, energyJ: 0, firstAtMs: null, lastAtMs: null }
  readonly errors: string[] = []
  done: PlanDone | null = null
  private nextSeq = 0
  private nextEventSeq = 0
  private sawLast = false

  constructor(
    readonly jobId: number,
    private readonly onBatch: (batch: SampleBatchView) => void = () => {},
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** A raw sample batch from the binary Channel. */
  batch(buffer: ArrayBuffer): void {
    const t = this.now()
    this.stats.firstAtMs ??= t
    this.stats.lastAtMs = t
    let b: SampleBatchView
    try {
      b = decodeSampleBatch(buffer)
    } catch (e) {
      this.errors.push(String(e))
      return
    }
    if (b.jobId !== this.jobId) this.errors.push(`batch ${b.sequence}: jobId ${b.jobId}, expected ${this.jobId}`)
    if (b.sequence !== this.nextSeq) this.errors.push(`batch sequence ${b.sequence}, expected ${this.nextSeq}`)
    if (this.sawLast) this.errors.push(`batch ${b.sequence} after the last batch`)
    this.nextSeq = b.sequence + 1
    this.sawLast ||= b.last
    this.stats.energyJ = addEnergy(this.stats.energyJ, b)
    this.stats.batches++
    this.stats.samples += b.sampleCount
    this.stats.bytes += buffer.byteLength
    this.onBatch(b)
  }

  /** A JSON contract event from the events Channel. */
  event(msg: ChannelEvent): void {
    if (msg.seq !== this.nextEventSeq) this.errors.push(`event seq ${msg.seq}, expected ${this.nextEventSeq}`)
    this.nextEventSeq = msg.seq + 1
    if (msg.event.type === 'plan.done') this.done = msg.event
  }

  /** True once plan.done has arrived and every batch it announced has too. */
  get complete(): boolean {
    return this.done !== null && this.stats.batches >= this.done.batchCount
  }

  /** Problems with the finished stream; empty means it round-tripped intact. */
  verify(): string[] {
    const errors = [...this.errors]
    const d = this.done
    if (!d) return [...errors, 'no plan.done event']
    if (d.jobId !== this.jobId) errors.push(`plan.done jobId ${d.jobId}, expected ${this.jobId}`)
    if (this.stats.batches !== d.batchCount) errors.push(`${this.stats.batches} batches, plan.done says ${d.batchCount}`)
    if (this.stats.samples !== d.sampleCount) errors.push(`${this.stats.samples} samples, plan.done says ${d.sampleCount}`)
    if (!this.sawLast) errors.push('no batch carried the last flag')
    if (this.stats.energyJ !== d.energyJ) errors.push(`energy ${this.stats.energyJ} J, plan.done says ${d.energyJ} J`)
    return errors
  }
}

/**
 * Σ powerW × dtS, in the same order and precision as Rust (f32 fields widened
 * to f64, one running sum across batches), so plan.done's energyJ matches exactly.
 */
function addEnergy(total: number, b: SampleBatchView): number {
  const p = SAMPLE_FIELD_INDEX.powerW
  const dt = SAMPLE_FIELD_INDEX.dtS
  for (let i = 0; i < b.sampleCount; i++) {
    const o = i * SAMPLE_FIELD_COUNT
    total += b.f32[o + p]! * b.f32[o + dt]!
  }
  return total
}
