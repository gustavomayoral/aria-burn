// SPDX-License-Identifier: GPL-3.0-or-later
// Material list for the sidebar: the core's provisional profiles (COD-266),
// and the user's profiles calibrated from a photographed grid (BURN-15).

import type { Lab, MaterialProfile } from 'aria-burn-core/contract'
import acrylic from 'aria-burn-core/profiles/provisional/black-cast-acrylic.json'
import aluminum from 'aria-burn-core/profiles/provisional/black-anodized-aluminum.json'
import birch from 'aria-burn-core/profiles/provisional/birch-ply.json'

/** The built-in (provisional) profiles. */
export const MATERIALS = [birch, acrylic, aluminum] as MaterialProfile[]

/**
 * The user's calibrated profiles (BURN-15) come from a source the photo-fit
 * state registers; reading it inside a $derived keeps the list reactive.
 */
let userSource: () => readonly MaterialProfile[] = () => []
export function useUserMaterials(source: () => readonly MaterialProfile[]): void {
  userSource = source
}

/** Built-in profiles, then the user's calibrated ones. */
export const allMaterials = (): MaterialProfile[] => [...MATERIALS, ...userSource()]

export const KIND_LABEL: Record<MaterialProfile['response']['kind'], string> = {
  char: 'Char',
  melt: 'Melt',
  bleach: 'Bleach',
}

export const findMaterial = (id: string) => allMaterials().find((m) => m.id === id) ?? MATERIALS[0]!

/** Colour a fully marked area takes, per response kind. */
export function markColor(m: MaterialProfile): Lab {
  const r = m.response
  return r.kind === 'char' ? r.charColor : r.kind === 'melt' ? r.frostColor : r.markColor
}

/** CIELAB (D65) → linear-light sRGB channel values in [0, 1]. */
function labToLinear({ l, a, b }: Lab): [number, number, number] {
  const fy = (l + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (116 * t - 16) / 903.3)
  const [x, y, z] = [0.95047 * inv(fx), 1.0 * inv(fy), 1.08883 * inv(fz)]
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ]
}

const encode = (c: number) => {
  const v = Math.min(1, Math.max(0, c))
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
}

/** CIELAB → 8-bit sRGB. */
export function labToRgb(lab: Lab): [number, number, number] {
  const [r, g, b] = labToLinear(lab)
  return [encode(r), encode(g), encode(b)]
}

export const labToCss = (lab: Lab) => `rgb(${labToRgb(lab).join(' ')})`
