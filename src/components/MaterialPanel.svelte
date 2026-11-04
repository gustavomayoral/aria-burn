<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import type { MaterialProfile } from 'aria-burn-core/contract'
  import { app } from '../lib/app.svelte.ts'
  import { KIND_LABEL, MATERIALS, findMaterial, labToCss } from '../lib/materials.ts'

  const selected = $derived(findMaterial(app.settings.ui.materialId))

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
      {#each MATERIALS as m (m.id)}
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
    <button class="btn wide" disabled>Calibrate from test grid… (coming later)</button>
  </div>
  <details>
    <summary>Advanced thresholds</summary>
    <div class="kv">
      {#each fields as [label, value] (label)}
        <span>{label}</span><span>{value}</span>
      {/each}
    </div>
    <p class="note">Read-only in v1. Refit per laser by calibration later.</p>
  </details>
</aside>

<style>
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
