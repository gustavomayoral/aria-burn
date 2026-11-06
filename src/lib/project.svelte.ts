// SPDX-License-Identifier: GPL-3.0-or-later
// The open project (BURN-55, feature BURN-49): Save, Save As and Open of
// .ariaburn files, the unsaved-changes prompt, and the notices a project
// opens with. In the desktop app the files go through native dialogs and Rust
// (project_write / project_read); in browser dev mode Save downloads the file
// and Open takes it from the file picker.
//
// A project is the SVG import's setup (svg-import.svelte.ts) plus the path it
// was saved to. "Unsaved" means the setup changed since it was opened or
// saved; machine and material are app settings and don't count.

import { parseProject, serializeProject, type AriaBurnProject } from 'aria-burn-core/contract'
import { app } from './app.svelte.ts'
import { isTauri, projectRead, projectWrite } from './ipc.ts'
import { loadMachine } from './machine-session.ts'
import { allMaterials, findMaterial } from './materials.ts'
import { baseName } from './open-route.ts'
import { buildProject, projectFileName, resolveMachine, resolveMaterial, setupKey, withProjectExtension } from './project.ts'
import { svgImport } from './svg-import.svelte.ts'

const PROJECT_FILTER = { name: 'Aria Burn project', extensions: ['ariaburn'] }

/** Answer of the unsaved-changes prompt. */
export type DiscardChoice = 'save' | 'discard' | 'cancel'

class Project {
  /** Where the project was last saved or opened from (desktop only); null for an SVG not saved yet. */
  path = $state<string | null>(null)
  /** Project file name once saved or opened; null for an SVG not saved yet. */
  fileName = $state<string | null>(null)
  /** Shown above the layers: what opening the project couldn't restore. */
  notices = $state<string[]>([])
  /** The last Save or Open failure, shown until the next one succeeds. */
  error = $state<string | null>(null)
  private baseKey = $state<string | null>(null)
  private baseText = $state.raw<string | null>(null)

  /** There is an SVG setup to save. */
  get canSave(): boolean {
    return svgImport.doc !== null && svgImport.name !== null
  }

  private get key(): string {
    return setupKey({ name: svgImport.name ?? '', pxPerInch: svgImport.pxPerInch, layers: svgImport.layers, placement: svgImport.placement })
  }

  /** The setup changed since it was opened or saved. */
  get dirty(): boolean {
    if (!this.canSave || this.baseKey === null) return false
    return svgImport.text !== this.baseText || this.key !== this.baseKey
  }

  /** What the top bar names: the project file, or the SVG until it's saved. */
  get title(): string | null {
    return this.fileName ?? svgImport.name
  }

  /** The current setup is the saved one (after an open or a save). */
  markClean(): void {
    this.baseKey = this.canSave ? this.key : null
    this.baseText = this.canSave ? svgImport.text : null
  }

  /** Another file (an SVG or G-code) replaced the project. */
  forget(): void {
    this.path = null
    this.fileName = null
    this.notices = []
    this.error = null
  }

  /** An SVG was opened on its own: it starts clean, with no project file. */
  openedSvg(): void {
    this.forget()
    this.markClean()
  }

  dismissNotice(i: number): void {
    this.notices = this.notices.filter((_, j) => j !== i)
  }

  /** The project file for the current setup. */
  build(): AriaBurnProject {
    const material = findMaterial(app.settings.ui.materialId)
    return buildProject(
      { name: svgImport.name ?? 'design.svg', text: svgImport.text, pxPerInch: svgImport.pxPerInch, layers: $state.snapshot(svgImport.layers), placement: $state.snapshot(svgImport.placement) },
      {
        machine: { id: app.library.activeId, name: app.settings.machine.name },
        material: { id: material.id, name: material.name },
        savedAt: new Date().toISOString(),
      },
    )
  }

  /** Save: to the file it came from, or Save As. Resolves to whether it was saved. */
  async save(): Promise<boolean> {
    if (!this.canSave) return false
    if (this.path && isTauri()) return this.writeTo(this.path)
    return this.saveAs()
  }

