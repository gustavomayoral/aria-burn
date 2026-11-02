// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { describeConnection, emulatorSettings } from './emulator.ts'
import { defaultSettings } from './settings.ts'

describe('emulator settings', () => {
  it('maps the network settings and copies the profile', () => {
    const s = defaultSettings()
    const out = emulatorSettings({ ...s.network, bindMode: 'lan', port: 2323, pacing: 'instant' }, s.machine)
    expect(out).toMatchObject({ enabled: true, bindMode: 'lan', port: 2323, pacing: 'instant' })
    expect(out.profile).toEqual(s.machine)
    expect(out.profile).not.toBe(s.machine)
  })

  it('describes each connection state', () => {
    expect(describeConnection({ state: 'stopped' })).toBe('Emulator off')
    expect(describeConnection({ state: 'listening', address: '127.0.0.1:23' })).toBe('Listening on 127.0.0.1:23')
    expect(describeConnection({ state: 'connected', address: '127.0.0.1:23', peer: '127.0.0.1:5000' })).toContain('127.0.0.1:5000')
    expect(describeConnection({ state: 'failed', address: '0.0.0.0:23', message: 'Port 23 is already in use' })).toBe('Port 23 is already in use')
  })
})
