// SPDX-License-Identifier: GPL-3.0-or-later
// Opening a file from the picker, a drop or the command line (BURN-53):
// routed by extension (open-route.ts). G-code keeps its path to Rust; an SVG
// is read as text (Rust's read_text_file for a path) and imported in the
// webview; a project file (.ariaburn, BURN-55) restores an SVG with its setup.
// Opening anything asks first when the open project has unsaved changes.

import { app } from './app.svelte.ts'
import { burn } from './burn.svelte.ts'
import { isTauri, readTextFile } from './ipc.ts'
import { OPEN_ACCEPT, OPEN_EXTENSIONS, SVG_EXTENSIONS, baseName, dialogExtensions, routeFor } from './open-route.ts'
import { project } from './project.svelte.ts'
import { svgImport } from './svg-import.svelte.ts'

/** A native drop, launch or dialog file: a path on disk. */
export async function openPath(path: string): Promise<void> {
  const route = routeFor(path)
  if (route === 'project') return project.openPath(path)
  if (!(await project.confirmDiscard())) return
  app.source = 'file'
  project.forget()
  if (route === 'gcode') {
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
  if (await svgImport.open(name, text)) project.openedSvg()
}

/** A picked or browser-dropped file: its name and text. */
export async function openText(name: string, text: string): Promise<void> {
  const route = routeFor(name)
  if (route === 'project') return project.openText(name, text)
  if (!(await project.confirmDiscard())) return
  app.source = 'file'
  project.forget()
  if (route === 'gcode') {
    svgImport.clear()
    return burn.openFile({ kind: 'text', name, text })
  }
  if (await svgImport.open(name, text)) project.openedSvg()
}

/** A browser file picker; resolves to the chosen file, or null. */
function pickInBrowser(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

/** Open…: the native dialog in the desktop app (so a project keeps its path), the file picker in the browser. */
export async function chooseFile(): Promise<void> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({
      title: 'Open',
      multiple: false,
      directory: false,
      filters: [
        { name: 'Projects, SVG and G-code', extensions: dialogExtensions(OPEN_EXTENSIONS) },
        { name: 'Aria Burn project', extensions: ['ariaburn'] },
        { name: 'SVG', extensions: ['svg'] },
      ],
    })
    if (path) await openPath(path)
    return
  }
  const file = await pickInBrowser(OPEN_ACCEPT)
  if (file) await openText(file.name, await file.text())
}

/** Replace SVG… (BURN-55): another SVG takes the open one's place, keeping layer settings by colour. */
export async function replaceSvg(): Promise<void> {
  let name: string
  let text: string
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({ title: 'Replace SVG', multiple: false, directory: false, filters: [{ name: 'SVG', extensions: dialogExtensions(SVG_EXTENSIONS) }] })
    if (!path) return
    name = baseName(path)
    try {
      text = await readTextFile(path)
    } catch (e) {
      project.error = `Can’t read ${name}: ${String(e)}`
      return
    }
  } else {
    const file = await pickInBrowser(SVG_EXTENSIONS.join(','))
    if (!file) return
    name = file.name
    text = await file.text()
  }
  await svgImport.replace(name, text)
}
