// SPDX-License-Identifier: GPL-3.0-or-later
// Placing an imported SVG on the bed (BURN-54, feature BURN-49): the placement
// state the canvas and the fields edit, as plain functions over plain data.
// The transform itself is aria-burn-core's placementMatrix (BURN-51); this
// module only decides how each gesture or field changes a Placement.
//
// The box the user moves, sizes and anchors is the drawn geometry
// (`reference: 'content'`), not the SVG page, so X/Y, W/H and "Centre on bed"
// refer to what is drawn. The default placement is still the identity (true
// size, the page's bottom-left on the bed origin, as BURN-53 loads it): the
// content box's bottom-left anchor sits where the identity puts it.
//
// Dragging and rotating need the placed box on every pointer move. The box of
// an affine image of a point set is the box of its convex hull's image, so a
// design is reduced once to the hull of its points (`placeGeometry`) and
// placementMatrix runs on that, giving exactly the matrix it gives the full
// document without walking every point.

import {
  ANCHORS,
  anchorPoint,
  apply,
  placementMatrix,
  transformedBounds,
  type Anchor,
  type Matrix,
  type Placement,
  type SvgDocument,
} from 'aria-burn-core/svg'

type BoundsMm = NonNullable<SvgDocument['bounds']>
type Point = { xMm: number; yMm: number }

export { ANCHORS, type Anchor, type Placement }

export const MIN_SCALE = 0.001
export const MAX_SCALE = 1000
export const ROTATE_SNAP_DEG = 15

/** A design reduced for placement: the page, the hull of all its points, and of each layer's. */
export interface PlaceGeometry {
  /** A stand-in for the document whose only shape is the hull of all points (placementMatrix gives the same matrix for it). */
  doc: SvgDocument
  /** Hull points (interleaved x,y, SVG mm) of each layer's shapes, by layer id. */
  layers: Map<string, Float64Array>
  widthMm: number
  heightMm: number
  /** Bounds of all geometry in SVG mm, or null for an empty design. */
  bounds: BoundsMm | null
}

/** Convex hull (Andrew's monotone chain) of interleaved points, as interleaved points. */
export function convexHull(points: ArrayLike<number>): Float64Array {
  const n = Math.floor(points.length / 2)
  const idx = Array.from({ length: n }, (_, i) => i)
  const x = (i: number) => points[2 * i]!
  const y = (i: number) => points[2 * i + 1]!
  idx.sort((a, b) => x(a) - x(b) || y(a) - y(b))
  if (n < 3) return Float64Array.from(idx.flatMap((i) => [x(i), y(i)]))
  const cross = (o: number, a: number, b: number) => (x(a) - x(o)) * (y(b) - y(o)) - (y(a) - y(o)) * (x(b) - x(o))
  const lower: number[] = []
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, i) <= 0) lower.pop()
    lower.push(i)
  }
  const upper: number[] = []
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, i) <= 0) upper.pop()
    upper.push(i)
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)]
  return Float64Array.from(hull.flatMap((i) => [x(i), y(i)]))
}

function hullOf(doc: SvgDocument, shapes: Iterable<number>): Float64Array {
  const pts: number[] = []
  for (const si of shapes) for (const sp of doc.shapes[si]!.subpaths) for (const v of sp.points) pts.push(v)
  return convexHull(pts)
}

/** Reduces a document for placement (once per document). */
export function placeGeometry(doc: SvgDocument): PlaceGeometry {
  const layers = new Map(doc.layers.map((l) => [l.id, hullOf(doc, l.shapes)]))
  const all = convexHull([...layers.values()].flatMap((h) => [...h]))
  const shape = { subpaths: all.length ? [{ points: all, closed: true }] : [] }
  const light = { ...doc, shapes: [shape], layers: [], diagnostics: [] } as unknown as SvgDocument
  return { doc: light, layers, widthMm: doc.widthMm, heightMm: doc.heightMm, bounds: doc.bounds }
}

/**
 * The placement a design loads with: true size, unrotated, its page's
 * bottom-left on the bed origin (the identity, BURN-51's DEFAULT_PLACEMENT),
 * expressed on the content box. An empty design keeps the page box.
 */
export function defaultPlacement(g: Pick<PlaceGeometry, 'bounds'>): Placement {
  const b = g.bounds
  if (!b) return { xMm: 0, yMm: 0, anchor: 'bottom-left', scale: 1, rotationDeg: 0 }
  return { xMm: b.minXMm, yMm: b.minYMm, anchor: 'bottom-left', scale: 1, rotationDeg: 0, reference: 'content' }
}

