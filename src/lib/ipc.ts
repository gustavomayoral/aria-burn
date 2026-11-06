// SPDX-License-Identifier: GPL-3.0-or-later
// Typed wrappers over the Rust commands. Samples arrive as raw ArrayBuffers on
// one Channel, contract events as JSON on another (COD-252: batched, never one
// message per G-code line).

import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import type { ChannelEvent, MachineProfile, SampleBatchView } from 'aria-burn-core/contract'
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

/** Mirrors `JobInput` in src-tauri/src/job.rs: a dropped file's path, or a picked file's text. */
export type JobInput = { kind: 'path'; path: string } | { kind: 'text'; name: string; text: string }

/** Mirrors `OpenRequest` in src-tauri/src/job.rs. */
export interface OpenRequest {
  jobId: number
  input: JobInput
  profile: MachineProfile
  /** Plan even with parse errors (the failing lines are dropped, as GRBL drops them). */
  planErrors?: boolean
}

/**
 * Opens a G-code file job: Rust parses it (aria-burn-gcode), plans it with the
 * GRBL planner and streams job.loaded → plan.started → batches → plan.done.
 * Resolves once Rust has queued everything.
 */
export async function openJob(
  request: OpenRequest,
  onEvent: (msg: ChannelEvent) => void,
  onBatch: (buffer: ArrayBuffer) => void,
): Promise<void> {
  const events = new Channel<ChannelEvent>()
  events.onmessage = onEvent
  const batches = new Channel<ArrayBuffer>()
  batches.onmessage = onBatch
  // Plain copy: Svelte state proxies don't survive IPC.
  const plain = JSON.parse(JSON.stringify(request)) as OpenRequest
  await invoke('job_open', { request: plain, events, batches })
}

/** Saves an export to the Downloads folder; resolves to the written path. */
export const saveExport = (name: string, bytes: Uint8Array) => invoke<string>('export_save', bytes, { headers: { 'x-export-name': name } })

/** A file to open at startup (command-line argument or ARIA_BURN_OPEN), or null. */
export const launchFile = () => (isTauri() ? invoke<string | null>('launch_file') : Promise.resolve(null))

/** Writes one file of a calibration record to the app's data folder (BURN-15); resolves to the written path. */
export const saveCalibrationFile = (id: string, name: string, bytes: Uint8Array) =>
  invoke<string>('calibration_save', bytes, { headers: { 'x-calibration-id': id, 'x-file-name': name } })

/** Reads a dropped or launch file as text (size-capped in Rust), for SVG import (BURN-53). */
export const readTextFile = (path: string) => invoke<string>('read_text_file', { path })

/** Writes a project file (.ariaburn only) at a path picked in the native Save dialog (BURN-55). */
export const projectWrite = (path: string, text: string) => invoke<void>('project_write', { path, text })

/** Reads a project file (.ariaburn only) as text. */
export const projectRead = (path: string) => invoke<string>('project_read', { path })

/** Tells Rust whether closing or quitting should ask first (unsaved project changes). */
export const setUnsaved = (unsaved: boolean) => (isTauri() ? invoke<void>('set_unsaved', { unsaved }) : Promise.resolve())

/** Quits without asking again (after the unsaved-changes prompt). */
export const appQuit = () => invoke<void>('app_quit')

/** Sent by Rust when the window is closed or the app quit with unsaved changes. */
export const QUIT_REQUESTED_EVENT = 'quit-requested'
