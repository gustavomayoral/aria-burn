// SPDX-License-Identifier: GPL-3.0-or-later
import { encodeSampleBatch, type ChannelEvent, type MotionSample } from 'aria-burn-core/contract'
import { describe, expect, it } from 'vitest'
import { StreamReceiver } from './stream-check.ts'

const f32 = (x: number) => Math.fround(x)

function batch(sequence: number, n: number, last: boolean, jobId = 3) {
  const samples: MotionSample[] = Array.from({ length: n }, (_, i) => ({
    tRelS: f32((i + 0.5) * 0.0005),
    xMm: f32(10 + i * 0.025),
    yMm: 10,
    dtS: f32(0.0005),
    speedMmPerS: 50,
    powerW: f32(2 + ((sequence * n + i) % 7)),
    line: 1,
  }))
  return { buffer: encodeSampleBatch({ sequence, t0S: sequence * n * 0.0005, jobId, last }, samples), samples }
}

function done(batchCount: number, sampleCount: number, energyJ: number, seq = 1): ChannelEvent {
  return { seq, event: { type: 'plan.done', jobId: 3, durationS: sampleCount * 0.0005, batchCount, sampleCount, energyJ } }
}

const started: ChannelEvent = { seq: 0, event: { type: 'plan.started', jobId: 3, gridPitchMm: 0.01, dtMaxS: 0.0005 } }

describe('StreamReceiver', () => {
  it('accepts an intact stream and matches plan.done energy exactly', () => {
    const r = new StreamReceiver(3)
    const all = [batch(0, 100, false), batch(1, 100, false), batch(2, 50, true)]
    let energy = 0
    for (const b of all) for (const s of b.samples) energy += s.powerW * s.dtS
    r.event(started)
    for (const b of all) r.batch(b.buffer)
    expect(r.complete).toBe(false)
    r.event(done(3, 250, energy))
    expect(r.complete).toBe(true)
    expect(r.verify()).toEqual([])
    expect(r.stats.bytes).toBe(all.reduce((n, b) => n + b.buffer.byteLength, 0))
  })

  it('reports gaps, wrong jobs and count mismatches', () => {
    const r = new StreamReceiver(3)
    r.event(started)
    r.batch(batch(0, 10, false).buffer)
    r.batch(batch(2, 10, true, 9).buffer)
    r.event(done(3, 30, 0))
    const errors = r.verify().join('\n')
    expect(errors).toMatch(/sequence 2, expected 1/)
    expect(errors).toMatch(/jobId 9/)
    expect(errors).toMatch(/2 batches, plan.done says 3/)
    expect(errors).toMatch(/energy/)
  })

  it('reports dropped events and a missing plan.done', () => {
    const r = new StreamReceiver(3)
    r.event({ ...started, seq: 1 })
    expect(r.verify().join('\n')).toMatch(/event seq 1, expected 0[\s\S]*no plan.done/)
  })

  it('reports undecodable batches', () => {
    const r = new StreamReceiver(3)
    r.batch(new ArrayBuffer(8))
    expect(r.errors[0]).toMatch(/shorter than header/)
  })
})
