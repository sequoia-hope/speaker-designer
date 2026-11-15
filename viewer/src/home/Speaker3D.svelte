<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import pc from 'polygon-clipping';
  import { createViewer, sectionCaps, onTap, type Viewer } from './three3d';
  import type { BuildPlan } from './speakerBuild';
  import { pointInPoly, type HeadGeometry, type PrintedModel, type Pt, type RoundWaveguide } from './hybrid';
  import type { DriverInfo } from './drivers';
  import { fmtInFrac } from './roomAcoustics';

  let {
    plan = null,
    printed = null,
    woofer,
    tweeter,
    height = '100%',
    initialExplode = 0,
    showStand = false,
    problems = [],
    onFix = null,
  }: {
    plan?: BuildPlan | null;
    printed?: PrintedModel | null;
    woofer: DriverInfo;
    tweeter: DriverInfo | null;
    height?: string;
    initialExplode?: number;
    showStand?: boolean;
    /** reasons this design can't be built as drawn (shown over the view) */
    problems?: string[];
    /** offer to adjust the design until it can be built */
    onFix?: (() => void) | null;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let viewer: Viewer | null = null;
  let explode = $state(initialExplode);
  let cutaway = $state(false);
  /** where the section cuts across the width: 0 = left side, 1 = right side; null = automatic */
  let cutPos = $state<number | null>(null);
  /** the automatic position for the current model (centre, or the middle of a printed core) */
  let autoCut = $state(0.5);
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
    if (printed) return printedInfo(selected);
    if (!plan) return null;
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
      port: plan?.box.port
        ? {
            title: 'Port tube',
            size: `Ø${plan!.box.port!.diameterMm} mm inside · ${plan!.box.port!.lengthMm.toFixed(0)} mm long`,
            lines: [`Tunes the box to ${plan!.box.port!.fbHz.toFixed(0)} Hz. Keep its inner end ≥ one diameter from any wall.`],
          }
        : { title: '', size: '', lines: [] },
      terminal:
        plan?.box.terminalMm.kind !== 'posts'
          ? { title: 'Terminal cup', size: '75 mm square cut-out', lines: ['Speaker-wire connection. Gasket it — it must be airtight.'] }
          : { title: 'Binding posts', size: 'two holes, 19 mm apart', lines: ['No room for a terminal cup beside the port, so a pair of binding posts. Seal them with a dab of silicone.'] },
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

  // ---------------------------------------------------------------------------
  // 3D-printed cabinets: profile (depth × height) extruded across the width
  // ---------------------------------------------------------------------------
  const PRINT = 0xd4d4d8;

  // Polygon booleans (outline minus chambers, ∩ printed regions, − the driver's wall) are
  // done with polygon-clipping, which handles holes, splits and notches exactly — no
  // zero-width seams or slivers for the renderer or the section slicer to trip over.
  type Ring = [number, number][];
  const ring = (poly: Pt[]): Ring => [...poly.map(([x, y]) => [x, y] as [number, number]), [poly[0][0], poly[0][1]]];
  const rectRing = (x0: number, x1: number, y0: number, y1: number): Ring => ring([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  const open = (r: Ring): Pt[] => r.slice(0, -1).map(([x, y]) => [x, y] as Pt);
  const area = (poly: Pt[]) => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };

  /** Shape (profile mm → m) from an outline and holes, holes kept just inside the outline. */
  function profileShape(outer: Pt[], holes: Pt[][], s: number) {
    const sh = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x * s, y * s)));
    for (const h of holes) {
      if (h.length < 3 || Math.abs(area(h)) < 4) continue;
      sh.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x * s, y * s))));
    }
    return sh;
  }

  /** Extrude a profile shape across the width: profile x → depth (z, front at 0), y up, extrusion along x. */
  function extrudeProfile(shape: THREE.Shape, W: number, x0: number, widthMm: number, m: THREE.Material, id: string) {
    const s = 0.001;
    const mesh = withEdges(new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: widthMm * s, bevelEnabled: false, curveSegments: 6 }), m));
    // shape x → +z, extrusion → −x
    mesh.rotation.y = -Math.PI / 2;
    mesh.position.set((x0 + widthMm) * s, 0, -W * s);
    mesh.userData.partId = id;
    return mesh;
  }

  function roundedSquare(w: number, h: number, r: number, s: number) {
    const sh = new THREE.Shape();
    const [x0, y0, x1, y1, rr] = [(-w / 2) * s, (-h / 2) * s, (w / 2) * s, (h / 2) * s, r * s];
    sh.moveTo(x0 + rr, y0);
    sh.lineTo(x1 - rr, y0);
    sh.absarc(x1 - rr, y0 + rr, rr, -Math.PI / 2, 0, false);
    sh.lineTo(x1, y1 - rr);
    sh.absarc(x1 - rr, y1 - rr, rr, 0, Math.PI / 2, false);
    sh.lineTo(x0 + rr, y1);
    sh.absarc(x0 + rr, y1 - rr, rr, Math.PI / 2, Math.PI, false);
    sh.lineTo(x0, y0 + rr);
    sh.absarc(x0 + rr, y0 + rr, rr, Math.PI, Math.PI * 1.5, false);
    return sh;
  }

  /**
   * A printed round waveguide (from hybrid.roundWaveguide) with its face at z = faceZ:
   * flare surface (throat at the back), a thin flange on the face, and the tweeter's
   * real faceplate + dome sitting flush in the throat recess.
   */
  function waveguideGroup(wg: RoundWaveguide, tw: DriverInfo, faceZ: number, id: string): THREE.Group {
    const s = 0.001;
    const g = new THREE.Group();
    const D = wg.depthMm;
    // a closed section revolved round the axis, so it is a solid (and cuts show plastic):
    // the flare surface throat → mouth lip, the flange on the face, then a straight conical
    // outer wall back to the throat. The flare curves outward (convex), so that straight
    // wall is everywhere at least one wall thickness outside it.
    const [r0] = wg.profile[0];
    const sec: [number, number][] = [
      ...wg.profile,
      [wg.flangeR, D],
      [wg.flangeR, D - 3],
      [wg.R + wg.wallMm, D - 3],
      [r0 + wg.wallMm, 0],
      [r0, 0],
    ];
    // lathe +y → −z after the flip: y = 0 at the face, y = D at the throat
    const pts = sec.map(([r, z]) => new THREE.Vector2(r * s, (D - z) * s));
    const flare = new THREE.Mesh(new THREE.LatheGeometry(pts, 64), mat(PRINT, id, { roughness: 0.5 }));
    flare.rotation.x = Math.PI / 2;
    flare.scale.y = -1;
    flare.position.z = faceZ;
    g.add(flare);
    // tweeter at the throat: its faceplate (r0 is the faceplate + 1 mm) flush in the recess
    const tz = faceZ - D * s;
    const pr = (tw.frameDiaMm / 2) * s;
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr, wg.recessMm * s, 48), mat(0x1c1d21, 'tweeter', { roughness: 0.45 }));
    plate.rotation.x = Math.PI / 2;
    plate.position.z = tz - (wg.recessMm / 2) * s;
    const domeR = Math.min(14, Math.sqrt(tw.sdCm2 / Math.PI) * 10) * s;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(domeR, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x9ca3af, 'tweeter', { roughness: 0.6 }));
    dome.rotation.x = Math.PI / 2;
    dome.position.z = tz;
    const body = new THREE.Mesh(new THREE.CylinderGeometry((tw.cutoutDiaMm / 2 - 1) * s, (tw.cutoutDiaMm / 2 - 1) * s, (tw.mountDepthMm ?? 35) * s, 40), mat(0x2a2c31, 'tweeter', { metalness: 0.5 }));
    body.rotation.x = Math.PI / 2;
    body.position.z = tz - wg.recessMm * s - ((tw.mountDepthMm ?? 35) / 2) * s;
    for (const m of [plate, dome, body]) {
      m.userData.partId = 'tweeter';
      g.add(m);
    }
    flare.userData.partId = id;
    return g;
  }

  /** Printed tweeter pod: rounded body, optional round waveguide, tweeter, soft pad. */
  function headGroup(h: HeadGeometry, frontZ: number, topY: number): THREE.Group {
    const s = 0.001;
    const g = new THREE.Group();
    const r = Math.min(h.w, h.h) * 0.32;
    const wg = h.waveguide;
    const flareD = wg ? wg.depthMm : 0;
    const inner = new THREE.Group();
    // body behind the face; with a waveguide, the front part is a shell round the flare
    const body = withEdges(new THREE.Mesh(new THREE.ExtrudeGeometry(roundedSquare(h.w, h.h, r, s), { depth: (h.d - flareD) * s, bevelEnabled: false, curveSegments: 12 }), mat(PRINT, 'head')));
    body.position.z = frontZ - h.d * s;
    inner.add(body);
    if (wg) {
      const ring = roundedSquare(h.w, h.h, r, s);
      const hole = new THREE.Path();
      hole.absarc(0, 0, (wg.R + wg.wallMm) * s, 0, Math.PI * 2, true);
      ring.holes.push(hole);
      const shell = withEdges(new THREE.Mesh(new THREE.ExtrudeGeometry(ring, { depth: flareD * s, bevelEnabled: false, curveSegments: 48 }), mat(PRINT, 'head')));
      shell.position.z = frontZ - flareD * s;
      inner.add(shell);
      inner.add(waveguideGroup(wg, tweeter!, frontZ, 'head'));
    } else if (tweeter) {
      const tg = new THREE.Group();
      tg.position.z = frontZ;
      addTweeter(tg, tweeter, s, { rebateDepthMm: tweeter.flangeMm ?? 3 });
      inner.add(tg);
    }
    inner.position.y = (3 + h.h / 2) * s;
    inner.traverse((m) => {
      if (!m.userData.partId && (m as THREE.Mesh).isMesh) m.userData.partId = 'head';
    });
    g.add(inner);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(h.w * 0.6 * s, 3 * s, h.d * 0.6 * s), mat(0x111111, 'head', { roughness: 0.9 }));
    pad.position.set(0, 1.5 * s, frontZ - (h.d / 2) * s);
    pad.userData.partId = 'head';
    g.add(pad);
    g.position.y = topY;
    return g;
  }

  function buildPrinted(pm: PrintedModel) {
    if (!viewer) return;
    const s = 0.001;
    const g = pm.geo;
    const p = pm.params;
    const W = g.W;
    const H = g.H;
    const t = g.wallMm;
    const ex = explode * Math.max(W, g.Etot) * s * 0.9;
    const root = new THREE.Group();
    viewer.content.add(root);
    const speaker = new THREE.Group();
    root.add(speaker);

    // the wall the woofer is mounted in, cut out of the profile and drawn on its own with a real hole
    const dv = g.driver;
    const wx0 = dv.face === 'front' ? W - t : dv.x - t / 2;
    const wx1 = dv.face === 'front' ? W : dv.x + t / 2;
    const isAirAt = (x: number, y: number) => !pointInPoly(g.core, x, y) || g.holes.some((h) => pointInPoly(h, x, y));
    // printed regions: whole profile, or only the end caps for "printed bends + plywood walls"
    const regions: [number, number][] = g.construction === 'bends' ? g.caps.map((c) => [c.x0, c.x1]) : [[0, W]];
    const wallCut: Ring = rectRing(wx0, wx1, -1, H + 1);
    let solid = pc.difference([ring(g.core)], ...g.holes.map((h) => [ring(h)] as Ring[]));
    solid = pc.intersection(solid, pc.union(...regions.map(([a, b]) => [rectRing(a, b, -1, H + 1)] as Ring[])));
    solid = pc.difference(solid, [wallCut]);
    const coreShapes = solid.map((poly) => profileShape(open(poly[0]), poly.slice(1).map(open), s));
    // dividers: plate outline minus their cut-outs (notch round the drivers, windows through
    // box chambers) and the driver's wall — nothing left in front of a driver
    const dividerShapes = pc
      .difference([ring(plateOutline(W, H))], ...g.dividerCuts.map((c) => [ring(c)] as Ring[]), [wallCut])
      .map((poly) => profileShape(open(poly[0]), poly.slice(1).map(open), s));
    const printMat = mat(PRINT, 'core', { roughness: 0.6 });
    // cores side by side with plywood dividers between; explode spreads them
    const plate = p.plateMm;
    const coreX = (c: number) => -g.Etot / 2 + c * (g.coreMm + plate);
    const spread = (c: number) => (c - (g.cores - 1) / 2) * ex * 0.25 / s;
    for (let c = 0; c < g.cores; c++) {
      for (const sh of coreShapes) speaker.add(extrudeProfile(sh, W, coreX(c) + spread(c), g.coreMm, printMat, 'core'));
      // plywood strips (bends construction), drawn only where they're not inside a printed cap
      for (const st of g.strips) {
        if (/Driver baffle/.test(st.name)) continue;
        let { x0, x1 } = st.rect;
        for (const cap of g.caps) {
          if (x0 >= cap.x0 && x0 < cap.x1) x0 = cap.x1;
          if (x1 > cap.x0 && x1 <= cap.x1) x1 = cap.x0;
        }
        if (x1 - x0 < 1) continue;
        const b = withEdges(new THREE.Mesh(new THREE.BoxGeometry(g.coreMm * s, (st.rect.y1 - st.rect.y0) * s, (x1 - x0) * s), mat(PLY_FACE, 'strip')));
        b.position.set((coreX(c) + spread(c) + g.coreMm / 2) * s, ((st.rect.y0 + st.rect.y1) / 2) * s, ((x0 + x1) / 2 - W) * s);
        b.userData.partId = 'strip';
        speaker.add(b);
      }
      if (c < g.cores - 1) {
        for (const sh of dividerShapes)
          speaker.add(extrudeProfile(sh, W, coreX(c) + g.coreMm + (spread(c) + spread(c + 1)) / 2, plate, mat(pm.dividerColor ?? PLY_ALT, 'divider'), 'divider'));
      }
    }
    // outer plates
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? -g.Etot / 2 - plate + spread(0) - ex / s : g.Etot / 2 + spread(g.cores - 1) + ex / s;
      speaker.add(extrudeProfile(profileShape(plateOutline(W, H), [], s), W, x0, plate, mat(pm.plateColor, 'plate'), 'plate'));
    }
    // the driver's wall, with its hole: the solid stretches of the profile at that depth, full width
    {
      const xm = (wx0 + wx1) / 2;
      const spans: [number, number][] = [];
      let y0: number | null = null;
      for (let y = 0; y <= H; y += 1) {
        const solid = y < H && !isAirAt(xm, y + 0.5);
        if (solid && y0 === null) y0 = y;
        if (!solid && y0 !== null) {
          spans.push([y0, y]);
          y0 = null;
        }
      }
      const Wt = g.Etot;
      const wood = dv.face === 'internal' && g.strips.some((st) => /Driver baffle/.test(st.name));
      for (const [a, b] of spans) {
        const sh = new THREE.Shape();
        sh.moveTo((-Wt / 2) * s, a * s);
        sh.lineTo((Wt / 2) * s, a * s);
        sh.lineTo((Wt / 2) * s, b * s);
        sh.lineTo((-Wt / 2) * s, b * s);
        const cut = (y: number, rMm: number) => {
          const r = rMm * s;
          if (y * s - r > a * s && y * s + r < b * s) {
            const hole = new THREE.Path();
            hole.absarc(0, y * s, r, 0, Math.PI * 2, true);
            sh.holes.push(hole);
          }
        };
        cut(dv.y, woofer.cutoutDiaMm / 2);
        if (g.tweeter && dv.face === 'front') cut(g.tweeter.y, g.tweeter.holeR);
        const m = withEdges(new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: (wx1 - wx0) * s, bevelEnabled: false, curveSegments: 48 }), mat(wood ? PLY_FACE : PRINT, 'front')));
        m.position.z = (wx0 - W) * s + (dv.face === 'front' ? ex * 0.6 : 0);
        m.userData.partId = 'front';
        speaker.add(m);
      }
    }
    // woofer
    if (showDrivers) {
      const wg = new THREE.Group();
      wg.position.set(0, dv.y * s, (wx1 - W) * s + (dv.face === 'front' ? ex * 1.6 : 0));
      speaker.add(wg);
      addWoofer(wg, woofer, s, { rebateDepthMm: null });
    }
    // tweeter in the front wall (flush, or in a printed waveguide insert)
    if (g.tweeter && showDrivers) {
      const tg = new THREE.Group();
      tg.position.set(0, g.tweeter.y * s, ex * 1.6);
      speaker.add(tg);
      if (g.tweeter.waveguide) tg.add(waveguideGroup(g.tweeter.waveguide, g.tweeter.driver, 0, 'waveguide'));
      else addTweeter(tg, g.tweeter.driver, s, { rebateDepthMm: null });
    }
    // tweeter head on top
    if (pm.head && showDrivers) speaker.add(headGroup(pm.head, -pm.head.setbackMm * s + ex * 0.4, H * s + ex * 0.5));

    // ground grid
    const grid = new THREE.GridHelper(Math.max(1.6, W * s * 3), 16, 0x2b3a5c, 0x1a2541);
    grid.position.set(0, -0.001, -(W * s) / 2);
    root.add(grid);

    // cut through the middle of the core nearest the centre, so the section shows the profile
    const cNear = Array.from({ length: g.cores }, (_, c) => c).sort((a, b) => Math.abs(coreX(a) + g.coreMm / 2) - Math.abs(coreX(b) + g.coreMm / 2))[0];
    const fullW = g.Etot + 2 * plate;
    autoCut = (coreX(cNear) + g.coreMm / 2 + fullW / 2) / fullW;
    clip.constant = (-fullW / 2 + (cutPos ?? autoCut) * fullW) * s;
    if (cutaway) root.add(sectionCaps(root, clip));

    const key = `printed|${W}|${H}|${g.Etot}|${pm.head?.kind ?? ''}`;
    if (key !== framedKey) {
      framedKey = key;
      const b = new THREE.Box3().setFromObject(speaker);
      viewer.frame(b);
    }
    viewer.render();
  }

  /** Outline of the outer plates / dividers: the profile's bounding box, corners rounded. */
  function plateOutline(W: number, H: number): Pt[] {
    const r = Math.min(25, W / 4, H / 4);
    const out: Pt[] = [];
    const corners: [number, number, number][] = [
      [r, r, Math.PI],
      [W - r, r, -Math.PI / 2],
      [W - r, H - r, 0],
      [r, H - r, Math.PI / 2],
    ];
    for (const [cx, cy, a0] of corners)
      for (let i = 0; i <= 6; i++) {
        const a = a0 + (i / 6) * (Math.PI / 2);
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    return out;
  }

  function printedInfo(id: string): { title: string; size: string; lines: string[] } | null {
    if (!printed) return null;
    const g = printed.geo;
    const p = printed.params;
    const m = (x: number) => `${Math.round(x)} mm`;
    const parts: Record<string, { title: string; size: string; lines: string[] }> = {
      core: {
        title: `Printed core${g.cores > 1 ? ` (×${g.cores})` : ''}`,
        size: `${m(g.W)} deep × ${m(g.H)} tall × ${g.coreMm.toFixed(0)} mm thick`,
        lines: [printed.printSummary, `Walls ${p.wallMm} mm. ${g.construction === 'bends' ? 'Only the curved end caps are printed; the straight walls are plywood strips.' : 'The whole inside shape is printed; cut in half to see it.'}`],
      },
      front: {
        title: g.driver.face === 'front' ? 'Front wall (woofer mount)' : 'Driver baffle',
        size: `${(g.driver.face === 'front' ? p.wallMm : g.wallMm).toFixed(0)} mm thick · woofer hole Ø${woofer.cutoutDiaMm} mm`,
        lines: ['Use heat-set M5 inserts (or a printed boss ring) for the woofer screws — plastic threads strip.', 'Seal the woofer with foam gasket tape.'],
      },
      plate: {
        title: 'Side plate (×2)',
        size: `${m(g.W)} × ${m(g.H)} × ${p.plateMm} mm`,
        lines: ['Flat outer skin that closes the printed core; corners rounded to match.', 'Glued and through-bolted to the cores.'],
      },
      divider: {
        title: `Plywood divider${g.cores > 2 ? ` (×${g.cores - 1})` : ''}`,
        size: `${m(g.W)} × ${m(g.H)} × ${p.plateMm} mm`,
        lines: ['Splits the core into thinner prints and stiffens the walls between the plates.', 'Cut away round the woofer (its basket and magnet pass through) and, in a box chamber, a window leaving a 30 mm frame so the air stays one volume.'],
      },
      strip: {
        title: 'Plywood wall strip',
        size: `${g.coreMm.toFixed(0)} mm wide · ${p.wallMm} mm thick`,
        lines: ['A straight wall in plywood, slotted 25 mm into the printed caps at each end. Lengths are in the strip list on the Build tab.'],
      },
      waveguide: g.tweeter?.waveguide
        ? {
            title: `Printed waveguide insert (${g.tweeter.waveguide.coverageDeg}°)`,
            size: `Ø${Math.round(2 * g.tweeter.waveguide.flangeR)} mm flange · ${g.tweeter.waveguide.depthMm.toFixed(0)} mm deep · throat Ø${Math.round(2 * g.tweeter.waveguide.r0)} mm`,
            lines: [
              `An oblate-spheroid flare with a rolled lip; controls the tweeter's spread down to ≈ ${Math.round(g.tweeter.waveguide.controlHz / 100) * 100} Hz, so cross over around there or above.`,
              `Printed as one piece; drops into a Ø${Math.round(2 * g.tweeter.holeR)} mm hole in the front wall and is screwed through its flange. The tweeter mounts from behind, its faceplate flush in the throat recess.`,
            ],
          }
        : { title: '', size: '', lines: [] },
      head: printed.head
        ? {
            title: `Tweeter head (${printed.head.kind === 'waveguide' ? 'waveguide pod' : 'round pod'})`,
            size: `${printed.head.w} × ${printed.head.h} × ${printed.head.d} mm · set back ${printed.head.setbackMm} mm`,
            lines: printed.head.notes,
          }
        : { title: '', size: '', lines: [] },
    };
    if (id === 'woofer')
      return { title: `Woofer — ${woofer.brand} ${woofer.model}`, size: `frame Ø${woofer.frameDiaMm} mm · cut-out Ø${woofer.cutoutDiaMm} mm · ${woofer.mountDepthMm ?? '?'} mm deep`, lines: [woofer.blurb] };
    if (id === 'tweeter' && tweeter) return { title: `Tweeter — ${tweeter.brand} ${tweeter.model}`, size: `faceplate Ø${tweeter.frameDiaMm} mm · cut-out Ø${tweeter.cutoutDiaMm} mm`, lines: [tweeter.blurb] };
    return parts[id]?.title ? parts[id] : null;
  }

  function build() {
    if (!viewer) return;
    viewer.clear();
    if (printed) {
      buildPrinted(printed);
      return;
    }
    if (!plan) return;
    autoCut = 0.5;
    clip.constant = (plan.box.externalMm.w * 0.001) * ((cutPos ?? autoCut) - 0.5);
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
    // back panel with its real cut-outs, at the spots the planner checked for
    // clearance (fitInternals): terminal cup or binding posts, and rear ports
    const rearPort = plan.box.rearPorts.length && plan.box.port ? plan.box.port : null;
    const rearPortXY = plan.box.rearPorts.map((p) => ({ x: p.xMm * s - W / 2, y: H - p.yMm * s }));
    const term = plan.box.terminalMm;
    const termX = term.xMm * s - W / 2;
    const termY = H - term.yMm * s;
    const termHalf = 0.0375;
    const postDx = [-0.0095, 0.0095];
    {
      const shape = new THREE.Shape();
      shape.moveTo(-W / 2, 0);
      shape.lineTo(W / 2, 0);
      shape.lineTo(W / 2, H);
      shape.lineTo(-W / 2, H);
      shape.lineTo(-W / 2, 0);
      if (term.kind === 'cup') {
        const cup = new THREE.Path();
        cup.moveTo(termX - termHalf, termY - termHalf);
        cup.lineTo(termX - termHalf, termY + termHalf);
        cup.lineTo(termX + termHalf, termY + termHalf);
        cup.lineTo(termX + termHalf, termY - termHalf);
        cup.lineTo(termX - termHalf, termY - termHalf);
        shape.holes.push(cup);
      } else {
        for (const dx of postDx) {
          const ph = new THREE.Path();
          ph.absarc(termX + dx, termY, 0.0045, 0, Math.PI * 2, true);
          shape.holes.push(ph);
        }
      }
      if (rearPort)
        for (const p of rearPortXY) {
          const ph = new THREE.Path();
          ph.absarc(p.x, p.y, ((rearPort.diameterMm + 4) * s) / 2, 0, Math.PI * 2, true);
          shape.holes.push(ph);
        }
      const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 48 });
      const m = withEdges(new THREE.Mesh(g, mat(color2, 'back')));
      m.position.z = -D - ex;
      m.userData.partId = 'back';
      speaker.add(m);
    }
    speaker.add(panel('side', color, -W / 2 - ex, -W / 2 + t - ex, 0, H, zb, zf));
    speaker.add(panel('side', color, W / 2 - t + ex, W / 2 + ex, 0, H, zb, zf));
    speaker.add(panel('topbottom', color2, -W / 2 + t, W / 2 - t, H - t + ex, H + ex, zb, zf));
    speaker.add(panel('topbottom', color2, -W / 2 + t, W / 2 - t, -ex * 0.4, t - ex * 0.4, zb, zf));

    // window brace
    if (box.braceFromBaffleMm != null) {
      // front face where the planner put it (clear of magnets and ports)
      const z1 = zf - box.braceFromBaffleMm * s;
      const shape = new THREE.Shape();
      const x0 = -W / 2 + t;
      const x1 = W / 2 - t;
      // above the false floor in a tower
      const y0 = t + (box.deadSpaceMm > 0 ? box.deadSpaceMm * s + t : 0);
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

    // terminal: a cup (flange outside, body recessed through its hole) or two binding posts
    const zBack = -D - ex; // outer face of the back
    const flangeT = 0.003;
    const termParts: THREE.Mesh[] = [];
    if (term.kind === 'cup') {
      const termFlange = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, flangeT), mat(0x222631, 'terminal', { roughness: 0.4 }));
      termFlange.position.set(termX, termY, zBack - flangeT / 2);
      const cupDepth = t + 0.012;
      const termCup = new THREE.Mesh(new THREE.BoxGeometry(termHalf * 2 - 0.002, termHalf * 2 - 0.002, cupDepth), mat(0x1b1e26, 'terminal', { roughness: 0.5 }));
      termCup.position.set(termX, termY, zBack + cupDepth / 2);
      termParts.push(termFlange, termCup);
    }
    for (const [i, dx] of postDx.entries()) {
      const red = i === 0;
      const color = red ? 0xdc2626 : 0x111111;
      // cup: posts stand on the flange; posts-only: a threaded shank through the panel too
      const len = term.kind === 'cup' ? 0.02 : 0.02 + t + 0.006;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(term.kind === 'cup' ? 0.005 : 0.004, term.kind === 'cup' ? 0.005 : 0.004, len, 16), mat(color, 'terminal'));
      post.rotation.x = Math.PI / 2;
      post.position.set(termX + dx * (term.kind === 'cup' ? 1.6 : 1), termY, term.kind === 'cup' ? zBack - flangeT - 0.01 : zBack - 0.02 + len / 2);
      termParts.push(post);
      if (term.kind === 'posts') {
        const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.012, 20), mat(color, 'terminal', { roughness: 0.4 }));
        knob.rotation.x = Math.PI / 2;
        knob.position.set(termX + dx, termY, zBack - 0.008);
        termParts.push(knob);
      }
    }
    for (const m of termParts) {
      m.userData.partId = 'terminal';
      speaker.add(m);
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
      if (rearPort)
        for (const p of rearPortXY) {
          // flipped so the tube runs from the back panel into the box
          const g = new THREE.Group();
          g.position.set(p.x, p.y, -D - ex);
          g.rotation.y = Math.PI;
          speaker.add(g);
          addPort(g, rearPort.diameterMm * s, rearPort.lengthMm * s);
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

    // fill the cut faces so the section reads as solid panels, not hollow shells
    if (cutaway) root.add(sectionCaps(root, clip));

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
    // frame flange: an annulus (open in the middle) so the cone shows through, and a cut-away shows only the rim
    const ringShape = new THREE.Shape();
    ringShape.absarc(0, 0, frameR, 0, Math.PI * 2, false);
    const ringHole = new THREE.Path();
    ringHole.absarc(0, 0, Math.min(coneR + 0.012, frameR - 0.004), 0, Math.PI * 2, true);
    ringShape.holes.push(ringHole);
    const ring = new THREE.Mesh(
      new THREE.ExtrudeGeometry(ringShape, { depth: flange, bevelEnabled: false, curveSegments: 64 }),
      mat(0x202226, 'woofer', { roughness: 0.5, metalness: 0.3 })
    );
    ring.position.z = z0;
    // cone: lathe profile, apex backwards
    const depth = coneR * 0.42;
    const pts = [
      new THREE.Vector2(coneR * 0.22, -depth),
      new THREE.Vector2(coneR * 0.6, -depth * 0.55),
      new THREE.Vector2(coneR, 0),
    ];
    const cone = new THREE.Mesh(new THREE.LatheGeometry(pts, 64), mat(0x2b2b2f, 'woofer', { roughness: 0.9 }));
    cone.rotation.x = Math.PI / 2; // lathe +y → +z, so the -depth apex points into the box
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
    flare.position.z = 0.006; // sits on the panel face, not sunk into the wood
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

  // a different speaker starts with the automatic section again (tweaks to the same one keep it)
  let cutKey = '';
  $effect.pre(() => {
    const k = `${plan?.box.externalMm.w ?? ''}|${printed?.geo.Etot ?? ''}|${printed?.params.type ?? ''}|${printed ? 'p' : 'w'}`;
    if (k !== cutKey) {
      cutKey = k;
      cutPos = null;
    }
  });

  $effect(() => {
    // rebuild on any input change
    void [plan, printed, explode, cutaway, cutPos, showDrivers, selected, showStand, woofer, tweeter];
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
  {#if cutaway}
    <label class="ex cutpos">
      <span>Section</span>
      <input type="range" min="0.02" max="0.98" step="0.005" value={cutPos ?? autoCut} oninput={(e) => (cutPos = +(e.currentTarget as HTMLInputElement).value)} aria-label="Section position" />
      <button class="chip" onclick={() => (cutPos = null)} disabled={cutPos === null}>Centre</button>
    </label>
  {/if}
  {#if problems.length}
    <div class="problems" role="alert">
      <b>Can't be built as drawn</b>
      <ul>{#each problems as pr}<li>{pr}</li>{/each}</ul>
      {#if onFix}<button class="fix" onclick={onFix}>Make it fit — adjust the size for me</button>{/if}
    </div>
  {/if}
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
  .problems {
    background: rgba(244, 63, 94, 0.12);
    border: 1px solid #fb7185;
    border-radius: 10px;
    padding: 8px 11px;
    font-size: 13px;
    color: #fecdd3;
  }
  .problems .fix {
    margin-top: 6px;
    border: 1px solid #fb7185;
    background: rgba(244, 63, 94, 0.2);
    color: #fff1f2;
    border-radius: 999px;
    padding: 6px 12px;
    font: inherit;
    cursor: pointer;
  }
  .problems b {
    color: #fda4af;
  }
  .problems ul {
    margin: 4px 0 0;
    padding-left: 16px;
  }
  .cutpos .chip:disabled {
    opacity: 0.5;
  }
  .hint {
    font-size: 12px;
    color: var(--text-2);
  }
</style>
