<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { peakTemperatureModel } from 'aria-burn-core'
  import { app } from '../lib/app.svelte.ts'
  import { burn } from '../lib/burn.svelte.ts'
  import { findMaterial } from '../lib/materials.ts'
  import { fmtDuration, legendFor, verdictLabel, verdictSwatch } from '../lib/verdicts.ts'

  let dismissed = $state<number | null>(null)

  const material = $derived(findMaterial(app.settings.ui.materialId))
  const thermal = $derived(peakTemperatureModel(material) !== null)
  const job = $derived(burn.job && (app.source === 'live' ? burn.job.kind === 'live' : burn.job.kind === 'file') ? burn.job : null)
  const ready = $derived(job !== null && burn.status === 'ready' && burn.grid !== null)
  const isColor = $derived(app.settings.ui.viewMode === 'color')
  const m = $derived(app.machine)
  const h = $derived(burn.hover)
  const r = $derived(h?.readout ?? null)

  const fire = $derived(ready && burn.fire && dismissed !== job?.jobId ? burn.fire : null)
  const fireTile = $derived.by(() => {
    const g = burn.grid
    if (!fire || !g || g.tileRects.length < 2) return null
    const i = g.tileRects.findIndex((t) => fire.xMm >= t.minX && fire.xMm < t.maxX && fire.yMm >= t.minY && fire.yMm < t.maxY)
    return i >= 0 ? i + 1 : null
  })
  const fireRule = $derived(
    material.fireRisk.kind === 'temperature'
      ? `the material heats past ${Math.round(material.fireRisk.thresholdK - 273.15)} °C`
      : material.fireRisk.kind === 'fluence'
        ? `it passes ${material.fireRisk.thresholdJPerMm2} J/mm²`
        : '',
  )

  const passes = $derived(job?.model?.passes.length ?? 0)
  const powerMode = $derived.by(() => {
    const moves = job?.model?.moves
    if (moves) {
      const m4 = moves.some((mv) => mv.laser === 'm4')
      const m3 = moves.some((mv) => mv.laser === 'm3')
      return m4 && m3 ? 'M3 + M4' : m4 ? 'M4 (dynamic)' : m3 ? 'M3 (constant)' : '—'
    }
    if (m && m.laser !== 'off') return m.laser === 'm4' ? 'M4 (dynamic)' : 'M3 (constant)'
    return '—'
  })
  const bounds = $derived.by(() => {
    const b = job?.model?.burnBounds
    if (b) return `${(b.maxXMm - b.minXMm).toFixed(1)} × ${(b.maxYMm - b.minYMm).toFixed(1)} mm`
    const g = burn.grid
    return g ? `${g.widthMm.toFixed(1)} × ${g.heightMm.toFixed(1)} mm (so far)` : '—'
  })
  const warnings = $derived(ready ? (job?.diagnostics.filter((d) => d.severity === 'warning') ?? []) : [])
  const streamErrors = $derived(job?.kind === 'live' ? job.diagnostics.filter((d) => d.severity === 'error' && d.code !== 'sender-disconnected' && d.code !== 'job-reset') : [])
  const kelvinToC = (k: number) => `${Math.round(k - 273.15)} °C`

  function showFire() {
    if (!fire) return
    app.settings.ui.viewMode = 'color'
    burn.focus({ minX: fire.minXMm, minY: fire.minYMm, maxX: fire.maxXMm, maxY: fire.maxYMm }, 4)
  }
</script>

