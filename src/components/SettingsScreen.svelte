<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import ariaLogo from '@aria/theme/aria-logo.svg'
  import { app } from '../lib/app.svelte.ts'
  import { describeConnection } from '../lib/emulator.ts'
  import { TILE_MAX_CELLS, gridPitchMm } from 'aria-burn-core/contract'
  import type { ProfileField } from 'aria-burn-core/contract'
  import { calibration } from '../lib/calibration.svelte.ts'
  import { activeMachine, applyScanOffset, liveStatus, saveSettingsScreen } from '../lib/machine-session.ts'
  import { describeReading, readingsForProfile, scanOffsetFromReadings } from '../lib/machine-readings.ts'
  import { isBuiltin } from '../lib/machines.ts'
  import { machineProblems } from '../lib/settings.ts'
  import MachinesSection from './MachinesSection.svelte'

  const m = $derived(app.settings.machine)
  const net = $derived(app.settings.network)

  let saved = $state(false)
  let saveError = $state<string | null>(null)
  let savedAs = $state<string | null>(null)
  // Provisional values (catalog vendor figures, or assumed defaults) are marked on their fields.
  const status = $derived(liveStatus(app))
  const provisional = (f: ProfileField) => status[f] === 'provisional'

  const problems = $derived(machineProblems(m))
  const host = $derived(net.bindMode === 'localhost' ? '127.0.0.1' : '<this machine’s LAN IP>')
  const pitchMm = $derived(gridPitchMm(m.spot))
  // One tile covers TILE_MAX_CELLS cells per side at the grid pitch (COD-252).
  const tileMm = $derived(TILE_MAX_CELLS * pitchMm)

  const num = (e: Event & { currentTarget: HTMLInputElement }) => Number(e.currentTarget.value)
  // Spot size as the 1/e² diameter a datasheet gives; the profile stores σ = d / 4.
  const diameter = (sigma: number) => +(sigma * 4).toFixed(4)
  const sigma = (e: Event & { currentTarget: HTMLInputElement }) => num(e) / 4

  async function save() {
    saveError = null
    try {
      // A built-in is never changed: edits to one are saved as a copy of your own.
      const copy = await saveSettingsScreen(app)
      savedAs = copy?.name ?? null
      // Restarts the emulator if the address changed; pacing and profile apply in place.
      await app.applyEmulator()
      saved = true
      setTimeout(() => (saved = false), savedAs ? 4000 : 1500)
    } catch (e) {
      saveError = String(e)
    }
  }

  // Scan offset (BURN-48): saved readings are applied to the machine only when the user says so.
  const scanReadings = $derived(readingsForProfile(calibration.readings, 'scan-offset', m))
  const fromReadings = $derived(scanOffsetFromReadings(scanReadings))
  const applied = $derived(m.scanOffsetMm ?? [])
  const readingsApplied = $derived(fromReadings.length > 0 && JSON.stringify(fromReadings) === JSON.stringify(applied))
  const target = $derived(activeMachine(app))
  let scanNote = $state<{ tone: 'ok' | 'danger'; text: string } | null>(null)

  async function applyScan(curve: typeof applied, done: string) {
    scanNote = null
    try {
      // Applying the readings keeps them with the machine (a built-in's copy, if one is made).
      const copy = curve.length ? await calibration.applyScanOffsetReadings(scanReadings, curve) : await applyScanOffset(app, curve)
      scanNote = { tone: 'ok', text: copy ? `${done} Saved as “${copy.name}” (built-ins are read-only).` : done }
    } catch (e) {
      scanNote = { tone: 'danger', text: e instanceof Error ? e.message : String(e) }
    }
  }

  const axes = [
    { label: 'Max rate (mm/min)', codes: '$110 / $111', key: 'maxRateMmPerMin' },
    { label: 'Acceleration (mm/s²)', codes: '$120 / $121', key: 'accelMmPerS2' },
    { label: 'Travel (mm)', codes: '$130 / $131', key: 'travelMm' },
  ] as const
</script>

