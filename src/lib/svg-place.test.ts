// SPDX-License-Identifier: GPL-3.0-or-later
// Placement state ↔ transform (BURN-54): each gesture and field gives the
// placement it should, and that placement moves the job svgJob makes to the
// matching bed position.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadMachineProfile } from 'aria-burn-core'
import { DEFAULT_PLACEMENT, apply, placementMatrix, readSvg, svgJob, type SvgDocument } from 'aria-burn-core/svg'
import { describe, expect, it } from 'vitest'
import { initialLayers, jobLayers, patchLayer } from './svg-layers.ts'
import {
  centreOnBed,
  convexHull,
  defaultPlacement,
  designSize,
  moveBy,
  offBedMm,
  placeGeometry,
  placeMatrix,
  placedBox,
  placedCorners,
  resetSize,
  rotateFromHandle,
  samePlacement,
  scaleFromHandle,
  setAnchor,
  setPosition,
  setRotation,
  setScale,
  setSize,
  shownBox,
  type Placement,
} from './svg-place.ts'
import { createHandler } from './svg-work.ts'

const fixture = (name: string) => readFileSync(fileURLToPath(import.meta.resolve(`aria-burn-core/svg/fixtures/${name}`)), 'utf8')
const svg = (attrs: string, body: string): SvgDocument => readSvg(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`)
const machine = loadMachineProfile(readFileSync(fileURLToPath(import.meta.resolve('aria-burn-core/profiles/provisional/machine-10w-diode.json')), 'utf8'))

// A 100 × 60 mm page with a 40 × 20 mm rectangle drawn at (10, 10) in SVG
// user units (y down), so in bed mm (y up) it spans x 10–50, y 30–50.
const page = () => svg('width="100mm" height="60mm" viewBox="0 0 100 60"', '<rect x="10" y="10" width="40" height="20" fill="none" stroke="#000000"/>')

const near = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits)
const nearBox = (a: { minXMm: number; minYMm: number; maxXMm: number; maxYMm: number }, b: [number, number, number, number], digits = 6) => {
  near(a.minXMm, b[0], digits)
  near(a.minYMm, b[1], digits)
  near(a.maxXMm, b[2], digits)
  near(a.maxYMm, b[3], digits)
}
const nearMatrix = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => near(v, b[i]!, 9))

/** Where svgJob burns the design for a placement (bed mm). */
function burnBounds(doc: SvgDocument, p: Placement) {
  const job = svgJob(doc, jobLayers(initialLayers(doc)), p, machine)
  return job.job.burnBounds!
}

describe('placement geometry', () => {
  it('the convex hull keeps the extreme points only', () => {
    const hull = convexHull([0, 0, 2, 0, 1, 1, 2, 2, 0, 2, 1, 0.5])
    expect(hull.length).toBe(8)
  })

  it('the hull stand-in gives the same matrix as the full document, for every anchor, scale and rotation', () => {
    const doc = readSvg(fixture('aria-studio-laser.svg'))
    const g = placeGeometry(doc)
    for (const p of [
      defaultPlacement(g),
      { ...defaultPlacement(g), anchor: 'top-right', xMm: 120, yMm: 80, scale: 0.5, rotationDeg: 33 } as Placement,
      { ...defaultPlacement(g), anchor: 'center', xMm: 200, yMm: 150, scale: 1.7, rotationDeg: -125 } as Placement,
    ])
      nearMatrix(placeMatrix(g, p), placementMatrix(doc, p))
  })

  it('the default after load is the identity BURN-53 loads with', () => {
    for (const doc of [page(), readSvg(fixture('aria-studio-laser.svg'))]) {
      const g = placeGeometry(doc)
      nearMatrix(placeMatrix(g, defaultPlacement(g)), placementMatrix(doc, DEFAULT_PLACEMENT))
    }
    const g = placeGeometry(page())
    expect(defaultPlacement(g)).toMatchObject({ xMm: 10, yMm: 30, anchor: 'bottom-left', scale: 1, rotationDeg: 0, reference: 'content' })
  })

  it('an empty design falls back to the page box', () => {
    const g = placeGeometry(svg('width="20mm" height="10mm"', ''))
    const p = defaultPlacement(g)
    expect(p.reference).toBeUndefined()
    nearBox(placedBox(g, p), [0, 0, 20, 10])
    expect(designSize(g, 2)).toEqual({ widthMm: 40, heightMm: 20 })
  })
})

describe('fields and gestures', () => {
  const g = placeGeometry(page())
  const p0 = defaultPlacement(g)

  it('X/Y put the anchor point on the bed; the anchor picker keeps the design put', () => {
    const p = setPosition(p0, 100, 70)
    nearBox(placedBox(g, p), [100, 70, 140, 90])
    const c = setAnchor(g, p, 'center')
    expect([c.xMm, c.yMm]).toEqual([120, 80])
    nearBox(placedBox(g, c), [100, 70, 140, 90])
    const tr = setAnchor(g, c, 'top-right')
    expect([tr.xMm, tr.yMm]).toEqual([140, 90])
    // Typing X/Y for the top-right anchor puts that corner there.
    nearBox(placedBox(g, setPosition(tr, 50, 50)), [10, 30, 50, 50])
    // An emptied field keeps its value.
    expect(setPosition(tr, Number.NaN, 12)).toMatchObject({ xMm: 140, yMm: 12 })
  })

  it('width/height are aspect locked and keep the anchor point; scale % follows', () => {
    const p = setAnchor(g, setPosition(p0, 100, 70), 'top-left')
    const w = setSize(g, p, 'width', 80)
    expect(w.scale).toBe(2)
    expect(designSize(g, w.scale)).toEqual({ widthMm: 80, heightMm: 40 })
    nearBox(placedBox(g, w), [100, 50, 180, 90])
    const h = setSize(g, w, 'height', 10)
    expect(h.scale).toBe(0.5)
    nearBox(placedBox(g, h), [100, 80, 120, 90])
    expect(setSize(g, p, 'width', 0)).toBe(p)
    expect(setScale(g, p, -3).scale).toBe(p.scale)
  })

  it('rotation turns about the centre, which stays put; the box is the rotated geometry', () => {
    const p = setPosition(p0, 100, 70)
    const r = setRotation(g, p, 90)
    expect(r.rotationDeg).toBe(90)
    nearBox(placedBox(g, r), [110, 60, 130, 100])
    expect(setRotation(g, p, 270).rotationDeg).toBe(-90)
    const corners = placedCorners(g, r)
    // The design's own bottom-left corner turned to its bottom-right.
    near(corners[0]!.xMm, 130)
    near(corners[0]!.yMm, 60)
  })

  it('drag moves by the pointer delta', () => {
    nearBox(placedBox(g, moveBy(p0, 5, -3)), [15, 27, 55, 47])
  })

  it('scale handle scales about the centre by the pointer’s distance ratio', () => {
    const p = setPosition(p0, 100, 70) // centre (120, 80)
    const s = scaleFromHandle(g, p, { xMm: 140, yMm: 90 }, { xMm: 160, yMm: 100 })
    near(s.scale, 2)
    nearBox(placedBox(g, s), [80, 60, 160, 100])
  })

  it('rotate handle follows the swept angle and snaps to 15° with Shift', () => {
    const p = setPosition(p0, 100, 70) // centre (120, 80)
    const free = rotateFromHandle(g, p, { xMm: 120, yMm: 100 }, { xMm: 100, yMm: 80.1 })
    near(free.rotationDeg, 90 - (Math.atan2(0.1, 20) * 180) / Math.PI, 6)
    const snapped = rotateFromHandle(g, p, { xMm: 120, yMm: 100 }, { xMm: 100, yMm: 81 }, true)
    expect(snapped.rotationDeg).toBe(90)
  })

  it('reset to true size gives the SVG’s mm size; centre on bed centres it', () => {
    const big = setScale(g, setRotation(g, p0, 30), 3, 'center')
    const back = resetSize(g, big)
    expect(back.scale).toBe(1)
    expect(back.rotationDeg).toBe(30)
    expect(designSize(g, back.scale)).toEqual({ widthMm: 40, heightMm: 20 })
    const c = centreOnBed(g, p0, { x: 400, y: 300 })
    nearBox(placedBox(g, c), [180, 140, 220, 160])
    expect(samePlacement(c, p0)).toBe(false)
  })
})

describe('placement moves the burn', () => {
  const doc = page()
  const g = placeGeometry(doc)
  const p0 = defaultPlacement(g)

  it('the burn lands where the placed box is, for drag, fields, rotation and scale', () => {
    const cases: Placement[] = [
      p0,
      moveBy(p0, 37, 12),
      setAnchor(g, setPosition(setAnchor(g, p0, 'center'), 150, 100), 'top-right'),
      setRotation(g, setPosition(p0, 100, 70), 90),
      setRotation(g, setPosition(p0, 100, 70), 30),
      setSize(g, setPosition(p0, 100, 70), 'width', 120),
      centreOnBed(g, scaleFromHandle(g, p0, { xMm: 50, yMm: 50 }, { xMm: 70, yMm: 60 }), { x: 400, y: 400 }),
    ]
    for (const p of cases) {
      const box = placedBox(g, p)
      const burn = burnBounds(doc, p)
      // The burn includes the beam width, so it is the placed box to within a fraction of a mm.
      nearBox(burn, [box.minXMm, box.minYMm, box.maxXMm, box.maxYMm], 0)
    }
  })

  it('the worker makes the job at the placement it is given', () => {
    const handler = createHandler()
    handler({ seq: 1, type: 'read', text: fixture('aria-studio-laser.svg'), pxPerInch: 96 })
    const d = readSvg(fixture('aria-studio-laser.svg'))
    const gg = placeGeometry(d)
    const layers = jobLayers(initialLayers(d))
    const placement = centreOnBed(gg, setRotation(gg, defaultPlacement(gg), 90), { x: 400, y: 400 })
    const r = handler({ seq: 2, type: 'job', layers, machine, name: 'x.svg', placement })
    const direct = svgJob(d, layers, placement, machine, { name: 'x.svg' })
    expect(r.type).toBe('job')
    if (r.type === 'job') expect(r.gcode).toBe(direct.gcode)
  })

  it('off-bed agrees with svgJob’s report, over the shown layers', () => {
    const d = svg(
      'width="100mm" height="60mm" viewBox="0 0 100 60"',
      '<rect x="10" y="10" width="40" height="20" fill="none" stroke="#000000"/><rect x="60" y="10" width="20" height="20" fill="none" stroke="#ff0000"/>',
    )
    const gg = placeGeometry(d)
    const bed = { x: 400, y: 400 }
    const layers = initialLayers(d)
    const ids = (ls: typeof layers) => ls.filter((l) => l.settings.visible).map((l) => l.id)
    const offReported = (p: Placement, ls = layers) => svgJob(d, jobLayers(ls), p, machine, { bedMm: bed }).diagnostics.some((x) => x.code === 'off-bed')
    const p0 = defaultPlacement(gg)
    for (const [p, ls] of [
      [p0, layers],
      [moveBy(p0, -15, 0), layers],
      [moveBy(p0, 360, 0), layers],
      // The red square leaves the bed, but hidden it isn't checked.
      [moveBy(p0, 360, 0), patchLayer(layers, 'C01', { visible: false })],
      [setRotation(gg, centreOnBed(gg, p0, bed), 45), layers],
    ] as const) {
      const off = offBedMm(shownBox(gg, p, ids(ls)), bed)
      expect(off > 0).toBe(offReported(p, ls))
    }
    near(offBedMm(shownBox(gg, moveBy(p0, -15, 0), ids(layers)), bed), 5)
  })

  it('the placed corners are the matrix image of the content box', () => {
    const p = setRotation(g, setPosition(p0, 100, 70), 30)
    const m = placementMatrix(doc, p)
    const [x, y] = apply(m, 10, 30)
    const c = placedCorners(g, p)[0]!
    near(c.xMm, x)
    near(c.yMm, y)
  })
})