export const samePlacement = (a: Placement, b: Placement, eps = 1e-9): boolean =>
  a.anchor === b.anchor &&
  (a.reference ?? 'page') === (b.reference ?? 'page') &&
  Math.abs(a.xMm - b.xMm) <= eps &&
  Math.abs(a.yMm - b.yMm) <= eps &&
  Math.abs(a.scale - b.scale) <= eps &&
  Math.abs(a.rotationDeg - b.rotationDeg) <= eps

/** SVG mm → bed mm. */
export const placeMatrix = (g: PlaceGeometry, p: Placement): Matrix => placementMatrix(g.doc, p)

/** The placed box on the bed: the axis-aligned box of the placed geometry (of the page for an empty design). */
export function placedBox(g: PlaceGeometry, p: Placement): BoundsMm {
  const m = placeMatrix(g, p)
  const b = g.bounds ? transformedBounds(g.doc, m) : null
  if (b) return b
  const page = { minXMm: Infinity, minYMm: Infinity, maxXMm: -Infinity, maxYMm: -Infinity }
  for (const [x, y] of [
    [0, 0],
    [g.widthMm, 0],
    [g.widthMm, g.heightMm],
    [0, g.heightMm],
  ] as const) {
    const [u, v] = apply(m, x, y)
    page.minXMm = Math.min(page.minXMm, u)
    page.maxXMm = Math.max(page.maxXMm, u)
    page.minYMm = Math.min(page.minYMm, v)
    page.maxYMm = Math.max(page.maxYMm, v)
  }
  return page
}

/** The four corners of the design's own (unrotated) box on the bed, counter-clockwise from its bottom-left. */
export function placedCorners(g: PlaceGeometry, p: Placement): Point[] {
  const b = g.bounds ?? { minXMm: 0, minYMm: 0, maxXMm: g.widthMm, maxYMm: g.heightMm }
  const m = placeMatrix(g, p)
  return [
    [b.minXMm, b.minYMm],
    [b.maxXMm, b.minYMm],
    [b.maxXMm, b.maxYMm],
    [b.minXMm, b.maxYMm],
  ].map(([x, y]) => {
    const [u, v] = apply(m, x!, y!)
    return { xMm: u, yMm: v }
  })
}

const centre = (b: BoundsMm): Point => ({ xMm: (b.minXMm + b.maxXMm) / 2, yMm: (b.minYMm + b.maxYMm) / 2 })

/** The design's size at a scale (unrotated content box; the page for an empty design). */
export function designSize(g: PlaceGeometry, scale: number): { widthMm: number; heightMm: number } {
  const b = g.bounds
  const w = b ? b.maxXMm - b.minXMm : g.widthMm
  const h = b ? b.maxYMm - b.minYMm : g.heightMm
  return { widthMm: w * scale, heightMm: h * scale }
}

/** `next` moved so the placed box's point `anchor` lands on `at`. */
function keep(g: PlaceGeometry, next: Placement, anchor: Anchor, at: Point): Placement {
  const now = anchorPoint(placedBox(g, next), anchor)
  return { ...next, xMm: next.xMm + at.xMm - now.xMm, yMm: next.yMm + at.yMm - now.yMm }
}

const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback)
const clampScale = (s: number, fallback: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, finite(s, fallback) > 0 ? finite(s, fallback) : fallback))
/** Degrees in (-180, 180]. */
export const normaliseDeg = (deg: number) => {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180
  return d === -180 ? 180 : d
}

/** Moved by a delta (drag). */
export const moveBy = (p: Placement, dxMm: number, dyMm: number): Placement => ({ ...p, xMm: p.xMm + finite(dxMm, 0), yMm: p.yMm + finite(dyMm, 0) })

/** X/Y fields: the anchor point goes to (x, y). An emptied field keeps its value. */
export const setPosition = (p: Placement, xMm: number, yMm: number): Placement => ({ ...p, xMm: finite(xMm, p.xMm), yMm: finite(yMm, p.yMm) })

/** Anchor picker: the design stays put; X/Y now name the new anchor's point. */
export function setAnchor(g: PlaceGeometry, p: Placement, anchor: Anchor): Placement {
  const at = anchorPoint(placedBox(g, p), anchor)
  return { ...p, anchor, xMm: at.xMm, yMm: at.yMm }
}

