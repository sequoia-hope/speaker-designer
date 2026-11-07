<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { createViewer, type Viewer } from './three3d';
  import type { Geometry, PrintPlan } from './hybrid';

  let {
    geo,
    plan,
    plateMm,
    plateColor = 0xcfa874,
    dividerColor,
    coupled = 1,
    mouth = 'edge',
  }: {
    geo: Geometry;
    plan: PrintPlan;
    plateMm: number;
    plateColor?: number;
    /** dividers when they differ from the plywood strips (sandwich panels) */
    dividerColor?: number;
    coupled?: number;
    mouth?: 'edge' | 'corner';
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let viewer: Viewer | null = null;
  let explode = $state(0.35);
  let showPlates = $state(true);
  let framedKey = '';


  /** Printed cores: the filleted outline extruded, one per core, with plywood dividers between. */
  function coreGroup(): THREE.Group {
    const s = 0.001;
    const g = new THREE.Group();
    const shape = new THREE.Shape(geo.core.map(([x, y]) => new THREE.Vector2(x * s, y * s)));
    for (const h of geo.holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x * s, y * s))));
    const coreGeo = new THREE.ExtrudeGeometry(shape, { depth: geo.coreMm * s, bevelEnabled: false, curveSegments: 4 });
    const printMat = new THREE.MeshStandardMaterial({ color: 0xd4d4d8, roughness: 0.6, side: THREE.DoubleSide });
    const divMat = new THREE.MeshStandardMaterial({ color: dividerColor !== undefined ? 0xcfa874 : plateColor, roughness: 0.7 });
    const seamMat = new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    const z0 = -geo.Etot / 2;
    for (let c = 0; c < geo.cores; c++) {
      const zc = z0 + c * (geo.coreMm + plateMm);
      const m = new THREE.Mesh(coreGeo, printMat);
      // profile x → depth (three z), profile y → height, extrusion → three x
      m.rotation.y = -Math.PI / 2;
      // after the rotation the extrusion runs toward −x, so offset by the core thickness
      m.position.set((zc + geo.coreMm) * s, 0, -(geo.W / 2) * s);
      const holder = new THREE.Group();
      holder.add(m);
      // seams: thin red planes where the core is cut into printed pieces
      for (const L of plan.cutLines) {
        const len = Math.hypot(L.x2 - L.x1, L.y2 - L.y1);
        const vertical = Math.abs(L.x2 - L.x1) < 1e-6;
        const pl = new THREE.Mesh(new THREE.PlaneGeometry(geo.coreMm * s, len * s), seamMat);
        if (vertical) pl.position.set((zc + geo.coreMm / 2) * s, ((L.y1 + L.y2) / 2) * s, (L.x1 - geo.W / 2) * s);
        else {
          pl.rotation.x = -Math.PI / 2;
          pl.position.set((zc + geo.coreMm / 2) * s, L.y1 * s, ((L.x1 + L.x2) / 2 - geo.W / 2) * s);
        }
        holder.add(pl);
      }
      // plywood strips (bends construction): wood boxes over the straight walls
      for (const st of geo.strips) {
        const r = st.rect;
        const bx = new THREE.Mesh(new THREE.BoxGeometry(geo.coreMm * s, (r.y1 - r.y0) * s, (r.x1 - r.x0) * s), divMat);
        bx.position.set((zc + geo.coreMm / 2) * s, ((r.y0 + r.y1) / 2) * s, ((r.x0 + r.x1) / 2 - geo.W / 2) * s);
        bx.scale.set(1.002, 1.02, 1.0);
        holder.add(bx);
      }
      for (const cz of plan.cutsZ) {
        const pl = new THREE.Mesh(new THREE.PlaneGeometry(geo.W * s, geo.H * s), seamMat);
        pl.rotation.y = Math.PI / 2;
        pl.position.set((zc + cz) * s, (geo.H / 2) * s, 0);
        holder.add(pl);
      }
      g.add(holder);
      if (c < geo.cores - 1) {
        const dv = new THREE.Mesh(
          new THREE.ExtrudeGeometry(new THREE.Shape(outline()), { depth: plateMm * s, bevelEnabled: false }),
          dividerColor !== undefined ? new THREE.MeshStandardMaterial({ color: dividerColor, roughness: 0.35, metalness: 0.2 }) : divMat
        );
        dv.rotation.y = -Math.PI / 2;
        dv.position.set((zc + geo.coreMm + plateMm) * s, 0, -(geo.W / 2) * s);
        g.add(dv);
      }
    }
    // driver
    const d = geo.driver;
    const r = (d.dia / 2) * s;
    const drv = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.012, 48), new THREE.MeshStandardMaterial({ color: 0x1f2024, metalness: 0.4 }));
    frame.rotation.x = Math.PI / 2;
    drv.add(frame);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 0.9, r * 0.5, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x2b2b2f, side: THREE.DoubleSide }));
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = -r * 0.25;
    drv.add(cone);
    drv.position.set(0, d.y * s, (d.x - geo.W / 2) * s);
    g.add(drv);
    return g;
  }

  /** Outer outline of the cabinet (rounded rectangle following the core's outer corners). */
  function outline(): THREE.Vector2[] {
    const s = 0.001;
    const r = Math.min(25, geo.W / 4, geo.H / 4);
    const pts: THREE.Vector2[] = [];
    const corners: [number, number, number][] = [
      [geo.W - r, r, -Math.PI / 2],
      [geo.W - r, geo.H - r, 0],
      [r, geo.H - r, Math.PI / 2],
      [r, r, Math.PI],
    ];
    for (const [cx, cy, a0] of corners)
      for (let i = 0; i <= 6; i++) {
        const a = a0 + (i / 6) * (Math.PI / 2);
        pts.push(new THREE.Vector2((cx + r * Math.cos(a)) * s, (cy + r * Math.sin(a)) * s));
      }
    return pts;
  }

  function cabinet(): THREE.Group {
    const s = 0.001;
    const cab = new THREE.Group();
    cab.add(coreGroup());
    if (showPlates) {
      const plateMat = new THREE.MeshStandardMaterial({ color: plateColor, roughness: 0.7, transparent: true, opacity: 0.92 });
      const pg = new THREE.ExtrudeGeometry(new THREE.Shape(outline()), { depth: plateMm * s, bevelEnabled: false });
      for (const side of [-1, 1]) {
        const p = new THREE.Mesh(pg, plateMat);
        p.rotation.y = -Math.PI / 2;
        const x = side < 0 ? -geo.Etot / 2 : geo.Etot / 2 + plateMm;
        p.position.set(x * s + side * explode * 0.35, 0, -(geo.W / 2) * s);
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(pg, 30), new THREE.LineBasicMaterial({ color: 0x5b4027 }));
        p.add(e);
        cab.add(p);
      }
    }
    return cab;
  }

  function build() {
    if (!viewer) return;
    viewer.clear();
    const s = 0.001;
    const root = new THREE.Group();
    viewer.content.add(root);
    const one = cabinet();
    const cabW = (geo.Etot + 2 * plateMm) * s;
    if (coupled <= 1) root.add(one);
    else {
      // mirrored stacks so the mouths meet: edge mouths stack top/bottom, corner mouths 2 × 2
      const copies: { x: number; flipY: boolean }[] =
        coupled >= 4
          ? [
              { x: -cabW / 2, flipY: false },
              { x: cabW / 2, flipY: false },
              { x: -cabW / 2, flipY: true },
              { x: cabW / 2, flipY: true },
            ]
          : [
              { x: 0, flipY: false },
              { x: 0, flipY: true },
            ];
      for (const c of copies) {
        const cab = c === copies[0] ? one : cabinet();
        cab.position.x = c.x;
        if (c.flipY) {
          // upside-down copy sitting on top: its mouth (at its bottom edge) meets the lower one's
          cab.rotation.z = Math.PI;
          cab.position.y = geo.H * s * 2;
          cab.position.x = -c.x;
        }
        root.add(cab);
      }
    }
    const bounds = new THREE.Box3().setFromObject(root);
    const grid = new THREE.GridHelper(4, 40, 0x2b3a5c, 0x1a2541);
    root.add(grid);
    const key = `${geo.W}|${geo.H}|${geo.E}|${coupled}`;
    if (key !== framedKey) {
      framedKey = key;
      viewer.frame(bounds, new THREE.Vector3(1.0, 0.55, 0.9));
    }
    viewer.render();
  }

  onMount(() => {
    if (!host) return;
    viewer = createViewer(host);
    build();
    return () => {
      viewer?.dispose();
      viewer = null;
    };
  });
  $effect(() => {
    void [geo, plan, plateMm, plateColor, dividerColor, explode, showPlates, coupled, mouth];
    build();
  });
