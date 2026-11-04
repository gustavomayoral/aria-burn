<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  Settings → Machines (BURN-31): the catalog picker, the user's machine library
  and the $$ / .lbdev imports. Same flow as Aria Studio's Preferences →
  Machines (COD-151): built-ins first and read-only, Load applies a machine,
  New keeps the settings being edited, Update writes them into your machine.
-->
<script lang="ts">
  import { app } from '../lib/app.svelte.ts'
  import { ImportError, summarize, type ImportReport } from '../lib/machine-import.ts'
  import * as session from '../lib/machine-session.ts'
  import {
    BUILTIN_DEFAULT_ID,
    FIELD_LABELS,
    MAX_MACHINES,
    builtinMachine,
    catalogByBrand,
    catalogMachine,
    isBuiltin,
    machineNameError,
    modulesForFrame,
    provisionalFieldsOf,
  } from '../lib/machines.ts'
  import { findFrame } from 'aria-burn-core/profiles/catalog/index.ts'

  const groups = catalogByBrand()
  const active = $derived(session.activeMachine(app))
  const activeBuiltIn = $derived(isBuiltin(app.library.activeId))
  const edited = $derived(active ? JSON.stringify(active.profile) !== JSON.stringify(app.settings.machine) : false)
  const builtIns = $derived([builtinMachine(BUILTIN_DEFAULT_ID)!, ...(activeBuiltIn && active && active.id !== BUILTIN_DEFAULT_ID ? [active] : [])])
  const full = $derived(app.library.machines.length >= MAX_MACHINES)

  // Picker: starts on the active catalog machine's frame, if any.
  let frameId = $state(app.settings.machine.frameId ?? groups[0]!.frames[0]!.id)
  const frame = $derived(findFrame(frameId)!)
  const modules = $derived(modulesForFrame(frame))
  let moduleId = $state('')
  $effect(() => {
    // Only modules the frame lists; keep the choice when the new frame takes it too.
    if (!frame.modules.includes(moduleId)) moduleId = app.settings.machine.frameId === frame.id && app.settings.machine.moduleId ? app.settings.machine.moduleId : frame.modules[0]!
  })
  const preview = $derived(modules.find((m) => m.id === moduleId) ? catalogMachine(frame, modules.find((m) => m.id === moduleId)!) : null)
  const previewProvisional = $derived(preview ? provisionalFieldsOf(preview.fieldStatus) : [])

  /** Row being renamed, deleted, or the New… form; one at a time. */
  let mode = $state<{ kind: 'new' } | { kind: 'rename'; id: string } | { kind: 'delete'; id: string } | null>(null)
  let nameInput = $state('')
  const nameError = $derived(
    mode?.kind === 'new' ? machineNameError(nameInput, app.library.machines) : mode?.kind === 'rename' ? machineNameError(nameInput, app.library.machines, mode.id) : null,
  )

  let message = $state<{ tone: 'ok' | 'warn' | 'danger'; lines: string[] } | null>(null)
  let showPaste = $state(false)
  let dump = $state('')
  let fileInput: HTMLInputElement | undefined = $state()

  async function run(action: () => Promise<unknown>, done?: string) {
    message = null
    try {
      await action()
      if (done) message = { tone: 'ok', lines: [done] }
    } catch (e) {
      message = { tone: 'danger', lines: [e instanceof Error ? e.message : String(e)] }
    }
  }

  const reportTone = (r: ImportReport) => (r.applied.length === 0 || r.rejected.length ? 'warn' : 'ok')

  function submitName() {
    if (!mode || nameError) return
    const name = nameInput
    if (mode.kind === 'new') void run(() => session.saveAsNew(app, name), `Saved “${name.trim()}”.`)
    else if (mode.kind === 'rename') {
      const id = mode.id
      void run(() => session.rename(app, id, name))
    }
    mode = null
  }

  function applyDump() {
    const report = session.importDump(app, dump)
    message = { tone: reportTone(report), lines: [...summarize(report), ...(report.applied.length ? ['Save to keep these settings.'] : [])] }
    if (report.applied.length) showPaste = false
  }

  async function onFile(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    message = null
    try {
      const text = await file.text()
      const { report, machine } = await session.importLbdev(app, text, 0)
      const head = machine ? `Imported ${file.name} as “${machine.name}”.` : `Nothing imported from ${file.name}.`
      // A file with several devices imports the first; the report names the others.
      message = { tone: machine ? reportTone(report) : 'warn', lines: [head, ...summarize(report)] }
    } catch (err) {
      message = { tone: 'danger', lines: [err instanceof ImportError ? err.message : `Couldn’t import ${file.name}: ${String(err)}`] }
    }
  }
</script>

