<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Layers of an imported SVG (BURN-53): one row per colour layer, and the
     selected layer's settings. Every change re-simulates (svg-import.svelte.ts). -->
<script lang="ts">
  import type { LayerSettings } from 'aria-burn-core/svg'
  import { replaceSvg } from '../lib/open-file.ts'
  import type { LayerPatch, LayerRow } from '../lib/svg-layers.ts'
  import { svgImport } from '../lib/svg-import.svelte.ts'

  const rows = $derived(svgImport.rows)
  const sel = $derived(rows.find((r) => r.id === svgImport.selected) ?? null)

  const fmtLength = (mm: number) => (mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm.toFixed(mm >= 100 ? 0 : 1)} mm`)
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

  /** Applies a number field and shows the value kept (clamped, or the old one for an emptied field). */
  function num(e: Event, id: string, patch: (v: number) => LayerPatch, kept: (s: LayerSettings) => number) {
    const input = e.currentTarget as HTMLInputElement
    svgImport.update(id, patch(input.valueAsNumber))
    const s = svgImport.layers.find((l) => l.id === id)?.settings
    if (s) input.value = String(kept(s))
  }
  const checked = (e: Event) => (e.currentTarget as HTMLInputElement).checked

  function skippedNote(r: LayerRow): string | null {
    if (!r.skipped) return null
    return r.settings.mode === 'line'
      ? `${plural(r.skipped, 'shape')} on this layer only by fill colour ${r.skipped === 1 ? 'is' : 'are'} traced by ${r.skipped === 1 ? 'its' : 'their'} stroke colour’s layer instead.`
      : `${plural(r.skipped, 'open path')} can’t be filled and ${r.skipped === 1 ? 'is' : 'are'} skipped.`
  }
</script>

<section aria-label="SVG layers">
  <div class="section-label">Layers</div>
  <div class="file-row">
    <p class="file" title={svgImport.name}>{svgImport.name}{svgImport.busy === 'building' ? ' · updating…' : ''}</p>
    <button
      class="replace"
      disabled={svgImport.busy !== null}
      title="Swap in another SVG: layers whose colour is still there keep their settings, new colours get defaults"
      onclick={() => replaceSvg()}>Replace SVG…</button
    >
  </div>
  <ul>
    {#each rows as r (r.id)}
      {@const off = !r.settings.visible || !r.settings.output}
      <li class:selected={r.id === svgImport.selected}>
        <button class="row" class:off aria-expanded={r.id === svgImport.selected} onclick={() => svgImport.select(r.id)}>
          <span class="swatch" style:background={r.color} aria-hidden="true"></span>
          <span class="text">
            <span class="name">{r.name} <span class="mode">{r.settings.mode === 'fill' ? 'Fill' : 'Line'}</span></span>
            <span class="meta">{plural(r.paths, 'path')} · {fmtLength(r.lengthMm)}</span>
          </span>
        </button>
        <button
          class="toggle"
          aria-pressed={r.settings.visible}
          aria-label="Show layer {r.name}"
          title={r.settings.visible ? 'Shown. Hide it (a hidden layer isn’t burned either)' : 'Hidden. Show it'}
          onclick={() => svgImport.update(r.id, { visible: !r.settings.visible })}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle>
            {#if !r.settings.visible}<line x1="3" y1="3" x2="21" y2="21"></line>{/if}
          </svg>
        </button>
        <button
          class="toggle"
          aria-pressed={r.settings.output}
          aria-label="Burn layer {r.name}"
          title={r.settings.output ? 'Burned. Turn output off to keep it shown but unburned (a frame or registration layer)' : 'Output off: shown, not burned'}
          onclick={() => svgImport.update(r.id, { output: !r.settings.output })}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4"></path><circle cx="12" cy="12" r="2.5"></circle>
            {#if !r.settings.output}<line x1="3" y1="3" x2="21" y2="21"></line>{/if}
          </svg>
        </button>
      </li>
    {/each}
  </ul>
  {#if !rows.length}<p class="note">This SVG has no stroked or filled shapes.</p>{/if}

  {#if sel}
    {@const s = sel.settings}
    {@const note = skippedNote(sel)}
    <div class="form" aria-label="Settings for layer {sel.name}">
      <div class="seg" role="group" aria-label="Mode">
        <button aria-pressed={s.mode === 'line'} onclick={() => svgImport.update(sel.id, { mode: 'line' })}>Line</button>
        <button aria-pressed={s.mode === 'fill'} onclick={() => svgImport.update(sel.id, { mode: 'fill' })}>Fill</button>
        <button disabled title="Offset Fill (concentric) is coming later (BURN-57)">Offset Fill</button>
      </div>
      {#if note}<p class="hint">{note}</p>{/if}
      <div class="grid">
        <label class="field">Max power %<input type="number" min="0" max="100" step="1" value={s.maxPowerPct} onchange={(e) => num(e, sel.id, (v) => ({ maxPowerPct: v }), (s) => s.maxPowerPct)} /></label>
        <label class="field">Min power %<input type="number" min="0" max="100" step="1" value={s.minPowerPct} onchange={(e) => num(e, sel.id, (v) => ({ minPowerPct: v }), (s) => s.minPowerPct)} /></label>
        <label class="field">Speed mm/min<input type="number" min="1" step="100" value={s.speedMmPerMin} onchange={(e) => num(e, sel.id, (v) => ({ speedMmPerMin: v }), (s) => s.speedMmPerMin)} /></label>
        <label class="field">Passes<input type="number" min="1" max="50" step="1" value={s.passes} onchange={(e) => num(e, sel.id, (v) => ({ passes: v }), (s) => s.passes)} /></label>
      </div>
      <p class="hint">GRBL ignores min power; the simulation uses max.</p>
      {#if s.mode === 'fill'}
        <div class="grid">
          <label class="field">Interval mm<input type="number" min="0.01" step="0.01" value={s.fill.intervalMm} onchange={(e) => num(e, sel.id, (v) => ({ fill: { intervalMm: v } }), (s) => s.fill.intervalMm)} /></label>
          <label class="field">Angle °<input type="number" step="15" value={s.fill.angleDeg} onchange={(e) => num(e, sel.id, (v) => ({ fill: { angleDeg: v } }), (s) => s.fill.angleDeg)} /></label>
          <label class="field">Overscan mm<input type="number" min="0" step="0.5" value={s.fill.overscanMm} onchange={(e) => num(e, sel.id, (v) => ({ fill: { overscanMm: v } }), (s) => s.fill.overscanMm)} /></label>
        </div>
        <label class="check"><input type="checkbox" checked={s.fill.bidirectional} onchange={(e) => svgImport.update(sel.id, { fill: { bidirectional: checked(e) } })} />Back-and-forth</label>
        <label class="check"><input type="checkbox" checked={s.fill.crosshatch} onchange={(e) => svgImport.update(sel.id, { fill: { crosshatch: checked(e) } })} />Crosshatch</label>
      {/if}
    </div>
  {:else if rows.length}
    <p class="note">Select a layer to set its mode, power, speed and passes.</p>
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
  }
  .file-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 8px;
  }
  .replace {
    flex: 0 0 auto;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: transparent;
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
    color: var(--fg);
  }
  .replace:hover:not(:disabled) {
    border-color: var(--line-strong);
    color: var(--fg-strong);
  }
  .file {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: var(--radius);
    border: 1px solid transparent;
  }
  li.selected {
    border-color: var(--accent-border);
    background: var(--accent-soft);
  }
  .row {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
    border: 0;
    background: none;
    text-align: left;
    border-radius: var(--radius);
  }
  .row:hover {
    background: var(--raised);
  }
  .row.off .text {
    opacity: 0.55;
  }
  .swatch {
    width: 14px;
    height: 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--swatch-border);
    flex: 0 0 auto;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-size: var(--text-ui);
    line-height: var(--leading-ui);
    color: var(--fg-strong);
  }
  .mode {
    font-family: var(--font-condensed);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--fg-faint);
    margin-left: 4px;
  }
  .meta {
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .toggle {
    flex: 0 0 auto;
    min-width: 28px;
    min-height: 28px;
    display: grid;
    place-items: center;
    border: 0;
    background: none;
    border-radius: var(--radius);
    color: var(--fg-faint);
  }
  .toggle[aria-pressed='true'] {
    color: var(--accent-text);
  }
  .toggle:hover {
    background: var(--raised);
  }
  .form {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .seg button {
    flex: 1 1 0;
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
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
    color: var(--fg);
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
  .hint {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-faint);
  }
</style>
