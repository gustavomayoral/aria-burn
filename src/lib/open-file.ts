// SPDX-License-Identifier: GPL-3.0-or-later
// Opening a file from the picker, a drop or the command line (BURN-53):
// routed by extension (open-route.ts). G-code keeps its path to Rust; an SVG
// is read as text (Rust's read_text_file for a path) and imported in the
// webview.

import { app } from './app.svelte.ts'
import { burn } from './burn.svelte.ts'
import { readTextFile } from './ipc.ts'
import { baseName, routeFor } from './open-route.ts'
import { svgImport } from './svg-import.svelte.ts'

/** A native drop or launch file: a path on disk. */
export async function openPath(path: string): Promise<void> {
  app.source = 'file'
  if (routeFor(path) === 'gcode') {
    svgImport.clear()
    return burn.openFile({ kind: 'path', path })
  }
  const name = baseName(path)
  let text: string
  try {
    text = await readTextFile(path)
  } catch (e) {
    svgImport.clear()
    burn.failFile(name, String(e), 'svg')
    return
  }
  await svgImport.open(name, text)
}

/** A picked or browser-dropped file: its name and text. */
export async function openText(name: string, text: string): Promise<void> {
  app.source = 'file'
  if (routeFor(name) === 'gcode') {
    svgImport.clear()
    return burn.openFile({ kind: 'text', name, text })
  }
  await svgImport.open(name, text)
}
