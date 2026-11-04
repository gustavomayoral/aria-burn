<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { app } from '../lib/app.svelte.ts'
  import { burn } from '../lib/burn.svelte.ts'
  import { describeConnection } from '../lib/emulator.ts'

  const fileStatus = $derived.by(() => {
    const job = burn.job
    if (!job || job.kind !== 'file') return null
    const b = job.model?.burnBounds
    const size = b ? ` · ${(b.maxXMm - b.minXMm).toFixed(0)}×${(b.maxYMm - b.minYMm).toFixed(0)}mm` : ''
    const m4 = job.model?.moves.some((m) => m.laser === 'm4')
    const mode = job.model ? (m4 ? ' · M4' : ' · M3') : ''
    const passes = (job.model?.passes.length ?? 0) > 1 ? ` · ${job.model!.passes.length} passes` : ''
    return `${job.name}${size}${mode}${passes}`
  })

  // Live pill: green streaming/connected, amber listening, red failed or dropped mid-job.
  const pill = $derived.by(() => {
    const c = app.connection
    const job = burn.job?.kind === 'live' ? burn.job : null
    if (job?.aborted === 'sender-disconnected' && c.state !== 'connected') return { tone: 'red', label: 'Sender disconnected' }
    if (c.state === 'connected') {
      const streaming = job && job.durationS === null ? ` · streaming ${job.name}` : ''
      return { tone: 'green', label: `${c.address} · ${describeConnection(c).replace('Sender connected from', 'sender')}${streaming}` }
    }
    if (c.state === 'listening') return { tone: 'amber', label: describeConnection(c) }
    if (c.state === 'failed') return { tone: 'red', label: describeConnection(c) }
    return { tone: 'gray', label: describeConnection(c) }
  })
</script>

<header>
  <div class="brand">
    <div class="logo" aria-hidden="true"></div>
    <span>Aria Burn</span>
  </div>
  <div class="seg" role="group" aria-label="Job source">
    <button aria-pressed={app.source === 'file'} onclick={() => (app.source = 'file')}>File</button>
    <button aria-pressed={app.source === 'live'} onclick={() => (app.source = 'live')}>Live (GRBL)</button>
  </div>
  <div class="status">
    {#if app.source === 'live'}
      <span class="pill {pill.tone}"><span class="dot"></span>{pill.label}</span>
    {:else if fileStatus}
      <span class="file">{fileStatus}</span>
    {/if}
  </div>
  <button class="icon" aria-label="Connection, laser and machine settings" onclick={() => (app.screen = 'settings')}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
      />
    </svg>
  </button>
</header>

<style>
  header {
    min-height: 56px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 20px;
    border-bottom: 1px solid var(--line-subtle);
    flex-wrap: wrap;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: 0.2px;
  }
  .logo {
    width: 22px;
    height: 22px;
    border-radius: 5px;
    background: linear-gradient(135deg, var(--accent), var(--accent-deep));
  }
  .status {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    justify-content: flex-end;
  }
  .file {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    font-size: var(--text-xs);
    border: 1px solid;
    border-radius: 999px;
    padding: 4px 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pill .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex: 0 0 auto;
  }
  .pill.green {
    color: var(--ok-text);
    background: var(--ok-soft);
    border-color: var(--ok-border);
  }
  .pill.amber {
    color: var(--warn-text);
    background: var(--warn-soft);
    border-color: var(--warn-border);
  }
  .pill.red {
    color: var(--danger-text);
    background: var(--danger-soft);
    border-color: var(--danger-border);
  }
  .pill.gray {
    color: var(--fg-muted);
    border-color: var(--line);
  }
  .icon {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    color: var(--fg);
  }
  .icon:hover {
    color: var(--fg-strong);
  }
</style>
