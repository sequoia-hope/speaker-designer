<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { createViewer, onTap, type Viewer } from './three3d';
  import type { BuildPlan } from './speakerBuild';
  import type { DriverInfo } from './drivers';
  import { fmtInFrac } from './roomAcoustics';

  let {
    plan,
    woofer,
    tweeter,
    height = '100%',
    initialExplode = 0,
    showStand = false,
  }: {
    plan: BuildPlan;
    woofer: DriverInfo;
    tweeter: DriverInfo | null;
    height?: string;
    initialExplode?: number;
    showStand?: boolean;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let viewer: Viewer | null = null;
  let explode = $state(initialExplode);
  let cutaway = $state(false);
  let showDrivers = $state(true);
  let selected = $state<string | null>(null);
  let framedKey = '';

  const PLY_FACE = 0xcfa874;
  const PLY_ALT = 0xc39a63;
  const MDF = 0x9c7a55;
  const clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);

  // part metadata for the info card
  const info = $derived.by(() => {
    if (!selected) return null;
    const p = [...plan.panels, ...(plan.stand?.panels ?? [])].find((x) => x.id === selected);
    if (p) {
      const ops = plan.panelOps.find((o) => o.panelId === p.id)?.ops ?? [];
      return {
        title: `${p.name}${p.qtyPerBox > 1 ? ` (×${p.qtyPerBox} per speaker)` : ''}`,
        size: `${fmtInFrac(p.lengthMm)} × ${fmtInFrac(p.widthMm)} × ${fmtInFrac(p.thicknessMm)} · ${Math.round(p.lengthMm)} × ${Math.round(p.widthMm)} × ${p.thicknessMm} mm`,
        lines: [...p.notes, ...ops.slice(1).map((o) => o.replace(/^\s*•\s*/, '↳ '))],
      };
    }
    const misc: Record<string, { title: string; size: string; lines: string[] }> = {
      woofer: {
        title: `Woofer — ${woofer.brand} ${woofer.model}`,
        size: `frame Ø${woofer.frameDiaMm} mm · cut-out Ø${woofer.cutoutDiaMm} mm · ${woofer.mountDepthMm ?? '?'} mm deep`,
        lines: [woofer.blurb],
      },
      tweeter: tweeter
        ? {
            title: `Tweeter — ${tweeter.brand} ${tweeter.model}`,
            size: `faceplate Ø${tweeter.frameDiaMm} mm · cut-out Ø${tweeter.cutoutDiaMm} mm`,
            lines: [tweeter.blurb],
          }
        : { title: '', size: '', lines: [] },
      port: plan.box.port
        ? {
            title: 'Port tube',
            size: `Ø${plan.box.port.diameterMm} mm inside · ${plan.box.port.lengthMm.toFixed(0)} mm long`,
            lines: [`Tunes the box to ${plan.box.port.fbHz.toFixed(0)} Hz. Keep its inner end ≥ one diameter from any wall.`],
          }
        : { title: '', size: '', lines: [] },
      terminal: { title: 'Terminal cup', size: '', lines: ['Speaker-wire connection. Gasket it — it must be airtight.'] },
    };
    return misc[selected] ?? null;
  });

  function mat(color: number, id: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.78,
      metalness: 0.02,
      side: THREE.DoubleSide,
      clippingPlanes: cutaway ? [clip] : [],
      ...opts,
    });
    if (selected && id === selected) {
      m.emissive = new THREE.Color(0x38bdf8);
      m.emissiveIntensity = 0.45;
    }
    return m;
  }

  function withEdges(mesh: THREE.Mesh) {
    const e = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 25),
      new THREE.LineBasicMaterial({ color: 0x3b2a18, transparent: true, opacity: 0.55, clippingPlanes: cutaway ? [clip] : [] })
    );
    mesh.add(e);
    return mesh;
  }

  /** Box panel from min/max corners in metres. */
  function panel(id: string, color: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    const m = withEdges(new THREE.Mesh(g, mat(color, id)));
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    m.userData.partId = id;
    return m;
  }

  function build() {
    if (!viewer) return;
    viewer.clear();
    const s = 0.001; // mm → m
    const box = plan.box;
    const W = box.externalMm.w * s;
    const H = box.externalMm.h * s;
    const D = box.externalMm.d * s;
    const t = box.wallMm * s;
    const bt = box.baffleMm * s;
    const color = plan.material.id.startsWith('mdf') ? MDF : PLY_FACE;
    const color2 = plan.material.id.startsWith('mdf') ? MDF : PLY_ALT;
    const ex = explode * Math.max(W, D) * 0.9;
    const root = new THREE.Group();
    viewer.content.add(root);

    const standH = showStand && plan.stand ? plan.stand.heightMm * s : 0;
    const speaker = new THREE.Group();
    speaker.position.y = standH;
    root.add(speaker);

    // ---- baffle: layered so each rebate has its true depth ----
    const holes = plan.holes;
    const depths = [...new Set(holes.filter((h) => h.rebateDepthMm).map((h) => (h.rebateDepthMm as number) * s))].sort((a, b) => a - b);
    const layers: [number, number][] = [];
    let prev = 0;
    for (const d of depths) {
      if (d > prev && d < t) {
        layers.push([prev, d]);
        prev = d;
      }
    }
    layers.push([prev, t]);
    const baffleGroup = new THREE.Group();
    baffleGroup.userData.partId = 'baffle';
    for (const [a, b] of layers) {
      const shape = new THREE.Shape();
      shape.moveTo(-W / 2, 0);
      shape.lineTo(W / 2, 0);
      shape.lineTo(W / 2, H);
      shape.lineTo(-W / 2, H);
      shape.lineTo(-W / 2, 0);
      for (const h of holes) {
        const useRebate = h.rebateDiaMm && h.rebateDepthMm && h.rebateDepthMm * s >= b - 1e-6;
        const r = ((useRebate ? h.rebateDiaMm : h.throughDiaMm) as number) * s / 2;
        const p = new THREE.Path();
        p.absarc(h.xMm * s - W / 2, H - h.yMm * s, r, 0, Math.PI * 2, true);
        shape.holes.push(p);
      }
      const g = new THREE.ExtrudeGeometry(shape, { depth: b - a, bevelEnabled: false, curveSegments: 48 });
      const m = withEdges(new THREE.Mesh(g, mat(color, 'baffle')));
      m.position.z = -b;
      m.userData.partId = 'baffle';
      baffleGroup.add(m);
    }
    // screw holes: dark dots on the rebate floor / face
    for (const h of holes) {
      if (!h.screwPcdMm || !h.screwCount) continue;
      for (let i = 0; i < h.screwCount; i++) {
        const ang = (i / h.screwCount) * Math.PI * 2 + Math.PI / 4;
        const dot = new THREE.Mesh(new THREE.CircleGeometry(2.2 * s, 12), new THREE.MeshBasicMaterial({ color: 0x1b1208, side: THREE.DoubleSide }));
        dot.position.set(h.xMm * s - W / 2 + Math.cos(ang) * (h.screwPcdMm * s) / 2, H - h.yMm * s + Math.sin(ang) * (h.screwPcdMm * s) / 2, -(h.rebateDepthMm ?? 0) * s + 0.0005);
        baffleGroup.add(dot);
      }
    }
    baffleGroup.position.z = ex * 1.0;
    speaker.add(baffleGroup);

    if (bt > t + 1e-6) {
      // inner baffle layer (through-holes only)
      const shape = new THREE.Shape();
      shape.moveTo(-W / 2, 0);
      shape.lineTo(W / 2, 0);
      shape.lineTo(W / 2, H);
      shape.lineTo(-W / 2, H);
      for (const h of holes) {
        const p = new THREE.Path();
        p.absarc(h.xMm * s - W / 2, H - h.yMm * s, (h.throughDiaMm * s) / 2, 0, Math.PI * 2, true);
        shape.holes.push(p);
      }
      const g = new THREE.ExtrudeGeometry(shape, { depth: bt - t, bevelEnabled: false, curveSegments: 48 });
      const m = withEdges(new THREE.Mesh(g, mat(color2, 'baffle2')));
      m.position.z = -bt + ex * 0.6;
      m.userData.partId = 'baffle2';
      speaker.add(m);
    }

    // ---- shell ----
    const zf = -bt; // inside face of the baffle
    const zb = -D + t; // inside face of the back
    speaker.add(panel('back', color2, -W / 2, W / 2, 0, H, -D - ex, -D + t - ex));
    speaker.add(panel('side', color, -W / 2 - ex, -W / 2 + t - ex, 0, H, zb, zf));
    if (!cutaway) speaker.add(panel('side', color, W / 2 - t + ex, W / 2 + ex, 0, H, zb, zf));
    speaker.add(panel('topbottom', color2, -W / 2 + t, W / 2 - t, H - t + ex, H + ex, zb, zf));
    speaker.add(panel('topbottom', color2, -W / 2 + t, W / 2 - t, -ex * 0.4, t - ex * 0.4, zb, zf));

    // window brace
    if (plan.panels.some((p) => p.id === 'brace')) {
      const innerD = D - bt - t;
      const z1 = zf - innerD / 2;
      const shape = new THREE.Shape();
      const x0 = -W / 2 + t;
      const x1 = W / 2 - t;
      const y0 = t;
      const y1 = H - t;
      shape.moveTo(x0, y0);
      shape.lineTo(x1, y0);
      shape.lineTo(x1, y1);
      shape.lineTo(x0, y1);
      const f = 0.038;
      const win = new THREE.Path();
      win.moveTo(x0 + f, y0 + f);
      win.lineTo(x0 + f, y1 - f);
      win.lineTo(x1 - f, y1 - f);
      win.lineTo(x1 - f, y0 + f);
      shape.holes.push(win);
      const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
      const m = withEdges(new THREE.Mesh(g, mat(0xb08ad8, 'brace')));
      m.position.z = z1 - t;
      m.userData.partId = 'brace';
      speaker.add(m);
    }

    // tower false floor (sand below)
    if (box.deadSpaceMm > 0) {
      const y0 = t + box.deadSpaceMm * s;
      speaker.add(panel('divider', 0x8f6b45, -W / 2 + t, W / 2 - t, y0, y0 + t, zb, zf));
      const sand = new THREE.Mesh(new THREE.BoxGeometry(W - 2 * t - 0.004, box.deadSpaceMm * s - 0.004, -zf + zb - 0.004 < 0 ? zf - zb - 0.004 : 0.01), mat(0xd9c38f, 'divider', { transparent: true, opacity: 0.55 }));
      sand.position.set(0, t + (box.deadSpaceMm * s) / 2, (zb + zf) / 2);
      sand.userData.partId = 'divider';
      speaker.add(sand);
    }

    // terminal cup on the back
    const term = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.02), mat(0x222631, 'terminal', { roughness: 0.4 }));
    term.position.set(0, H / 3, -D - ex - 0.002);
    term.userData.partId = 'terminal';
    speaker.add(term);
    for (const dx of [-0.015, 0.015]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.02, 16), mat(dx < 0 ? 0xdc2626 : 0x111111, 'terminal'));
      post.rotation.x = Math.PI / 2;
      post.position.set(dx, H / 3, -D - ex - 0.014);
      post.userData.partId = 'terminal';
      speaker.add(post);
    }

    // ---- drivers ----
    if (showDrivers) {
      for (const h of holes) {
        const cx = h.xMm * s - W / 2;
        const cy = H - h.yMm * s;
        const g = new THREE.Group();
        g.position.set(cx, cy, ex * (h.kind === 'port' ? 1.0 : 1.9));
        speaker.add(g);
        if (h.kind === 'woofer') addWoofer(g, woofer, s, h);
        else if (h.kind === 'tweeter' && tweeter) addTweeter(g, tweeter, s, h);
        else if (h.kind === 'port' && plan.box.port) addPort(g, plan.box.port.diameterMm * s, plan.box.port.lengthMm * s);
      }
    }

    // ---- stand ----
    if (showStand && plan.stand) {
      const st = plan.stand;
      const C = st.columnMm * s;
      const base = st.panels.find((p) => p.id === 'stand-base')!;
      const bw = base.widthMm * s;
      const bd = base.lengthMm * s;
      const zc = -D / 2;
      root.add(panel('stand-top', color, -W / 2, W / 2, standH - t, standH, -D, 0));
      root.add(panel('stand-base', color2, -bw / 2, bw / 2, 0, t, zc - bd / 2, zc + bd / 2));
      root.add(panel('stand-colA', color, -C / 2, C / 2, t, standH - t, zc + C / 2 - t, zc + C / 2));
      root.add(panel('stand-colA', color, -C / 2, C / 2, t, standH - t, zc - C / 2, zc - C / 2 + t));
      root.add(panel('stand-colB', color2, -C / 2, -C / 2 + t, t, standH - t, zc - C / 2 + t, zc + C / 2 - t));
      root.add(panel('stand-colB', color2, C / 2 - t, C / 2, t, standH - t, zc - C / 2 + t, zc + C / 2 - t));
    }

    // ground grid for scale (10 cm squares)
    const grid = new THREE.GridHelper(1.6, 16, 0x2b3a5c, 0x1a2541);
    grid.position.set(0, -0.001, -D / 2);
    root.add(grid);

    const key = `${W}|${H}|${D}|${showStand}`;
    if (key !== framedKey) {
      framedKey = key;
      const b = new THREE.Box3().setFromObject(speaker);
      if (showStand) b.expandByObject(root);
      viewer.frame(b);
    }
    viewer.render();
  }

  function addWoofer(g: THREE.Group, d: DriverInfo, s: number, h: { rebateDepthMm: number | null }) {
    const flange = (d.flangeMm ?? 6) * s;
    const frameR = (d.frameDiaMm * s) / 2;
    const coneR = Math.sqrt(d.sdCm2 / 1e4 / Math.PI);
    const z0 = -(h.rebateDepthMm ?? 0) * s; // flange sits in the rebate
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(frameR, frameR, flange, 64, 1, false), mat(0x202226, 'woofer', { roughness: 0.5, metalness: 0.3 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.z = z0 + flange / 2;
    // cone: lathe profile, apex backwards
    const depth = coneR * 0.42;
    const pts = [
      new THREE.Vector2(coneR * 0.22, -depth),
      new THREE.Vector2(coneR * 0.6, -depth * 0.55),
      new THREE.Vector2(coneR, 0),
    ];
    const cone = new THREE.Mesh(new THREE.LatheGeometry(pts, 64), mat(0x2b2b2f, 'woofer', { roughness: 0.9 }));
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = z0 + flange;
    const surround = new THREE.Mesh(new THREE.TorusGeometry(coneR + 0.006, 0.006, 10, 64, Math.PI), mat(0x151517, 'woofer'));
    surround.position.z = z0 + flange;
    const surround2 = surround.clone();
    surround2.rotation.z = Math.PI;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(coneR * 0.24, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2.6), mat(0x3a3a40, 'woofer'));
    cap.rotation.x = Math.PI / 2;
    cap.position.z = z0 + flange - depth * 1.05;
    // basket + magnet behind the baffle
    const md = (d.mountDepthMm ?? 80) * s;
    const basket = new THREE.Mesh(new THREE.CylinderGeometry((d.cutoutDiaMm * s) / 2 - 0.002, frameR * 0.42, md * 0.55, 32, 1, true), mat(0x3a3d44, 'woofer', { metalness: 0.5, roughness: 0.4, wireframe: false }));
    basket.rotation.x = Math.PI / 2;
    basket.position.z = z0 - md * 0.275;
    const magnet = new THREE.Mesh(new THREE.CylinderGeometry(frameR * 0.5, frameR * 0.5, md * 0.4, 48), mat(0x18191c, 'woofer', { metalness: 0.6, roughness: 0.35 }));
    magnet.rotation.x = Math.PI / 2;
    magnet.position.z = z0 - md * 0.75;
    for (const m of [ring, cone, surround, surround2, cap, basket, magnet]) {
      m.userData.partId = 'woofer';
      g.add(m);
    }
  }

  function addTweeter(g: THREE.Group, d: DriverInfo, s: number, h: { rebateDepthMm: number | null }) {
    const flange = (d.flangeMm ?? 4) * s;
    const z0 = -(h.rebateDepthMm ?? 0) * s;
    const plate = new THREE.Mesh(new THREE.CylinderGeometry((d.frameDiaMm * s) / 2, (d.frameDiaMm * s) / 2, flange, 64), mat(0x1c1d21, 'tweeter', { roughness: 0.45 }));
    plate.rotation.x = Math.PI / 2;
    plate.position.z = z0 + flange / 2;
    const domeR = Math.sqrt(d.sdCm2 / 1e4 / Math.PI);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(domeR, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x9ca3af, 'tweeter', { roughness: 0.6 }));
    dome.rotation.x = Math.PI / 2;
    dome.position.z = z0 + flange;
    const md = (d.mountDepthMm ?? 35) * s;
    const body = new THREE.Mesh(new THREE.CylinderGeometry((d.cutoutDiaMm * s) / 2 - 0.001, (d.cutoutDiaMm * s) / 2 - 0.001, md, 48), mat(0x2a2c31, 'tweeter', { metalness: 0.5 }));
    body.rotation.x = Math.PI / 2;
    body.position.z = z0 - md / 2;
    for (const m of [plate, dome, body]) {
      m.userData.partId = 'tweeter';
      g.add(m);
    }
  }

  function addPort(g: THREE.Group, dia: number, len: number) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(dia / 2 + 0.002, dia / 2 + 0.002, len, 40, 1, true), mat(0x1f2937, 'port', { roughness: 0.6 }));
    tube.rotation.x = Math.PI / 2;
    tube.position.z = -len / 2;
    const flare = new THREE.Mesh(new THREE.TorusGeometry(dia / 2 + 0.006, 0.006, 10, 40), mat(0x111827, 'port'));
    flare.position.z = 0.002;
    for (const m of [tube, flare]) {
      m.userData.partId = 'port';
      g.add(m);
    }
  }

  onMount(() => {
    if (!host) return;
    viewer = createViewer(host, { clipping: true });
    const off = onTap(viewer.renderer.domElement, (x, y) => {
      const o = viewer?.pick(x, y);
      selected = (o?.userData.partId as string) ?? null;
    });
    build();
    return () => {
      off();
      viewer?.dispose();
      viewer = null;
    };
  });

  $effect(() => {
    // rebuild on any input change
    void [plan, explode, cutaway, showDrivers, selected, showStand, woofer, tweeter];
    build();
  });