</script>

<div class="h3d">
  <div class="canvas" bind:this={host}></div>
  <div class="ctl">
    <label class="ex"><span>Plates apart</span><input type="range" min="0" max="1" step="0.01" bind:value={explode} aria-label="Explode plates" /></label>
    <button class="chip" class:on={showPlates} onclick={() => (showPlates = !showPlates)}>Side plates</button>
  </div>
  <div class="hint">Light grey = printed, wood = plywood (plates, dividers, straight walls; dark or pale green plates = carbon / fibreglass sandwich), red planes = where prints are cut into pieces. Drag to orbit.</div>
</div>

<style>
  .h3d {
    display: flex;
    flex-direction: column;
    gap: 6px;
    height: 100%;
    min-height: 0;
  }
  .canvas {
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid var(--border);
    min-height: 280px;
    flex: 1 1 auto;
  }
  .ctl {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .ex {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 160px;
    font-size: 13px;
    color: var(--text-1);
  }
  .ex input {
    flex: 1;
    accent-color: var(--accent);
  }
  .chip {
    border: 1px solid var(--border);
    background: var(--bg-2);
    color: var(--text-1);
    border-radius: 999px;
    padding: 6px 11px;
    font-size: 13px;
    cursor: pointer;
  }
  .chip.on {
    border-color: var(--accent);
    color: var(--accent);
    background: rgba(56, 189, 248, 0.14);
  }
  .hint {
    font-size: 12px;
    color: var(--text-2);
  }
</style>
