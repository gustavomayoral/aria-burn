<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { app } from '../lib/app.svelte.ts'
  import { describeConnection } from '../lib/emulator.ts'

  const status = $derived.by(() => {
    if (app.source === 'live') {
      const c = app.connection
      const m = app.machine
      const live = app.live
      if (c.state !== 'connected') return describeConnection(c)
      const job = live && !live.done ? ` · job ${live.jobId}, ${live.samples.toLocaleString()} samples` : ''
      const line = m && m.line > 0 ? ` · line ${m.line}` : ''
      return `${describeConnection(c)} · ${m?.state ?? 'Idle'}${line}${job}`
    }
    const s = app.stream
    if (s.state === 'running') return `Streaming dummy job… ${s.batches} batches`
    if (s.state === 'done') return `Dummy job · ${s.samples.toLocaleString()} samples`
    return 'No job loaded'
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
  <div class="status" class:danger={app.source === 'live' && app.connection.state === 'failed'}>{status}</div>
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
    color: var(--muted);
    font-size: 12px;
    text-align: right;
  }
  .status.danger {
    color: var(--danger);
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
