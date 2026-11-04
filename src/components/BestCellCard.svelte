<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  "Pick the best cell" (BURN-32): over the burn view while a calibration
  pattern is open. Click a cell on the canvas (or choose it from the list),
  name it, and its settings are kept as a material setting.
-->
<script lang="ts">
  import { app } from '../lib/app.svelte.ts'
  import { calibration } from '../lib/calibration.svelte.ts'
  import { suggestName } from '../lib/material-settings.ts'
  import { findMaterial } from '../lib/materials.ts'

  const pattern = $derived(calibration.active)
  const cell = $derived(calibration.selected)
  const material = $derived(pattern ? findMaterial(pattern.material.id) : null)
  let name = $state('')
  let error = $state<string | null>(null)
  let saving = $state(false)

  // A new pick suggests a new name.
  $effect(() => {
    if (cell && material) name = suggestName(material.name, cell)
  })

  async function save() {
    saving = true
    error = null
    try {
      await calibration.saveSelected(name)
    } catch (e) {
      error = String(e)
    } finally {
      saving = false
    }
  }

  const pct = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1))
  const sameMaterial = $derived(pattern?.material.id === app.settings.ui.materialId)
</script>

{#if pattern}
  <section class="card" aria-label="Pick the best cell">
    <div class="head">
      <div class="section-label">Pick the best cell</div>
      <button class="btn small" onclick={() => calibration.close()}>Done</button>
    </div>
    <p class="hint">Click the cell that looked best on your real burn.</p>
    <label class="pick">
      <span class="sr">Cell</span>
      <select value={calibration.selectedId ?? ''} onchange={(e) => (calibration.selectedId = e.currentTarget.value || null)}>
        <option value="">Choose a cell…</option>
        {#each pattern.cells as c (c.id)}
          <option value={c.id}>{c.id} · {c.label}</option>
        {/each}
      </select>
    </label>
    {#if cell}
      {@const s = cell.settings}
      <div class="kv">
        <span>Power</span><span>{pct(s.powerPct)}% (S{s.s}) · {s.powerW} W</span>
        <span>Speed</span><span>{s.feedMmPerMin} mm/min</span>
        {#if s.intervalMm}<span>Interval</span><span>{s.intervalMm} mm, scan {s.scan?.toUpperCase()}</span>{/if}
        <span>Energy</span><span>{s.energyJPerMm2} J/mm²</span>
      </div>
      <form
        onsubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label>
          Setting name
          <input type="text" bind:value={name} maxlength="60" />
        </label>
        <button class="btn primary" type="submit" disabled={saving}>Save setting</button>
      </form>
      {#if !sameMaterial}
        <p class="hint">Saved for {material?.name}, the material this pattern was made for.</p>
      {/if}
    {/if}
    {#if error}<div class="callout danger" role="alert">{error}</div>{/if}
    {#if calibration.note}<p class="saved" role="status">{calibration.note}</p>{/if}
  </section>
{/if}

<style>
  .card {
    position: absolute;
    top: 12px;
    left: 12px;
    width: 260px;
    max-width: calc(100% - 24px);
    padding: 12px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-popup);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .hint,
  .saved {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .saved {
    color: var(--ok-text);
  }
  select,
  input {
    width: 100%;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
