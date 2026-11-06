<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { createViewer, type Viewer } from './three3d';
  import { isAir, type Geometry, type PrintPlan } from './hybrid';

  let {
    geo,
    plan,
    plateMm,
    plateColor = 0xcfa874,
    coupled = 1,
    mouth = 'edge',
  }: {
    geo: Geometry;
    plan: PrintPlan;
    plateMm: number;
    plateColor?: number;
    coupled?: number;
    mouth?: 'edge' | 'corner';
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let viewer: Viewer | null = null;
  let explode = $state(0.35);
  let showPlates = $state(true);
  let framedKey = '';

  const SEG_COLORS = [0xe5e7eb, 0x93c5fd, 0xfca5a5, 0x86efac, 0xfcd34d, 0xc4b5fd, 0xf9a8d4, 0x67e8f9];

  /** Solid printed core as merged boxes on the grid of all rectangle edges + print cuts. */
  function coreGroup(): THREE.Group {
    const s = 0.001;
    const g = new THREE.Group();
    const xs = new Set<number>([0, geo.W, ...plan.cutsX]);
    const ys = new Set<number>([0, geo.H, ...plan.cutsY]);
    for (const r of geo.air) {
      xs.add(Math.max(0, Math.min(geo.W, r.x0)));
      xs.add(Math.max(0, Math.min(geo.W, r.x1)));
      ys.add(Math.max(0, Math.min(geo.H, r.y0)));
      ys.add(Math.max(0, Math.min(geo.H, r.y1)));
    }
    // waveguide polygons: sample finer so the flare reads as a staircase
    if (geo.airPolys.length) {
      for (let x = 0; x <= geo.W; x += 6) xs.add(x);
      for (let y = 0; y <= geo.H; y += 6) ys.add(y);
    }
    const X = [...xs].sort((a, b) => a - b);
    const Y = [...ys].sort((a, b) => a - b);
    const zc = [0, ...plan.cutsZ, geo.E];
    const segIndex = (x: number, y: number, z: number) => {
      const i = plan.segments.findIndex((sg) => x >= sg.x0 && x <= sg.x1 && y >= sg.y0 && y <= sg.y1 && z >= sg.z0 && z <= sg.z1);
      return Math.max(0, i);
    };
    const mats = SEG_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55 }));
    for (let k = 0; k < zc.length - 1; k++) {
      for (let j = 0; j < Y.length - 1; j++) {
        let run0 = -1;
        for (let i = 0; i <= X.length - 1; i++) {
          const solid = i < X.length - 1 && !isAir(geo, (X[i] + X[i + 1]) / 2, (Y[j] + Y[j + 1]) / 2);
          // break runs at print cuts so each segment gets its own colour
          const atCut = plan.cutsX.includes(X[i]);
          if (run0 >= 0 && (!solid || atCut)) {
            const x0 = X[run0];
            const x1 = X[i];
            const y0 = Y[j];
            const y1 = Y[j + 1];
            const box = new THREE.Mesh(
              new THREE.BoxGeometry((zc[k + 1] - zc[k]) * s, (y1 - y0) * s, (x1 - x0) * s),
              mats[segIndex((x0 + x1) / 2, (y0 + y1) / 2, (zc[k] + zc[k + 1]) / 2) % mats.length]
            );
            box.position.set(((zc[k] + zc[k + 1]) / 2 - geo.E / 2) * s, ((y0 + y1) / 2) * s, ((x0 + x1) / 2 - geo.W / 2) * s);
            g.add(box);
            run0 = -1;
          }
          if (solid && run0 < 0) run0 = i;
        }
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
    const magnet = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, r * 0.5, 32), new THREE.MeshStandardMaterial({ color: 0x111113, metalness: 0.6 }));
    magnet.rotation.x = Math.PI / 2;
    magnet.position.z = -r * 0.75;
    drv.add(magnet);
    drv.position.set(0, d.y * s, (d.x - geo.W / 2) * s);
    g.add(drv);
    return g;
  }

  function cabinet(): THREE.Group {
    const s = 0.001;
    const cab = new THREE.Group();
    cab.add(coreGroup());
    if (showPlates) {
      const plateMat = new THREE.MeshStandardMaterial({ color: plateColor, roughness: 0.7, transparent: true, opacity: 0.92 });
      for (const side of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(plateMm * s, geo.H * s, geo.W * s), plateMat);
        p.position.set(side * ((geo.E / 2 + plateMm / 2) * s + explode * 0.35), (geo.H / 2) * s, 0);
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(p.geometry), new THREE.LineBasicMaterial({ color: 0x5b4027 }));
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
    const cabW = (geo.E + 2 * plateMm) * s;
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
    void [geo, plan, plateMm, explode, showPlates, coupled, mouth];
    build();
  });
</script>

<div class="h3d">
  <div class="canvas" bind:this={host}></div>
  <div class="ctl">
    <label class="ex"><span>Plates apart</span><input type="range" min="0" max="1" step="0.01" bind:value={explode} aria-label="Explode plates" /></label>
    <button class="chip" class:on={showPlates} onclick={() => (showPlates = !showPlates)}>Side plates</button>
  </div>
  <div class="hint">Each colour = one printed segment. Drag to orbit.</div>
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
