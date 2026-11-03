// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { gray16Png } from './export.ts'

describe('16-bit height PNG', () => {
  it('writes a valid signature, IHDR and zlib IDAT', async () => {
    const png = await gray16Png(3, 2, new Uint16Array([0, 1000, 65535, 4, 5, 6]))
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const v = new DataView(png.buffer)
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR')
    expect(v.getUint32(16)).toBe(3)
    expect(v.getUint32(20)).toBe(2)
    expect(png[24]).toBe(16) // bit depth
    expect(png[25]).toBe(0) // grayscale
    const idat = 8 + 25
    expect(String.fromCharCode(...png.subarray(idat + 4, idat + 8))).toBe('IDAT')
    const len = v.getUint32(idat)
    const raw = new Uint8Array(
      await new Response(new Blob([png.slice(idat + 8, idat + 8 + len)]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer(),
    )
    expect([...raw.subarray(0, 7)]).toEqual([0, 0, 0, 3, 232, 255, 255])
  })
})
