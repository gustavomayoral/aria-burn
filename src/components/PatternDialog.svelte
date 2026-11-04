<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  Test patterns (BURN-32): choose a calibration pattern for the active machine
  and material, see where it lands and how long it takes, then preview it in
  the sim or save its G-code for the laser.
-->
<script lang="ts">
  import { patternGenerator } from 'aria-burn-core/calibration'
  import { app } from '../lib/app.svelte.ts'
  import { PATTERN_KINDS, calibration } from '../lib/calibration.svelte.ts'
  import { findMaterial } from '../lib/materials.ts'

  const material = $derived(findMaterial(app.settings.ui.materialId))
  const machine = $derived(app.settings.machine)
  const result = $derived(calibration.generate(machine, material, calibration.kind))
  const pattern = $derived(result.pattern)

  let manual = $state(calibration.placement.originMm !== null)
  let ox = $state(calibration.placement.originMm?.x ?? 10)
  let oy = $state(calibration.placement.originMm?.y ?? 10)
  $effect(() => {
    calibration.placement = { originMm: manual ? { x: Number(ox) || 0, y: Number(oy) || 0 } : null }
  })

  let note = $state<string | null>(null)
  let card: HTMLDivElement

  const fmtTime = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`)
  const mm = (v: number) => v.toFixed(1)

  async function save() {
    if (!pattern) return
    try {
      note = `Saved ${await calibration.saveGcode(pattern)}`
    } catch (e) {
      note = `Couldn’t save: ${String(e)}`
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') calibration.open = false
  }

  $effect(() => card?.focus())
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && (calibration.open = false)} onkeydown={onKey}>
  <div class="card" role="dialog" aria-modal="true" aria-labelledby="pattern-title" tabindex="-1" bind:this={card}>
    <header>
      <h2 id="pattern-title">Test patterns</h2>
      <button class="btn small" onclick={() => (calibration.open = false)}>Close</button>
    </header>
    <p class="for">For <strong>{machine.name}</strong> · <strong>{material.name.replace(' (provisional)', '')}</strong></p>

    <div class="body">
      <div class="kinds" role="radiogroup" aria-label="Pattern">
        {#each PATTERN_KINDS as kind (kind)}
          {@const gen = patternGenerator(kind)}
          <button class="kind" role="radio" aria-checked={calibration.kind === kind} onclick={() => (calibration.kind = kind)}>
            <span class="title">{gen.title}</span>
            <span class="summary">{gen.summary}</span>
          </button>
        {/each}
      </div>

      <div class="side">
        <div class="section-label">Position</div>
        <div class="seg" role="group" aria-label="Position">
          <button aria-pressed={!manual} onclick={() => (manual = false)}>Near origin</button>
          <button aria-pressed={manual} onclick={() => (manual = true)}>At X / Y</button>
        </div>
        {#if manual}
          <div class="xy">
            <label>X (mm)<input type="number" min="0" step="1" bind:value={ox} /></label>
            <label>Y (mm)<input type="number" min="0" step="1" bind:value={oy} /></label>
          </div>
        {/if}

        {#if pattern}
          {@const b = pattern.burnBoundsMm}
          <div class="kv">
            <span>Burn area</span><span>{mm(b.maxXMm - b.minXMm)} × {mm(b.maxYMm - b.minYMm)} mm</span>
            <span>From</span><span>X {mm(b.minXMm)}, Y {mm(b.minYMm)}</span>
            <span>Bed</span><span>{pattern.machine.bedMm.x} × {pattern.machine.bedMm.y} mm</span>
            <span>Cells</span><span>{pattern.cells.length}</span>
            <span>Time</span><span>≥ {fmtTime(pattern.estimatedTimeS)}</span>
          </div>
          <p class="note">
            Power and speed ranges follow this machine and material. Labels are engraved, and corner marks frame the print for a photo later.
          </p>
        {:else}
          <div class="callout warn" role="alert">{result.error}</div>
        {/if}

        <div class="actions">
          <button class="btn" disabled={!pattern} onclick={save}>Save G-code</button>
          <button class="btn primary" disabled={!pattern} onclick={() => pattern && calibration.preview(pattern)}>Preview in sim</button>
        </div>
        {#if note}<p class="note" role="status">{note}</p>{/if}
        <p class="note">Burn the saved G-code on your laser. Then preview it here and click the cell that looked best to keep its settings.</p>
      </div>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-picker);
    background: var(--overlay);
    display: grid;
    place-items: center;
    padding: 16px;
  }
  .card {
    width: min(760px, 100%);
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-paper);
    padding: 16px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .card:focus-visible {
    outline: var(--focus-ring);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-family: var(--font-condensed);
    font-size: var(--text-sm);
    line-height: var(--leading-sm);
    font-weight: 600;
    color: var(--fg-strong);
  }
  .for {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
  }
  .for strong {
    color: var(--fg);
    font-weight: 500;
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: 20px;
  }
  @media (max-width: 640px) {
    .body {
      grid-template-columns: 1fr;
    }
  }
  .kinds {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .kind {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: transparent;
  }
  .kind:hover:not([aria-checked='true']) {
    border-color: var(--line-strong);
    background: var(--raised);
  }
  .kind[aria-checked='true'] {
    border-color: var(--accent-border);
    background: var(--accent-soft);
  }
  .title {
    font-weight: 500;
    color: var(--fg-strong);
  }
  .summary {
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .xy {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .xy label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .xy input {
    font-family: var(--font-mono);
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .note {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
</style>
