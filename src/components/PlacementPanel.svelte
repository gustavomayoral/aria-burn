<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Where an imported SVG sits on the bed (BURN-54): X/Y of a 9-point anchor,
     width/height and scale (aspect locked), rotation, "Reset to true size" and
     "Centre on bed", and the Place / Simulate switch. The fields edit the
     design's drawn box (svg-place.ts). -->
<script lang="ts">
  import { usableBedMm } from 'aria-burn-core/calibration'
  import { app } from '../lib/app.svelte.ts'
  import { svgImport } from '../lib/svg-import.svelte.ts'
  import {
    ANCHORS,
    centreOnBed,
    designSize,
    offBedMm,
    resetSize,
    setAnchor,
    setPosition,
    setRotation,
    setScale,
    setSize,
    shownBox,
    type Anchor,
    type Placement,
  } from '../lib/svg-place.ts'

  const g = $derived(svgImport.geometry)
  const p = $derived(svgImport.placement)
  const bed = $derived(usableBedMm(app.settings.machine))
  const size = $derived(g ? designSize(g, p.scale) : null)
  const shown = $derived(svgImport.layers.filter((l) => l.settings.visible).map((l) => l.id))
  const off = $derived(g ? offBedMm(shownBox(g, p, shown), bed) : 0)

  const ANCHOR_LABELS: Record<Anchor, string> = {
    'top-left': 'Top left',
    top: 'Top',
    'top-right': 'Top right',
    left: 'Left',
    center: 'Centre',
    right: 'Right',
    'bottom-left': 'Bottom left',
    bottom: 'Bottom',
    'bottom-right': 'Bottom right',
  }

  /** Field display: at most 2 decimals, no trailing zeros, and never -0. */
  const fmt = (v: number, digits = 2) => String(+v.toFixed(digits) || 0)

  /** Applies a number field and shows the value kept. */
  function num(e: Event, next: (v: number) => Placement | null, kept: () => number, digits = 2) {
    const input = e.currentTarget as HTMLInputElement
    const n = next(input.valueAsNumber)
    if (n) svgImport.setPlacement(n)
    input.value = fmt(kept(), digits)
  }
</script>

{#if g && size}
  <section aria-label="Placement">
    <div class="head">
      <div class="section-label">Placement</div>
      {#if svgImport.placing}
        <button class="btn primary small" onclick={() => svgImport.finishPlacing()} title="Leave Place mode and simulate the burn here">Simulate</button>
      {:else}
        <button class="btn small" onclick={() => svgImport.place()} title="Show the bed and drag, scale or rotate the design">Place</button>
      {/if}
    </div>

    <div class="row">
      <div class="anchors" role="group" aria-label="Anchor for X and Y">
        {#each ANCHORS as a (a)}
          <button aria-pressed={p.anchor === a} aria-label="Anchor {ANCHOR_LABELS[a]}" title="X/Y are the {ANCHOR_LABELS[a].toLowerCase()} of the design" onclick={() => svgImport.setPlacement(setAnchor(g, p, a))}
          ></button>
        {/each}
      </div>
      <div class="grid">
        <label class="field">X mm<input type="number" step="1" value={fmt(p.xMm)} onchange={(e) => num(e, (v) => setPosition(p, v, p.yMm), () => svgImport.placement.xMm)} /></label>
        <label class="field">Y mm<input type="number" step="1" value={fmt(p.yMm)} onchange={(e) => num(e, (v) => setPosition(p, p.xMm, v), () => svgImport.placement.yMm)} /></label>
      </div>
    </div>
    <div class="grid">
      <label class="field"
        >W mm<input type="number" min="0" step="1" value={fmt(size.widthMm)} onchange={(e) => num(e, (v) => setSize(g, p, 'width', v), () => designSize(g, svgImport.placement.scale).widthMm)} /></label
      >
      <label class="field"
        >H mm<input type="number" min="0" step="1" value={fmt(size.heightMm)} onchange={(e) => num(e, (v) => setSize(g, p, 'height', v), () => designSize(g, svgImport.placement.scale).heightMm)} /></label
      >
    </div>
    <div class="grid">
      <label class="field"
        >Scale %<input type="number" min="0.1" step="1" value={fmt(p.scale * 100, 1)} onchange={(e) => num(e, (v) => (v > 0 ? setScale(g, p, v / 100) : null), () => svgImport.placement.scale * 100, 1)} /></label
      >
      <label class="field"
        >Rotation °<input type="number" step="15" value={fmt(p.rotationDeg, 1)} onchange={(e) => num(e, (v) => setRotation(g, p, v), () => svgImport.placement.rotationDeg, 1)} /></label
      >
    </div>
    <div class="actions">
      <button class="btn small" disabled={p.scale === 1} onclick={() => svgImport.setPlacement(resetSize(g, p))} title="Scale 100 %: the size the SVG gives in mm">Reset to true size</button>
      <button class="btn small" onclick={() => svgImport.setPlacement(centreOnBed(g, p, bed))}>Centre on bed</button>
    </div>
    {#if off > 0}
      <div class="callout warn" role="status">
        <strong>Off the bed by up to {fmt(off, 1)} mm</strong>
        Part of the design is outside the {fmt(bed.x, 0)} × {fmt(bed.y, 0)} mm work area. Only the part inside is simulated.
      </div>
    {/if}
    {#if svgImport.placing && svgImport.placementStale}
      <p class="hint">Moved since the last burn. Simulate to burn it here.</p>
    {/if}
  </section>
{/if}

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .head .section-label {
    margin-bottom: 0;
  }
  .btn.small {
    min-height: 28px;
    padding: 0 10px;
    font-family: var(--font-condensed);
    font-size: var(--text-ui);
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: 10px;
  }
  .row .grid {
    flex: 1 1 auto;
  }
  .anchors {
    display: grid;
    grid-template-columns: repeat(3, 16px);
    gap: 3px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    flex: 0 0 auto;
  }
  .anchors button {
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid var(--line-strong);
    border-radius: 50%;
    background: transparent;
  }
  .anchors button:hover:not([aria-pressed='true']) {
    background: var(--raised);
  }
  .anchors button[aria-pressed='true'] {
    background: var(--accent);
    border-color: var(--accent-border);
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--font-condensed);
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
    color: var(--fg-muted);
  }
  input[type='number'] {
    background: var(--field);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 4px 8px;
    min-width: 0;
    width: 100%;
    font-family: var(--font-mono);
    font-size: var(--text-ui);
    line-height: var(--leading-ui);
    color: var(--fg);
  }
  input[type='number']:focus {
    border-color: var(--accent-border);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .hint {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-faint);
  }
</style>
