// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { OPEN_ACCEPT, baseName, dialogExtensions, routeFor } from './open-route.ts'

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

  it('routes .ariaburn to project open (BURN-55)', () => {
    expect(routeFor('job.ariaburn')).toBe('project')
    expect(routeFor('/Users/me/Job.AriaBurn')).toBe('project')
    expect(routeFor('job.ariaburn.gcode')).toBe('gcode')
  })

  it('the picker accepts projects, SVG and G-code', () => {
    expect(OPEN_ACCEPT.split(',')).toEqual(['.ariaburn', '.svg', '.gcode', '.gc', '.nc', '.ngc', '.txt'])
    expect(dialogExtensions(['.ariaburn', '.svg'])).toEqual(['ariaburn', 'svg'])
  })

  it('names a path by its last part, with either separator', () => {
    expect(baseName('/a/b/c.svg')).toBe('c.svg')
    expect(baseName('C:\\a\\c.svg')).toBe('c.svg')
    expect(baseName('c.svg')).toBe('c.svg')
  })
})
