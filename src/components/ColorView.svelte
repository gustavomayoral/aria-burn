<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { app } from '../lib/app.svelte.ts'
  import { findMaterial, labToRgb, markColor } from '../lib/materials.ts'
  import { PREVIEW_PITCH_MM, preview } from '../lib/preview.svelte.ts'

  let { zoom }: { zoom: number } = $props()

  let canvas: HTMLCanvasElement
  let hover = $state<{ xMm: number; yMm: number; energy: number } | null>(null)
  let frame = 0

  const material = $derived(findMaterial(app.settings.ui.materialId))

  function draw() {
    frame = 0
    const ctx = canvas?.getContext('2d')
    if (!ctx) return
    const { width, height, energy } = preview
    const image = ctx.createImageData(width, height)
    const [br, bg, bb] = labToRgb(material.response.baseColor)
    const [mr, mg, mb] = labToRgb(markColor(material))
    const inv = preview.max > 0 ? 1 / preview.max : 0
    for (let i = 0; i < energy.length; i++) {
      const t = Math.min(1, energy[i]! * inv) ** 0.7
      const o = i * 4
      image.data[o] = br + (mr - br) * t
      image.data[o + 1] = bg + (mg - bg) * t
      image.data[o + 2] = bb + (mb - bb) * t
      image.data[o + 3] = 255
    }
    ctx.putImageData(image, 0, 0)
  }

  // Redraw at most once per frame however fast batches arrive.
  $effect(() => {
    void preview.version
    void material
    if (!frame) frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      frame = 0
    }
  })

  function onMove(e: PointerEvent) {
    const r = canvas.getBoundingClientRect()
    const cx = Math.floor(((e.clientX - r.left) / r.width) * preview.width)
    const cy = Math.floor(((e.clientY - r.top) / r.height) * preview.height)
    if (cx < 0 || cy < 0 || cx >= preview.width || cy >= preview.height) return (hover = null)
    hover = {
      xMm: preview.bounds.minX + (cx + 0.5) * PREVIEW_PITCH_MM,
      yMm: preview.bounds.maxY - (cy + 0.5) * PREVIEW_PITCH_MM,
      energy: preview.energy[cy * preview.width + cx]!,
    }
  }

  const headStyle = $derived.by(() => {
    const live = app.source === 'live' && app.live !== null && app.live.done === null
    const h = live && app.machine ? app.machine.positionMm : preview.head
    if (!h || (app.stream.state !== 'running' && !live)) return null
    const b = preview.bounds
    const x = ((h.xMm - b.minX) / (b.maxX - b.minX)) * 100
    const y = ((b.maxY - h.yMm) / (b.maxY - b.minY)) * 100
    return `left:${x}%;top:${y}%`
  })

  const cellAreaMm2 = PREVIEW_PITCH_MM * PREVIEW_PITCH_MM
</script>

<div class="wrap">
  <div class="bed" style:width="{zoom * 600}px">
    <canvas bind:this={canvas} width={preview.width} height={preview.height} onpointermove={onMove} onpointerleave={() => (hover = null)}></canvas>
    {#if headStyle}
      <div class="head" style={headStyle} aria-hidden="true"></div>
    {/if}
  </div>
  {#if hover}
    <div class="hover" role="status">
      <span>{hover.xMm.toFixed(1)}, {hover.yMm.toFixed(1)} mm</span>
      <span>{(hover.energy / cellAreaMm2).toFixed(3)} J/mm² (placeholder bin)</span>
    </div>
  {/if}
  <div class="scale" aria-hidden="true">
    <div class="bar" style:width="{zoom * 600 * (10 / 60)}px"></div>
    <span>10 mm</span>
  </div>
</div>

<style>
  .wrap {
    position: absolute;
    inset: 0;
    overflow: auto;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .bed {
    position: relative;
    box-shadow: 0 0 0 1px var(--line-strong), 0 12px 40px rgba(0, 0, 0, 0.45);
  }
  canvas {
    display: block;
    width: 100%;
    height: auto;
    image-rendering: pixelated;
    cursor: crosshair;
  }
  .head {
    position: absolute;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    border-radius: 50%;
    border: 2px solid var(--accent);
    box-shadow: 0 0 12px var(--accent);
    pointer-events: none;
  }
  .hover {
    position: absolute;
    left: 16px;
    top: 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--overlay);
    font-family: var(--mono);
    font-size: 11px;
  }
  .scale {
    position: absolute;
    left: 16px;
    bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--text-2);
  }
  .bar {
    height: 4px;
    border: 1px solid var(--text-2);
    border-top: 0;
  }
</style>
