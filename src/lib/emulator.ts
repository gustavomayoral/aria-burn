// SPDX-License-Identifier: GPL-3.0-or-later
// GRBL network emulator (Rust, crate aria-burn-grbl): settings in, three
// Channels out — contract events, binary sample batches, connection state.
// The connection state and the settings shape are app-local until the
// contract grows them (see COD-265).

import { Channel, invoke } from '@tauri-apps/api/core'
import type { ChannelEvent, MachineProfile } from 'aria-burn-core/contract'
import type { NetworkSettings } from './settings.ts'

/** Mirrors `ConnectionStatus` in crates/aria-burn-grbl/src/server.rs. */
export type ConnectionStatus =
  | { state: 'stopped' }
  | { state: 'listening'; address: string }
  | { state: 'connected'; address: string; peer: string }
  | { state: 'failed'; address: string; message: string }

/** Mirrors `EmulatorSettings` in src-tauri/src/emulator.rs. */
export interface EmulatorSettings {
  enabled: boolean
  bindMode: NetworkSettings['bindMode']
  port: number
  pacing: NetworkSettings['pacing']
  profile: MachineProfile
}

export interface EmulatorHandlers {
  event(msg: ChannelEvent): void
  batch(buffer: ArrayBuffer): void
  status(status: ConnectionStatus): void
}

export function emulatorSettings(network: NetworkSettings, profile: MachineProfile): EmulatorSettings {
  return {
    enabled: network.listening,
    bindMode: network.bindMode,
    port: network.port,
    pacing: network.pacing,
    // Plain copy: Svelte state proxies don't survive IPC.
    profile: JSON.parse(JSON.stringify(profile)) as MachineProfile,
  }
}

/** Opens the emulator's Channels; a later call replaces the earlier ones. */
export async function subscribeEmulator(h: EmulatorHandlers): Promise<void> {
  const events = new Channel<ChannelEvent>()
  events.onmessage = h.event
  const batches = new Channel<ArrayBuffer>()
  batches.onmessage = h.batch
  const status = new Channel<ConnectionStatus>()
  status.onmessage = h.status
  await invoke('emulator_subscribe', { events, batches, status })
}

/** Starts, restarts, updates or stops the emulator; resolves to its state. */
export const configureEmulator = (settings: EmulatorSettings) => invoke<ConnectionStatus>('emulator_configure', { settings })

export function describeConnection(s: ConnectionStatus): string {
  switch (s.state) {
    case 'stopped':
      return 'Emulator off'
    case 'listening':
      return `Listening on ${s.address}`
    case 'connected':
      return `Sender connected from ${s.peer}`
    case 'failed':
      return s.message
  }
}
