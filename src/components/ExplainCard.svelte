<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  Outcome explanation (BURN-45): click a cell of the burn and this card says
  why it came out the way it did. It names the threshold that set the verdict,
  the moves that put the energy there and, for an over-burned cell, what
  pushed it over. The numbers come from the core's explainCell, computed on
  the CPU from the samples near the cell.
-->
<script lang="ts">
  import { app } from '../lib/app.svelte.ts'
  import { burn } from '../lib/burn.svelte.ts'
  import { describeCause, describeMode, describeReason, fmtJ, fmtPct, slowed } from '../lib/explain.ts'
  import { findMaterial } from '../lib/materials.ts'
  import { verdictLabel, verdictSwatch } from '../lib/verdicts.ts'

  const material = $derived(findMaterial(app.settings.ui.materialId))
  const x = $derived(burn.explained)
  const e = $derived(x?.explanation ?? null)
  const multiPass = $derived((burn.job?.model?.passes.length ?? 0) > 1)
  const kelvinToC = (k: number) => `${Math.round(k - 273.15)} °C`
  const speed = (v: number) => Math.round(v).toLocaleString('en-US')
  // Sit on the side away from the clicked cell, so the pin and the move markers stay visible.
  const left = $derived.by(() => {
    void burn.view
    return x ? burn.toPx(x.xMm, x.yMm).x > burn.canvasSize.width / 2 : false
  })
</script>

{#if x}
  <section class="card" class:left aria-label="Why this cell looks like this" aria-live="polite">
    <div class="head">
      <div class="section-label">Why this result</div>
      <button class="x" aria-label="Close the explanation" onclick={() => burn.clearExplained()}><span aria-hidden="true">×</span></button>
    </div>

    {#if !e}
      <p class="muted">Outside the job: nothing burns here.</p>
    {:else}
      <div class="verdict">
        <i style:background={verdictSwatch(e.readout.verdict)}></i>
        <strong>{verdictLabel(e.readout.verdict, material)}</strong>
        <span class="at">{e.readout.xMm.toFixed(2)}, {e.readout.yMm.toFixed(2)} mm</span>
      </div>
      <p class="reason">{describeReason(e.reason, material)}</p>

      <div class="kv">
        <span>Fluence</span><span>{fmtJ(e.fluenceJPerMm2)}</span>
        {#if e.doseJPerMm2 !== null}
          <span title="Fluence weighted by how hot each pass ran: what the colour and verdict read">Thermal dose</span><span>{fmtJ(e.doseJPerMm2)}</span>
        {/if}
        {#if e.readout.peakTemperatureK !== null}<span>Peak temp.</span><span>{kelvinToC(e.readout.peakTemperatureK)}</span>{/if}
        {#if e.readout.bulkTemperatureK !== null}<span>Built-up heat</span><span>{kelvinToC(e.readout.bulkTemperatureK)}</span>{/if}
        {#if e.preheatDoseJPerMm2 !== null && e.doseJPerMm2}
          <span title="Dose from heat left by earlier lines">From preheat</span><span>{fmtPct(e.preheatDoseJPerMm2 / e.doseJPerMm2)}</span>
        {/if}
      </div>

      {#if e.causes.length}
        <div class="causes">
          {#each e.causes.slice(0, 3) as c, i (c.kind)}
            {@const t = describeCause(c, e, material)}
            <div class="cause" class:main={i === 0}>
              <strong>{t.title}</strong>
              <span>{t.body}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if e.moves.length}
        <div class="section-label sub">Moves that made it</div>
        <ol class="moves">
          {#each e.moves as m, i (m.line)}
            <li>
              <div class="row">
                <span class="n" aria-hidden="true">{i + 1}</span>
                <code>Line {m.line.toLocaleString('en-US')}</code>
                {#if multiPass && m.passIndex !== null}<span class="pass">Pass {m.passIndex + 1}{m.passLabel ? ` · ${m.passLabel}` : ''}</span>{/if}
                <span class="share">{fmtPct(m.share)}</span>
              </div>
              <div class="bar" aria-hidden="true"><div style:width="{Math.max(2, m.share * 100)}%"></div></div>
              <div class="facts">
                <span>{describeMode(m)}</span>
                <span class:slow={slowed(m)} title="Actual planner speed at this cell (lowest {speed(m.minActualMmPerMin)}) / commanded">
                  {speed(m.actualMmPerMin)}{m.commandedMmPerMin !== null ? ` / ${speed(m.commandedMmPerMin)}` : ''} mm/min
                </span>
                <span>{m.powerW.toFixed(m.powerW >= 10 ? 0 : 1)} W</span>
              </div>
            </li>
          {/each}
        </ol>
      {/if}

      <p class="foot">
        {#if e.moveCount}
          {e.moveCount.toLocaleString('en-US')} move{e.moveCount === 1 ? '' : 's'} reach this cell; {e.moves.length === e.moveCount ? 'all listed' : `the top ${e.moves.length} carry ${fmtPct(e.listedShare)}`}.
        {:else}
          No move has reached this cell yet.
        {/if}
        <!-- WKWebView's clock ticks in whole ms, so sub-ms answers read 0. -->
        Answered in {x.ms < 1 ? 'under 1' : x.ms < 10 ? x.ms.toFixed(1) : x.ms.toFixed(0)} ms.
      </p>
    {/if}
  </section>
{/if}

<style>
  .card {
    position: absolute;
    top: 48px;
    right: 10px;
    width: 320px;
    max-width: calc(100% - 20px);
    max-height: calc(100% - 100px);
    overflow-y: auto;
    padding: 12px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-popup);
    display: flex;
    flex-direction: column;
    gap: 10px;
    cursor: auto;
  }
  .card.left {
    right: auto;
    left: 10px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .head .section-label {
    margin: 0;
  }
  .x {
    border: 0;
    background: none;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 1;
    min-width: 24px;
    min-height: 24px;
    border-radius: var(--radius);
  }
  .x:hover {
    color: var(--fg-strong);
  }
  .verdict {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-ui);
    line-height: var(--leading-ui);
    color: var(--fg-strong);
  }
  .verdict strong {
    font-weight: 600;
  }
  .verdict .at {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--fg-faint);
  }
  i {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: var(--radius-sm);
    flex: 0 0 auto;
    border: 1px solid var(--swatch-border);
  }
  p {
    margin: 0;
  }
  .reason {
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
    color: var(--fg);
  }
  .muted,
  .foot {
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-faint);
  }
  .causes {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cause {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--line-subtle);
    background: var(--raised);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .cause strong {
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
    font-weight: 600;
    color: var(--fg-strong);
  }
  .cause.main {
    border-color: var(--warn-border);
    background: var(--warn-soft);
    color: var(--warn-muted);
  }
  .cause.main strong {
    color: var(--warn-text);
  }
  .sub {
    margin-bottom: -4px;
  }
  .moves {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
  }
  .row code {
    font-family: var(--font-mono);
    color: var(--fg-strong);
  }
  .n {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--text-2xs);
    font-family: var(--font-mono);
    flex: 0 0 auto;
  }
  .pass {
    color: var(--fg-muted);
    font-size: var(--text-2xs);
  }
  .share {
    margin-left: auto;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--fg-strong);
  }
  .bar {
    height: 3px;
    margin: 4px 0 4px 22px;
    border-radius: var(--radius-sm);
    background: var(--accent-track);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--accent);
  }
  .facts {
    margin-left: 22px;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .facts .slow {
    color: var(--warn-text);
  }
</style>
