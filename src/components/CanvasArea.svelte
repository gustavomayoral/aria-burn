<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { app } from '../lib/app.svelte.ts'
  import { isTauri } from '../lib/ipc.ts'
  import type { ViewMode } from '../lib/settings.ts'
  import ColorView from './ColorView.svelte'

  const VIEW_MODES: { id: ViewMode; label: string }[] = [
    { id: 'color', label: 'Color' },
    { id: 'height', label: 'Height' },
  ]
  const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3]
  let zoomIndex = $state(2)

  const ui = $derived(app.settings.ui)
  const hasJob = $derived(app.source === 'live' ? app.live !== null : app.stream.state !== 'idle')

  function setPref<K extends keyof typeof ui>(key: K, value: (typeof ui)[K]) {
    app.settings.ui[key] = value
    void app.savePrefs()
  }
</script>

<div class="toolbar">
  <div class="seg" role="group" aria-label="View">
    {#each VIEW_MODES as v (v.id)}
      <button aria-pressed={ui.viewMode === v.id} onclick={() => setPref('viewMode', v.id)}>{v.label}</button>
    {/each}
  </div>
  <div class="tools">
    <label>
      <input type="checkbox" checked={ui.verdictOverlay} disabled onchange={(e) => setPref('verdictOverlay', e.currentTarget.checked)} />
      Verdict overlay
    </label>
    <label>
      <input type="checkbox" checked={ui.relief} onchange={(e) => setPref('relief', e.currentTarget.checked)} />
      Relief shading
    </label>
    <button class="btn" disabled>Export PNG</button>
  </div>
</div>

<div class="stage">
  {#if !hasJob}
    <div class="empty">
      <div class="card">
        {#if app.source === 'live'}
          <strong>Waiting for a job</strong>
          <p class="note">Point LightBurn or LaserGRBL at the emulator (Settings → Network emulator) and start a job; the preview builds as it burns.</p>
        {:else}
          <strong>Open a G-code job</strong>
          <p class="note">Drop a .gcode file here, or switch to Live to receive jobs from LightBurn or LaserGRBL.</p>
          <button class="btn primary" onclick={() => app.runDemoStream()} disabled={!isTauri()}>Stream dummy job</button>
        {/if}
        {#if !isTauri()}<p class="note">Run inside the desktop app (<code>pnpm tauri dev</code>) to stream from Rust.</p>{/if}
      </div>
    </div>
  {:else if ui.viewMode === 'color'}
    <ColorView zoom={ZOOMS[zoomIndex]!} />
  {:else}
    <!-- three.js loads only when the Height view is first opened. -->
    {#await import('./HeightView.svelte') then { default: HeightView }}
      <HeightView />
    {/await}
  {/if}

  {#if hasJob && ui.viewMode === 'color'}
    <div class="zoom">
      <button class="btn" aria-label="Zoom out" disabled={zoomIndex === 0} onclick={() => zoomIndex--}>−</button>
      <span>{Math.round(ZOOMS[zoomIndex]! * 100)}%</span>
      <button class="btn" aria-label="Zoom in" disabled={zoomIndex === ZOOMS.length - 1} onclick={() => zoomIndex++}>+</button>
      <button class="btn" onclick={() => (zoomIndex = 2)}>Fit</button>
    </div>
  {/if}
  {#if app.source === 'file' && app.stream.state === 'running'}
    <div class="chip" role="status"><span class="dot"></span>Rendering · {app.stream.batches} batches</div>
  {:else if app.source === 'live' && app.live && !app.live.done}
    <div class="chip" role="status"><span class="dot"></span>Live · {app.live.batches} batches</div>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 16px;
    color: var(--text-2);
  }
  .tools label {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .stage {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    background: #141312;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }
  .card {
    max-width: 360px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
    padding: 28px;
    border: 1px dashed var(--line-strong);
    border-radius: 12px;
  }
  .card p {
    margin: 0;
  }
  .zoom {
    position: absolute;
    right: 16px;
    bottom: 16px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px;
    border-radius: var(--radius);
    background: var(--overlay);
  }
  .zoom span {
    min-width: 44px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .chip {
    position: absolute;
    right: 16px;
    top: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-radius: 999px;
    background: var(--overlay);
    font-size: 12px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1s infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.3;
    }
  }
</style>
