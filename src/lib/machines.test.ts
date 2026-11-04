// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOG_FRAMES, CATALOG_MODULES } from 'aria-burn-core/profiles/catalog/index.ts'
import { emulatorSettings } from './emulator.ts'
import * as session from './machine-session.ts'
import {
  BUILTIN_DEFAULT_ID,
  LibraryError,
  MAX_MACHINES,
  builtinMachine,
  catalogMachineId,
  commitLive,
  createMachine,
  emptyLibrary,
  isBuiltin,
  modulesForFrame,
  readLibrary,
  type MachineLibrary,
} from './machines.ts'
import { defaultSettings, machineProblems, useBackend, type Backend, type Settings } from './settings.ts'

const S30 = catalogMachineId('sculpfun-s30', 'sculpfun-s30-pro-10w')
const FALCON = catalogMachineId('creality-falcon2', 'creality-falcon2-40w')

/** The store file, kept across “restarts” (new hosts). */
function memoryStore(): Backend & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    read: async (key) => (data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : undefined),
    write: async (key, value) => void data.set(key, JSON.parse(JSON.stringify(value))),
  }
}

/** A fresh app over the store: what `app.load()` does at startup. */
async function startApp() {
  const host = {
    settings: defaultSettings() as Settings,
    library: emptyLibrary() as MachineLibrary,
    warnings: [] as string[],
    emulated: [] as ReturnType<typeof emulatorSettings>[],
    async applyEmulator() {
      this.emulated.push(emulatorSettings(this.settings.network, this.settings.machine))
    },
  }
  await session.loadMachines(host)
  return host
}

let store: ReturnType<typeof memoryStore>
beforeEach(() => {
  store = memoryStore()
  useBackend(store)
})
afterEach(() => useBackend(null))

describe('catalog built-ins', () => {
  it('offers every frame with only the modules it lists, each a valid profile', () => {
    for (const frame of CATALOG_FRAMES) {
      expect(modulesForFrame(frame).map((m) => m.id)).toEqual(frame.modules)
      for (const id of frame.modules) {
        const m = builtinMachine(catalogMachineId(frame.id, id))!
        expect(machineProblems(m.profile)).toEqual([])
        expect(m.profile.frameId).toBe(frame.id)
      }
    }
    const foreign = CATALOG_MODULES.find((m) => !CATALOG_FRAMES[0]!.modules.includes(m.id))!
    expect(builtinMachine(catalogMachineId(CATALOG_FRAMES[0]!.id, foreign.id))).toBeNull()
  })

  it('carries each field’s catalog status', () => {
    const m = builtinMachine(S30)!
    expect(m.fieldStatus.spot).toBe('provisional')
    expect(m.fieldStatus.maxRateMmPerMin).toBe('sourced')
    expect(builtinMachine(BUILTIN_DEFAULT_ID)!.fieldStatus.accelMmPerS2).toBe('provisional')
  })
})

describe('library', () => {
  it('names must be non-empty and unique; at most MAX_MACHINES', () => {
    const p = builtinMachine(S30)!
    let lib = createMachine(emptyLibrary(), 'Mine', p.profile, p.fieldStatus).library
    expect(() => createMachine(lib, ' Mine ', p.profile, {})).toThrow('A machine already has that name.')
    expect(() => createMachine(lib, '  ', p.profile, {})).toThrow('Enter a name.')
    for (let i = 1; i < MAX_MACHINES; i++) lib = createMachine(lib, `M${i}`, p.profile, {}).library
    expect(() => createMachine(lib, 'one more', p.profile, {})).toThrow(LibraryError)
  })

  it('never changes a built-in: an edit is committed as a copy', () => {
    const lib: MachineLibrary = { activeId: S30, machines: [] }
    const live = structuredClone(builtinMachine(S30)!.profile)
    expect(commitLive(lib, live, {}).copied).toBeNull()
    live.accelMmPerS2.x = 2500
    const { library, copied } = commitLive(lib, live, {})
    expect(copied!.name).toBe('Sculpfun S30 / S30 Pro + S30 Pro 10 W copy')
    expect(library.activeId).toBe(copied!.id)
    expect(copied!.profile.accelMmPerS2.x).toBe(2500)
    expect(builtinMachine(S30)!.profile.accelMmPerS2.x).toBe(1000)
  })

  it('drops invalid stored entries and says so', () => {
    const good = builtinMachine(S30)!
    const { library, warnings } = readLibrary(
      {
        activeId: 'gone',
        machines: [
          { id: 'a', name: 'Good', profile: good.profile, fieldStatus: { spot: 'provisional', sMax: 'nonsense' } },
          { id: 'b', name: 'Good', profile: good.profile },
          { id: S30, name: 'Sneaky', profile: good.profile },
          { id: 'c', name: 'Broken', profile: { ...good.profile, opticalPowerW: -1 } },
        ],
      },
      machineProblems,
    )
    expect(library.machines.map((m) => m.name)).toEqual(['Good'])
    expect(library.machines[0]!.fieldStatus).toEqual({ spot: 'provisional' })
    expect(library.activeId).toBeNull()
    expect(warnings).toHaveLength(3)
  })
})