</script>

<div class="s3d">
  <div class="canvas" bind:this={host} style:height></div>
  <div class="ctl">
    <label class="ex">
      <span>Explode</span>
      <input type="range" min="0" max="1" step="0.01" bind:value={explode} aria-label="Explode speaker" />
    </label>
    <button class="chip" class:on={cutaway} onclick={() => (cutaway = !cutaway)}>Cut in half</button>
    <button class="chip" class:on={showDrivers} onclick={() => (showDrivers = !showDrivers)}>Drivers</button>
  </div>
  {#if info}
    <div class="info">
      <button class="x" aria-label="Close part info" onclick={() => (selected = null)}>✕</button>
      <b>{info.title}</b>
      {#if info.size}<div class="sz">{info.size}</div>{/if}
      <ul>{#each info.lines as l}<li>{l}</li>{/each}</ul>
    </div>
  {:else}
    <div class="hint">Drag to orbit · pinch to zoom · tap a part to see what it is and how to make it.</div>
  {/if}
</div>

<style>
  .s3d {
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
  .info {
    position: relative;
    background: var(--bg-2);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 9px 30px 9px 11px;
    font-size: 13px;
    color: var(--text-1);
    max-height: 30vh;
    overflow-y: auto;
  }
  .info b {
    color: var(--text-0);
  }
  .info .sz {
    color: var(--amber);
    font-size: 12.5px;
    margin-top: 2px;
  }
  .info ul {
    margin: 4px 0 0;
    padding-left: 16px;
  }
  .info li {
    margin: 2px 0;
  }
  .x {
    position: absolute;
    right: 6px;
    top: 6px;
    background: none;
    border: none;
    color: var(--text-2);
    font-size: 15px;
    cursor: pointer;
  }
  .hint {
    font-size: 12px;
    color: var(--text-2);
  }
</style>
