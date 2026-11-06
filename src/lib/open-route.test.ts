// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { OPEN_ACCEPT, baseName, routeFor } from './open-route.ts'

describe('open routing (BURN-53)', () => {
  it('routes .svg to SVG import, case-insensitively, from a name or a path', () => {
    expect(routeFor('design.svg')).toBe('svg')
    expect(routeFor('DESIGN.SVG')).toBe('svg')
    expect(routeFor('/Users/me/Laser/aria studio.svg')).toBe('svg')
    expect(routeFor('C:\\Users\\me\\job.Svg')).toBe('svg')
  })

  it('keeps G-code and anything unknown on the G-code path', () => {
    for (const name of ['job.gcode', 'job.gc', 'job.nc', 'job.ngc', 'job.txt', 'job', 'svg', 'job.svg.gcode', 'job.svgz', '/a.svg/job.nc'])
      expect(routeFor(name), name).toBe('gcode')
  })

  it('the picker accepts G-code and SVG', () => {
    expect(OPEN_ACCEPT.split(',')).toEqual(['.gcode', '.gc', '.nc', '.ngc', '.txt', '.svg'])
  })

  it('names a path by its last part, with either separator', () => {
    expect(baseName('/a/b/c.svg')).toBe('c.svg')
    expect(baseName('C:\\a\\c.svg')).toBe('c.svg')
    expect(baseName('c.svg')).toBe('c.svg')
  })
})
