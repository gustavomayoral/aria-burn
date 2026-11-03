// SPDX-License-Identifier: GPL-3.0-or-later
// App-wide state: settings, which screen is showing, and the GRBL network
// emulator's connection. Jobs (files and live) and the burn they make live in
// the burn engine (burn.svelte.ts).

import type { ChannelEvent, MachineProfile } from 'aria-burn-core/contract'
import { burn } from './burn.svelte.ts'
import { configureEmulator, emulatorSettings, subscribeEmulator, type ConnectionStatus } from './emulator.ts'
import { isTauri } from './ipc.ts'
import { defaultSettings, loadSettings, machineProblems, saveSettings, type Settings } from './settings.ts'

export type Screen = 'main' | 'settings'
export type JobSource = 'file' | 'live'

type EventOf<T extends ChannelEvent['event']['type']> = Extract<ChannelEvent['event'], { type: T }>
export type MachineStatus = EventOf<'machine.status'>

class AppState {
  settings = $state<Settings>(defaultSettings())
  screen = $state<Screen>('main')
  loaded = $state(false)
  warnings = $state<string[]>([])
  source = $state<JobSource>('file')
  connection = $state<ConnectionStatus>({ state: 'stopped' })
  machine = $state<MachineStatus | null>(null)
  /** Channel problems on the live stream (dropped events). */
  liveErrors = $state<string[]>([])
  private nextEventSeq = 0

  async load() {
    const { settings, warnings } = await loadSettings()
    this.settings = settings
    this.warnings = warnings
    this.loaded = true
  }

  /** Persists the current settings; throws if the machine profile is invalid. */
  save = () => saveSettings(this.settings)

  /** UI preferences save as they change, no Save button needed. */
  async savePrefs() {
    try {
      await saveSettings(this.settings)
    } catch {
      // An invalid machine profile blocks saving; the settings screen reports it.
    }
  }

  /** Opens the emulator's Channels and applies the network settings. */
  async startEmulator() {
    if (!isTauri()) return
    await subscribeEmulator({
      event: (msg) => this.onLiveEvent(msg),
      batch: (buf) => this.onLiveBatch(buf),
      status: (status) => (this.connection = status),
      profile: (profile) => this.onEmulatorProfile(profile),
    })
    await this.applyEmulator()
  }

  /** Starts, restarts or stops the emulator to match the settings. */
  async applyEmulator() {
    if (!isTauri()) return
    try {
      this.connection = await configureEmulator(emulatorSettings(this.settings.network, this.settings.machine))
    } catch (e) {
      this.connection = { state: 'failed', address: `port ${this.settings.network.port}`, message: String(e) }
    }
  }

  /** A sender wrote `$` settings the profile holds (`$11`, `$110`…): keep and save them. */
  private onEmulatorProfile(profile: MachineProfile) {
    const problems = machineProblems(profile)
    if (problems.length) {
      this.warnings = [...this.warnings, `Ignored $ settings from the sender: ${problems[0]}`]
      return
    }
    this.settings.machine = profile
    void this.savePrefs()
  }

  private onLiveEvent(msg: ChannelEvent) {
    // Events and batches travel on separate Channels, so either can come first.
    if (msg.seq !== this.nextEventSeq && msg.event.type !== 'hello')
      this.liveErrors = [...this.liveErrors.slice(-4), `event seq ${msg.seq}, expected ${this.nextEventSeq}`]
    this.nextEventSeq = msg.seq + 1
    const e = msg.event
    if (e.type === 'machine.status') {
      this.machine = e
      return
    }
    if (e.type === 'job.streaming') {
      // A sender started a job: show it, whatever was open before.
      this.source = 'live'
      this.liveErrors = []
    }
    if (e.type === 'error' && e.jobId === null) this.warnings = [...this.warnings, e.message]
    burn.liveEvent(msg)
  }

  private onLiveBatch(buffer: ArrayBuffer) {
    try {
      burn.liveBatch(buffer)
      this.source = 'live'
    } catch (e) {
      this.liveErrors = [...this.liveErrors.slice(-4), String(e)]
    }
  }
}

export const app = new AppState()
