// SPDX-License-Identifier: GPL-3.0-or-later
// Export the burn as images (COD-259): the shaded colour view at overview
// resolution, and the height map as a 16-bit grayscale PNG whose full scale is
// the deepest cut (stated in the file name), so it keeps real depth steps.

import { burn } from './burn.svelte.ts'
import { saveExport } from './ipc.ts'
import { depthLabel, heightPngValues } from './relief.ts'

const stem = () => (burn.job?.name ?? 'burn').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'burn'

async function rgbaPng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** 16-bit grayscale PNG (colour type 0, bit depth 16), rows top-down. */
export async function gray16Png(width: number, height: number, values: Uint16Array): Promise<Uint8Array> {
  const raw = new Uint8Array(height * (1 + width * 2))
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 2)
    raw[o] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const v = values[y * width + x]!
      raw[o + 1 + x * 2] = v >> 8
      raw[o + 2 + x * 2] = v & 0xff
    }
  }
  const zlib = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width)
  v.setUint32(4, height)
  ihdr.set([16, 0, 0, 0, 0], 8)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export async function exportColor(): Promise<string> {
  const img = burn.colorImage()
  if (!img) throw new Error('nothing to export yet')
  return saveExport(`${stem()}-color.png`, await rgbaPng(img.width, img.height, img.rgba))
}

export async function exportHeight(): Promise<string> {
  const h = burn.heightmap(4096)
  if (!h) throw new Error('nothing to export yet')
  const { values, maxMm } = heightPngValues(h)
  const depth = depthLabel(maxMm)
  return saveExport(`${stem()}-height-${depth}-${(h.texelMm * 1000).toFixed(1)}umpx.png`, await gray16Png(h.width, h.height, values))
}