  /** Save As: a native Save dialog, or a download in browser dev mode. */
  async saveAs(): Promise<boolean> {
    if (!this.canSave) return false
    const suggested = this.fileName ?? projectFileName(svgImport.name)
    if (!isTauri()) {
      download(suggested, serializeProject(this.build()))
      this.fileName = suggested
      this.error = null
      this.markClean()
      return true
    }
    const { save } = await import('@tauri-apps/plugin-dialog')
    const picked = await save({ title: 'Save project', defaultPath: this.path ?? suggested, filters: [PROJECT_FILTER] })
    if (!picked) return false
    return this.writeTo(withProjectExtension(picked))
  }

  private async writeTo(path: string): Promise<boolean> {
    try {
      await projectWrite(path, serializeProject(this.build()))
    } catch (e) {
      this.error = `Can’t save the project: ${String(e)}`
      return false
    }
    this.path = path
    this.fileName = baseName(path)
    this.error = null
    this.markClean()
    return true
  }

  /**
   * Asks before unsaved changes are lost (another file opened, the window
   * closed, the app quit). Resolves to true when it's fine to go on: nothing
   * unsaved, the user saved, or chose not to.
   */
  async confirmDiscard(): Promise<boolean> {
    if (!this.dirty) return true
    const choice = await askDiscard(this.title ?? 'this project')
    if (choice === 'cancel') return false
    if (choice === 'discard') return true
    return this.save()
  }

  /** Opens a project file from a path (picker, drop or launch in the desktop app). */
  async openPath(path: string): Promise<void> {
    let text: string
    try {
      text = await projectRead(path)
    } catch (e) {
      this.error = `Can’t open ${baseName(path)}: ${String(e)}`
      return
    }
    await this.openText(baseName(path), text, path)
  }

  /**
   * Opens a project file's text: check it, ask about unsaved changes, restore
   * the machine and material if they still exist (a notice otherwise), then
   * the SVG with its layers and placement.
   */
  async openText(name: string, text: string, path: string | null = null): Promise<void> {
    const parsed = parseProject(text)
    if (!parsed.ok) {
      this.error = `Can’t open ${name}: ${parsed.error}`
      return
    }
    if (!(await this.confirmDiscard())) return
    const p = parsed.project
    const notices: string[] = []

    const machine = resolveMachine(p.machine, app.library, app.settings.machine.name)
    if (machine.kind === 'missing') notices.push(machine.notice)
    if (machine.kind === 'load') {
      try {
        await loadMachine(app, machine.id)
      } catch (e) {
        notices.push(`Couldn’t switch to the machine “${p.machine.name}” (${String(e)}). It opens with ${app.settings.machine.name}.`)
      }
    }
    svgImport.setMachine(app.settings.machine)

    const material = resolveMaterial(p.material, allMaterials(), findMaterial(app.settings.ui.materialId).name)
    if (material.kind === 'missing') notices.push(material.notice)
    else if (app.settings.ui.materialId !== material.id) {
      app.settings.ui.materialId = material.id
      void app.savePrefs()
    }

    app.source = 'file'
    this.path = path
    this.fileName = name
    this.error = null
    this.notices = notices
    const ok = await svgImport.open(p.svg.fileName, p.svg.text, p.svg.pxPerInch, false, { layers: p.layers, placement: p.placement })
    if (ok) this.markClean()
  }
}

/** Save / Don't Save / Cancel: a native message box, or confirm() in the browser (OK discards). */
async function askDiscard(title: string): Promise<DiscardChoice> {
  if (!isTauri()) return window.confirm(`Discard unsaved changes to ${title}?`) ? 'discard' : 'cancel'
  const { message } = await import('@tauri-apps/plugin-dialog')
  const answer = await message(`Do you want to save the changes to ${title}?`, {
    title: 'Unsaved changes',
    kind: 'warning',
    buttons: { yes: 'Save', no: 'Don’t Save', cancel: 'Cancel' },
  })
  return discardChoice(answer)
}

/** The message box answers with the button key or, for custom labels, the label. */
export function discardChoice(answer: string): DiscardChoice {
  if (answer === 'Yes' || answer === 'Save') return 'save'
  if (answer === 'No' || answer === 'Don’t Save') return 'discard'
  return 'cancel'
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const project = new Project()
