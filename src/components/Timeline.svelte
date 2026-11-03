<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { app } from '../lib/app.svelte.ts'
  import { burn } from '../lib/burn.svelte.ts'
  import { fmtDuration } from '../lib/verdicts.ts'

  // The canvas shows only what has burned up to the cutoff: dragging previews
  // coarse, letting go renders full resolution (core scrub rules, COD-264).
  const job = $derived(burn.job)
  const live = $derived(job?.kind === 'live' && app.source === 'live')
  const streaming = $derived(live && job?.durationS === null)
  const ready = $derived(burn.status === 'ready' && burn.grid !== null && (app.source === 'live' ? job?.kind === 'live' : job?.kind === 'file'))
  const total = $derived(burn.totalS)
  const elapsed = $derived(Math.min(1, burn.progress) * total)

  const label = $derived.by(() => {
    if (!ready || !job) return app.source === 'live' ? 'No job yet' : '—'
    const pct = `${Math.round(burn.progress * 100)}%`
    if (streaming) {
      const line = app.machine && app.machine.line > 0 ? ` · line ${app.machine.line.toLocaleString('en-US')}` : ''
      return burn.follow ? `Live · ${fmtDuration(total)} streamed${line}` : `${pct} · ${fmtDuration(elapsed)} / ${fmtDuration(total)} streamed`
    }
    return `${pct} · ${fmtDuration(elapsed)} / ${fmtDuration(total)}`
  })
</script>

<div class="timeline">
  <button class="play" aria-label={burn.playing ? 'Pause' : 'Play'} disabled={!ready || live} onclick={() => burn.togglePlay()}>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {#if burn.playing}
        <rect x="5" y="4" width="4" height="16" /><rect x="15" y="4" width="4" height="16" />
      {:else}
        <polygon points="6 4 20 12 6 20" />
      {/if}
    </svg>
  </button>
  <div class="track">
    {#if streaming}
      <!-- The whole track is what has streamed so far; scrubbing can't pass the head. -->
      <div class="streamed" aria-hidden="true"></div>
    {/if}
    <input
      type="range"
      min="0"
      max="1000"
      step="1"
      value={Math.round(burn.progress * 1000)}
      disabled={!ready}
      oninput={(e) => burn.scrub(Number(e.currentTarget.value) / 1000)}
      aria-label="Job progress"
      aria-valuetext={label}
    />
  </div>
  <span class="label">{label}</span>
  {#if live}
    <label class="follow">
      <input type="checkbox" checked={burn.follow} disabled={!streaming} onchange={(e) => burn.setFollow(e.currentTarget.checked)} />
      Follow live
    </label>
  {/if}
</div>

<style>
  .timeline {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 20px;
    border-top: 1px solid var(--line-subtle);
    flex-wrap: wrap;
  }
  .play {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: var(--panel);
    display: grid;
    place-items: center;
    flex: 0 0 auto;
  }
  .track {
    flex: 1 1 200px;
    min-width: 200px;
    position: relative;
    display: flex;
    align-items: center;
  }
  .streamed {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 4px;
    transform: translateY(-50%);
    border-radius: 2px;
    background: var(--accent-track);
    pointer-events: none;
  }
  input[type='range'] {
    position: relative;
    width: 100%;
    accent-color: var(--accent);
  }
  .label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--fg-muted);
    min-width: 150px;
    text-align: right;
    white-space: nowrap;
  }
  .follow {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--fg);
    min-height: 32px;
  }
</style>
