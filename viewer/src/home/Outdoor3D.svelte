<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { createViewer, onTap, type Viewer } from './three3d';
  import type { OutdoorRig } from './outdoor';
  import { FILL_CAB, TOP_CAB, TOWER_CAB } from './outdoor';
  import type { SystemSpeaker } from './system';

  let {
    rig,
    mapCanvas,
    mapVersion = 0,
    subShape = null,
    onPick,
  }: {
    rig: OutdoorRig;
    mapCanvas: HTMLCanvasElement | null;
    mapVersion?: number;
    /** optional 2D horn profile (printed hybrid cabinet) drawn on the sub's side plate */
    subShape?: { w: number; h: number; d: number } | null;
    onPick?: (id: string | null) => void;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let viewer: Viewer | null = null;
  let showMap = $state(true);
  let showCrowd = $state(true);
  let floorTex: THREE.CanvasTexture | null = null;
  let framedKey = '';

  // venue → three: x' = x − W/2, y' = z, z' = −(y − Y0) so the crowd is toward +z' from the stage? keep +y → +z'
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x - rig.venue.widthM / 2, z, y - rig.venue.depthM / 2);

  // deterministic pseudo-random for trees / crowd
  function rng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  function box(w: number, h: number, d: number, color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...opts }));
  }

  function speakerMesh(s: SystemSpeaker): THREE.Object3D {
    const g = new THREE.Group();
    g.userData.partId = s.id;
    const yaw = Math.atan2(s.aim.x, s.aim.y);
    const pitch = -Math.asin(Math.max(-1, Math.min(1, s.aim.z)));
    let dims = TOP_CAB;
    let color = 0x2b2b30;
    if (s.role === 'sub') {
      dims = { ...rig.subCab };
      void subShape;
      color = s.invert ? 0x5b4a8a : 0x3a3530;
    } else if (s.role === 'fill' && s.onStage) {
      dims = FILL_CAB;
    } else if (s.role === 'fill') {
      dims = TOWER_CAB;
    } else if (s.role === 'monitor') {
      dims = { w: 0.45, h: 0.3, d: 0.4 };
      color = 0x1f2937;
    }
    const p = P(s.pos.x, s.pos.y, s.pos.z);
    g.position.copy(p);
    g.rotation.order = 'YXZ';
    g.rotation.y = yaw;
    if (s.role !== 'sub') g.rotation.x = pitch;
    const b = box(dims.w, dims.h, dims.d, color);
    // acoustic centre is the front face: shift the box back by half its depth
    b.position.z = -dims.d / 2;
    g.add(b);
    // front face: grille / horn mouth
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(dims.w * 0.9, dims.h * 0.85),
      new THREE.MeshStandardMaterial({ color: s.role === 'sub' ? 0x0d0d0f : 0x111318, roughness: 0.95 })
    );
    face.position.z = 0.002;
    g.add(face);
    if (s.role === 'mains' || (s.role === 'fill' && !s.onStage)) {
      const horn = new THREE.Mesh(new THREE.CylinderGeometry(dims.w * 0.33, dims.w * 0.12, 0.05, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0x4b5563, side: THREE.DoubleSide }));
      horn.rotation.x = Math.PI / 2;
      horn.position.set(0, dims.h * 0.18, 0.02);
      g.add(horn);
    }
    const out = new THREE.Group();
    out.add(g);
    // poles for raised boxes
    if ((s.role === 'mains' || (s.role === 'fill' && !s.onStage)) && s.pos.z > 1.2) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, s.pos.z - dims.h / 2, 10), new THREE.MeshStandardMaterial({ color: 0x9ca3af, metalness: 0.6 }));
      const base = P(s.pos.x, s.pos.y - 0.25, (s.pos.z - dims.h / 2) / 2);
      pole.position.copy(base);
      out.add(pole);
      const feet = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.03, 3), new THREE.MeshStandardMaterial({ color: 0x6b7280 }));
      feet.position.copy(P(s.pos.x, s.pos.y - 0.25, 0.02));
      out.add(feet);
    }
    if (s.role !== 'sub' && s.role !== 'monitor') {
      const aim = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([p, p.clone().add(new THREE.Vector3(s.aim.x, s.aim.z, s.aim.y).multiplyScalar(s.role === 'mains' ? 12 : 6))]),
        new THREE.LineBasicMaterial({ color: s.role === 'mains' ? 0x38bdf8 : 0xfb923c })
      );
      out.add(aim);
    }
    return out;
  }

  function build() {
    if (!viewer) return;
    viewer.clear();
    const W = rig.venue.widthM;
    const D = rig.venue.depthM;
    const g = new THREE.Group();
    viewer.content.add(g);
    const R = Math.hypot(W, D) / 2 + 10;

    // forest floor + clearing
    const ground = new THREE.Mesh(new THREE.CircleGeometry(R + 25, 64), new THREE.MeshStandardMaterial({ color: 0x24361f, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    g.add(ground);
    const clearing = new THREE.Mesh(new THREE.CircleGeometry(R - 3, 64), new THREE.MeshStandardMaterial({ color: 0x3f5a2c, roughness: 1 }));
    clearing.rotation.x = -Math.PI / 2;
    clearing.position.y = -0.01;
    g.add(clearing);
    floorTex = null;
    if (showMap && mapCanvas) {
      const tex = new THREE.CanvasTexture(mapCanvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.LinearFilter;
      floorTex = tex;
      const map = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85 }));
      map.rotation.x = -Math.PI / 2;
      map.position.y = 0.01;
      g.add(map);
    }
    // trees around the clearing
    const rand = rng(7);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3423 });
    const leafMats = [0x1f4d2b, 0x24563a, 0x2f5e2a].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 }));
    for (let i = 0; i < 90; i++) {
      const a = rand() * Math.PI * 2;
      const r = R + rand() * 22;
      const h = 9 + rand() * 12;
      const t = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, h * 0.4, 6), trunkMat);
      trunk.position.y = h * 0.2;
      t.add(trunk);
      const crown = new THREE.Mesh(new THREE.ConeGeometry(2 + rand() * 1.5, h * 0.75, 7), leafMats[i % 3]);
      crown.position.y = h * 0.6;
      t.add(crown);
      t.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      g.add(t);
    }
    // stage deck + DJ booth
    const st = rig.stage;
    const deck = box(st.x1 - st.x0, 0.6, st.y1 - st.y0, 0x3b3128);
    deck.position.copy(P((st.x0 + st.x1) / 2, (st.y0 + st.y1) / 2, 0.3));
    g.add(deck);
    const booth = box(2.2, 1.0, 0.8, 0x1f1b18);
    booth.position.copy(P(rig.dj.x, rig.dj.y + 0.7, 0.6 + 0.5));
    g.add(booth);
    const djHead = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshStandardMaterial({ color: 0xf472b6 }));
    djHead.position.copy(P(rig.dj.x, rig.dj.y, 0.6 + 1.6));
    g.add(djHead);
    // crowd outline + people
    const c = rig.crowd;
    const outline = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([P(c.x0, c.y0, 0.03), P(c.x1, c.y0, 0.03), P(c.x1, c.y1, 0.03), P(c.x0, c.y1, 0.03), P(c.x0, c.y0, 0.03)]),
      new THREE.LineDashedMaterial({ color: 0xf472b6, dashSize: 0.6, gapSize: 0.4 })
    );
    outline.computeLineDistances();
    g.add(outline);
    if (showCrowd) {
      const pr = rng(3);
      const bodyGeo = new THREE.CapsuleGeometry(0.2, 1.1, 4, 8);
      const cols = [0xe2e8f0, 0xfbbf24, 0x60a5fa, 0xf472b6, 0x34d399].map((x) => new THREE.MeshStandardMaterial({ color: x }));
      const n = Math.min(220, Math.round(((c.x1 - c.x0) * (c.y1 - c.y0)) / 5));
      for (let i = 0; i < n; i++) {
        // denser near the front
        const fy = Math.pow(pr(), 1.6);
        const m = new THREE.Mesh(bodyGeo, cols[i % cols.length]);
        m.position.copy(P(c.x0 + pr() * (c.x1 - c.x0), c.y0 + fy * (c.y1 - c.y0), 0.75));
        g.add(m);
      }
    }
    for (const s of rig.speakers) g.add(speakerMesh(s));

    const key = `${W}|${D}`;
    if (key !== framedKey) {
      framedKey = key;
      const b = new THREE.Box3(new THREE.Vector3(-W / 2, 0, -D / 2), new THREE.Vector3(W / 2, 6, D / 2));
      viewer.frame(b, new THREE.Vector3(0.35, 0.85, 1.0));
    }
    viewer.render();
  }

  onMount(() => {
    if (!host) return;
    viewer = createViewer(host);
    viewer.renderer.setClearColor(0x0b1622);
    const off = onTap(viewer.renderer.domElement, (x, y) => {
      const o = viewer?.pick(x, y);
      onPick?.((o?.userData.partId as string) ?? null);
    });
    build();
    return () => {
      off();
      viewer?.dispose();
      viewer = null;
    };
  });

  $effect(() => {
    void [rig, mapCanvas, showMap, showCrowd, subShape];
    build();
  });
  $effect(() => {
    void mapVersion;
    if (floorTex) {
      floorTex.needsUpdate = true;
      viewer?.render();
    }
  });
</script>

<div class="o3d">
  <div class="canvas" bind:this={host}></div>
  <div class="ctl">
    <button class="chip" class:on={showMap} onclick={() => (showMap = !showMap)}>Map on ground</button>
    <button class="chip" class:on={showCrowd} onclick={() => (showCrowd = !showCrowd)}>Crowd</button>
    <span class="hint">Purple subs = rear-facing, polarity-inverted · tap a speaker for its settings</span>
  </div>
</div>

<style>
  .o3d {
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
    min-height: 260px;
    flex: 1 1 auto;
  }
  .ctl {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
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