describe('machine session', () => {
  it('a user machine survives a restart', async () => {
    let app = await startApp()
    await session.pickCatalog(app, 'creality-falcon2', 'creality-falcon2-40w')
    app.settings.machine.accelMmPerS2 = { x: 3000, y: 2800 }
    const copy = await session.saveSettingsScreen(app)
    expect(copy!.name).toBe('Creality Falcon2 + Falcon2 40 W copy')
    await session.rename(app, copy!.id, 'Garage Falcon')
    const dup = await session.duplicate(app, copy!.id)
    await session.remove(app, dup.id)
    await session.loadMachine(app, copy!.id)

    app = await startApp()
    expect(app.warnings).toEqual([])
    expect(app.library.machines.map((m) => m.name)).toEqual(['Garage Falcon'])
    expect(app.library.activeId).toBe(copy!.id)
    expect(session.activeMachine(app)!.profile.accelMmPerS2).toEqual({ x: 3000, y: 2800 })
    expect(app.settings.machine.name).toBe('Garage Falcon')
    expect(app.settings.machine.accelMmPerS2).toEqual({ x: 3000, y: 2800 })
    // Edited fields are the user's; the rest keep the catalog status.
    expect(app.settings.machineStatus.accelMmPerS2).toBe('user')
    expect(app.settings.machineStatus.spot).toBe('provisional')
  })

  it('the active machine sets the emulated $ values', async () => {
    const app = await startApp()
    await session.pickCatalog(app, 'creality-falcon2', 'creality-falcon2-40w')
    const sent = app.emulated.at(-1)!.profile
    expect(sent).toEqual(builtinMachine(FALCON)!.profile)
    expect(sent.maxRateMmPerMin).not.toEqual(builtinMachine(BUILTIN_DEFAULT_ID)!.profile.maxRateMmPerMin)
  })

  it('a $x= write from the sender goes into a copy of a built-in, then into that copy', async () => {
    const app = await startApp()
    await session.pickCatalog(app, 'sculpfun-s30', 'sculpfun-s30-pro-10w')
    const written = { ...structuredClone(app.settings.machine), accelMmPerS2: { x: 2000, y: 1000 } }
    const copy = await session.senderWrote(app, written)
    expect(copy).not.toBeNull()
    expect(app.library.activeId).toBe(copy!.id)
    expect(isBuiltin(app.library.activeId)).toBe(false)
    expect(builtinMachine(S30)!.profile.accelMmPerS2.x).toBe(1000)
    expect(app.settings.machineStatus.accelMmPerS2).toBe('user')
    expect(app.warnings.at(-1)).toMatch(/saved them as/)
    // The emulator now runs the copy (same values, its name).
    expect(app.emulated.at(-1)!.profile.name).toBe(copy!.name)

    const again = await session.senderWrote(app, { ...structuredClone(app.settings.machine), junctionDeviationMm: 0.02 })
    expect(again).toBeNull()
    expect(app.library.machines).toHaveLength(1)
    expect(session.activeMachine(app)!.profile.junctionDeviationMm).toBe(0.02)

    const restarted = await startApp()
    expect(session.activeMachine(restarted)!.profile).toMatchObject({ junctionDeviationMm: 0.02, accelMmPerS2: { x: 2000, y: 1000 } })
  })

  it('ignores an invalid write from the sender', async () => {
    const app = await startApp()
    const bad = { ...structuredClone(app.settings.machine), sMax: -1 }
    expect(await session.senderWrote(app, bad)).toBeNull()
    expect(app.settings.machine.sMax).toBe(defaultSettings().machine.sMax)
    expect(app.warnings[0]).toMatch(/Ignored \$ settings/)
  })

  it('imports a .lbdev as a new machine named after the device', async () => {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync(new URL('./fixtures/workshop-diode.lbdev', import.meta.url), 'utf8')
    const app = await startApp()
    await session.pickCatalog(app, 'sculpfun-s30', 'sculpfun-s30-pro-10w')
    const { report, machine } = await session.importLbdev(app, text)
    expect(machine!.name).toBe('Workshop Diode 400')
    expect(report.ignored.length).toBeGreaterThan(0)
    expect(app.library.activeId).toBe(machine!.id)
    // Spot and power come from the machine it was imported over; the bed from the file.
    expect(app.settings.machine.spot).toEqual(builtinMachine(S30)!.profile.spot)
    expect(app.settings.machine.travelMm).toEqual({ x: 400, y: 380 })
    expect(app.settings.machineStatus).toMatchObject({ travelMm: 'user', spot: 'provisional' })
    expect(app.emulated.at(-1)!.profile.travelMm).toEqual({ x: 400, y: 380 })
  })

  it('a $$ paste marks what it changed and is kept on save', async () => {
    const app = await startApp()
    const report = session.importDump(app, '$120=1800\n$121=1700\n$0=10')
    expect(report.ignored).toEqual(['$0=10: the simulator has no $0'])
    const copy = await session.saveSettingsScreen(app)
    expect(copy!.profile.accelMmPerS2).toEqual({ x: 1800, y: 1700 })
    expect(app.settings.machineStatus.accelMmPerS2).toBe('user')
  })

  it('a customised profile from before the library becomes “My machine”', async () => {
    const s = defaultSettings()
    s.machine.opticalPowerW = 7
    store.data.set('settings', s)
    const app = await startApp()
    expect(app.library.machines.map((m) => m.name)).toEqual([session.MIGRATED_MACHINE_NAME])
    expect(app.library.activeId).toBe(app.library.machines[0]!.id)
    expect((await startApp()).library.machines).toHaveLength(1)
  })
})
