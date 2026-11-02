<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte'
  import * as THREE from 'three'
  import { app } from '../lib/app.svelte.ts'
  import { findMaterial, labToRgb } from '../lib/materials.ts'
  import { PREVIEW_BOUNDS_MM, preview } from '../lib/preview.svelte.ts'

  // Height view (three.js). Relief is the placeholder energy grid, exaggerated;
  // real depth comes from the core's response model (COD-264).
  const STEP = 4 // grid cells per mesh vertex
  const RELIEF_MM = 1.5

  let host: HTMLDivElement
  let renderer: THREE.WebGLRenderer | null = null
  let mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  let camera: THREE.PerspectiveCamera
  let scene: THREE.Scene
  let yaw = $state(-0.5)
  let pitch = $state(0.9)
  let frame = 0
  let webglError = $state<string | null>(null)

  const w = PREVIEW_BOUNDS_MM.maxX - PREVIEW_BOUNDS_MM.minX
  const h = PREVIEW_BOUNDS_MM.maxY - PREVIEW_BOUNDS_MM.minY
  const cols = Math.floor(preview.width / STEP)
  const rows = Math.floor(preview.height / STEP)

  const material = $derived(findMaterial(app.settings.ui.materialId))
  const flat = $derived(material.response.kind === 'bleach')

  function placeCamera() {
    const r = 100
    camera.position.set(r * Math.cos(pitch) * Math.sin(yaw), r * Math.sin(pitch), r * Math.cos(pitch) * Math.cos(yaw))
    camera.lookAt(0, 0, 0)
  }

  function updateMesh() {
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
    const inv = preview.max > 0 && !flat ? RELIEF_MM / preview.max : 0
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const cy = Math.min(preview.height - 1, r * STEP)
        const cx = Math.min(preview.width - 1, c * STEP)
        // Engraving goes down into the surface.
        pos.setZ(r * (cols + 1) + c, -preview.energy[cy * preview.width + cx]! * inv)
      }
    }
    pos.needsUpdate = true
    mesh.geometry.computeVertexNormals()
    const [cr, cg, cb] = labToRgb(material.response.baseColor)
    mesh.material.color.setRGB(cr / 255, cg / 255, cb / 255, THREE.SRGBColorSpace)
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
    updateMesh()
    renderer.render(scene, camera)
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render)
  }

  onMount(() => {
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch (e) {
      webglError = `WebGL2 unavailable: ${String(e)}`
      return
    }
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x1b1a18)
    host.appendChild(renderer.domElement)
    scene = new THREE.Scene()
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000)
    // Plane in XY, laid flat; vertex z (depth) becomes world -y.
    const geometry = new THREE.PlaneGeometry(w, h, cols, rows)
    mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }))
    mesh.rotation.x = -Math.PI / 2
    scene.add(mesh)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x302a24, 1.2))
    const sun = new THREE.DirectionalLight(0xffffff, 2)
    sun.position.set(-30, 60, 20)
    scene.add(sun)
    const ro = new ResizeObserver(schedule)
    ro.observe(host)
    schedule()
    return () => {
      ro.disconnect()
      cancelAnimationFrame(frame)
      mesh.geometry.dispose()
      mesh.material.dispose()
      renderer?.dispose()
      renderer = null
    }
  })

  $effect(() => {
    void preview.version
    void material
    void yaw
    void pitch
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
    pitch = Math.min(1.5, Math.max(0.15, pitch + (e.clientY - drag.y) * 0.01))
    drag = { x: e.clientX, y: e.clientY }
  }
  const tilt = (d: number) => (pitch = Math.min(1.5, Math.max(0.15, pitch + d)))
</script>

<div class="wrap">
  <div class="gl" bind:this={host} onpointerdown={onDown} onpointermove={onDrag} onpointerup={() => (drag = null)} role="img" aria-label="3D height view of the engraving"></div>
  {#if webglError}
    <div class="msg">{webglError}</div>
  {:else if flat}
    <div class="msg">Bleach response: marks have no depth, so the relief is flat.</div>
  {/if}
  <div class="orbit">
    <button class="btn" aria-label="Orbit left" onclick={() => (yaw += 0.3)}>⟲</button>
    <button class="btn" aria-label="Orbit right" onclick={() => (yaw -= 0.3)}>⟳</button>
    <button class="btn" aria-label="Tilt up" onclick={() => tilt(0.15)}>▲</button>
    <button class="btn" aria-label="Tilt down" onclick={() => tilt(-0.15)}>▼</button>
    <button class="btn" onclick={() => ((yaw = -0.5), (pitch = 0.9))}>Reset camera</button>
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
    top: 16px;
    transform: translateX(-50%);
    padding: 6px 12px;
    border-radius: 6px;
    background: var(--overlay);
    font-size: 12px;
  }
  .orbit {
    position: absolute;
    left: 16px;
    bottom: 16px;
    display: flex;
    gap: 6px;
  }
</style>
