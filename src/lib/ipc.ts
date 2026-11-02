// SPDX-License-Identifier: GPL-3.0-or-later
// Typed wrappers over the Rust commands. Samples arrive as raw ArrayBuffers on
// one Channel, contract events as JSON on another (COD-252: batched, never one
// message per G-code line).

import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import type { ChannelEvent, SampleBatchView } from 'aria-burn-core/contract'
import { StreamReceiver } from './stream-check.ts'

export { isTauri }

/** Mirrors `StreamRequest` in src-tauri/src/stream.rs. */
export interface StreamRequest {
  jobId: number
  batchCount: number
  samplesPerBatch: number
  paceMs?: number | null
}

export interface StreamRun {
  receiver: StreamReceiver
  /** From the invoke to the last batch (or plan.done, if later). */
  seconds: number
  errors: string[]
}

export async function runDummyStream(
  request: StreamRequest,
  onBatch?: (batch: SampleBatchView) => void,
): Promise<StreamRun> {
  const receiver = new StreamReceiver(request.jobId, onBatch)
  const started = performance.now()
  let finish!: () => void
  const finished = new Promise<void>((resolve) => (finish = resolve))
  const settle = () => receiver.complete && finish()

  const events = new Channel<ChannelEvent>()
  events.onmessage = (msg) => {
    receiver.event(msg)
    settle()
  }
  const batches = new Channel<ArrayBuffer>()
  batches.onmessage = (buf) => {
    receiver.batch(buf)
    settle()
  }

  await invoke('start_dummy_stream', { request, events, batches })
  await finished
  return { receiver, seconds: (performance.now() - started) / 1000, errors: receiver.verify() }
}

export interface SmokeReport {
  ok: boolean
  batches: number
  samples: number
  bytes: number
  seconds: number
  mbPerS: number
  batchesPerS: number
  errors: string[]
  userAgent: string
}

/** The smoke-test stream Rust wants run (ARIA_BURN_SMOKE), or null. */
export const smokeConfig = () => (isTauri() ? invoke<StreamRequest | null>('smoke_config') : Promise.resolve(null))

export const smokeReport = (report: SmokeReport) => invoke('smoke_report', { report })

export async function runSmoke(request: StreamRequest): Promise<SmokeReport> {
  try {
    const run = await runDummyStream(request)
    const { stats } = run.receiver
    return {
      ok: run.errors.length === 0,
      batches: stats.batches,
      samples: stats.samples,
      bytes: stats.bytes,
      seconds: run.seconds,
      mbPerS: stats.bytes / 1e6 / run.seconds,
      batchesPerS: stats.batches / run.seconds,
      errors: run.errors,
      userAgent: navigator.userAgent,
    }
  } catch (e) {
    return { ok: false, batches: 0, samples: 0, bytes: 0, seconds: 0, mbPerS: 0, batchesPerS: 0, errors: [String(e)], userAgent: navigator.userAgent }
  }
}
