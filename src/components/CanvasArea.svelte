<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from '../lib/app.svelte.ts'
  import { burn } from '../lib/burn.svelte.ts'
  import { describeConnection } from '../lib/emulator.ts'
  import { exportColor, exportHeight } from '../lib/export.ts'
  import { isTauri } from '../lib/ipc.ts'
  import { findMaterial } from '../lib/materials.ts'
  import type { ViewMode } from '../lib/settings.ts'
  import { scaleBar } from '../lib/verdicts.ts'

  const VIEW_MODES: { id: ViewMode; label: string }[] = [
    { id: 'color', label: 'Color' },
    { id: 'height', label: 'Height (3D)' },
  ]

  let canvas: HTMLCanvasElement
  let stage: HTMLDivElement
  let fileInput: HTMLInputElement
  let dragOver = $state(false)
  let exportOpen = $state(false)
  let exportNote = $state<string | null>(null)
  let drag = $state<{ x: number; y: number; moved: boolean } | null>(null)

  const ui = $derived(app.settings.ui)
  const material = $derived(findMaterial(ui.materialId))
  const isColor = $derived(ui.viewMode === 'color')
  const status = $derived(burn.status)
  const job = $derived(burn.job)
  const shownJob = $derived(job && (app.source === 'live' ? job.kind === 'live' : job.kind === 'file') ? job : null)
  const hasBurn = $derived(shownJob !== null && status === 'ready' && burn.grid !== null)
  const errors = $derived(shownJob?.diagnostics.filter((d) => d.severity === 'error') ?? [])
  const warnings = $derived(shownJob?.diagnostics.filter((d) => d.severity === 'warning') ?? [])

  function setPref<K extends keyof typeof ui>(key: K, value: (typeof ui)[K]) {
    app.settings.ui[key] = value
    void app.savePrefs()
  }

  $effect(() => burn.configure(app.settings.machine, material))
  $effect(() => burn.setOptions({ relief: ui.relief, overlay: ui.verdictOverlay && isColor }))

  onMount(() => {
    burn.attach(canvas)
    const ro = new ResizeObserver(() => burn.resize(stage.clientWidth, stage.clientHeight, window.devicePixelRatio || 1))
    ro.observe(stage)
    let unlisten: (() => void) | null = null
    if (isTauri()) {
      // Native file drops arrive as paths (the webview never sees the drop).
      void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
        unlisten = await getCurrentWebview().onDragDropEvent((e) => {
          if (e.payload.type === 'over' || e.payload.type === 'enter') dragOver = true
          else if (e.payload.type === 'leave') dragOver = false
          else if (e.payload.type === 'drop') {
            dragOver = false
            const path = e.payload.paths[0]
            if (path) openPath(path)
          }
        })
      })
    }
    return () => {
      ro.disconnect()
      unlisten?.()
    }
  })

  function openPath(path: string) {
    app.source = 'file'
    void burn.openFile({ kind: 'path', path })
  }

  async function onPick(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0]
    if (!file) return
    app.source = 'file'
    const text = await file.text()
    fileInput.value = ''
    await burn.openFile({ kind: 'text', name: file.name, text })
  }

  // Browser drop (pnpm dev without Tauri, where drops reach the page).
  async function onDrop(e: DragEvent) {
    e.preventDefault()
    dragOver = false
    const file = e.dataTransfer?.files[0]
    if (!file) return
    app.source = 'file'
    await burn.openFile({ kind: 'text', name: file.name, text: await file.text() })
  }

  // ── Pan, zoom, hover ──
  function local(e: PointerEvent | WheelEvent) {
    const r = stage.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  function onDown(e: PointerEvent) {
    if (!hasBurn || !isColor || e.button !== 0) return
    drag = { x: e.clientX, y: e.clientY, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onMove(e: PointerEvent) {
    if (!hasBurn || !isColor) return
    if (drag) {
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (drag.moved || Math.abs(dx) + Math.abs(dy) > 2) {
        drag = { x: e.clientX, y: e.clientY, moved: true }
        burn.panBy(dx, dy)
        burn.clearHover()
        return
      }
    }
    const p = local(e)
    burn.hoverAt(p.x, p.y)
  }
  function onWheel(e: WheelEvent) {
    if (!hasBurn || !isColor) return
    e.preventDefault()
    const p = local(e)
    // Trackpad pinch arrives as ctrl+wheel; both zoom around the cursor.
    burn.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), p.x, p.y)
    burn.hoverAt(p.x, p.y)
  }
  function onKey(e: KeyboardEvent) {
    if (!hasBurn || !isColor) return
    const step = 40
    if (e.key === '+' || e.key === '=') burn.zoomAt(2)
    else if (e.key === '-') burn.zoomAt(0.5)
    else if (e.key === '0') burn.fit()
    else if (e.key === 'ArrowLeft') burn.panBy(step, 0)
    else if (e.key === 'ArrowRight') burn.panBy(-step, 0)
    else if (e.key === 'ArrowUp') burn.panBy(0, step)
    else if (e.key === 'ArrowDown') burn.panBy(0, -step)
    else return
    e.preventDefault()
  }

  const zoom = $derived(burn.fitMmPerPx / burn.view.mmPerPx)
  const zoomLabel = $derived(zoom >= 10 ? `${Math.round(zoom)}×` : `${+zoom.toFixed(1)}×`)
  const atMaxZoom = $derived(burn.view.mmPerPx <= burn.minMmPerPx * 1.001)
  const bar = $derived(scaleBar(burn.view.mmPerPx))
  const hoverPx = $derived(burn.hover ? burn.toPx(burn.hover.xMm, burn.hover.yMm) : null)

  // Where the head is at the cutoff: the last sample burned. Only mid-job; the burn itself shows what's done.
  const marker = $derived.by(() => {
    void burn.version
    void burn.view
    if (!hasBurn || !isColor) return null
    const streaming = job?.kind === 'live' && job.durationS === null && burn.follow
    const pos = streaming && app.machine ? app.machine.positionMm : burn.progress > 0 && burn.progress < 1 ? burn.headAt() : null
    if (!pos) return null
    const p = burn.toPx(pos.xMm, pos.yMm)
    if (p.x < 0 || p.y < 0 || p.x > burn.canvasSize.width || p.y > burn.canvasSize.height) return null
    return p
  })

  const tileAt = $derived.by(() => {
    const g = burn.grid
    if (!g) return -1
    const { centerXMm: x, centerYMm: y } = burn.view
    return g.tileRects.findIndex((t) => x >= t.minX && x < t.maxX && y >= t.minY && y < t.maxY)
  })
  // Minimap rows top-down (max Y first), like the canvas.
  const minimap = $derived(burn.grid ? [...burn.grid.tileRects].map((t, index) => ({ ...t, index })).sort((a, b) => b.row - a.row || a.col - b.col) : [])

  async function doExport(kind: 'color' | 'height') {
    exportOpen = false
    exportNote = 'Exporting…'
    try {
      const path = kind === 'color' ? await exportColor() : await exportHeight()
      exportNote = `Saved ${path}`
    } catch (e) {
      exportNote = `Export failed: ${String(e)}`
    }
    setTimeout(() => (exportNote = null), 6000)
  }

  const chip = $derived.by(() => {
    if (!hasBurn || !isColor) return null
    if (burn.playing) return { label: 'Coarse preview while playing', dot: 'var(--info)' }
    if (job?.kind === 'live' && job.durationS === null && burn.follow) return { label: 'Live · coarse preview while streaming', dot: 'var(--info)' }
    if (burn.rendering || burn.coarseShown) return { label: 'Rendering full resolution…', dot: 'var(--warn)' }
    return null
  })
</script>

<div class="toolbar">
  <div class="seg" role="group" aria-label="View">
    {#each VIEW_MODES as v (v.id)}
      <button aria-pressed={ui.viewMode === v.id} onclick={() => setPref('viewMode', v.id)}>{v.label}</button>
    {/each}
  </div>
  <div class="tools">
    <label class:off={!isColor || !hasBurn}>
      <input type="checkbox" checked={ui.verdictOverlay} disabled={!isColor || !hasBurn} onchange={(e) => setPref('verdictOverlay', e.currentTarget.checked)} />
      Verdict overlay
    </label>
    <label class:off={!isColor || !hasBurn}>
      <input type="checkbox" checked={ui.relief} disabled={!isColor || !hasBurn} onchange={(e) => setPref('relief', e.currentTarget.checked)} />
      Relief shading
    </label>
    <div class="menu">
      <button class="btn small" disabled={!hasBurn || !isTauri()} aria-haspopup="menu" aria-expanded={exportOpen} onclick={() => (exportOpen = !exportOpen)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
          ><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg
        >
        Export PNG
      </button>
      {#if exportOpen}
        <div class="popup" role="menu">
          <button role="menuitem" onclick={() => doExport('color')}>Color image</button>
          <button role="menuitem" onclick={() => doExport('height')}>Height map (16-bit)</button>
        </div>
      {/if}
    </div>
  </div>
</div>

<div class="stage-wrap">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="stage"
    class:grab={hasBurn && isColor && zoom > 1.01}
    class:dragging={drag?.moved}
    bind:this={stage}
    role="application"
    aria-label="Burn view. Drag to pan, scroll to zoom, arrow keys pan, + and − zoom, 0 fits."
    tabindex="0"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={() => (drag = null)}
    onpointerleave={() => burn.clearHover()}
    onwheel={onWheel}
    onkeydown={onKey}
    ondragover={(e) => {
      e.preventDefault()
      dragOver = true
    }}
    ondragleave={() => (dragOver = false)}
    ondrop={onDrop}
  >
    <canvas bind:this={canvas} class:hidden={!isColor || !hasBurn}></canvas>

    {#if hasBurn && !isColor}
      <!-- three.js loads only when the Height view is first opened. -->
      {#await import('./HeightView.svelte') then { default: HeightView }}
        <HeightView />
      {/await}
    {/if}

    {#if hasBurn && isColor}
      {#if hoverPx && !drag?.moved}
        <div class="cross" style:left="{hoverPx.x}px" style:top="{hoverPx.y}px" aria-hidden="true"></div>
      {/if}
      {#if marker}
        <div class="head" style:left="{marker.x}px" style:top="{marker.y}px" aria-hidden="true"></div>
      {/if}
      <div class="scale" aria-hidden="true">
        <div class="bar" style:width="{bar.px}px"></div>
        <span>{bar.label}</span>
      </div>
      <div class="zoom">
        <button aria-label="Zoom out" disabled={zoom <= 0.51} onclick={() => burn.zoomAt(0.5)}>−</button>
        <span>{zoomLabel}</span>
        <button aria-label="Zoom in" disabled={atMaxZoom} onclick={() => burn.zoomAt(2)}>+</button>
        <button class="text" onclick={() => burn.fit()}>Fit</button>
        <button class="text" title="One grid cell per screen pixel ({burn.grid?.pitchMm.toFixed(4)} mm)" onclick={() => burn.setView({ ...burn.view, mmPerPx: burn.pitchMmPerPx })}
          >1:1</button
        >
      </div>
      {#if burn.grid && burn.grid.tileRects.length > 1}
        <div class="minimap">
          <div class="tiles" style:grid-template-columns="repeat({burn.grid.tiles[0]}, 40px)">
            {#each minimap as t, i (t.index)}
              <button aria-label="Show tile {i + 1}" aria-pressed={t.index === tileAt} onclick={() => burn.focus(t, 1)}>{i + 1}</button>
            {/each}
          </div>
          <span>Tile {tileAt >= 0 ? minimap.findIndex((t) => t.index === tileAt) + 1 : '—'} / {minimap.length} · ≤9000² cells</span>
        </div>
      {/if}
    {/if}

    {#if chip}
      <div class="chip" role="status"><span class="dot" style:background={chip.dot}></span>{chip.label}</div>
    {/if}
    {#if exportNote}
      <div class="toast" role="status">{exportNote}</div>
    {/if}

    {#if burn.glError}
      <div class="center">
        <div class="card error">
          <strong>The burn view can’t run</strong>
          <p>{burn.glError}</p>
        </div>
      </div>
    {:else if burn.restoring}
      <div class="center">
        <div class="card" role="status">
          <strong>Restoring the burn view…</strong>
          <p>The graphics driver reset the GPU. Your job is kept and re-renders once the view is back.</p>
        </div>
      </div>
    {:else if app.source === 'live' && !shownJob}
      <div class="center">
        <div class="card plain">
          <div class="pulse" class:failed={app.connection.state === 'failed'}></div>
          <strong
            >{app.connection.state === 'connected'
              ? 'Connected, waiting for a job'
              : app.connection.state === 'failed'
                ? 'The emulator isn’t listening'
                : 'Waiting for a connection'}</strong
          >
          <p>
            In LightBurn, add a GRBL device with a Network connection pointed at
            <code>{app.settings.network.bindMode === 'localhost' ? '127.0.0.1' : 'this computer'}:{app.settings.network.port}</code>. The preview builds as lines stream in.
          </p>
          <p class="sub">{describeConnection(app.connection)}</p>
          <button class="link" onclick={() => (app.screen = 'settings')}>Connection settings</button>
        </div>
      </div>
    {:else if !shownJob}
      <div class="center">
        <div class="card dashed" class:over={dragOver}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--fg-muted)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg
          >
          <strong>Open a G-code job</strong>
          <p>Drop a .gcode file here, or switch to Live to receive jobs from LightBurn or LaserGRBL.</p>
          <button class="btn primary big" onclick={() => fileInput.click()}>Choose file…</button>
          {#if !isTauri()}<p class="sub">Opening files needs the desktop app (<code>pnpm tauri dev</code>).</p>{/if}
        </div>
      </div>
    {:else if status === 'error'}
      <div class="center">
        <div class="card error">
          <strong>Can’t simulate {shownJob.name}</strong>
          <ul>
            {#each errors.slice(0, 6) as d, i (i)}
              <li>{#if d.line > 0}<span class="line">Line {d.line.toLocaleString('en-US')}</span>{' · '}{/if}{d.message}</li>
            {/each}
            {#each warnings.slice(0, 2) as d, i (i)}
              <li class="warn">{#if d.line > 0}<span class="line">Line {d.line.toLocaleString('en-US')}</span>{' · '}{/if}{d.message}</li>
            {/each}
          </ul>
          {#if errors.length > 6}<p class="sub">…and {errors.length - 6} more errors.</p>{/if}
          {#if shownJob.kind === 'file'}
            <div class="actions">
              <button class="btn" onclick={() => fileInput.click()}>Open another file</button>
              {#if shownJob.model?.burnBounds}
                <button class="btn" onclick={() => burn.simulateAnyway()} title="Plan the job with the failing lines dropped, as GRBL would">Simulate without these lines</button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {:else if status !== 'ready'}
      <div class="center">
        <div class="card plain" role="status">
          <div class="spinner" aria-hidden="true"></div>
          <strong>{status === 'parsing' ? `Reading ${shownJob.name}…` : status === 'planning' ? 'Planning motion like GRBL…' : 'Computing heat build-up…'}</strong>
          <p class="sub">
            {#if status === 'planning'}{shownJob.samples.toLocaleString('en-US')} samples{:else if status === 'thermal'}One-time thermal step for this material; scrubbing reuses it.{:else}&nbsp;{/if}
          </p>
        </div>
      </div>
    {/if}

    {#if dragOver && shownJob}
      <div class="drop" aria-hidden="true">Drop to open</div>
    {/if}
  </div>
</div>

<input bind:this={fileInput} type="file" accept=".gcode,.gc,.nc,.ngc,.txt" hidden onchange={onPick} />

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--line-subtle);
    flex-wrap: wrap;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    color: var(--fg);
    font-size: var(--text-xs);
  }
  .tools label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    user-select: none;
  }
  .tools label.off {
    color: var(--fg-faint);
  }
  .btn.small {
    min-height: 32px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--fg);
  }
  .menu {
    position: relative;
  }
  .popup {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: var(--z-popup);
    display: flex;
    flex-direction: column;
    min-width: 180px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: var(--shadow-popup);
  }
  .popup button {
    text-align: left;
    border: 0;
    background: transparent;
    padding: 8px 10px;
    border-radius: 5px;
  }
  .popup button:hover {
    background: var(--line);
  }
  .stage-wrap {
    flex: 1 1 auto;
    min-height: 0;
    padding: 16px;
    background: var(--sunken);
    display: flex;
  }
  .stage {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--field);
    box-shadow: var(--shadow-paper);
    cursor: crosshair;
    outline: none;
  }
  .stage:focus-visible {
    outline: var(--focus-ring);
  }
  .stage.grab {
    cursor: grab;
  }
  .stage.dragging {
    cursor: grabbing;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  canvas.hidden {
    visibility: hidden;
  }
  .cross {
    position: absolute;
    width: 1px;
    height: 1px;
    pointer-events: none;
  }
  .cross::before,
  .cross::after {
    content: '';
    position: absolute;
    background: var(--crosshair);
    box-shadow: var(--shadow-outline);
  }
  .cross::before {
    left: -9px;
    width: 18px;
    height: 1px;
  }
  .cross::after {
    top: -9px;
    width: 1px;
    height: 18px;
  }
  .head {
    position: absolute;
    width: 22px;
    height: 22px;
    margin: -11px 0 0 -11px;
    border-radius: 50%;
    background: radial-gradient(circle, var(--marker-core) 0 2px, var(--marker-glow) 3px, var(--marker-fade) 70%);
    pointer-events: none;
  }
  .scale {
    position: absolute;
    left: 10px;
    bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    pointer-events: none;
  }
  .scale .bar {
    height: 4px;
    min-width: 20px;
    background: var(--fg-strong);
    border-radius: 1px;
    box-shadow: var(--shadow-hairline);
  }
  .scale span {
    font-size: var(--text-2xs);
    font-family: var(--font-mono);
    text-shadow: var(--shadow-text);
  }
  .zoom {
    position: absolute;
    right: 10px;
    top: 10px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    background: var(--overlay);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .zoom button {
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    font-size: var(--text-lg);
    line-height: 1;
  }
  .zoom button.text {
    width: auto;
    padding: 0 8px;
    font-size: var(--text-xs);
    color: var(--fg);
  }
  .zoom button:hover:not(:disabled) {
    background: var(--line);
  }
  .zoom span {
    min-width: 40px;
    text-align: center;
    font-size: var(--text-2xs);
    font-family: var(--font-mono);
    color: var(--fg);
  }
  .minimap {
    position: absolute;
    right: 10px;
    bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: var(--overlay);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .tiles {
    display: grid;
    gap: 3px;
  }
  .tiles button {
    height: 30px;
    border-radius: 4px;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--fg);
    font-size: var(--text-2xs);
  }
  .tiles button[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--fg-strong);
  }
  .minimap span {
    font-size: var(--text-2xs);
    font-family: var(--font-mono);
    color: var(--fg);
    white-space: nowrap;
  }
  .chip {
    position: absolute;
    left: 10px;
    top: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--overlay);
    font-size: var(--text-2xs);
    white-space: nowrap;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .toast {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    max-width: 80%;
    padding: 6px 12px;
    border-radius: 6px;
    background: var(--overlay);
    border: 1px solid var(--line);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .center {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .card {
    max-width: 380px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 10px;
    padding: 28px 24px;
    border-radius: 12px;
  }
  .card strong {
    font-size: var(--text-md);
  }
  .card p {
    margin: 0;
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--fg-muted);
  }
  .card .sub {
    color: var(--fg-faint);
    font-size: var(--text-2xs);
  }
  .card.dashed {
    border: 1px dashed var(--line-strong);
  }
  .card.dashed.over {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .card.error {
    max-width: 440px;
    align-items: stretch;
    text-align: left;
    border: 1px solid var(--danger-border);
    background: var(--danger-soft);
    padding: 20px;
  }
  .card.error strong {
    font-size: var(--text-sm);
    color: var(--danger-text);
  }
  .card ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--fg);
  }
  .card li .line {
    font-family: var(--font-mono);
    color: var(--danger-text);
  }
  .card li.warn .line {
    color: var(--warn-muted);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .btn.big {
    min-height: 40px;
    padding: 0 16px;
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent);
    font-size: var(--text-xs);
    padding: 4px;
  }
  .link:hover {
    color: var(--accent-hover);
  }
  code {
    font-family: var(--font-mono);
    color: var(--fg-strong);
  }
  .pulse {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--warn);
    box-shadow: 0 0 0 6px var(--warn-soft);
  }
  .pulse.failed {
    background: var(--danger);
    box-shadow: 0 0 0 6px var(--danger-soft);
  }
  .spinner {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid var(--line);
    border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .drop {
    position: absolute;
    inset: 8px;
    display: grid;
    place-items: center;
    border: 2px dashed var(--accent);
    border-radius: 10px;
    background: var(--scrim);
    font-size: var(--text-sm);
    pointer-events: none;
  }
</style>
