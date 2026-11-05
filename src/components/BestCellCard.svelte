<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  "Pick the best cell" (BURN-32): over the burn view while a calibration
  pattern is open. Click a cell on the canvas (or choose it from the list),
  name it, and its settings are kept as a material setting.

  Measurement patterns (BURN-47) pick by their own rule: the first line that
  marked, the thinnest line, or a scan offset strip with the shift measured on
  the burn. Those are kept as machine readings for the contract field the
  pattern measures.
-->
<script lang="ts">
  import { app } from '../lib/app.svelte.ts'
  import { calibration } from '../lib/calibration.svelte.ts'
  import { describeReading, isReadingKind, readingsFor } from '../lib/machine-readings.ts'
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

  // Measurement patterns.
  const pick = $derived(pattern?.pick ?? 'best-cell')
  const HEADS = { 'best-cell': 'Pick the best cell', 'first-visible': 'Pick the first visible line', thinnest: 'Pick the thinnest line', shift: 'Measure the scan offset' } as const
  const HINTS = {
    'best-cell': 'Click the cell that looked best on your real burn.',
    'first-visible': 'Click the first line, from the top, that marked at all on your real burn.',
    thinnest: 'Click the thinnest line on your real burn: that Z is best focus. Measure its width if you can.',
    shift: 'For each strip, measure how far forward and back lines end apart at the same edge (the ticks mark the programmed edge), then click the strip and enter it.',
  } as const
  let widthMm = $state<number | null>(null)
  let shiftMm = $state<number | null>(null)
  $effect(() => {
    void calibration.selectedId
    widthMm = null
    shiftMm = null
  })
  const saved = $derived(pattern && isReadingKind(pattern.kind) ? readingsFor(calibration.readings, pattern.kind, pattern.machine) : [])

  async function saveReading() {
    saving = true
    error = null
    try {
      await calibration.saveReading({ lineWidthMm: widthMm, shiftMm })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      saving = false
    }
  }
  const sameMaterial = $derived(pattern?.material.id === app.settings.ui.materialId)
</script>

{#if pattern}
  <section class="card" aria-label={HEADS[pick]}>
    <div class="head">
      <div class="section-label">{HEADS[pick]}</div>
      <button class="btn small" onclick={() => calibration.close()}>Done</button>
    </div>
    <p class="hint">{HINTS[pick]}</p>
    {#if pattern.measures}
      <p class="measures">Measures <code>{pattern.measures.on}.{pattern.measures.field}</code>{pattern.measures.inContract ? '' : ' (not in the contract yet)'}</p>
    {/if}
    <label class="pick">
      <span class="sr">{pick === 'best-cell' ? 'Cell' : pick === 'shift' ? 'Strip' : 'Line'}</span>
      <select value={calibration.selectedId ?? ''} onchange={(e) => (calibration.selectedId = e.currentTarget.value || null)}>
        <option value="">{pick === 'best-cell' ? 'Choose a cell…' : pick === 'shift' ? 'Choose a strip…' : 'Choose a line…'}</option>
        {#each pattern.cells as c (c.id)}
          <option value={c.id}>{c.id} · {c.label}</option>
        {/each}
      </select>
    </label>
    {#if cell && pick !== 'best-cell'}
      {@const s = cell.settings}
      <div class="kv">
        {#if pick === 'first-visible'}
          <span>Marks from</span><span>{s.powerPct.toFixed(1)}% (S{s.s})</span>
          <span>Curve says</span><span>{s.powerW} W at this S</span>
          <span>Speed</span><span>{s.feedMmPerMin} mm/min</span>
        {:else if pick === 'thinnest'}
          {@const z = Number(cell.extra?.zOffsetMm ?? 0)}
          <span>Best focus</span><span>Z {z > 0 ? '+' : ''}{z} mm {z === 0 ? '(as focused)' : z > 0 ? '(head up)' : '(head down)'}</span>
          <span>Line</span><span>{pct(s.powerPct)}% · {s.feedMmPerMin} mm/min</span>
        {:else}
          <span>Strip</span><span>{s.feedMmPerMin} mm/min, scan {s.scan?.toUpperCase()}</span>
          <span>Lines</span><span>every {s.intervalMm} mm</span>
        {/if}
      </div>
      <form
        onsubmit={(e) => {
          e.preventDefault()
          void saveReading()
        }}
      >
        {#if pick === 'thinnest'}
          <label>
            Line width (mm, optional)
            <input type="number" min="0" max="2" step="0.01" bind:value={widthMm} />
          </label>
        {:else if pick === 'shift'}
          <label>
            Forward/back shift (mm)
            <input type="number" min="-5" max="5" step="0.01" bind:value={shiftMm} required />
          </label>
        {/if}
        <button class="btn primary" type="submit" disabled={saving}>Save reading</button>
      </form>
    {/if}
    {#if pick !== 'best-cell' && saved.length}
      <div class="saved-list">
        <div class="section-label">Saved for this machine</div>
        <ul>
          {#each saved as r (r.id)}
            <li>
              <span>{describeReading(r)}</span>
              <button class="btn small" aria-label="Delete reading {describeReading(r)}" onclick={() => calibration.removeReading(r.id)}>Delete</button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if cell && pick === 'best-cell'}
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
  .measures {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .measures code {
    font-family: var(--font-mono);
    color: var(--fg);
  }
  .saved-list ul {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .saved-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
