<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import type { MaterialProfile } from 'aria-burn-core/contract'
  import { app } from '../lib/app.svelte.ts'
  import { calibration } from '../lib/calibration.svelte.ts'
  import { settingsFor } from '../lib/material-settings.ts'
  import { KIND_LABEL, allMaterials, findMaterial, labToCss } from '../lib/materials.ts'
  import { photoFit } from '../lib/photo-fit.svelte.ts'

  const selected = $derived(findMaterial(app.settings.ui.materialId))
  /** Settings picked from calibration patterns for this material (BURN-32). */
  const saved = $derived(settingsFor(calibration.library, selected.id))
  const pct = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1))

  function pick(m: MaterialProfile) {
    app.settings.ui.materialId = m.id
    void app.savePrefs()
  }

  /** Honesty tag from the profile's metadata (COD-266 → COD-254 → COD-257), not from code. */
  const tag = (m: MaterialProfile) => m.provenance.label ?? (m.provenance.source === 'calibrated' ? 'calibrated' : m.provenance.source === 'user' ? 'your profile' : 'provisional')

  const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(2))

  /** Read-only threshold rows, per response kind. */
  const fields = $derived.by(() => {
    const r = selected.response
    const rows: [string, string][] = [['Absorption', selected.absorption.toFixed(2)]]
    if (r.kind === 'char') {
      rows.push(['Tone start', `${fmt(r.toneStartJPerMm2)} J/mm²`], ['Tone end', `${fmt(r.toneEndJPerMm2)} J/mm²`])
      rows.push(['Ablation', `${fmt(r.ablationThresholdJPerMm2)} J/mm²`])
    } else if (r.kind === 'melt') {
      rows.push(['Frost start', `${fmt(r.frostStartJPerMm2)} J/mm²`], ['Frost full', `${fmt(r.frostFullJPerMm2)} J/mm²`])
      rows.push(['Removal', `${fmt(r.removalThresholdJPerMm2)} J/mm²`])
    } else {
      rows.push(['Mark start', `${fmt(r.markStartJPerMm2)} J/mm²`], ['Mark full', `${fmt(r.markFullJPerMm2)} J/mm²`])
      rows.push(['Damage', `${fmt(r.damageThresholdJPerMm2)} J/mm²`])
    }
    const fire = selected.fireRisk
    if (fire.kind === 'temperature') rows.push(['Fire risk', `${Math.round(fire.thresholdK - 273.15)} °C built-up heat`])
    else if (fire.kind === 'fluence') rows.push(['Fire risk', `${fmt(fire.thresholdJPerMm2)} J/mm²`])
    rows.push(['Speed / dwell', selected.thermal.kind === 'peakTemperature' ? 'thermal dose (COD-258)' : 'fluence only'])
    return rows
  })
</script>

<aside>
  <div>
    <div class="section-label">Material</div>
    <div class="list">
      {#each allMaterials() as m (m.id)}
        <button class="material" aria-pressed={m.id === selected.id} onclick={() => pick(m)}>
          <span class="swatch" style:background={labToCss(m.response.baseColor)} aria-hidden="true"></span>
          <span class="text">
            <span class="name">{m.name.replace(' (provisional)', '')}</span>
            <span class="kind">{KIND_LABEL[m.response.kind]} · {tag(m)}</span>
          </span>
        </button>
      {/each}
    </div>
    {#if selected.provenance.source === 'provisional'}
      <p class="note">Provisional profiles from published data, not yet validated against real burns. Treat predictions as approximate.</p>
    {/if}
    {#if photoFit.isUser(selected.id)}
      {@const entry = photoFit.library.materials.find((m) => m.profile.id === selected.id)}
      <p class="note">
        Calibrated{selected.provenance.meanDeltaE !== undefined ? ` · mean ΔE ${selected.provenance.meanDeltaE.toFixed(2)} on its grid` : ''} · {entry?.machine.name}.
        <button class="link" onclick={() => photoFit.removeMaterial(selected.id)}>Delete</button>
      </p>
    {/if}
    <div class="buttons">
      <button class="btn wide" onclick={() => (calibration.open = true)}>Test patterns…</button>
      <button class="btn wide" onclick={() => photoFit.begin(app.settings.machine, selected)}>Fit from a photo…</button>
    </div>
  </div>
  <div>
    <div class="section-label">Your settings</div>
    {#if saved.length}
      <ul class="saved">
        {#each saved as s (s.id)}
          <li>
            <span class="text">
              <span class="name">{s.name}</span>
              <span class="kind"
                >{pct(s.powerPct)}% · {s.feedMmPerMin} mm/min{s.intervalMm ? ` · ${s.intervalMm} mm` : ''} · {s.machine.name}</span
              >
            </span>
            <button class="btn small" aria-label="Delete {s.name}" onclick={() => calibration.remove(s.id)}>Delete</button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="note">None yet. Burn a test pattern, then click the cell that looked best to keep its power and speed.</p>
    {/if}
  </div>
  <details>
    <summary>Advanced thresholds</summary>
    <div class="kv">
      {#each fields as [label, value] (label)}
        <span>{label}</span><span>{value}</span>
      {/each}
    </div>
    <p class="note">Read-only here. Fit them to your laser and material with “Fit from a photo”.</p>
  </details>
</aside>

<style>
  .buttons {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent-text);
    font: inherit;
    cursor: pointer;
  }
  aside {
    flex: 0 0 272px;
    min-width: 240px;
    border-right: 1px solid var(--line-subtle);
    background: var(--panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .material {
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    padding: 6px 8px;
    border-radius: var(--radius);
    border: 1px solid var(--line);
    background: transparent;
  }
  .material:hover:not([aria-pressed='true']) {
    border-color: var(--line-strong);
    background: var(--raised);
  }
  .material[aria-pressed='true'] {
    border-color: var(--accent-border);
    background: var(--accent-soft);
  }
  .swatch {
    width: 22px;
    height: 22px;
    border-radius: var(--radius);
    border: 1px solid var(--swatch-border);
    flex: 0 0 auto;
  }
  .text {
    display: flex;
    flex-direction: column;
  }
  .name {
    font-weight: 500;
    color: var(--fg-strong);
  }
  .kind {
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .saved {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .saved li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .wide {
    width: 100%;
  }
  summary {
    cursor: pointer;
    font-family: var(--font-condensed);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    font-weight: 600;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: var(--fg-muted);
    margin-bottom: 10px;
  }
  summary:hover {
    color: var(--fg);
  }
</style>
