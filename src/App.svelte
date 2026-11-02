<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte'
  import CanvasArea from './components/CanvasArea.svelte'
  import InfoPanel from './components/InfoPanel.svelte'
  import MaterialPanel from './components/MaterialPanel.svelte'
  import SettingsScreen from './components/SettingsScreen.svelte'
  import Timeline from './components/Timeline.svelte'
  import TopBar from './components/TopBar.svelte'
  import { app } from './lib/app.svelte.ts'
  import { runSmoke, smokeConfig, smokeReport } from './lib/ipc.ts'

  let smokeRunning = $state(false)

  onMount(async () => {
    await app.load()
    // CI smoke mode (ARIA_BURN_SMOKE): stream, verify, report, and Rust exits.
    const smoke = await smokeConfig()
    if (smoke) {
      smokeRunning = true
      await smokeReport(await runSmoke(smoke))
      return
    }
    await app.startEmulator()
  })
</script>

{#if app.screen === 'settings'}
  <SettingsScreen />
{:else}
  <div class="shell">
    <TopBar />
    {#if smokeRunning}
      <div class="smoke" role="status">IPC smoke test running…</div>
    {/if}
    <div class="body">
      <MaterialPanel />
      <main>
        <CanvasArea />
        <Timeline />
      </main>
      <InfoPanel />
    </div>
  </div>
{/if}

<style>
  .shell {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .body {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
  }
  main {
    flex: 999 1 560px;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .smoke {
    padding: 6px 20px;
    background: rgba(77, 145, 214, 0.15);
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
</style>