<aside>
  {#each app.warnings as w (w)}
    <div class="callout warn"><strong>Settings</strong><span>{w}</span></div>
  {/each}

  {#if fire}
    <div class="banner fire">
      <div class="head">
        <strong>Fire risk detected</strong>
        <button class="x" aria-label="Dismiss fire-risk warning" onclick={() => (dismissed = job?.jobId ?? null)}><span aria-hidden="true">×</span></button>
      </div>
      <span>
        Heat builds up {fireTile ? `in tile ${fireTile}, ` : ''}around X {fire.xMm.toFixed(0)} mm, Y {fire.yMm.toFixed(0)} mm, where {fireRule}.
      </span>
      <button class="go" onclick={showFire}>Show location</button>
    </div>
  {/if}

  {#if ready && passes > 1}
    <div class="banner amber">
      <strong>Multi-pass job ({passes} passes)</strong>
      <span>v1 doesn’t model how charring changes absorption between passes, so later passes will look too dark.</span>
    </div>
  {/if}

  {#if job?.kind === 'live' && job.aborted}
    <div class="banner red">
      <strong>{job.aborted === 'job-reset' ? 'Job stopped by the sender' : 'Sender disconnected'}</strong>
      <span>
        {job.aborted === 'job-reset' ? 'A soft reset (Ctrl-X) ended the job' : 'The connection dropped'}
        {#if job.model} after line {job.model.source.lineCount.toLocaleString('en-US')}{/if}. The preview is kept up to that point; the next job clears it.
      </span>
    </div>
  {/if}

  {#if job?.mismatch}
    <div class="callout danger"><strong>Stream check failed</strong><span>{job.mismatch}</span></div>
  {/if}
  {#if streamErrors.length || app.liveErrors.length}
    <div class="callout danger">
      <strong>Live stream</strong>
      {#each [...streamErrors.map((d) => d.message), ...app.liveErrors].slice(0, 4) as e, i (i)}<span>{e}</span>{/each}
    </div>
  {/if}
  {#if warnings.length}
    <details class="callout warn">
      <summary><strong>{warnings.length} G-code warning{warnings.length > 1 ? 's' : ''}</strong></summary>
      {#each warnings.slice(0, 8) as d, i (i)}<span>{#if d.line > 0}<code>Line {d.line.toLocaleString('en-US')}</code>{' · '}{/if}{d.message}</span>{/each}
    </details>
  {/if}

  <div>
    <div class="section-label">Cursor</div>
    {#if h && isColor && ready}
      <div class="kv">
        <span>Position</span><span>{h.xMm.toFixed(2)}, {h.yMm.toFixed(2)} mm</span>
        {#if r}
          <span>Fluence</span><span>{r.fluenceJPerMm2.toFixed(2)} J/mm²</span>
          {#if r.peakTemperatureK !== null}
            <span title="Thermal dose drives colour and verdict (COD-258)">Peak temp.</span><span>{kelvinToC(r.peakTemperatureK)}</span>
          {/if}
          {#if r.bulkTemperatureK !== null}
            <span title="Preheat a pass met here; fire risk compares this">Built-up heat</span><span>{kelvinToC(r.bulkTemperatureK)}</span>
          {/if}
          <span>Verdict</span><span class="verdict"><i style:background={verdictSwatch(r.verdict)}></i>{verdictLabel(r.verdict, material)}</span>
          {#if r.depthMm > 0}<span>Depth</span><span>{(r.depthMm * 1000).toFixed(0)} µm</span>{/if}
          {#if r.lines.length}<span>G-code lines</span><span>{r.lines.slice(0, 3).join(', ')}</span>{/if}
        {:else}
          <span>Verdict</span><span>Outside the job</span>
        {/if}
      </div>
    {:else}
      <p class="note">
        {#if !ready}No job loaded.{:else if isColor}Hover the canvas for position, {thermal ? 'temperature' : 'fluence'} and verdict. Drag to pan, scroll to zoom.{:else}Readout is available in the Color view.{/if}
      </p>
    {/if}
  </div>

  <div>
    <div class="section-label">Job</div>
    <div class="kv">
      <span>Bounds</span><span>{ready ? bounds : '—'}</span>
      <span>Grid pitch</span><span>{burn.grid ? `${(burn.grid.pitchMm * 1000).toFixed(1)} µm` : '—'}</span>
      <span>Grid</span><span>{burn.grid && ready ? `${burn.grid.cells[0].toLocaleString('en-US')} × ${burn.grid.cells[1].toLocaleString('en-US')}` : '—'}</span>
      <span>Tiles</span><span>{burn.grid && ready ? (burn.grid.tileRects.length > 1 ? `${burn.grid.tiles[0]} × ${burn.grid.tiles[1]}` : '1 (untiled)') : '—'}</span>
      <span>Power mode</span><span>{ready ? powerMode : '—'}</span>
      <span>Passes</span><span>{ready && passes ? passes : '—'}</span>
      <span>{job?.kind === 'live' && job.durationS === null ? 'Streamed' : 'Est. time'}</span><span>{ready ? fmtDuration(burn.totalS) : '—'}</span>
      {#if job?.kind === 'live'}<span>Samples</span><span>{job.samples.toLocaleString('en-US')}</span>{/if}
    </div>
    <p class="note">Timing from the GRBL planner{job?.kind === 'file' ? ' (same as streaming it)' : ''}. Pitch = spot σ ÷ 3; jobs over 9000 cells a side tile.</p>
  </div>

  {#if app.source === 'live'}
    <div>
      <div class="section-label">Machine</div>
      <div class="kv">
        <span>State</span><span>{m?.state ?? '—'}</span>
        <span>Position</span><span>{m ? `${m.positionMm.xMm.toFixed(2)}, ${m.positionMm.yMm.toFixed(2)} mm` : '—'}</span>
        <span>Feed</span><span>{m ? `${m.feedMmPerMin.toFixed(0)} mm/min` : '—'}</span>
        <span>Line</span><span>{m && m.line > 0 ? m.line.toLocaleString('en-US') : '—'}</span>
        <span>Pacing</span><span>{app.settings.network.pacing === 'realtime' ? 'real time' : 'instant ok'}</span>
      </div>
      {#if app.settings.network.pacing === 'instant'}
        <p class="note">Instant pacing answers ok at once: the job streams faster than it would burn, and the timeline is still machine time.</p>
      {/if}
    </div>
  {/if}

  {#if ready && isColor && app.settings.ui.verdictOverlay}
    <div>
      <div class="section-label">Verdict legend</div>
      <div class="legend">
        {#each legendFor(material) as v (v)}
          <div class:absent={!burn.verdicts.includes(v)}><i style:background={verdictSwatch(v)}></i>{verdictLabel(v, material)}</div>
        {/each}
      </div>
      <p class="note">Small patches merge into the surrounding area; fire risk always shows.</p>
    </div>
  {/if}

  {#if ready && !isColor && material.response.kind !== 'bleach'}
    <div>
      <div class="section-label">Depth</div>
      <div class="depth">
        <div class="ramp" aria-hidden="true"></div>
        <div class="ticks">
          <span>0 µm</span><span>−{((burn.depthMaxMm * 1000) / 2).toFixed(0)} µm</span><span>−{(burn.depthMaxMm * 1000).toFixed(0)} µm</span>
        </div>
      </div>
      <p class="note">Only {thermal ? 'dose' : 'fluence'} above the {material.response.kind === 'melt' ? 'removal' : 'ablation'} threshold removes material; lighter marks stay flat.</p>
    </div>
  {/if}

  {#if ready}
    <details class="perf">
      <summary>Render timing</summary>
      <div class="kv">
        <span>Full res</span><span>{burn.times.full?.toFixed(0) ?? '—'} ms</span>
        <span>Scrub preview</span><span>{burn.times.coarse?.toFixed(0) ?? '—'} ms</span>
        <span>Zoom detail</span><span>{burn.times.detail?.toFixed(0) ?? '—'} ms</span>
        <span>Redraw</span><span>{burn.times.draw?.toFixed(1) ?? '—'} ms</span>
      </div>
    </details>
  {/if}
</aside>

<style>
  aside {
    flex: 0 0 260px;
    min-width: 220px;
    border-left: 1px solid var(--line);
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
  }
  p {
    margin: 8px 0 0;
    font-size: 11px;
    line-height: 1.45;
    color: var(--faint);
  }
  .banner {
    border: 1px solid;
    border-radius: var(--radius);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 11px;
    line-height: 1.45;
  }
  .banner strong {
    font-size: 12px;
  }
  .banner.fire {
    border-color: rgba(214, 51, 108, 0.55);
    background: rgba(214, 51, 108, 0.1);
    color: #e6b3c4;
  }
  .banner.fire strong,
  .banner.fire .go {
    color: #f5a3c0;
  }
  .banner.amber {
    border-color: rgba(224, 169, 64, 0.5);
    background: rgba(224, 169, 64, 0.08);
    color: #d8c39a;
  }
  .banner.amber strong {
    color: #e8c57f;
  }
  .banner.red {
    border-color: rgba(229, 72, 77, 0.5);
    background: rgba(229, 72, 77, 0.08);
    color: #d79a9c;
  }
  .banner.red strong {
    color: var(--danger);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .x {
    border: 0;
    background: none;
    color: var(--muted);
    font-size: 16px;
    line-height: 1;
    min-width: 28px;
    min-height: 28px;
  }
  .go {
    align-self: flex-start;
    min-height: 30px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid rgba(214, 51, 108, 0.55);
    background: transparent;
    font-size: 12px;
  }
  .verdict {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    font-family: inherit !important;
  }
  i {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
    flex: 0 0 auto;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }
  .legend {
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-size: 12px;
    color: var(--text-2);
  }
  .legend div {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .legend .absent {
    opacity: 0.5;
  }
  .depth {
    display: flex;
    gap: 10px;
  }
  .ramp {
    width: 14px;
    height: 96px;
    border-radius: 3px;
    background: linear-gradient(to bottom, #9a9a9a, #2a2a2a);
  }
  .ticks {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-size: 11px;
    font-family: var(--mono);
    color: var(--text-2);
  }
  details summary {
    cursor: pointer;
  }
  .perf summary {
    font-size: 11px;
    color: var(--faint);
    margin-bottom: 6px;
  }
  code {
    font-family: var(--mono);
  }
</style>
