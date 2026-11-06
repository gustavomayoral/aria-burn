<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  Fit a material from a photographed test grid (BURN-15). Three steps: the
  grid (save its G-code, print the reference card), the photo (find the card
  and the grid, place corners by hand if needed, optional depths and flames),
  and the review (photographed vs fitted cells with ΔE, the fitted values,
  save as a named profile with its calibration record).
-->
<script lang="ts">
  import { labToCss } from '../lib/materials.ts'
  import { fieldRows, photoFit, type FitStep } from '../lib/photo-fit.svelte.ts'

  const f = photoFit
  const pattern = $derived(f.pattern)
  const rows = $derived(pattern ? Math.max(...pattern.cells.map((c) => c.row ?? 0)) + 1 : 0)
  const cols = $derived(pattern ? Math.max(...pattern.cells.map((c) => c.col ?? 0)) + 1 : 0)
  const cellsByPos = $derived(pattern ? [...pattern.cells].sort((a, b) => (a.row ?? 0) - (b.row ?? 0) || (a.col ?? 0) - (b.col ?? 0)) : [])
  const compared = $derived(new Map((f.result?.cells ?? []).map((c) => [c.id, c])))
  const table = $derived(f.result && f.start ? fieldRows(f.start, f.result.material, f.truth, f.result) : [])
  const dev = import.meta.env.DEV
  const STEPS: [FitStep, string][] = [
    ['grid', '1 · Grid'],
    ['photo', '2 · Photo'],
    ['review', '3 · Review'],
  ]
  const canGo = (s: FitStep) => s === 'grid' || (s === 'photo' && !!f.photo) || (s === 'review' && !!f.result)
  const deClass = (de: number) => (de < 2 ? 'ok' : de < 5 ? 'warn' : 'bad')
  const pts = (q: { x: number; y: number }[]) => q.map((p) => `${p.x},${p.y}`).join(' ')
  const MANUAL_HELP = {
    card: 'Click the card’s four outer frame corners in the order printed: top-left, top-right, bottom-right, bottom-left (the corner by the white patch is top-left).',
    fiducials: 'Click the centres of the four corner squares of the burn: bottom-left (the one with the small square beside it), bottom-right, top-right, top-left.',
  } as const

  let card: HTMLDivElement
  let fileInput = $state<HTMLInputElement | null>(null)
  let svg = $state<SVGSVGElement | null>(null)

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') f.close()
  }

  function onPhotoClick(e: MouseEvent) {
    if (!f.manual || !svg || !f.photo) return
    const r = svg.getBoundingClientRect()
    // The SVG keeps the photo's aspect inside its box (xMidYMid meet).
    const s = Math.min(r.width / f.photo.width, r.height / f.photo.height)
    const ox = (r.width - f.photo.width * s) / 2
    const oy = (r.height - f.photo.height * s) / 2
    void f.addManualPoint({ x: (e.clientX - r.left - ox) / s, y: (e.clientY - r.top - oy) / s })
  }

  async function onFile(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0]
    if (file) await f.loadFile(file)
  }

  $effect(() => card?.focus())
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && f.close()} onkeydown={onKey}>
  <div class="card" role="dialog" aria-modal="true" aria-labelledby="fit-title" tabindex="-1" bind:this={card}>
    <header>
      <h2 id="fit-title">Fit material from a photo</h2>
      <div class="seg" role="group" aria-label="Step">
        {#each STEPS as [s, label] (s)}
          <button aria-pressed={f.step === s} disabled={!canGo(s)} onclick={() => (f.step = s)}>{label}</button>
        {/each}
      </div>
      <button class="btn small" onclick={() => f.close()}>Close</button>
    </header>
    <p class="for">
      For <strong>{f.machine?.name}</strong> · starting from <strong>{f.start?.name}</strong>
    </p>

    {#if f.busy}
      <div class="callout" role="status">{f.busy}</div>
    {/if}
    {#if f.error}
      <div class="callout warn" role="alert">{f.error}</div>
    {/if}

    {#if f.step === 'grid'}
      <div class="body">
        <ol class="steps">
          <li>Save the grid’s G-code and burn it on this laser, on the material you want to fit.</li>
          <li>Print the reference card at 100 % on matte white paper.</li>
          <li>
            Photograph the burn with the card beside it, flat, under even light and without glare. Fill most of the frame with both; the corner squares
            must be in the picture.
          </li>
          <li>Choose the photo. Optionally measure the depth of two or three burned cells and note any cell that flamed.</li>
        </ol>
        <div class="side">
          {#if pattern}
            {@const b = pattern.burnBoundsMm}
            <div class="kv">
              <span>Grid</span><span>{cols} powers × {rows} speeds</span>
              <span>Burn area</span><span>{(b.maxXMm - b.minXMm).toFixed(1)} × {(b.maxYMm - b.minYMm).toFixed(1)} mm</span>
              <span>Time</span><span>≥ {Math.round(pattern.estimatedTimeS / 60)} min</span>
            </div>
          {:else}
            <div class="callout warn" role="alert">{f.patternError}</div>
          {/if}
          <div class="actions">
            <button class="btn" disabled={!pattern} onclick={() => f.saveGcode()}>Save G-code</button>
            <button class="btn" onclick={() => f.saveCard()}>Save reference card</button>
          </div>
          <div class="actions">
            {#if dev}
              <button class="btn" disabled={!pattern || !!f.busy} onclick={() => f.makeSynthetic()} title="Developer builds: simulate the burn from a known material and photograph it">Synthetic photo</button>
            {/if}
            <button class="btn primary" disabled={!pattern || !!f.busy} onclick={() => fileInput?.click()}>Choose photo…</button>
            <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={onFile} />
          </div>
          {#if f.note}<p class="note" role="status">{f.note}</p>{/if}
          <p class="note">The photo, G-code, machine profile and fit are kept together on this computer when you save. Nothing is shared.</p>
        </div>
      </div>
    {:else if f.step === 'photo' && f.photo}
      <div class="body wide">
        <div class="viewer">
          <img src={f.photoUrl} alt="Photographed grid" />
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <svg bind:this={svg} viewBox="0 0 {f.photo.width} {f.photo.height}" class:placing={!!f.manual} onclick={onPhotoClick}>
            {#if f.analysis}
              {@const a = f.analysis}
              <polygon class="card-quad" points={pts(a.cardCorners)} />
              {#each a.cellQuads as q (q.id)}
                {@const c = compared.get(q.id)}
                <polygon class="cell-quad {c ? deClass(c.deltaE) : ''}" points={pts(q.quad)} />
              {/each}
              {#each Object.entries(a.marks) as [id, p] (id)}
                <circle class="mark" cx={p.x} cy={p.y} r={Math.max(6, f.photo.width / 250)} />
              {/each}
            {/if}
            {#each f.manualPoints as p, i (i)}
              <circle class="manual" cx={p.x} cy={p.y} r={Math.max(6, f.photo.width / 200)} />
            {/each}
          </svg>
        </div>
        <div class="side">
          {#if f.truth}
            <p class="note">Synthetic photo: the grid was simulated from a known material and photographed with uneven light, white balance, perspective, blur and noise. Depths and flames below come from that material.</p>
          {/if}
          {#if f.manual}
            <div class="callout" role="status">{MANUAL_HELP[f.manual]} ({f.manualPoints.length}/4)</div>
          {:else if f.analysisError}
            <div class="callout warn" role="alert">{f.analysisError.message}</div>
          {:else if f.analysis}
            <div class="kv">
              <span>Card</span><span>found · patches ΔE {f.analysis.correction.meanPatchDeltaE.toFixed(2)} after correction</span>
              <span>Grid</span><span>{f.analysis.observations.length} of {pattern?.cells.length} cells sampled</span>
              <span>Bare material</span><span><span class="chip" style:background={labToCss(f.analysis.base)}></span> L* {f.analysis.base.l.toFixed(1)}</span>
            </div>
            {#each f.analysis.warnings as w (w)}<p class="note caution">{w}</p>{/each}
          {/if}
          <div class="actions">
            <button class="btn small" onclick={() => f.beginManual('card')}>Place card corners</button>
            <button class="btn small" onclick={() => f.beginManual('fiducials')}>Place grid corners</button>
          </div>

          {#if f.depths.length}
            <div class="section-label">Depth (optional)</div>
            <p class="note">The photo can’t show depth. Measure two or three burned cells (mm, typical depth over the middle of the cell).</p>
            {#each f.depths as d, i (i)}
              <div class="depth">
                <select bind:value={d.cellId} aria-label="Cell {i + 1}">
                  <option value="">Cell…</option>
                  {#each cellsByPos as c (c.id)}<option value={c.id}>{c.id} · {c.label}</option>{/each}
                </select>
                <input type="number" min="0" step="0.01" placeholder="mm" bind:value={d.depthMm} aria-label="Depth {i + 1} (mm)" />
              </div>
            {/each}
          {/if}

          {#if f.askFire}
            <div class="section-label">Flames (optional)</div>
            <p class="note">Click the cells where you saw flame or flare-ups while burning.</p>
            <div class="fire" style:grid-template-columns="repeat({cols}, 1fr)">
              {#each cellsByPos as c (c.id)}
                <button class="fire-cell" aria-pressed={f.fireCellIds.includes(c.id)} title={c.label} onclick={() => f.toggleFire(c.id)}>{c.id}</button>
              {/each}
            </div>
          {/if}

          <label class="check"><input type="checkbox" bind:checked={f.fitPowerCurve} /> Also fit the S → power curve (machine reading, not applied)</label>
          <div class="actions">
            <button class="btn primary" disabled={!f.analysis || !!f.busy} onclick={() => f.fit()}>Fit</button>
          </div>
        </div>
      </div>
    {:else if f.step === 'review' && f.result}
      {@const r = f.result}
      <p class="summary">
        Mean ΔE00 <strong>{r.meanDeltaE.toFixed(2)}</strong> · max {r.maxDeltaE.toFixed(2)} over {r.cells.length} cells · {r.thermalIterations} thermal run{r.thermalIterations > 1 ? 's' : ''} · {(f.fitMs / 1000).toFixed(1)} s
      </p>
      <div class="body wide">
        <div>
          <div class="section-label">Photographed | fitted</div>
          <div class="cells" style:grid-template-columns="repeat({cols}, minmax(0, 1fr))">
            {#each cellsByPos as cell (cell.id)}
              {@const c = compared.get(cell.id)}
              <div class="cell" title="{cell.id} · {cell.label}">
                {#if c}
                  <div class="pair">
                    <span style:background={labToCss(c.observed)}></span>
                    <span style:background={labToCss(c.predicted)}></span>
                  </div>
                  <span class="de {deClass(c.deltaE)}">{c.deltaE.toFixed(1)}</span>
                {:else}
                  <div class="pair empty"></div>
                  <span class="de">—</span>
                {/if}
              </div>
            {/each}
          </div>
          <p class="note">Left half: the cell as photographed after colour correction. Right half: the fitted profile’s prediction. Number: ΔE00.</p>
        </div>
        <div class="side">
          <table>
            <thead><tr><th>Field</th><th>Start</th><th>Fitted</th>{#if f.truth}<th>True</th>{/if}</tr></thead>
            <tbody>
              {#each table as row (row.label)}
                <tr>
                  <td>{row.label}{#if row.unit}<span class="unit">{row.unit}</span>{/if}</td>
                  <td>{row.start}</td>
                  <td>{row.fitted}{#if row.sigma}<span class="unit">{row.sigma}</span>{/if}</td>
                  {#if f.truth}<td>{row.truth ?? '—'}</td>{/if}
                </tr>
              {/each}
            </tbody>
          </table>
          {#if r.depth}<p class="note">Depth: {r.depth.note}</p>{/if}
          {#if r.fire}<p class="note">Fire risk: {r.fire.note}</p>{/if}
          {#if r.powerCurve}
            <p class="note">
              S → power (kept with the record, not applied): {r.powerCurve.map((p) => `${(p.s * 100).toFixed(0)} %→${(p.power * 100).toFixed(0)} %`).join(', ')}
            </p>
          {/if}
          {#each r.notes as n (n)}<p class="note">{n}</p>{/each}
          <label class="name">Name<input type="text" bind:value={f.name} /></label>
          <div class="actions">
            <button class="btn" onclick={() => (f.step = 'photo')}>Back</button>
            <button class="btn primary" disabled={!!f.busy} onclick={() => f.save()}>Save profile</button>
          </div>
          {#if f.note}<p class="note" role="status">{f.note}</p>{/if}
          <p class="note">Fitted from one grid on synthetic or real photos; how well it predicts other burns is checked on real held-out burns (BURN-12).</p>
        </div>
      </div>
    {/if}
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
    width: min(1080px, 100%);
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
    gap: 12px;
  }
  header .seg {
    margin-left: auto;
  }
  h2 {
    margin: 0;
    font-family: var(--font-condensed);
    font-size: var(--text-sm);
    line-height: var(--leading-sm);
    font-weight: 600;
    color: var(--fg-strong);
  }
  .for,
  .summary {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
  }
  .for strong,
  .summary strong {
    color: var(--fg);
    font-weight: 500;
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: 20px;
  }
  .body.wide {
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  }
  @media (max-width: 760px) {
    .body,
    .body.wide {
      grid-template-columns: 1fr;
    }
  }
  .steps {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--fg);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .note {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .caution {
    color: var(--warn-text);
  }
  .viewer {
    position: relative;
    background: var(--sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    aspect-ratio: 4 / 3;
  }
  .viewer img,
  .viewer svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .viewer svg.placing {
    cursor: crosshair;
  }
  .card-quad {
    fill: none;
    stroke: var(--accent);
    stroke-width: 4;
    vector-effect: non-scaling-stroke;
  }
  .cell-quad {
    fill: none;
    stroke: var(--accent-ring);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .cell-quad.ok {
    stroke: var(--ok);
  }
  .cell-quad.warn {
    stroke: var(--warn);
  }
  .cell-quad.bad {
    stroke: var(--danger);
  }
  .mark {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .manual {
    fill: var(--accent);
    stroke: var(--on-accent);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .chip {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: var(--radius);
    border: 1px solid var(--swatch-border);
    vertical-align: middle;
  }
  .depth {
    display: grid;
    grid-template-columns: 1fr 90px;
    gap: 8px;
  }
  .depth input {
    font-family: var(--font-mono);
  }
  .fire {
    display: grid;
    gap: 3px;
  }
  .fire-cell {
    padding: 2px 0;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: transparent;
    color: var(--fg-muted);
  }
  .fire-cell[aria-pressed='true'] {
    border-color: var(--fire-border);
    background: var(--fire-soft);
    color: var(--fire-text);
  }
  .check,
  .name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
    color: var(--fg);
  }
  .name {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    color: var(--fg-muted);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
  }
  .cells {
    display: grid;
    gap: 4px;
  }
  .cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    width: 100%;
    aspect-ratio: 1;
    border: 1px solid var(--swatch-border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .pair.empty {
    background: var(--sunken);
  }
  .de {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
  }
  .de.ok {
    color: var(--ok-text);
  }
  .de.warn {
    color: var(--warn-text);
  }
  .de.bad {
    color: var(--danger-text);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
  }
  th,
  td {
    text-align: left;
    padding: 3px 6px 3px 0;
    border-bottom: 1px solid var(--line-subtle);
    color: var(--fg);
  }
  th {
    color: var(--fg-muted);
    font-weight: 500;
  }
  td:not(:first-child) {
    font-family: var(--font-mono);
  }
  .unit {
    margin-left: 4px;
    color: var(--fg-faint);
  }
</style>
