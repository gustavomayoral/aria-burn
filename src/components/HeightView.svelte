<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte'
  import * as THREE from 'three'
  import { app } from '../lib/app.svelte.ts'
  import { burn } from '../lib/burn.svelte.ts'
  import { findMaterial } from '../lib/materials.ts'

  // Height view (three.js): the core's depth map as a lit mesh, coloured with
  // the shaded burn. Depth is exaggerated so tenths of a millimetre read on a
  // job tens of millimetres wide; the factor is shown, the scale bar is true.
  const MESH_MAX = 384
  const COLOR_MAX = 1024
  const YAW0 = -0.5
  const PITCH0 = 0.9

  let host: HTMLDivElement
  let renderer: THREE.WebGLRenderer | null = null
  let camera: THREE.PerspectiveCamera
  let scene: THREE.Scene
  let mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null = null
  let yaw = $state(YAW0)
  let pitch = $state(PITCH0)
  let distance = $state(1)
  let exaggeration = $state(1)
  let sizeMm = 1
  let frame = 0
  let webglError = $state<string | null>(null)

  const material = $derived(findMaterial(app.settings.ui.materialId))
  const flat = $derived(material.response.kind === 'bleach')

  function placeCamera() {
    const r = sizeMm * 2 * distance
    camera.position.set(r * Math.cos(pitch) * Math.sin(yaw), r * Math.sin(pitch), r * Math.cos(pitch) * Math.cos(yaw))
    camera.near = r / 100
    camera.far = r * 10
    camera.lookAt(0, 0, 0)
  }

  /** Rebuilds the mesh from the engine's heightmap (after each run). */
  function rebuild() {
    const hm = burn.heightmap(COLOR_MAX)
    if (!hm || !renderer) return
    const step = Math.max(1, Math.ceil(Math.max(hm.width, hm.height) / MESH_MAX))
    const cols = Math.max(1, Math.floor((hm.width - 1) / step))
    const rows = Math.max(1, Math.floor((hm.height - 1) / step))
    const wMm = hm.width * hm.texelMm
    const hMm = hm.height * hm.texelMm
    sizeMm = Math.max(wMm, hMm)
    let max = 0
    for (const d of hm.depthMm) if (d > max) max = d
    burn.depthMaxMm = max
    // Deepest cut ≈ 3 % of the job's size, never flattened below true scale.
    exaggeration = max > 0 ? Math.max(1, Math.round((0.03 * sizeMm) / max)) : 1
    const geometry = new THREE.PlaneGeometry(wMm, hMm, cols, rows)
    const pos = geometry.attributes.position as THREE.BufferAttribute
    for (let r = 0; r <= rows; r++)
      for (let c = 0; c <= cols; c++) {
        // Plane rows run top (+Y) to bottom; heightmap row 0 is min Y.
        const y = Math.min(hm.height - 1, Math.round(((rows - r) / rows) * (hm.height - 1)))
        const x = Math.min(hm.width - 1, Math.round((c / cols) * (hm.width - 1)))
        pos.setZ(r * (cols + 1) + c, flat ? 0 : -hm.depthMm[y * hm.width + x]! * exaggeration)
      }
    geometry.computeVertexNormals()
    const tex = new THREE.DataTexture(hm.color, hm.width, hm.height, THREE.RGBAFormat)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.flipY = false
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.needsUpdate = true
    // DataTexture row 0 is v = 0 (bottom), matching min Y.
    if (mesh) {
      mesh.geometry.dispose()
      mesh.material.map?.dispose()
      mesh.material.dispose()
      scene.remove(mesh)
    }
    mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 }))
    mesh.rotation.x = -Math.PI / 2
    scene.add(mesh)
    schedule()
  }

  function render() {
    frame = 0
    if (!renderer) return
    const { clientWidth: cw, clientHeight: ch } = host
    if (cw === 0 || ch === 0) return
    renderer.setSize(cw, ch, false)
    camera.aspect = cw / ch
    camera.updateProjectionMatrix()
    placeCamera()
    renderer.render(scene, camera)
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render)
  }

  onMount(() => {
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch (e) {
      webglError = `WebGL unavailable: ${String(e)}`
      return
    }
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x161514)
    host.appendChild(renderer.domElement)
    scene = new THREE.Scene()
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x302a24, 1.1))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(-30, 60, 40)
    scene.add(sun)
    const ro = new ResizeObserver(schedule)
    ro.observe(host)
    // Results that arrived before the renderer existed.
    rebuild()
    return () => {
      ro.disconnect()
      cancelAnimationFrame(frame)
      if (mesh) {
        mesh.geometry.dispose()
        mesh.material.map?.dispose()
        mesh.material.dispose()
      }
      renderer?.dispose()
      renderer = null
    }
  })

  // New results (runs bump version) or a material change: rebuild once per change.
  $effect(() => {
    void burn.version
    void flat
    rebuild()
  })
  $effect(() => {
    void yaw
    void pitch
    void distance
    schedule()
  })

  let drag: { x: number; y: number } | null = null
  function onDown(e: PointerEvent) {
    drag = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onDrag(e: PointerEvent) {
    if (!drag) return
    yaw -= (e.clientX - drag.x) * 0.01
    tilt((e.clientY - drag.y) * 0.01)
    drag = { x: e.clientX, y: e.clientY }
  }
  const tilt = (d: number) => (pitch = Math.min(1.5, Math.max(0.12, pitch + d)))
  const dolly = (f: number) => (distance = Math.min(3, Math.max(0.08, distance * f)))
  function onWheel(e: WheelEvent) {
    e.preventDefault()
    dolly(Math.exp(e.deltaY * 0.002))
  }
</script>

<div class="wrap">
  <div
    class="gl"
    bind:this={host}
    onpointerdown={onDown}
    onpointermove={onDrag}
    onpointerup={() => (drag = null)}
    onwheel={onWheel}
    role="img"
    aria-label="3D height view of the engraving. Drag to orbit, scroll to zoom."
  ></div>
  {#if webglError}
    <div class="msg">{webglError}</div>
  {:else if flat}
    <div class="msg">Bleach response: marks have no depth, so the relief is flat.</div>
  {:else if exaggeration > 1}
    <div class="msg small">Depth exaggerated ×{exaggeration}</div>
  {/if}
  <div class="controls">
    <button aria-label="Orbit left" onclick={() => (yaw += 0.26)}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
    </button>
    <button aria-label="Orbit right" onclick={() => (yaw -= 0.26)}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
    </button>
    <button aria-label="Tilt up" onclick={() => tilt(0.14)}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>
    </button>
    <button aria-label="Tilt down" onclick={() => tilt(-0.14)}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </button>
    <button aria-label="Zoom in" onclick={() => dolly(0.7)}>+</button>
    <button aria-label="Zoom out" onclick={() => dolly(1 / 0.7)}>−</button>
    <button class="text" onclick={() => ((yaw = YAW0), (pitch = PITCH0), (distance = 1))}>Reset camera</button>
  </div>
</div>

<style>
  .wrap {
    position: absolute;
    inset: 0;
  }
  .gl {
    position: absolute;
    inset: 0;
    cursor: grab;
  }
  .gl :global(canvas) {
    width: 100%;
    height: 100%;
    display: block;
  }
  .msg {
    position: absolute;
    left: 50%;
    top: 14px;
    transform: translateX(-50%);
    padding: 6px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--line);
    background: var(--overlay);
    font-size: var(--text-xs);
    white-space: nowrap;
  }
  .msg.small {
    font-size: var(--text-2xs);
    color: var(--fg);
  }
  .controls {
    position: absolute;
    left: 10px;
    top: 10px;
    display: flex;
    gap: 6px;
    padding: 6px;
    background: var(--overlay);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .controls button {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--fg);
    display: grid;
    place-items: center;
    font-size: var(--text-sm);
    line-height: 1;
  }
  .controls button:hover {
    border-color: var(--line-strong);
    background: var(--raised);
    color: var(--fg-strong);
  }
  .controls button.text {
    width: auto;
    padding: 0 10px;
    font-family: var(--font-condensed);
    font-size: var(--text-xs);
  }
</style>
