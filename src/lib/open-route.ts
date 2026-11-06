// SPDX-License-Identifier: GPL-3.0-or-later
// Which open path a file takes, by its extension (BURN-53): an SVG is read
// and turned into a job in the webview (svg-import.svelte.ts); anything else
// is G-code and goes to Rust as before.

export type OpenRoute = 'svg' | 'gcode'

export const GCODE_EXTENSIONS = ['.gcode', '.gc', '.nc', '.ngc', '.txt'] as const
export const SVG_EXTENSIONS = ['.svg'] as const

/** The file picker's accept list: G-code and SVG. */
export const OPEN_ACCEPT = [...GCODE_EXTENSIONS, ...SVG_EXTENSIONS].join(',')

/** The file name of a path (either separator). */
export const baseName = (path: string): string => path.split(/[\\/]/).pop() || path

/** Routes a file name or path by its extension, case-insensitively. Unknown extensions stay G-code, as before. */
export function routeFor(nameOrPath: string): OpenRoute {
  const name = baseName(nameOrPath).toLowerCase()
  return SVG_EXTENSIONS.some((ext) => name.endsWith(ext)) ? 'svg' : 'gcode'
}
