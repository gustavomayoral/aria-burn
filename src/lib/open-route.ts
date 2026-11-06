// SPDX-License-Identifier: GPL-3.0-or-later
// Which open path a file takes, by its extension (BURN-53): an SVG is read
// and turned into a job in the webview (svg-import.svelte.ts), a project file
// (.ariaburn, BURN-55) restores an SVG with its setup (project.svelte.ts);
// anything else is G-code and goes to Rust as before.

export type OpenRoute = 'svg' | 'project' | 'gcode'

export const GCODE_EXTENSIONS = ['.gcode', '.gc', '.nc', '.ngc', '.txt'] as const
export const SVG_EXTENSIONS = ['.svg'] as const
export const PROJECT_EXTENSIONS = ['.ariaburn'] as const

/** Everything Open accepts: projects, SVG and G-code. */
export const OPEN_EXTENSIONS = [...PROJECT_EXTENSIONS, ...SVG_EXTENSIONS, ...GCODE_EXTENSIONS] as const

/** The browser file picker's accept list. */
export const OPEN_ACCEPT = OPEN_EXTENSIONS.join(',')

/** Native dialog filters: extensions without the dot. */
export const dialogExtensions = (exts: readonly string[]): string[] => exts.map((e) => e.slice(1))

/** The file name of a path (either separator). */
export const baseName = (path: string): string => path.split(/[\\/]/).pop() || path

/** Routes a file name or path by its extension, case-insensitively. Unknown extensions stay G-code, as before. */
export function routeFor(nameOrPath: string): OpenRoute {
  const name = baseName(nameOrPath).toLowerCase()
  if (PROJECT_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'project'
  return SVG_EXTENSIONS.some((ext) => name.endsWith(ext)) ? 'svg' : 'gcode'
}
