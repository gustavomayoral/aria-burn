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
  import { QUIT_REQUESTED_EVENT, appQuit, isTauri, launchFile, runSmoke, smokeConfig, smokeReport, setUnsaved } from './lib/ipc.ts'
  import { chooseFile, openPath } from './lib/open-file.ts'
  import { project } from './lib/project.svelte.ts'

  let smokeRunning = $state(false)

  // Closing or quitting with unsaved project changes asks first (BURN-55): Rust
  // stops the close while the flag is set and sends quit-requested.
  $effect(() => {
    void setUnsaved(project.dirty)
  })

  onMount(() => {
    let unlisten: (() => void) | null = null
    if (isTauri())
      void import('@tauri-apps/api/event').then(async ({ listen }) => {
        unlisten = await listen(QUIT_REQUESTED_EVENT, async () => {
          if (await project.confirmDiscard()) await appQuit()
        })
      })
    return () => unlisten?.()
  })

  /** Browser dev mode: the page's own leave prompt. */
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!isTauri() && project.dirty) e.preventDefault()
  }

  /** Open ⌘O, Save ⌘S, Save As ⇧⌘S (Ctrl on Windows and Linux). */
  function onKey(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || app.screen !== 'main') return
    const k = e.key.toLowerCase()
    if (k === 'o' && !e.shiftKey) {
      e.preventDefault()
      void chooseFile()
    } else if (k === 's' && project.canSave) {
      e.preventDefault()
      void (e.shiftKey ? project.saveAs() : project.save())
    }
  }

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

<svelte:window onkeydown={onKey} onbeforeunload={onBeforeUnload} />

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
