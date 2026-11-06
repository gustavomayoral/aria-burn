<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Place mode (BURN-54): the machine's bed with the design drawn as vectors in
     its layer colours (not simulated) and a selection box. Drag the design to
     move it, a corner to scale it (aspect locked) and the top handle to rotate
     it (Shift snaps to 15°). Arrow keys nudge 1 mm (Shift: 10 mm). "Simulate"
     runs the burn at the new placement. -->
<script lang="ts">
  import { usableBedMm } from 'aria-burn-core/calibration'
  import { onMount } from 'svelte'
  import { app } from '../lib/app.svelte.ts'
  import { burnedShapes } from '../lib/svg-layers.ts'
  import { svgImport } from '../lib/svg-import.svelte.ts'
  import { moveBy, offBedMm, placeMatrix, placedBox, placedCorners, rotateFromHandle, scaleFromHandle, shownBox, type Placement } from '../lib/svg-place.ts'

  type Pt = { xMm: number; yMm: number }
  type Gesture = { kind: 'move' | 'scale' | 'rotate'; start: Placement; from: Pt; id: number }

  let svgEl: SVGSVGElement
  let plane: SVGGElement
  let size = $state({ width: 1, height: 1 })
  let gesture = $state<Gesture | null>(null)
  /** The frame shown while a gesture runs, so the view doesn't move under the pointer. */
  let frozen = $state<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null)

  const doc = $derived(svgImport.doc)
  const g = $derived(svgImport.geometry)
  const p = $derived(svgImport.placement)
  const bed = $derived(usableBedMm(app.settings.machine))
  const shownIds = $derived(svgImport.layers.filter((l) => l.settings.visible).map((l) => l.id))
  const off = $derived(g ? offBedMm(shownBox(g, p, shownIds), bed) : 0)
  const box = $derived(g ? placedBox(g, p) : null)
  const corners = $derived(g ? placedCorners(g, p) : [])
  const matrix = $derived(g ? placeMatrix(g, p) : null)

  /** Bed and design with a margin: what the view fits. */
  const frame = $derived.by(() => {
    if (frozen) return frozen
    let minX = 0
    let minY = 0
    let maxX = bed.x
    let maxY = bed.y
    if (box) {
      minX = Math.min(minX, box.minXMm)
      minY = Math.min(minY, box.minYMm)
      maxX = Math.max(maxX, box.maxXMm)
      maxY = Math.max(maxY, box.maxYMm)
    }
    const m = Math.max(maxX - minX, maxY - minY) * 0.05
    return { minX: minX - m, minY: minY - m, maxX: maxX + m, maxY: maxY + m }
  })
  /** CSS px per mm at the current fit (preserveAspectRatio meet). */
  const pxPerMm = $derived(Math.min(size.width / (frame.maxX - frame.minX), size.height / (frame.maxY - frame.minY)))
  const viewBox = $derived(`${frame.minX} ${-frame.maxY} ${frame.maxX - frame.minX} ${frame.maxY - frame.minY}`)

  /** Grid lines every 10 mm, every 50 mm stronger (only 50 mm on a big bed). */
  const grid = $derived.by(() => {
    const step = Math.max(bed.x, bed.y) > 1000 ? 50 : 10
    const lines: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = []
    for (let x = step; x < bed.x; x += step) lines.push({ x1: x, y1: 0, x2: x, y2: bed.y, major: x % 50 === 0 })
    for (let y = step; y < bed.y; y += step) lines.push({ x1: 0, y1: y, x2: bed.x, y2: y, major: y % 50 === 0 })
    return lines
  })

  /** One path per layer and fill rule, in SVG mm; the placement is the group's transform. */
  const paths = $derived.by(() => {
    if (!doc) return []
    const out: { key: string; d: string; color: string; fill: boolean; rule: 'nonzero' | 'evenodd'; output: boolean }[] = []
    for (const l of svgImport.layers) {
      if (!l.settings.visible) continue
      const fill = l.settings.mode === 'fill'
      const parts: Record<'nonzero' | 'evenodd', string[]> = { nonzero: [], evenodd: [] }
      for (const si of burnedShapes(doc, l.id, l.settings.mode)) {
        const s = doc.shapes[si]!
        const bucket = parts[fill ? s.fillRule : 'nonzero']
        for (const sp of s.subpaths) {
          if (fill && !sp.closed) continue
          const pts = sp.points
          if (pts.length < 2) continue
          let d = `M${pts[0]!.toFixed(3)} ${pts[1]!.toFixed(3)}`
          for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]!.toFixed(3)} ${pts[i + 1]!.toFixed(3)}`
          if (sp.closed) d += 'Z'
          bucket.push(d)
        }
      }
      for (const rule of ['nonzero', 'evenodd'] as const)
        if (parts[rule].length) out.push({ key: `${l.id}-${rule}`, d: parts[rule].join(''), color: l.color, fill, rule, output: l.settings.output })
    }
    return out
  })

  const poly = (pts: Pt[]) => pts.map((q) => `${q.xMm},${q.yMm}`).join(' ')
  const handleMm = $derived(8 / pxPerMm)
  /** The rotate handle: above the middle of the design's top edge, 24 px out. */
  const rotateHandle = $derived.by(() => {
    if (corners.length < 4) return null
    const [, , tr, tl] = corners as [Pt, Pt, Pt, Pt]
    const mid = { xMm: (tr.xMm + tl.xMm) / 2, yMm: (tr.yMm + tl.yMm) / 2 }
    const c = { xMm: (corners[0]!.xMm + tr.xMm) / 2, yMm: (corners[0]!.yMm + tr.yMm) / 2 }
    let nx = mid.xMm - c.xMm
    let ny = mid.yMm - c.yMm
    const len = Math.hypot(nx, ny) || 1
    nx /= len
    ny /= len
    const out = 24 / pxPerMm
    return { mid, at: { xMm: mid.xMm + nx * out, yMm: mid.yMm + ny * out } }
  })

  onMount(() => {
    const ro = new ResizeObserver(() => (size = { width: svgEl.clientWidth || 1, height: svgEl.clientHeight || 1 }))
    ro.observe(svgEl)
    svgEl.focus({ preventScroll: true })
    return () => ro.disconnect()
  })

  /** Pointer → bed mm. */
  function toMm(e: PointerEvent): Pt {
    const ctm = plane.getScreenCTM()
    if (!ctm) return { xMm: 0, yMm: 0 }
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { xMm: q.x, yMm: q.y }
  }

  function begin(e: PointerEvent, kind: Gesture['kind']) {
    if (e.button !== 0 || !g) return
    e.stopPropagation()
    e.preventDefault()
    frozen = frame
    gesture = { kind, start: p, from: toMm(e), id: e.pointerId }
    svgEl.setPointerCapture(e.pointerId)
    svgEl.focus({ preventScroll: true })
  }

  function onMove(e: PointerEvent) {
    const gs = gesture
    if (!gs || e.pointerId !== gs.id || !g) return
    const at = toMm(e)
    const next =
      gs.kind === 'move'
        ? moveBy(gs.start, at.xMm - gs.from.xMm, at.yMm - gs.from.yMm)
        : gs.kind === 'scale'
          ? scaleFromHandle(g, gs.start, gs.from, at)
          : rotateFromHandle(g, gs.start, gs.from, at, e.shiftKey)
    svgImport.setPlacement(next)
  }

  function end(e: PointerEvent) {
    if (!gesture || e.pointerId !== gesture.id) return
    gesture = null
    frozen = null
  }

  function onKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 10 : 1
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key]
    if (d) svgImport.setPlacement(moveBy(p, d[0]!, d[1]!))
    else if (e.key === 'Enter') svgImport.finishPlacing()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  const fmt = (v: number) => String(+v.toFixed(1) || 0)
</script>

<div class="place">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg
    bind:this={svgEl}
    class:busy={gesture !== null}
    {viewBox}
    preserveAspectRatio="xMidYMid meet"
    role="application"
    aria-label="Place the design on the bed. Drag to move, drag a corner to scale, drag the top handle to rotate (Shift snaps to 15°), arrow keys nudge, Enter simulates."
    tabindex="0"
    onpointermove={onMove}
    onpointerup={end}
    onpointercancel={end}
    onkeydown={onKey}
    onwheel={(e) => e.stopPropagation()}
  >
    <g bind:this={plane} transform="scale(1,-1)">
      <rect class="bed" class:off={off > 0} x="0" y="0" width={bed.x} height={bed.y} />
      {#each grid as l, i (i)}
        <line class="grid" class:major={l.major} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
      {/each}
      <rect class="bed-edge" class:off={off > 0} x="0" y="0" width={bed.x} height={bed.y} />
      <circle class="origin" cx="0" cy="0" r={4 / pxPerMm} />

      {#if matrix}
        <g transform="matrix({matrix.join(' ')})">
          {#each paths as path (path.key)}
            <!-- A light halo first, so dark layer colours show on the dark bed. -->
            <path class="halo" d={path.d} />
          {/each}
          {#each paths as path (path.key)}
            <path
              class="vec"
              class:no-output={!path.output}
              d={path.d}
              stroke={path.color}
              fill={path.fill ? path.color : 'none'}
              fill-opacity={path.fill ? 0.3 : undefined}
              fill-rule={path.rule}
            />
          {/each}
        </g>
      {/if}

      {#if corners.length === 4}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <polygon class="select" points={poly(corners)} onpointerdown={(e) => begin(e, 'move')} />
        {#if rotateHandle}
          <line class="stem" x1={rotateHandle.mid.xMm} y1={rotateHandle.mid.yMm} x2={rotateHandle.at.xMm} y2={rotateHandle.at.yMm} />
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <circle class="handle rotate" cx={rotateHandle.at.xMm} cy={rotateHandle.at.yMm} r={handleMm * 0.7} onpointerdown={(e) => begin(e, 'rotate')}>
            <title>Rotate (Shift snaps to 15°)</title>
          </circle>
        {/if}
        {#each corners as c, i (i)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <rect class="handle scale" x={c.xMm - handleMm / 2} y={c.yMm - handleMm / 2} width={handleMm} height={handleMm} onpointerdown={(e) => begin(e, 'scale')}>
            <title>Scale (aspect locked)</title>
          </rect>
        {/each}
      {/if}
    </g>
  </svg>

  <div class="bar" role="status">
    <span
      >Bed {fmt(bed.x)} × {fmt(bed.y)} mm{#if box}{' · '}design ({fmt(box.minXMm)}, {fmt(box.minYMm)}) to ({fmt(box.maxXMm)}, {fmt(box.maxYMm)}) mm{/if}</span
    >
    {#if off > 0}<span class="warn">Off the bed by up to {fmt(off)} mm</span>{/if}
  </div>
  <div class="tools">
    <span class="hint">Drag to move · corners scale · top handle rotates (Shift: 15°)</span>
    <button class="btn primary" onclick={() => svgImport.finishPlacing()}>Simulate</button>
  </div>
</div>

<style>
  .place {
    position: absolute;
    inset: 0;
    background: var(--paper);
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    outline: none;
    cursor: default;
    touch-action: none;
  }
  svg:focus-visible {
    outline: var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-offset));
  }
  svg.busy {
    cursor: grabbing;
  }
  .bed {
    fill: var(--bed);
  }
  .bed-edge {
    fill: none;
    stroke: var(--line-strong);
    stroke-width: 1.5px;
    vector-effect: non-scaling-stroke;
  }
  .bed-edge.off {
    stroke: var(--warn);
  }
  .grid {
    stroke: var(--line-subtle);
    stroke-width: 1px;
    vector-effect: non-scaling-stroke;
  }
  .grid.major {
    stroke: var(--line);
  }
  .origin {
    fill: var(--accent);
  }
  .vec {
    stroke-width: 1.25px;
    vector-effect: non-scaling-stroke;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .halo {
    fill: none;
    stroke: var(--fg-faint);
    stroke-width: 3px;
    stroke-opacity: 0.55;
    vector-effect: non-scaling-stroke;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .vec.no-output {
    stroke-dasharray: 4 3;
    opacity: 0.6;
  }
  .select {
    fill: transparent;
    stroke: var(--accent-ring);
    stroke-width: 1px;
    stroke-dasharray: 5 4;
    vector-effect: non-scaling-stroke;
    cursor: move;
  }
  .stem {
    stroke: var(--accent-ring);
    stroke-width: 1px;
    vector-effect: non-scaling-stroke;
  }
  .handle {
    fill: var(--panel);
    stroke: var(--accent-ring);
    stroke-width: 1.5px;
    vector-effect: non-scaling-stroke;
  }
  .handle.scale {
    cursor: nwse-resize;
  }
  .handle.rotate {
    cursor: grab;
  }
  .bar {
    position: absolute;
    left: 10px;
    bottom: 10px;
    display: flex;
    gap: 10px;
    padding: 4px 8px;
    border-radius: var(--radius);
    border: 1px solid var(--line);
    background: var(--overlay);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg);
    pointer-events: none;
  }
  .bar .warn {
    color: var(--warn-text);
  }
  .tools {
    position: absolute;
    right: 10px;
    top: 10px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .hint {
    padding: 4px 8px;
    border-radius: var(--radius);
    background: var(--overlay);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .btn.primary {
    min-height: 28px;
    padding: 0 14px;
    font-family: var(--font-condensed);
    font-size: var(--text-ui);
  }
</style>
