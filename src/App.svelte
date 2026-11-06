<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte'
  import CanvasArea from './components/CanvasArea.svelte'
  import InfoPanel from './components/InfoPanel.svelte'
  import MaterialPanel from './components/MaterialPanel.svelte'
  import PatternDialog from './components/PatternDialog.svelte'
  import PhotoFitDialog from './components/PhotoFitDialog.svelte'
  import { photoFit, runPhotoFitDemo } from './lib/photo-fit.svelte.ts'
  import SettingsScreen from './components/SettingsScreen.svelte'
  import Timeline from './components/Timeline.svelte'
  import TopBar from './components/TopBar.svelte'
  import { app } from './lib/app.svelte.ts'
  import { calibration } from './lib/calibration.svelte.ts'
  import { launchFile, runSmoke, smokeConfig, smokeReport } from './lib/ipc.ts'
  import { openPath } from './lib/open-file.ts'

  let smokeRunning = $state(false)

  onMount(async () => {
    await app.load()
    await calibration.load()
    await photoFit.load()
    // Developer demo (BURN-15): VITE_ARIA_DEMO=photo-fit runs the photo fit on a synthetic photo and saves it.
    if (import.meta.env.DEV && import.meta.env.VITE_ARIA_DEMO === 'photo-fit') void runPhotoFitDemo(import.meta.env.VITE_ARIA_DEMO_MATERIAL)
    // CI smoke mode (ARIA_BURN_SMOKE): stream, verify, report, and Rust exits.
    const smoke = await smokeConfig()
    if (smoke) {
      smokeRunning = true
      await smokeReport(await runSmoke(smoke))
      return
    }
    await app.startEmulator()
    const path = await launchFile()
    if (path) void openPath(path)
  })
</script>

{#if app.screen === 'settings'}
  <SettingsScreen />
{/if}
{#if calibration.open}
  <PatternDialog />
{/if}
{#if photoFit.open}
  <PhotoFitDialog />
{/if}
<!-- Kept mounted behind the settings screen so the burn (and its GPU context) survives. -->
<div class="shell" hidden={app.screen === 'settings'}>
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

<style>
  .shell[hidden] {
    display: none;
  }
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
    background: var(--info-soft);
    border-bottom: 1px solid var(--line-subtle);
    font-size: var(--text-xs);
  }
</style>
