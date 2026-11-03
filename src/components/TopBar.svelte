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
    <span>LaserSim</span>
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
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 15px;
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
    font-size: 12px;
    font-family: var(--mono);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    font-size: 12px;
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
    color: #8fd6ab;
    background: rgba(76, 175, 125, 0.12);
    border-color: rgba(76, 175, 125, 0.35);
  }
  .pill.amber {
    color: #e8c57f;
    background: rgba(224, 169, 64, 0.1);
    border-color: rgba(224, 169, 64, 0.35);
  }
  .pill.red {
    color: var(--danger);
    background: rgba(229, 72, 77, 0.1);
    border-color: rgba(229, 72, 77, 0.35);
  }
  .pill.gray {
    color: var(--muted);
    border-color: var(--line-strong);
  }
  .icon {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--panel);
    color: var(--text-2);
  }
  .icon:hover {
    color: var(--text);
  }
</style>