<section aria-labelledby="machines-title">
  <div class="row-between">
    <h2 id="machines-title">Machine</h2>
    {#if active}
      <span class="current">
        {active.name}
        {#if activeBuiltIn}<span class="tag">built-in · read-only</span>{/if}
        {#if edited}<span class="tag user">edited</span>{/if}
      </span>
    {:else}
      <span class="current muted">Unsaved machine</span>
    {/if}
  </div>
  <p class="note">
    Pick your machine from the catalog, or keep your own. The active machine is the emulated controller LightBurn reads with <code>$$</code>. Built-in
    machines can’t be changed: saving edits to one, or a <code>$x=</code> write from LightBurn, makes your own copy.
  </p>

  <div class="sub">
    <span class="section-label">Catalog</span>
    <div class="picker">
      <label
        >Frame
        <select bind:value={frameId} aria-label="Frame">
          {#each groups as g (g.brand)}
            <optgroup label={g.brand}>
              {#each g.frames as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
            </optgroup>
          {/each}
        </select>
      </label>
      <label
        >Laser module
        <select bind:value={moduleId} aria-label="Laser module">
          {#each modules as m, i (m.id)}<option value={m.id}>{m.name}{i === 0 ? ' (stock)' : ''}</option>{/each}
        </select>
      </label>
      <button class="btn primary" disabled={!preview} onclick={() => run(() => session.pickCatalog(app, frameId, moduleId), `Loaded ${preview?.name}.`)}>Load</button>
    </div>
    {#if preview}
      <div class="kv preview">
        <span>Optical power</span><span>{preview.profile.opticalPowerW} W{#if preview.fieldStatus.opticalPowerW === 'provisional'}<span class="tag prov">provisional</span>{/if}</span>
        <span>Spot (1/e²)</span><span
          >{(preview.profile.spot.sigmaXMm * 4).toFixed(3)} × {(preview.profile.spot.sigmaYMm * 4).toFixed(3)} mm{#if preview.fieldStatus.spot === 'provisional'}<span class="tag prov">provisional</span>{/if}</span
        >
        <span>Max rate</span><span>{preview.profile.maxRateMmPerMin.x} mm/min{#if preview.fieldStatus.maxRateMmPerMin === 'provisional'}<span class="tag prov">provisional</span>{/if}</span>
        <span>Acceleration</span><span>{preview.profile.accelMmPerS2.x} mm/s²{#if preview.fieldStatus.accelMmPerS2 === 'provisional'}<span class="tag prov">provisional</span>{/if}</span>
        <span>Work area</span><span>{frame.workAreaMm.x} × {frame.workAreaMm.y} mm</span>
      </div>
      {#if previewProvisional.length}
        <p class="hint">Provisional (vendor figures or assumed defaults, not measured): {previewProvisional.map((k) => FIELD_LABELS[k]).join(', ')}.</p>
      {/if}
    {/if}
  </div>

  <div class="sub">
    <span class="section-label">Machines</span>
    <ul aria-label="Machines" class="list">
      {#each [...builtIns, ...app.library.machines] as machine (machine.id)}
        {@const builtIn = isBuiltin(machine.id)}
        {@const selected = machine.id === app.library.activeId}
        <li aria-current={selected ? 'true' : undefined}>
          <span class="dot" class:on={selected} aria-hidden="true"></span>
          {#if mode?.kind === 'rename' && mode.id === machine.id}
            <form class="name-form" onsubmit={(e) => (e.preventDefault(), submitName())}>
              <!-- svelte-ignore a11y_autofocus -->
              <input autofocus aria-label="New name for {machine.name}" maxlength="80" bind:value={nameInput} aria-invalid={nameError !== null} />
              <button class="btn" type="button" onclick={() => (mode = null)}>Cancel</button>
              <button class="btn primary" type="submit" disabled={nameError !== null}>Rename</button>
            </form>
          {:else}
            <span class="name" class:sel={selected}>{machine.name}</span>
            {#if builtIn}<span class="tag">built-in</span>{/if}
            {#if mode?.kind === 'delete' && mode.id === machine.id}
              <span class="confirm">Delete {machine.name}?</span>
              <button class="btn" onclick={() => (mode = null)}>Keep</button>
              <button class="btn danger" onclick={() => (run(() => session.remove(app, machine.id)), (mode = null))}>Delete</button>
            {:else}
              <button class="btn" aria-label="Load {machine.name}" onclick={() => run(() => session.loadMachine(app, machine.id), `Loaded ${machine.name}.`)}>Load</button>
              <button class="btn" aria-label="Duplicate {machine.name}" disabled={full} onclick={() => run(() => session.duplicate(app, machine.id))}>Duplicate</button>
              {#if !builtIn}
                <button class="btn" aria-label="Rename {machine.name}" onclick={() => ((nameInput = machine.name), (mode = { kind: 'rename', id: machine.id }))}>Rename</button>
                <button class="btn" aria-label="Delete {machine.name}" onclick={() => (mode = { kind: 'delete', id: machine.id })}>Delete</button>
              {/if}
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
    {#if mode?.kind === 'rename' && nameError && nameInput.trim() !== ''}<p class="hint warn">{nameError}</p>{/if}

    {#if mode?.kind === 'new'}
      <form class="name-form" onsubmit={(e) => (e.preventDefault(), submitName())}>
        <!-- svelte-ignore a11y_autofocus -->
        <input autofocus aria-label="Machine name" placeholder="Machine name" maxlength="80" bind:value={nameInput} aria-invalid={nameError !== null && nameInput.trim() !== ''} />
        <button class="btn" type="button" onclick={() => (mode = null)}>Cancel</button>
        <button class="btn primary" type="submit" disabled={nameError !== null}>Save machine</button>
      </form>
      {#if nameError && nameInput.trim() !== ''}<p class="hint warn">{nameError}</p>{/if}
    {:else}
      <div class="row">
        <button class="btn" disabled={full} title={full ? `At most ${MAX_MACHINES} machines` : undefined} onclick={() => ((nameInput = ''), (mode = { kind: 'new' }))}>New…</button>
        <button
          class="btn"
          disabled={!active || activeBuiltIn}
          title={active && !activeBuiltIn ? undefined : 'Select one of your own machines to update it'}
          onclick={() => run(() => session.updateActive(app), `Updated ${active?.name}.`)}>{active && !activeBuiltIn ? `Update ${active.name}` : 'Update'}</button
        >
      </div>
    {/if}
  </div>

  <div class="sub">
    <span class="section-label">Import</span>
    <p class="note">
      Run <code>$$</code> on your machine and paste the output, or import a LightBurn device file (<code>.lbdev</code>; LightBurn: Devices → Export). Only the fields
      the source carries change, and the report lists everything that was ignored.
    </p>
    {#if showPaste}
      <label
        >$$ output
        <textarea rows="6" bind:value={dump} placeholder={'$11=0.010\n$30=1000\n$32=1\n$110=6000\n…'}></textarea>
      </label>
      <div class="row">
        <button class="btn primary" onclick={applyDump}>Apply</button>
        <button class="btn" onclick={() => (showPaste = false)}>Cancel</button>
      </div>
    {:else}
      <div class="row">
        <button class="btn" onclick={() => (showPaste = true)}>Paste $$ output…</button>
        <button class="btn" disabled={full} onclick={() => fileInput?.click()}>Import LightBurn device…</button>
        <input bind:this={fileInput} class="file" type="file" accept=".lbdev,.json,application/json" onchange={onFile} aria-label="LightBurn device file" />
      </div>
    {/if}
  </div>

  {#if message}
    <div class="callout {message.tone === 'ok' ? 'ok' : message.tone}" role="status">
      {#each message.lines as line (line)}<span>{line}</span>{/each}
    </div>
  {/if}
</section>

<style>
  section {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-paper);
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-sm);
    font-weight: 600;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--fg-strong);
  }
  code {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--fg-muted);
  }
  .row-between {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .current {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-ui);
    line-height: var(--leading-ui);
    color: var(--fg-strong);
    min-width: 0;
  }
  .current.muted {
    color: var(--fg-muted);
  }
  .sub {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid var(--line-subtle);
  }
  .picker {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 10px;
    align-items: end;
  }
  @media (max-width: 560px) {
    .picker {
      grid-template-columns: 1fr;
    }
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--font-condensed);
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
    color: var(--fg-muted);
  }
  select,
  textarea,
  input:not([type]) {
    background: var(--field);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 4px 8px;
    min-width: 0;
    font-size: var(--text-ui);
    line-height: var(--leading-ui);
  }
  select:focus,
  textarea:focus,
  input:not([type]):focus {
    border-color: var(--accent-border);
  }
  input[aria-invalid='true'] {
    border-color: var(--warn-border);
  }
  textarea {
    font-family: var(--font-mono);
  }
  .preview {
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
  }
  .tag {
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    border: 1px solid var(--line);
    font-family: var(--font-condensed);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .tag.prov {
    color: var(--warn-text);
    background: var(--warn-soft);
    border-color: var(--warn-border);
  }
  .tag.user {
    color: var(--accent-text);
    background: var(--accent-soft);
    border-color: var(--accent-border);
  }
  .hint {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    color: var(--fg-faint);
  }
  .hint.warn {
    color: var(--warn-text);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--line-subtle);
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--line-subtle);
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
  }
  .dot {
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    border-radius: 50%;
  }
  .dot.on {
    background: var(--accent-ring);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
  }
  .name.sel {
    color: var(--fg-strong);
    font-weight: 600;
  }
  .confirm {
    color: var(--danger-text);
  }
  .btn.danger {
    background: var(--danger);
    border-color: var(--danger);
    color: var(--on-accent);
  }
  .btn.danger:hover {
    background: var(--danger-hover);
  }
  .name-form {
    display: flex;
    flex: 1;
    gap: 8px;
    align-items: center;
  }
  .name-form input {
    flex: 1;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .file {
    display: none;
  }
  .callout.ok {
    border-color: var(--ok-border);
    background: var(--ok-soft);
    color: var(--fg);
  }
</style>
