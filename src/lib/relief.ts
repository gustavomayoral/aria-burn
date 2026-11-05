// SPDX-License-Identifier: GPL-3.0-or-later
// Height (3D) view depth exaggeration (BURN-46). Diode engraving is a few
// tenths of a millimetre deep on a job tens of millimetres wide, so at true
// scale the relief is almost flat. The user picks ×1, ×5 or ×20. It scales the
// mesh on screen only: the hover readout, the depth scale and the exported
// height map always show true depth, so nothing outside the 3D mesh reads it.

/** The on-screen depth factors the Height view offers. */
export const EXAGGERATIONS = [1, 5, 20] as const
export type Exaggeration = (typeof EXAGGERATIONS)[number]
export const DEFAULT_EXAGGERATION: Exaggeration = 5

export const isExaggeration = (v: unknown): v is Exaggeration => EXAGGERATIONS.includes(v as Exaggeration)

/** Mesh Z (mm, surface at 0, cuts negative) for a true depth, scaled for display only. */
export const reliefZ = (depthMm: number, factor: Exaggeration): number => (depthMm > 0 ? -depthMm * factor : 0)

/**
 * The 16-bit height PNG's samples, top-down rows: white is the surface, black
 * the deepest cut, whose true depth (µm) goes in the file name. It takes no
 * exaggeration: exports are true depth whatever the Height view shows.
 */
export function heightPngValues(h: { width: number; height: number; depthMm: Float32Array }): { values: Uint16Array; maxMm: number } {
  const maxMm = h.depthMm.reduce((m, d) => Math.max(m, d), 0)
  const values = new Uint16Array(h.width * h.height)
  for (let y = 0; y < h.height; y++)
    for (let x = 0; x < h.width; x++) {
      const d = h.depthMm[(h.height - 1 - y) * h.width + x]!
      values[y * h.width + x] = maxMm > 0 ? Math.round(65535 * (1 - d / maxMm)) : 65535
    }
  return { values, maxMm }
}

/** The depth part of the exported file name, true depth in µm. */
export const depthLabel = (maxMm: number): string => (maxMm > 0 ? `${(maxMm * 1000).toFixed(0)}um` : 'flat')
