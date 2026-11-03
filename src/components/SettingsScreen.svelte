<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { app } from '../lib/app.svelte.ts'
  import { describeConnection } from '../lib/emulator.ts'
  import { TILE_MAX_CELLS, gridPitchMm } from 'aria-burn-core/contract'
  import { applySettingsDump, machineProblems } from '../lib/settings.ts'

  const m = $derived(app.settings.machine)
  const net = $derived(app.settings.network)

  let saved = $state(false)
  let saveError = $state<string | null>(null)
  let showPaste = $state(false)
  let dump = $state('')
  let dumpResult = $state('')

  const problems = $derived(machineProblems(m))
  const host = $derived(net.bindMode === 'localhost' ? '127.0.0.1' : '<this machine’s LAN IP>')
  const pitchMm = $derived(gridPitchMm(m.spot))
  // One tile covers TILE_MAX_CELLS cells per side at the grid pitch (COD-252).
  const tileMm = $derived(TILE_MAX_CELLS * pitchMm)

  const num = (e: Event & { currentTarget: HTMLInputElement }) => Number(e.currentTarget.value)
  // Spot size as the 1/e² diameter a datasheet gives; the profile stores σ = d / 4.
  const diameter = (sigma: number) => +(sigma * 4).toFixed(4)
  const sigma = (e: Event & { currentTarget: HTMLInputElement }) => num(e) / 4

  function applyDump() {
    const { applied, rejected } = applySettingsDump(m, dump)
    const parts = [applied.length ? `Applied ${applied.join(', ')}.` : 'No profile settings found.']
    if (rejected.length) parts.push(`Skipped ${rejected.join('; ')}.`)
    dumpResult = parts.join(' ')
    showPaste = applied.length === 0
  }

  async function save() {
    saveError = null
    try {
      await app.save()
      // Restarts the emulator if the address changed; pacing and profile apply in place.
      await app.applyEmulator()
      saved = true
      setTimeout(() => (saved = false), 1500)
    } catch (e) {
      saveError = String(e)
    }
  }

  const axes = [
    { label: 'Max rate (mm/min)', codes: '$110 / $111', key: 'maxRateMmPerMin' },
    { label: 'Acceleration (mm/s²)', codes: '$120 / $121', key: 'accelMmPerS2' },
    { label: 'Travel (mm)', codes: '$130 / $131', key: 'travelMm' },
  ] as const
</script>

<div class="screen">
  <header>
    <div class="brand">
      <div class="logo" aria-hidden="true"></div>
      <span>LaserSim</span>
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

      <section>
        <h2>Laser</h2>
        <p class="note">Turns S values into absolute energy. Without optical watts the simulator can’t compute fluence.</p>
        <div class="grid">
          <label>Optical power (W)
            <input type="number" min="0.5" step="0.5" value={m.opticalPowerW} onchange={(e) => (m.opticalPowerW = num(e))} />
            <span class="hint">Output power, not the module’s electrical rating.</span>
          </label>
          <label>Max S value <code>$30</code>
            <input type="number" min="1" value={m.sMax} onchange={(e) => (m.sMax = num(e))} />
          </label>
          <label>Spot width × height (mm)
            <span class="pair">
              <input type="number" min="0.004" step="0.001" value={diameter(m.spot.sigmaXMm)} onchange={(e) => (m.spot.sigmaXMm = sigma(e))} aria-label="Spot width, long axis, 1/e² diameter (mm)" />
              <span aria-hidden="true">×</span>
              <input type="number" min="0.004" step="0.001" value={diameter(m.spot.sigmaYMm)} onchange={(e) => (m.spot.sigmaYMm = sigma(e))} aria-label="Spot height, short axis, 1/e² diameter (mm)" />
            </span>
            <span class="hint">1/e² diameters; width is the long axis. Gaussian σ {m.spot.sigmaXMm.toFixed(4)} × {m.spot.sigmaYMm.toFixed(4)} mm.</span>
          </label>
          <label>Spot orientation (°)
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
              <span>{a.label} <code>{a.codes}</code></span>
              <span class="pair">
                <label>X <input type="number" min="1" value={m[a.key].x} onchange={(e) => (m[a.key].x = num(e))} /></label>
                <label>Y <input type="number" min="1" value={m[a.key].y} onchange={(e) => (m[a.key].y = num(e))} /></label>
              </span>
            </div>
          {/each}
          <label>Junction deviation (mm) <code>$11</code>
            <input type="number" min="0.001" step="0.001" value={m.junctionDeviationMm} onchange={(e) => (m.junctionDeviationMm = num(e))} />
          </label>
        </div>
        <p class="note">Grid pitch {pitchMm.toFixed(4)} mm (spot σ ÷ 3). Tiling follows each job’s burn area, not the bed: up to {TILE_MAX_CELLS} × {TILE_MAX_CELLS} cells (about {tileMm.toFixed(0)} × {tileMm.toFixed(0)} mm at this pitch) renders as one tile; larger jobs are split into tiles.</p>
      </section>

      <section>
        <h2>GRBL settings</h2>
        <p class="note">The profile is the emulated controller’s <code>$11</code>, <code>$30</code>, <code>$32</code> and <code>$110</code>–<code>$131</code>: LightBurn reads them with <code>$$</code>, and writes from its machine settings change them here. To match your machine, run <code>$$</code> on it and paste the output.</p>
        {#if showPaste}
          <label>$$ output
            <textarea rows="6" bind:value={dump} placeholder={'$11=0.010\n$30=1000\n$32=1\n$110=6000\n…'}></textarea>
          </label>
          <div class="row">
            <button class="btn primary" onclick={applyDump}>Apply</button>
            <button class="btn" onclick={() => (showPaste = false)}>Cancel</button>
            <span class="note">{dumpResult}</span>
          </div>
        {:else}
          <div class="row">
            <button class="btn" onclick={() => (showPaste = true)}>Paste $$ output…</button>
            <span class="note">{dumpResult}</span>
          </div>
        {/if}
      </section>

      {#if problems.length}
        <div class="callout danger">
          <strong>Machine profile can’t be saved</strong>
          {#each problems as p (p)}<span>{p}</span>{/each}
        </div>
      {/if}
      {#if saveError}<div class="callout danger">{saveError}</div>{/if}

      <div class="footer">
        {#if saved}<span class="saved" role="status">Saved</span>{/if}
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
    min-height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 20px;
    border-bottom: 1px solid var(--line-subtle);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--text-md);
    font-weight: 600;
  }
  .crumb {
    color: var(--fg-muted);
    font-weight: 400;
  }
  .logo {
    width: 22px;
    height: 22px;
    border-radius: 5px;
    background: linear-gradient(135deg, var(--accent), var(--accent-deep));
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
    border-radius: 12px;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: var(--text-md);
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
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--fg-muted);
  }
  .pill.on {
    color: var(--ok);
    border-color: var(--ok);
  }
  .pill.bad {
    color: var(--danger-text);
    border-color: var(--danger-text);
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
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--fg);
  }
  .check {
    flex-direction: row;
    align-items: center;
  }
  input[type='number'],
  select,
  textarea {
    background: var(--bed);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 7px 9px;
    min-width: 0;
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
    color: var(--fg-faint);
    font-size: var(--text-2xs);
  }
  code {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--fg-muted);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 12px;
  }
  .saved {
    color: var(--ok);
  }
</style>
