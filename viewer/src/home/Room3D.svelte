<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { createViewer, onTap, type Viewer } from './three3d';
  import type { PlacementConfig, ReflectionPoint, RoomConfig, Vec3 } from './roomAcoustics';
  import { listenerPosition } from './roomAcoustics';
  import type { AppShape } from './roomShape';
  import type { SystemSpeaker } from './system';
  import type { Role } from './designs';
  import type { FurnitureItem, Zone } from './furniture';

  export interface SpeakerLook {
    w: number;
    h: number;
    d: number;
    /** tweeter centre below the top of the box (mm) */
    tweeterFromTopMm: number;
    isTower: boolean;
  }

  let {
    room,
    placement,
    shape,
    speakers,
    looks,
    mapCanvas,
    mapVersion = 0,
    reflections,
    showTv = false,
    furniture = [],
    zones = [],
    onPick,
  }: {
    room: RoomConfig;
    placement: PlacementConfig;
    shape: AppShape | null;
    speakers: SystemSpeaker[];
    looks: Record<Role, SpeakerLook>;
    mapCanvas: HTMLCanvasElement | null;
    /** bump to refresh the floor texture without rebuilding the scene (animations) */
    mapVersion?: number;
    reflections: ReflectionPoint[];
    showTv?: boolean;
    furniture?: FurnitureItem[];
    zones?: Zone[];
    onPick?: (id: string | null) => void;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let viewer: Viewer | null = null;
  let showPanels = $state(true);
  let showMap = $state(true);
  let framedKey = '';

  // app coords → three: x' = x − W/2, y' = z (height), z' = y − D/2 (front wall at −D/2)
  const P = (v: Vec3) => new THREE.Vector3(v.x - room.widthM / 2, v.z, v.y - room.depthM / 2);

  let floorTex: THREE.CanvasTexture | null = null;
  function mapTexture() {
    const tex = new THREE.CanvasTexture(mapCanvas!);
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    floorTex = tex;
    return tex;
  }

  function wallPiece(g: THREE.Group, a: THREE.Vector2, b: THREE.Vector2, u0: number, u1: number, v0: number, v1: number, inward: THREE.Vector2, mat: THREE.Material) {
    if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return;
    const dir = b.clone().sub(a).normalize();
    const um = (u0 + u1) / 2;
    const geo = new THREE.PlaneGeometry(u1 - u0, v1 - v0);
    const m = new THREE.Mesh(geo, mat);
    const c = a.clone().add(dir.clone().multiplyScalar(um));
    m.position.set(c.x - room.widthM / 2, (v0 + v1) / 2, c.y - room.depthM / 2);
    // plane normal (+z local) → inward (three x/z)
    m.rotation.y = Math.atan2(inward.x, inward.y);
    g.add(m);
  }

  function buildWalls(g: THREE.Group) {
    const H = room.heightM;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe9e3d8, roughness: 0.95, side: THREE.FrontSide });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd6ff, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35, side: THREE.FrontSide });
    const outline: [number, number][] = shape
      ? shape.outline
      : [
          [0, 0],
          [room.widthM, 0],
          [room.widthM, room.depthM],
          [0, room.depthM],
        ];
    const cx = outline.reduce((s, p) => s + p[0], 0) / outline.length;
    const cy = outline.reduce((s, p) => s + p[1], 0) / outline.length;
    const segs = shape
      ? shape.segments
      : outline.map((p, i) => ({ a: p, b: outline[(i + 1) % outline.length], features: [] as AppShape['segments'][number]['features'] }));
    for (const s of segs) {
      const a = new THREE.Vector2(s.a[0], s.a[1]);
      const b = new THREE.Vector2(s.b[0], s.b[1]);
      const len = a.distanceTo(b);
      const dir = b.clone().sub(a).normalize();
      let inward = new THREE.Vector2(-dir.y, dir.x);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      if (inward.dot(new THREE.Vector2(cx - mid.x, cy - mid.y)) < 0) inward = inward.multiplyScalar(-1);
      const feats = [...s.features].sort((p, q) => p.centerM - q.centerM);
      let u = 0;
      for (const f of feats) {
        const f0 = Math.max(0, f.centerM - f.widthM / 2);
        const f1 = Math.min(len, f.centerM + f.widthM / 2);
        wallPiece(g, a, b, u, f0, 0, H, inward, wallMat);
        wallPiece(g, a, b, f0, f1, 0, f.sillM, inward, wallMat);
        wallPiece(g, a, b, f0, f1, Math.min(f.headM, H), H, inward, wallMat);
        if (f.kind === 'window') wallPiece(g, a, b, f0, f1, f.sillM, Math.min(f.headM, H), inward, glassMat);
        u = f1;
      }
      wallPiece(g, a, b, u, len, 0, H, inward, wallMat);
    }
    // outline at floor and ceiling
    const lineMat = new THREE.LineBasicMaterial({ color: 0x94a3b8 });
    for (const y of [0.001, H]) {
      const pts = [...outline, outline[0]].map(([x, z]) => new THREE.Vector3(x - room.widthM / 2, y, z - room.depthM / 2));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }
    // plain floor under the whole outline (the bay etc.)
    const fs = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x - room.widthM / 2, -(y - room.depthM / 2))));
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(fs), new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.002;
    g.add(floor);
  }

  function speakerMesh(s: SystemSpeaker): THREE.Group {
    const look = looks[s.role];
    const w = look.w / 1000;
    const h = look.h / 1000;
    const d = look.d / 1000;
    const g = new THREE.Group();
    g.userData.partId = s.id;
    const wood = new THREE.MeshStandardMaterial({ color: s.role === 'sub' ? 0x7c5c3c : 0xcfa874, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c1d21 });
    const p = P(s.pos);
    g.position.copy(p);
    // orientation: local +z = speaker front
    const yaw = Math.atan2(s.aim.x, s.aim.y);
    const pitch = -Math.asin(Math.max(-1, Math.min(1, s.aim.z)));
    g.rotation.order = 'YXZ';
    g.rotation.y = yaw;
    // vertical placement of the box centre relative to s.pos (pos = acoustic centre for stands, floor point for floor/console)
    let cy = 0;
    let standH = 0;
    if (s.mount === 'stand') {
      const tweeterY = placement.earHeightM;
      const bottom = tweeterY - (h - look.tweeterFromTopMm / 1000);
      g.position.y = 0;
      cy = bottom + h / 2;
      standH = bottom;
    } else if (s.mount === 'floor') {
      g.position.y = 0;
      cy = h / 2;
    } else if (s.mount === 'console') {
      g.position.y = 0;
      const bottom = Math.max(0.45, s.pos.z - h / 2);
      cy = bottom + h / 2;
      const console_ = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w + 0.4, 1.4), bottom, 0.42), new THREE.MeshStandardMaterial({ color: 0x3f3a36 }));
      console_.position.set(0, bottom / 2, -0.21 + d / 2);
      g.add(console_);
    } else if (s.mount === 'ceiling') {
      g.position.y = room.heightM;
      cy = -h / 2 - 0.02;
    } else {
      // wall: box hangs on the wall at s.pos height
      cy = 0;
    }
    const tilt = new THREE.Group();
    tilt.position.y = cy;
    if (s.mount === 'wall' || s.mount === 'ceiling' || s.mount === 'console') tilt.rotation.x = pitch;
    g.add(tilt);
    // box: front face at local z = 0 (stand/floor) — wall/ceiling boxes sit centred
    const zOff = s.mount === 'wall' || s.mount === 'ceiling' ? 0 : -d / 2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wood);
    body.position.z = zOff;
    tilt.add(body);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.97, h * 0.97), new THREE.MeshStandardMaterial({ color: 0xb48c58 }));
    face.position.z = zOff + d / 2 + 0.001;
    tilt.add(face);
    if (s.role === 'sub') {
      const cone = new THREE.Mesh(new THREE.CircleGeometry(Math.min(w, h) * 0.38, 40), dark);
      cone.position.z = zOff + d / 2 + 0.002;
      tilt.add(cone);
    } else if (look.isTower || h > w * 1.2 || w > h * 1.2) {
      const horiz = w > h * 1.2;
      const n = 2;
      for (let i = 0; i < n; i++) {
        const c = new THREE.Mesh(new THREE.CircleGeometry(Math.min(w, h) * (horiz ? 0.36 : 0.34), 32), dark);
        if (horiz) c.position.set((i === 0 ? -1 : 1) * w * 0.3, 0, zOff + d / 2 + 0.002);
        else c.position.set(0, h / 2 - look.tweeterFromTopMm / 1000 - (i + 1) * w * 0.78, zOff + d / 2 + 0.002);
        tilt.add(c);
      }
      const tw = new THREE.Mesh(new THREE.CircleGeometry(0.04, 24), new THREE.MeshStandardMaterial({ color: 0x9ca3af }));
      tw.position.set(0, horiz ? 0 : h / 2 - look.tweeterFromTopMm / 1000, zOff + d / 2 + 0.003);
      tilt.add(tw);
    } else {
      const tw = new THREE.Mesh(new THREE.CircleGeometry(0.035, 24), new THREE.MeshStandardMaterial({ color: 0x9ca3af }));
      tw.position.set(0, h / 2 - look.tweeterFromTopMm / 1000, zOff + d / 2 + 0.003);
      tilt.add(tw);
      const wf = new THREE.Mesh(new THREE.CircleGeometry(w * 0.36, 32), dark);
      wf.position.set(0, h / 2 - look.tweeterFromTopMm / 1000 - 0.05 - w * 0.4, zOff + d / 2 + 0.002);
      tilt.add(wf);
    }
    if (standH > 0.05) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.15, standH, 0.15), new THREE.MeshStandardMaterial({ color: 0x8a6a48 }));
      col.position.set(0, standH / 2, -d / 2);
      g.add(col);
      const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.018, d + 0.08), new THREE.MeshStandardMaterial({ color: 0x8a6a48 }));
      base.position.set(0, 0.009, -d / 2);
      g.add(base);
    }
    // aim line
    if (s.role !== 'sub') {
      const aim = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, zOff + d / 2), new THREE.Vector3(0, 0, zOff + d / 2 + 1.2)]),
        new THREE.LineBasicMaterial({ color: s.role === 'fill' ? 0xfb923c : s.role === 'height' || s.role === 'surround' ? 0xa78bfa : 0x38bdf8 })
      );
      tilt.add(aim);
    }
    return g;
  }

  function build() {
    if (!viewer) return;
    viewer.clear();
    const W = room.widthM;
    const D = room.depthM;
    const g = new THREE.Group();
    viewer.content.add(g);
    buildWalls(g);

    floorTex = null;
    if (showMap && mapCanvas) {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ map: mapTexture(), transparent: true, opacity: 0.88 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = 0.002;
      g.add(floor);
    }

    for (const s of speakers) g.add(speakerMesh(s));

    if (showTv) {
      const tv = new THREE.Mesh(new THREE.BoxGeometry(1.23, 0.71, 0.04), new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.3 }));
      tv.position.set(0, 1.25, -D / 2 + 0.05);
      g.add(tv);
    }

    // listener + sofa
    const ear = listenerPosition(room, placement);
    const e = P(ear);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 16), new THREE.MeshStandardMaterial({ color: 0x34d399 }));
    head.position.copy(e);
    g.add(head);
    const sofaMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.95 });
    for (const f of furniture) {
      const w = f.x1 - f.x0;
      const d = f.y1 - f.y0;
      const cx = (f.x0 + f.x1) / 2 - room.widthM / 2;
      const cz = (f.y0 + f.y1) / 2 - room.depthM / 2;
      const seat = new THREE.Mesh(new THREE.BoxGeometry(w, f.seatH, d), sofaMat);
      seat.position.set(cx, f.seatH / 2, cz);
      g.add(seat);
      const bt = 0.2;
      const back =
        f.back === 'back'
          ? new THREE.Mesh(new THREE.BoxGeometry(w, f.backH - f.seatH, bt), sofaMat)
          : new THREE.Mesh(new THREE.BoxGeometry(bt, f.backH - f.seatH, f.kind === 'chaise' ? d * 0.45 : d), sofaMat);
      const by = f.seatH + (f.backH - f.seatH) / 2;
      if (f.back === 'back') back.position.set(cx, by, f.y1 - room.depthM / 2 - bt / 2);
      else {
        const bx = f.back === 'left' ? f.x0 - room.widthM / 2 + bt / 2 : f.x1 - room.widthM / 2 - bt / 2;
        // a chaise has its backrest at the end nearest the back of the room
        back.position.set(bx, by, f.kind === 'chaise' ? f.y1 - room.depthM / 2 - d * 0.225 : cz);
      }
      g.add(back);
    }
    for (const z of zones) {
      if (z.id !== 'dance') continue;
      const pts = [
        [z.x0, z.y0],
        [z.x1, z.y0],
        [z.x1, z.y1],
        [z.x0, z.y1],
        [z.x0, z.y0],
      ].map(([x, y]) => new THREE.Vector3(x - room.widthM / 2, 0.012, y - room.depthM / 2));
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xf472b6, dashSize: 0.12, gapSize: 0.08 }));
      l.computeLineDistances();
      g.add(l);
    }

    const mains = speakers.filter((s) => s.role === 'mains');
    if (mains.length === 2) {
      const tri = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([P({ ...mains[0].pos, z: placement.earHeightM }), e, P({ ...mains[1].pos, z: placement.earHeightM }), P({ ...mains[0].pos, z: placement.earHeightM })]),
        new THREE.LineDashedMaterial({ color: 0xe2e8f0, dashSize: 0.08, gapSize: 0.06 })
      );
      tri.computeLineDistances();
      g.add(tri);
    }

    if (showPanels) {
      const panelMat = new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 1, transparent: true, opacity: 0.85 });
      for (const r of reflections) {
        if (r.surface === 'floor' || r.surface === 'front wall') continue;
        const p = P(r.at);
        let m: THREE.Mesh;
        if (r.surface === 'ceiling') {
          m = new THREE.Mesh(new THREE.BoxGeometry(0.61, 0.08, 1.22), panelMat);
          m.position.set(p.x, room.heightM - 0.05, p.z);
        } else {
          m = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.22, 0.61), panelMat);
          const x = r.surface === 'left wall' ? -W / 2 + 0.045 : W / 2 - 0.045;
          m.position.set(x, Math.max(p.y, 0.62), p.z);
        }
        g.add(m);
      }
    }

    const key = `${W}|${D}|${room.heightM}`;
    if (key !== framedKey) {
      framedKey = key;
      const b = new THREE.Box3(new THREE.Vector3(-W / 2, 0, -D / 2 - 0.2), new THREE.Vector3(W / 2, room.heightM, D / 2));
      viewer.frame(b, new THREE.Vector3(0.55, 1.05, 1.15));
    }
    viewer.render();
  }

  onMount(() => {
    if (!host) return;
    viewer = createViewer(host);
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
    void [JSON.stringify(room), JSON.stringify(placement), shape, speakers, looks, mapCanvas, reflections, showPanels, showMap, showTv, furniture, zones];
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

<div class="r3d">
  <div class="canvas" bind:this={host}></div>
  <div class="ctl">
    <button class="chip" class:on={showMap} onclick={() => (showMap = !showMap)}>Map on floor</button>
    <button class="chip" class:on={showPanels} onclick={() => (showPanels = !showPanels)}>Absorption panels</button>
    <span class="hint">Tap a speaker to open its design · yellow = 2′×4′ panels</span>
  </div>
</div>

<style>
  .r3d {
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
