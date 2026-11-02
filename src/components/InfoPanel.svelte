<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { TILE_MAX_CELLS } from 'aria-burn-core/contract'
  import { app } from '../lib/app.svelte.ts'

  const machine = $derived(app.settings.machine)
  // Grid pitch = smallest spot sigma ÷ 3, as the planner will use it (COD-260).
  const pitchMm = $derived(Math.min(machine.spot.sigmaXMm, machine.spot.sigmaYMm) / 3)
  const tileMm = $derived(TILE_MAX_CELLS * pitchMm)
  const s = $derived(app.stream)
  const live = $derived(app.source === 'live' ? app.live : null)
  const m = $derived(app.machine)
</script>

<aside>
  {#each app.warnings as w (w)}
    <div class="callout warn"><strong>Settings</strong><span>{w}</span></div>
  {/each}
  {#if live && live.errors.length}
    <div class="callout danger">
      <strong>Live job</strong>
      {#each live.errors.slice(0, 5) as e (e)}<span>{e}</span>{/each}
    </div>
  {/if}
  {#if s.state === 'error'}
    <div class="callout danger">
      <strong>Stream check failed</strong>
      {#each s.errors.slice(0, 5) as e (e)}<span>{e}</span>{/each}
    </div>
  {/if}

  <div>
    <div class="section-label">Cursor</div>
    <p class="note">Hover the canvas to read position and fluence.</p>
  </div>

  <div>
    <div class="section-label">Job</div>
    <div class="kv">
      {#if app.source === 'live'}
        <span>Bounds</span><span>{live?.bounds ? `${live.bounds.widthMm.toFixed(1)} × ${live.bounds.heightMm.toFixed(1)} mm` : '—'}</span>
      {:else}
        <span>Bounds</span><span>{s.state === 'idle' ? '—' : '40.0 × 30.0 mm'}</span>
      {/if}
      <span>Grid pitch</span><span>{pitchMm.toFixed(3)} mm</span>
      <span>Tile size</span><span>{tileMm.toFixed(0)} mm</span>
      <span>Power mode</span><span>{machine.laserMode ? 'M4 (laser mode)' : 'M3'}</span>
      <span>Passes</span><span>{s.state === 'idle' ? '—' : '1'}</span>
    </div>
    <p class="note">Pitch = spot σ ÷ 3. Tiles hold at most 9000² cells.</p>
  </div>

  {#if app.source === 'live'}
    <div>
      <div class="section-label">Machine</div>
      <div class="kv">
        <span>State</span><span>{m?.state ?? '—'}</span>
        <span>Position</span><span>{m ? `${m.positionMm.xMm.toFixed(2)}, ${m.positionMm.yMm.toFixed(2)} mm` : '—'}</span>
        <span>Feed</span><span>{m ? `${m.feedMmPerMin.toFixed(0)} mm/min` : '—'}</span>
        <span>Line</span><span>{m && m.line > 0 ? m.line : '—'}</span>
      </div>
    </div>
    {#if live}
      <div>
        <div class="section-label">{live.name ?? `Live job ${live.jobId}`}</div>
        <div class="kv">
          <span>Batches</span><span>{live.batches.toLocaleString()}</span>
          <span>Samples</span><span>{live.samples.toLocaleString()}</span>
          {#if live.lineCount !== null}<span>Lines</span><span>{live.lineCount.toLocaleString()}</span>{/if}
          {#if live.done}
            <span>Duration</span><span>{live.done.durationS.toFixed(1)} s</span>
            <span>Check</span>
            {#if live.done.batchCount === live.batches && live.done.sampleCount === live.samples}<span class="ok">plan.done ✓</span>{:else}<span>{live.batches}/{live.done.batchCount} batches</span>{/if}
          {/if}
        </div>
      </div>
    {/if}
  {/if}

  <div>
    <div class="section-label">Sample stream</div>
    <div class="kv">
      <span>State</span><span>{s.state}</span>
      <span>Batches</span><span>{s.batches.toLocaleString()}</span>
      <span>Samples</span><span>{s.samples.toLocaleString()}</span>
      {#if s.state === 'done'}
        <span>Data</span><span>{s.mb.toFixed(1)} MB</span>
        <span>Time</span><span>{s.seconds.toFixed(2)} s</span>
        <span>Check</span><span class="ok">plan.done ✓</span>
      {/if}
    </div>
    <p class="note">Dummy planner output over a Tauri Channel, binary sample batches checked against plan.done.</p>
  </div>
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
    margin: 6px 0 0;
  }
  .ok {
    color: var(--ok);
  }
</style>