/** Scale (aspect locked). `about` is the box point that stays put: the anchor for field edits, the centre for the handles. */
export function setScale(g: PlaceGeometry, p: Placement, scale: number, about: 'anchor' | 'center' = 'anchor'): Placement {
  const a: Anchor = about === 'anchor' ? p.anchor : 'center'
  return keep(g, { ...p, scale: clampScale(scale, p.scale) }, a, anchorPoint(placedBox(g, p), a))
}

/** Width or height field (mm), aspect locked: the scale that gives it. */
export function setSize(g: PlaceGeometry, p: Placement, which: 'width' | 'height', mm: number): Placement {
  const one = designSize(g, 1)
  const base = which === 'width' ? one.widthMm : one.heightMm
  if (!(base > 0) || !(mm > 0)) return p
  return setScale(g, p, mm / base)
}

/** Rotation (deg, counter-clockwise) about the design's centre, which stays put. */
export function setRotation(g: PlaceGeometry, p: Placement, deg: number): Placement {
  const c = centre(placedBox(g, p))
  return keep(g, { ...p, rotationDeg: normaliseDeg(finite(deg, p.rotationDeg)) }, 'center', c)
}

/** Back to scale 1 (the SVG's true mm size), keeping the centre and the rotation. */
export const resetSize = (g: PlaceGeometry, p: Placement): Placement => setScale(g, p, 1, 'center')

/** The design's centre on the bed's centre. */
export function centreOnBed(g: PlaceGeometry, p: Placement, bedMm: { x: number; y: number }): Placement {
  return keep(g, p, 'center', { xMm: bedMm.x / 2, yMm: bedMm.y / 2 })
}

// ── Handles ──

/** Scale handle: the scale that puts the dragged corner's distance from the centre at `pointer`'s. */
export function scaleFromHandle(g: PlaceGeometry, start: Placement, startPointer: Point, pointer: Point): Placement {
  const c = centre(placedBox(g, start))
  const d0 = Math.hypot(startPointer.xMm - c.xMm, startPointer.yMm - c.yMm)
  const d1 = Math.hypot(pointer.xMm - c.xMm, pointer.yMm - c.yMm)
  if (!(d0 > 0)) return start
  return setScale(g, start, start.scale * (d1 / d0), 'center')
}

/** Rotate handle: turned by the angle the pointer swept about the centre; `snap` (Shift) rounds to 15°. */
export function rotateFromHandle(g: PlaceGeometry, start: Placement, startPointer: Point, pointer: Point, snap = false): Placement {
  const c = centre(placedBox(g, start))
  const a0 = Math.atan2(startPointer.yMm - c.yMm, startPointer.xMm - c.xMm)
  const a1 = Math.atan2(pointer.yMm - c.yMm, pointer.xMm - c.xMm)
  let deg = start.rotationDeg + ((a1 - a0) * 180) / Math.PI
  if (snap) deg = Math.round(deg / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG
  return setRotation(g, start, deg)
}

// ── Off the bed ──

/**
 * The box of the layers svgJob checks against the bed (every shown layer,
 * as its off-bed report does), or null when none has geometry.
 */
export function shownBox(g: PlaceGeometry, p: Placement, shownLayerIds: Iterable<string>): BoundsMm | null {
  const m = placeMatrix(g, p)
  const b = { minXMm: Infinity, minYMm: Infinity, maxXMm: -Infinity, maxYMm: -Infinity }
  for (const id of shownLayerIds) {
    const h = g.layers.get(id)
    if (!h) continue
    for (let i = 0; i < h.length; i += 2) {
      const [x, y] = apply(m, h[i]!, h[i + 1]!)
      b.minXMm = Math.min(b.minXMm, x)
      b.maxXMm = Math.max(b.maxXMm, x)
      b.minYMm = Math.min(b.minYMm, y)
      b.maxYMm = Math.max(b.maxYMm, y)
    }
  }
  return Number.isFinite(b.minXMm) ? b : null
}

/** How far (mm) a box leaves the bed, 0 when it is inside (within svgJob's 1e-6 mm off-bed tolerance). */
export function offBedMm(b: BoundsMm | null, bedMm: { x: number; y: number }): number {
  if (!b) return 0
  const over = Math.max(0, -b.minXMm, -b.minYMm, b.maxXMm - bedMm.x, b.maxYMm - bedMm.y)
  return over > 1e-6 ? over : 0
}