{#snippet prov(field: ProfileField)}
  {#if provisional(field)}<span class="tag prov" title="Provisional: a vendor figure or an assumed default, not measured">provisional</span>{/if}
{/snippet}

<div class="screen">
  <header>
    <div class="brand">
      <img class="logo" src={ariaLogo} alt="" width="28" height="28" draggable="false" />
      <span>Aria Burn</span>
      <span class="crumb">/ Connection, laser &amp; machine</span>
    </div>
    <button class="btn" onclick={() => (app.screen = 'main')}>← Back to simulator</button>
  </header>

  <div class="scroll">
    <div class="col">
      <section>
        <div class="row-between">
          <h2>Network emulator</h2>
          <span class="pill" class:on={app.connection.state === 'listening' || app.connection.state === 'connected'} class:bad={app.connection.state === 'failed'}>{describeConnection(app.connection)}</span>
        </div>
        <p class="note">GRBL over TCP. In LightBurn or LaserGRBL, add a GRBL device with a Network connection pointed at the address below. Changes apply when you save.</p>
        <label class="check">
          <input type="checkbox" bind:checked={net.listening} />
          Listen for senders
        </label>
        <div class="grid">
          <label>Bind address
            <select bind:value={net.bindMode}>
              <option value="localhost">Localhost only (127.0.0.1)</option>
              <option value="lan">All interfaces (visible on LAN)</option>
            </select>
          </label>
          <label>Port
            <input type="number" min="1" max="65535" value={net.port} onchange={(e) => (net.port = num(e))} />
          </label>
          <label>Response pacing
            <select bind:value={net.pacing}>
              <option value="realtime">Real time (matches the machine)</option>
              <option value="instant">Instant (fastest preview)</option>
            </select>
          </label>
          <div class="field">
            <span>Device address for LightBurn</span>
            <code>{host}:{net.port}</code>
          </div>
        </div>
        {#if net.bindMode === 'lan'}
          <div class="callout warn">Anyone on your network can connect and stream jobs to the emulator. There is no authentication, so use this only on a network you trust.</div>
        {/if}
      </section>

      <MachinesSection />

      <section>
        <h2>Laser</h2>
        <p class="note">Turns S values into absolute energy. Without optical watts the simulator can’t compute fluence.</p>
        <div class="grid">
          <label>Optical power (W) {@render prov('opticalPowerW')}
            <input type="number" min="0.5" step="0.5" value={m.opticalPowerW} onchange={(e) => (m.opticalPowerW = num(e))} />
            <span class="hint">Output power, not the module’s electrical rating.</span>
          </label>
          <label>Max S value <code>$30</code> {@render prov('sMax')}
            <input type="number" min="1" value={m.sMax} onchange={(e) => (m.sMax = num(e))} />
          </label>
          <label>Spot width × height (mm) {@render prov('spot')}
            <span class="pair">
              <input type="number" min="0.004" step="0.001" value={diameter(m.spot.sigmaXMm)} onchange={(e) => (m.spot.sigmaXMm = sigma(e))} aria-label="Spot width, long axis, 1/e² diameter (mm)" />
              <span aria-hidden="true">×</span>
              <input type="number" min="0.004" step="0.001" value={diameter(m.spot.sigmaYMm)} onchange={(e) => (m.spot.sigmaYMm = sigma(e))} aria-label="Spot height, short axis, 1/e² diameter (mm)" />
            </span>
            <span class="hint">1/e² diameters; width is the long axis. Gaussian σ {m.spot.sigmaXMm.toFixed(4)} × {m.spot.sigmaYMm.toFixed(4)} mm.</span>
          </label>
          <label>Spot orientation (°) {@render prov('spot')}
            <input type="number" min="-180" max="180" value={m.spot.angleDeg} onchange={(e) => (m.spot.angleDeg = num(e))} />
            <span class="hint">Angle of the long axis from machine +X, counter-clockwise.</span>
          </label>
        </div>
        <label class="check">
          <input type="checkbox" bind:checked={m.laserMode} />
          Laser mode <code>$32=1</code>
        </label>
        {#if !m.laserMode}
          <div class="callout warn">With laser mode off, GRBL pauses at every power change and M4 doesn’t scale power with speed. Raster jobs will scorch heavily.</div>
        {/if}
      </section>

      <section>
        <h2>Motion</h2>
        <p class="note">Fed to the emulator's GRBL planner, so corners, starts and raster-line ends slow down (and scorch) exactly as on the machine.</p>
        <div class="grid">
          {#each axes as a (a.key)}
            <div class="field">
              <span>{a.label} <code>{a.codes}</code> {@render prov(a.key)}</span>
              <span class="pair">
                <label>X <input type="number" min="1" value={m[a.key].x} onchange={(e) => (m[a.key].x = num(e))} /></label>
                <label>Y <input type="number" min="1" value={m[a.key].y} onchange={(e) => (m[a.key].y = num(e))} /></label>
              </span>
            </div>
          {/each}
          <label>Junction deviation (mm) <code>$11</code> {@render prov('junctionDeviationMm')}
            <input type="number" min="0.001" step="0.001" value={m.junctionDeviationMm} onchange={(e) => (m.junctionDeviationMm = num(e))} />
          </label>
        </div>
        <p class="note">Detail pitch {pitchMm.toFixed(4)} mm (spot σ ÷ 3), used when zoomed in and for the hover readout. On GPUs that can't render a large job at this pitch quickly (integrated Intel graphics), the full-job overview uses a whole multiple of it. Tiling follows each job’s burn area, not the bed: up to {TILE_MAX_CELLS} × {TILE_MAX_CELLS} cells (about {tileMm.toFixed(0)} × {tileMm.toFixed(0)} mm at the detail pitch) renders as one tile; larger jobs are split into tiles.</p>
      </section>

      <section aria-labelledby="scan-offset-title">
        <div class="row-between">
          <h2 id="scan-offset-title">Scan offset</h2>
          <span>{@render prov('scanOffsetMm')}{#if status.scanOffsetMm === 'user'}<span class="tag measured">from readings</span>{/if}</span>
        </div>
        <p class="note">
          On bidirectional fills, lines scanned right to left land a little apart from lines scanned left to right, more so at speed. The simulator shifts
          each right-to-left (−X) scan line by the offset at its feed: linear between the feeds below, from 0 at a standstill, flat above the fastest.
          Positive means those lines land further left.
        </p>
        <div class="field">
          <span>Applied to this machine</span>
          {#if applied.length}
            <table class="offsets">
              <thead><tr><th scope="col">Feed (mm/min)</th><th scope="col">Offset (mm)</th></tr></thead>
              <tbody>
                {#each applied as p (p.feedMmPerMin)}<tr><td>{p.feedMmPerMin}</td><td>{p.offsetMm > 0 ? '+' : ''}{p.offsetMm}</td></tr>{/each}
              </tbody>
            </table>
          {:else}
            <span class="value">None: reverse lines land where they are programmed.</span>
          {/if}
        </div>
        {#if scanReadings.length}
          <div class="field">
            <span>Saved readings{readingsApplied ? ' (applied)' : ' (not applied)'}</span>
            <ul class="readings">
              {#each scanReadings as r (r.id)}<li>{describeReading(r)}</li>{/each}
            </ul>
          </div>
        {:else}
          <p class="hint">No saved scan offset readings for this machine. Burn the Scan offset test pattern, measure each strip, and enter it on the pick card.</p>
        {/if}
        <div class="actions">
          {#if scanReadings.length}
            <button class="btn primary" disabled={readingsApplied || problems.length > 0} onclick={() => applyScan(fromReadings, `Applied ${fromReadings.length} reading${fromReadings.length === 1 ? '' : 's'}.`)}>
              {readingsApplied ? 'Applied to' : `Apply ${fromReadings.length} reading${fromReadings.length === 1 ? '' : 's'} to`} {target?.name ?? 'this machine'}
            </button>
          {/if}
          {#if applied.length}
            <button class="btn" disabled={problems.length > 0} onclick={() => applyScan([], 'Scan offset cleared.')}>Clear offset</button>
          {/if}
        </div>
        {#if target && isBuiltin(target.id) && scanReadings.length && !readingsApplied}
          <p class="hint">{target.name} is built in, so applying saves your own copy of it, with any other edits on this screen.</p>
        {:else if scanReadings.length && !readingsApplied}
          <p class="hint">Applying saves the machine, with any other edits on this screen.</p>
        {/if}
        {#if scanNote}<div class="callout" class:danger={scanNote.tone === 'danger'} role="status">{scanNote.text}</div>{/if}
      </section>

      <section>
        <h2>GRBL settings</h2>
        <p class="note">The machine is the emulated controller’s <code>$11</code>, <code>$30</code>, <code>$32</code> and <code>$110</code>–<code>$131</code>: LightBurn reads them with <code>$$</code>, and writes from its machine settings change your machine (a built-in one is copied first). To match your machine, import its <code>$$</code> output under Machine above.</p>
      </section>

      {#if problems.length}
        <div class="callout danger">
          <strong>Machine profile can’t be saved</strong>
          {#each problems as p (p)}<span>{p}</span>{/each}
        </div>
      {/if}
      {#if saveError}<div class="callout danger">{saveError}</div>{/if}

      <div class="footer">
        {#if saved}<span class="saved" role="status">{savedAs ? `Saved as “${savedAs}” (built-ins are read-only)` : 'Saved'}</span>{/if}
        <button class="btn primary" disabled={problems.length > 0} onclick={save}>Save</button>
      </div>
    </div>
  </div>
</div>

<style>
  .screen {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  header {
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--bed);
    border-bottom: 1px solid var(--line-subtle);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-sm);
    line-height: var(--leading-sm);
    font-weight: 600;
    color: var(--fg-strong);
  }
  .crumb {
    color: var(--fg-muted);
    font-weight: 400;
  }
  .logo {
    display: block;
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
  }
  .scroll {
    flex: 1 1 auto;
    overflow-y: auto;
  }
  .col {
    max-width: 760px;
    margin: 0 auto;
    padding: 24px 20px 48px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
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
  .note {
    margin: 0;
  }
  .row-between {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .pill {
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--fg-muted);
  }
  .pill.on {
    color: var(--ok-text);
    background: var(--ok-soft);
    border-color: var(--ok-border);
  }
  .pill.bad {
    color: var(--danger-text);
    background: var(--danger-soft);
    border-color: var(--danger-border);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px 18px;
  }
  label,
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--font-condensed);
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
    color: var(--fg-muted);
  }
  .check {
    gap: 6px;
    font-size: var(--text-ui);
    color: var(--fg);
    flex-direction: row;
    align-items: center;
  }
  input[type='number'],
  select {
    background: var(--field);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 4px 8px;
    min-width: 0;
    font-size: var(--text-ui);
    line-height: var(--leading-ui);
  }
  input[type='number'] {
    font-family: var(--font-mono);
  }
  input[type='number']:focus,
  select:focus {
    border-color: var(--accent-border);
  }
  .pair {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pair label {
    flex-direction: row;
    align-items: center;
    flex: 1;
  }
  .pair input {
    flex: 1;
    width: 0;
  }
  .hint {
    font-family: var(--font-sans);
    color: var(--fg-faint);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
  }
  code {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--fg-muted);
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 12px;
  }
  .saved {
    color: var(--ok-text);
  }
  .tag.prov {
    align-self: flex-start;
    padding: 0 6px;
    border-radius: 999px;
    border: 1px solid var(--warn-border);
    background: var(--warn-soft);
    color: var(--warn-text);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    white-space: nowrap;
  }
  .tag.measured {
    display: inline-block;
    margin-left: 4px;
    padding: 0 6px;
    border-radius: 999px;
    border: 1px solid var(--accent-border);
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-2xs);
    line-height: var(--leading-2xs);
    white-space: nowrap;
  }
  .offsets {
    align-self: flex-start;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--leading-xs);
    color: var(--fg);
  }
  .offsets th {
    font-family: var(--font-condensed);
    font-weight: normal;
    color: var(--fg-muted);
    text-align: right;
    padding: 2px 12px 2px 0;
    border-bottom: 1px solid var(--line-subtle);
  }
  .offsets td {
    text-align: right;
    padding: 2px 12px 2px 0;
  }
  .value {
    font-family: var(--font-sans);
    font-size: var(--text-ui);
    line-height: var(--leading-ui);
    color: var(--fg);
  }
  .readings {
    margin: 0;
    padding-left: 16px;
    font-family: var(--font-sans);
    font-size: var(--text-ui);
    line-height: var(--leading-ui);
    color: var(--fg);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  label .tag.prov {
    display: inline-block;
    margin-left: 4px;
  }
</style>
