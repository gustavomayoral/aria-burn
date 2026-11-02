<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { DEMO_DURATION_S as TOTAL_S, app } from '../lib/app.svelte.ts'
  import { isTauri } from '../lib/ipc.ts'
  import { preview } from '../lib/preview.svelte.ts'

  // Scrub is placeholder until the core's scrub model (COD-264) lands: it shows
  // stream progress and is not draggable yet.
  const progress = $derived(app.stream.state === 'idle' ? 0 : Math.min(100, (preview.jobTimeS / TOTAL_S) * 100))
  const running = $derived(app.stream.state === 'running')

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
</script>

<div class="timeline">
  <button
    class="play"
    aria-label={running ? 'Streaming' : 'Stream dummy job'}
    disabled={running || !isTauri()}
    onclick={() => app.runDemoStream()}
  >
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {#if running}
        <rect x="2" y="2" width="3.5" height="10" fill="currentColor" /><rect x="8.5" y="2" width="3.5" height="10" fill="currentColor" />
      {:else}
        <path d="M3 1.5v11l9-5.5z" fill="currentColor" />
      {/if}
    </svg>
  </button>
  <input type="range" min="0" max="100" step="0.5" value={progress} disabled aria-label="Job progress" />
  <span class="label">{fmt(preview.jobTimeS)} / {fmt(TOTAL_S)}</span>
</div>

<style>
  .timeline {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-top: 1px solid var(--line);
  }
  .play {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 0;
    background: var(--accent);
    color: #1b1a18;
    display: grid;
    place-items: center;
  }
  input[type='range'] {
    flex: 1 1 auto;
    accent-color: var(--accent);
  }
  .label {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-2);
    min-width: 110px;
    text-align: right;
  }
</style>
