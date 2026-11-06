// SPDX-License-Identifier: GPL-3.0-or-later
// The slow parts of SVG import (BURN-53), off the UI thread: reading the SVG
// (aria-burn-core readSvg, BURN-50) and making its job (svgJob, BURN-51/52).
// A large Aria Studio SVG takes a few hundred ms to read and longer to turn
// into moves (20k paths: ~250 ms and ~700 ms on an M1), so both run in a Web
// Worker that keeps the document between jobs. Where there is no Worker
// (vitest), the same handler runs inline.

import type { MachineProfile } from 'aria-burn-core/contract'
import { DEFAULT_PLACEMENT, readSvg, svgJob, type SvgDocument, type SvgJobDiagnostic, type SvgJobLayer } from 'aria-burn-core/svg'

export type SvgRequest =
  | { seq: number; type: 'read'; text: string; pxPerInch: number }
  | { seq: number; type: 'job'; layers: SvgJobLayer[]; machine: MachineProfile; name: string }

export interface SvgJobResult {
  gcode: string
  diagnostics: SvgJobDiagnostic[]
  estimatedTimeS: number
}

export type SvgReply =
  | { seq: number; type: 'read'; doc: SvgDocument }
  | ({ seq: number; type: 'job' } & SvgJobResult)
  | { seq: number; type: 'error'; message: string }

/** One worker's state: the last document read, which jobs are made from. */
export function createHandler(): (req: SvgRequest) => SvgReply {
  let doc: SvgDocument | null = null
  return (req) => {
    try {
      if (req.type === 'read') {
        doc = null
        doc = readSvg(req.text, { pxPerInch: req.pxPerInch })
        return { seq: req.seq, type: 'read', doc }
      }
      if (!doc) return { seq: req.seq, type: 'error', message: 'No SVG has been read' }
      // Placement is BURN-51's default (true size, page bottom-left at the bed origin) until BURN-54.
      const job = svgJob(doc, req.layers, DEFAULT_PLACEMENT, req.machine, { name: req.name })
      return { seq: req.seq, type: 'job', gcode: job.gcode, diagnostics: job.diagnostics, estimatedTimeS: job.estimatedTimeS }
    } catch (e) {
      const line = e && typeof e === 'object' && 'line' in e && typeof e.line === 'number' && e.line > 0 ? ` (line ${e.line})` : ''
      return { seq: req.seq, type: 'error', message: `${e instanceof Error ? e.message : String(e)}${line}` }
    }
  }
}

type Payload<T extends SvgRequest['type']> = Omit<Extract<SvgRequest, { type: T }>, 'seq' | 'type'>

/** Reads and makes jobs, in a worker when there is one. Requests are answered in order. */
export class SvgWork {
  private seq = 0
  private waiting = new Map<number, (reply: SvgReply) => void>()
  private worker: Worker | null = null
  private inline: ((req: SvgRequest) => SvgReply) | null = null

  constructor() {
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./svg.worker.ts', import.meta.url), { type: 'module', name: 'svg-import' })
        this.worker.onmessage = (e: MessageEvent<SvgReply>) => this.settle(e.data)
        this.worker.onerror = (e) => {
          e.preventDefault()
          for (const [seq] of this.waiting) this.settle({ seq, type: 'error', message: `SVG worker failed: ${e.message}` })
        }
      } catch {
        this.worker = null
      }
    }
    if (!this.worker) this.inline = createHandler()
  }

  async read(p: Payload<'read'>): Promise<SvgDocument> {
    const r = await this.send({ seq: 0, type: 'read', ...p })
    if (r.type === 'error') throw new Error(r.message)
    if (r.type !== 'read') throw new Error('Unexpected reply from the SVG worker')
    return r.doc
  }

  async job(p: Payload<'job'>): Promise<SvgJobResult> {
    const r = await this.send({ seq: 0, type: 'job', ...p })
    if (r.type === 'error') throw new Error(r.message)
    if (r.type !== 'job') throw new Error('Unexpected reply from the SVG worker')
    return { gcode: r.gcode, diagnostics: r.diagnostics, estimatedTimeS: r.estimatedTimeS }
  }

  private send(req: SvgRequest): Promise<SvgReply> {
    const seq = ++this.seq
    const msg = { ...req, seq } as SvgRequest
    return new Promise((resolve) => {
      this.waiting.set(seq, resolve)
      if (this.worker) this.worker.postMessage(msg)
      else queueMicrotask(() => this.settle(this.inline!(msg)))
    })
  }

  private settle(reply: SvgReply) {
    const resolve = this.waiting.get(reply.seq)
    this.waiting.delete(reply.seq)
    resolve?.(reply)
  }
}
