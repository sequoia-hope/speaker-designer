<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
  import type {
    SimulationBundle,
    SimulatedVariant,
    Transform3,
    VisualCabinetModel,
    VisualSubMesh,
  } from '../types';
  import { splNormalizedToRgb, wavePressureToRgb, formatFreq } from '../colormaps';

  interface Props {
    bundle: SimulationBundle;
    variant: SimulatedVariant;
    activeMicIdx: number;
    viewMode?: 'venue' | 'cutaway';
    selectedCabIdx?: number;
    onSelectCab?: (idx: number) => void;
    onOpenCadTab?: () => void;
  }

  let {
    bundle,
    variant,
    activeMicIdx,
    viewMode = $bindable<'venue' | 'cutaway'>('venue'),
    selectedCabIdx = 0,
    onSelectCab,
    onOpenCadTab,
  }: Props = $props();

  let containerEl = $state<HTMLDivElement | null>(null);
  let fieldMode = $state<'spl' | 'phase' | 'transient'>('spl');
  let sliceFreqIdx = $state(1);
  let balloonFreqIdx = $state(6);
  let transientFrameIdx = $state(6);
  let isPlayingWave = $state(false);
  let relief3d = $state(true);

  // 3D Solid Cabinet CAD controls
  let sectionAxis = $state<'x' | 'z' | 'y' | 'none'>('x');
  let sectionRatio = $state(0.0); // -0.95 .. +0.95 across selected axis
  let explodeAmount = $state(0.0); // 0.0 .. 1.0
  let shellOpacity = $state(0.76);
  let showBalloon = $state(false);

  let showShell = $state(true);
  let showBaffle = $state(true);
  let showInternals = $state(true);
  let showBracing = $state(true);
  let showDamping = $state(true);
  let showDrivers = $state(true);

  let hoveredPart = $state<VisualSubMesh | null>(null);
  let lastBundleForBalloon = '';

  $effect(() => {
    const nSlices = variant.spatial_field.slice_freqs_hz.length;
    if (sliceFreqIdx >= nSlices) sliceFreqIdx = Math.max(0, Math.min(1, nSlices - 1));
    const bFreqs = variant.directivity.balloon_freqs_hz;
    if (lastBundleForBalloon !== bundle.id && bFreqs.length > 0) {
      lastBundleForBalloon = bundle.id;
      const target = bFreqs[bFreqs.length - 1] > 1500 ? 2500 : 63;
      let best = 0;
      for (let i = 1; i < bFreqs.length; i++) {
        if (Math.abs(bFreqs[i] - target) < Math.abs(bFreqs[best] - target)) best = i;
      }
      balloonFreqIdx = best;
    } else if (balloonFreqIdx >= bFreqs.length) {
      balloonFreqIdx = Math.max(0, bFreqs.length - 1);
    }
    const nFrames = variant.spatial_field.transient_frames.length;
    if (transientFrameIdx >= nFrames) transientFrameIdx = Math.max(0, Math.min(6, nFrames - 1));
  });

  const activeCab = $derived(
    bundle.cabinet_models[selectedCabIdx] ?? bundle.cabinet_models[0] ?? null
  );

  const currentSliceFreq = $derived(
    variant.spatial_field.slice_freqs_hz[sliceFreqIdx] ?? 50
  );
  const currentBalloonFreq = $derived(
    variant.directivity.balloon_freqs_hz[balloonFreqIdx] ?? 1000
  );
  const currentTransientMs = $derived(
    variant.spatial_field.transient_times_ms[transientFrameIdx] ?? 0
  );

  const splRange = $derived.by(() => {
    const arr = variant.spatial_field.spl_slices_db[sliceFreqIdx] ?? [];
    let hi = -Infinity;
    for (const v of arr) if (Number.isFinite(v) && v > hi) hi = v;
    if (!Number.isFinite(hi)) hi = 115;
    return [hi - 28, hi] as const;
  });

  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controls: OrbitControls | null = null;
  let contentGroup: THREE.Group | null = null;
  let fieldMesh: THREE.Mesh | null = null;
  let pickableMeshes: THREE.Mesh[] = [];
  let lastCameraKey = '';

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  function transformToMatrix4(t: Transform3): THREE.Matrix4 {
    const yr = (t.yaw_deg * Math.PI) / 180;
    const pr = (t.pitch_deg * Math.PI) / 180;
    const rr = (t.roll_deg * Math.PI) / 180;
    const sy = Math.sin(yr),
      cy = Math.cos(yr);
    const sp = Math.sin(pr),
      cp = Math.cos(pr);
    const sr = Math.sin(rr),
      cr = Math.cos(rr);

    const m = new THREE.Matrix4();
    m.set(
      cy * cr - sy * sp * sr,
      -sy * cp,
      cy * sr + sy * sp * cr,
      t.position.x,
      sy * cr + cy * sp * sr,
      cy * cp,
      sy * sr - cy * sp * cr,
      t.position.y,
      -cp * sr,
      sp,
      cp * cr,
      t.position.z,
      0,
      0,
      0,
      1
    );
    return m;
  }

  function isSubmeshLayerVisible(sm: VisualSubMesh): boolean {
    switch (sm.layer) {
      case 'outer_shell':
      case 'hardware':
        return showShell;
      case 'front_baffle':
        return showBaffle;
      case 'internal_horn':
      case 'port_waveguide':
        return showInternals;
      case 'bracing':
        return showBracing;
      case 'damping':
        return showDamping;
      case 'driver_motor':
      case 'driver_cone':
        return showDrivers;
      default:
        return true;
    }
  }

  function computeClipPlane(cab: VisualCabinetModel): THREE.Plane | null {
    if (sectionAxis === 'none') return null;
    const [w, d, h] = cab.dims_m;
    if (sectionAxis === 'x') {
      const c = sectionRatio * 0.5 * w;
      return new THREE.Plane(new THREE.Vector3(-1, 0, 0), c);
    }
    if (sectionAxis === 'z') {
      const c = (0.5 + 0.48 * sectionRatio) * h;
      return new THREE.Plane(new THREE.Vector3(0, 0, -1), c);
    }
    const c = sectionRatio * 0.5 * d;
    return new THREE.Plane(new THREE.Vector3(0, -1, 0), c);
  }

  function sectionStrokeRgb(sm: VisualSubMesh): [number, number, number] {
    switch (sm.layer) {
      case 'outer_shell':
        return [0.98, 0.78, 0.36];
      case 'front_baffle':
        return [0.35, 0.82, 0.99];
      case 'internal_horn':
        return [0.99, 0.68, 0.25];
      case 'bracing':
        return [0.76, 0.56, 0.99];
      case 'port_waveguide':
        return [0.22, 0.91, 0.65];
      case 'damping':
        return [0.98, 0.44, 0.52];
      case 'driver_cone':
        return [0.99, 0.58, 0.18];
      default:
        return [0.92, 0.96, 1.0];
    }
  }

  /**
   * Intersect every visible solid submesh triangle against `clipPlane` (`n · p + constant = 0`)
   * so real finite wall thicknesses (`18 mm`, `22 mm`, `28 mm`), rabbet joints, horn folds,
   * window braces, waveguides, cones, voice coils, and magnet plates glow crisply right on the 3D cut plane!
   */
  function buildSectionCutContours(
    cab: VisualCabinetModel,
    plane: THREE.Plane,
    explode: number
  ): THREE.Group {
    const grp = new THREE.Group();
    const linePos: number[] = [];
    const lineCol: number[] = [];
    const nx = plane.normal.x;
    const ny = plane.normal.y;
    const nz = plane.normal.z;
    const c = plane.constant;
    // Slight nudge toward viewer (`-normal`) prevents Z-fighting with solid wall faces
    const epsX = -nx * 0.0007;
    const epsY = -ny * 0.0007;
    const epsZ = -nz * 0.0007;

    for (const sm of cab.submeshes) {
      if (!isSubmeshLayerVisible(sm)) continue;
      const pos = sm.positions;
      const idx = sm.indices;
      if (pos.length < 9 || idx.length < 3) continue;
      const ox = (sm.explode_offset_m?.[0] ?? 0) * explode;
      const oy = (sm.explode_offset_m?.[1] ?? 0) * explode;
      const oz = (sm.explode_offset_m?.[2] ?? 0) * explode;
      const [cr, cg, cb] = sectionStrokeRgb(sm);

      for (let t = 0; t + 2 < idx.length; t += 3) {
        const i0 = idx[t] * 3;
        const i1 = idx[t + 1] * 3;
        const i2 = idx[t + 2] * 3;

        const x0 = pos[i0] + ox,
          y0 = pos[i0 + 1] + oy,
          z0 = pos[i0 + 2] + oz;
        const x1 = pos[i1] + ox,
          y1 = pos[i1 + 1] + oy,
          z1 = pos[i1 + 2] + oz;
        const x2 = pos[i2] + ox,
          y2 = pos[i2 + 1] + oy,
          z2 = pos[i2 + 2] + oz;

        const d0 = nx * x0 + ny * y0 + nz * z0 + c;
        const d1 = nx * x1 + ny * y1 + nz * z1 + c;
        const d2 = nx * x2 + ny * y2 + nz * z2 + c;

        if ((d0 > 0 && d1 > 0 && d2 > 0) || (d0 < 0 && d1 < 0 && d2 < 0)) continue;

        const hits: number[] = [];
        const edgeHit = (
          ax: number,
          ay: number,
          az: number,
          da: number,
          bx: number,
          by: number,
          bz: number,
          db: number
        ) => {
          if ((da >= 0 && db < 0) || (da < 0 && db >= 0)) {
            const denom = da - db;
            if (Math.abs(denom) > 1e-12) {
              const u = da / denom;
              hits.push(ax + u * (bx - ax), ay + u * (by - ay), az + u * (bz - az));
            }
          }
        };
        edgeHit(x0, y0, z0, d0, x1, y1, z1, d1);
        edgeHit(x1, y1, z1, d1, x2, y2, z2, d2);
        edgeHit(x2, y2, z2, d2, x0, y0, z0, d0);

        if (hits.length >= 6) {
          linePos.push(
            hits[0] + epsX,
            hits[1] + epsY,
            hits[2] + epsZ,
            hits[3] + epsX,
            hits[4] + epsY,
            hits[5] + epsZ
          );
          lineCol.push(cr, cg, cb, cr, cg, cb);
        }
      }
    }

    if (linePos.length >= 6) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(lineCol, 3));
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.96,
      });
      const segs = new THREE.LineSegments(geo, mat);
      segs.renderOrder = 6;
      grp.add(segs);
    }

    // Subtle CAD laser section-plane boundary frame
    const [w, d, h] = cab.dims_m;
    const pad = 0.05 * Math.max(w, d, h);
    let framePts: THREE.Vector3[] = [];
    if (sectionAxis === 'x') {
      const x = c;
      framePts = [
        new THREE.Vector3(x, -0.5 * d - pad, -pad * 0.3),
        new THREE.Vector3(x, 0.5 * d + pad, -pad * 0.3),
        new THREE.Vector3(x, 0.5 * d + pad, h + pad),
        new THREE.Vector3(x, -0.5 * d - pad, h + pad),
      ];
    } else if (sectionAxis === 'z') {
      const z = c;
      framePts = [
        new THREE.Vector3(-0.5 * w - pad, -0.5 * d - pad, z),
        new THREE.Vector3(0.5 * w + pad, -0.5 * d - pad, z),
        new THREE.Vector3(0.5 * w + pad, 0.5 * d + pad, z),
        new THREE.Vector3(-0.5 * w - pad, 0.5 * d + pad, z),
      ];
    } else {
      const y = c;
      framePts = [
        new THREE.Vector3(-0.5 * w - pad, y, -pad * 0.3),
        new THREE.Vector3(0.5 * w + pad, y, -pad * 0.3),
        new THREE.Vector3(0.5 * w + pad, y, h + pad),
        new THREE.Vector3(-0.5 * w - pad, y, h + pad),
      ];
    }
    const fGeo = new THREE.BufferGeometry().setFromPoints([...framePts, framePts[0]]);
    const fLine = new THREE.Line(
      fGeo,
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.38 })
    );
    grp.add(fLine);

    return grp;
  }

  function buildCabinetObject(
    cabModel: VisualCabinetModel,
    cutawayAlpha: number,
    withWireframe: boolean,
    clipPlane: THREE.Plane | null,
    explode: number,
    collectPickables: boolean
  ): THREE.Group {
    const grp = new THREE.Group();
    const clips = clipPlane ? [clipPlane] : [];

    for (const sm of cabModel.submeshes) {
      if (collectPickables && !isSubmeshLayerVisible(sm)) continue;
      if (sm.positions.length < 9 || sm.indices.length < 3) continue;

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(sm.positions, 3));
      if (sm.normals.length === sm.positions.length) {
        geom.setAttribute('normal', new THREE.Float32BufferAttribute(sm.normals, 3));
      } else {
        geom.computeVertexNormals();
      }
      geom.setIndex(sm.indices);

      const isOuter = sm.role === 'shell' || sm.role === 'baffle';
      const baseOp = isOuter
        ? Math.min(1, cutawayAlpha + (sm.role === 'baffle' ? 0.1 : 0) + explode * 0.25)
        : Math.min(1, sm.opacity);
      const transparent = baseOp < 0.98;
      const isMetal =
        sm.role === 'motor' ||
        sm.role === 'cone' ||
        sm.material_name.toLowerCase().includes('aluminum');

      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(sm.color_hex),
        roughness: isMetal ? 0.34 : 0.62,
        metalness: isMetal ? 0.42 : 0.08,
        transparent,
        opacity: baseOp,
        side: THREE.DoubleSide,
        depthWrite: !transparent || baseOp > 0.65,
        clippingPlanes: clips,
        clipShadows: true,
      });

      const partGrp = new THREE.Group();
      if (explode > 0 && sm.explode_offset_m) {
        partGrp.position.set(
          sm.explode_offset_m[0] * explode,
          sm.explode_offset_m[1] * explode,
          sm.explode_offset_m[2] * explode
        );
      }

      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.submesh = sm;
      mesh.renderOrder = isOuter && transparent ? 3 : 1;
      partGrp.add(mesh);

      if (collectPickables) {
        pickableMeshes.push(mesh);
      }

      if (withWireframe && (isOuter || sm.role === 'internal_horn' || sm.role === 'brace')) {
        const edges = new THREE.EdgesGeometry(geom, 28);
        const lineMat = new THREE.LineBasicMaterial({
          color: isOuter ? 0x60a5fa : 0xfbbf24,
          transparent: true,
          opacity: isOuter ? 0.28 : 0.32,
          clippingPlanes: clips,
        });
        partGrp.add(new THREE.LineSegments(edges, lineMat));
      }

      grp.add(partGrp);
    }
    return grp;
  }

  function disposeGroup(grp: THREE.Object3D) {
    grp.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else {
          mesh.material.dispose();
        }
      }
    });
  }

  function rebuildScene() {
    if (!scene || !camera || !controls) return;

    if (contentGroup) {
      scene.remove(contentGroup);
      disposeGroup(contentGroup);
    }
    contentGroup = new THREE.Group();
    fieldMesh = null;
    pickableMeshes = [];
    hoveredPart = null;
    scene.add(contentGroup);

    if (viewMode === 'venue') {
      buildVenueScene(contentGroup);
    } else {
      buildCutawayScene(contentGroup);
    }
  }

  function buildVenueScene(root: THREE.Group) {
    const sf = variant.spatial_field;
    const [xmin, xmax, ymin, ymax] = sf.bounds_m;
    const cx = 0.5 * (xmin + xmax);
    const cy = 0.5 * (ymin + ymax);
    const spanX = Math.max(2, xmax - xmin);
    const spanY = Math.max(2, ymax - ymin);
    const maxSpan = Math.max(spanX, spanY);

    const camKey = `venue:${bundle.id}`;
    if (camera && controls && lastCameraKey !== camKey) {
      lastCameraKey = camKey;
      const aspectScale = camera.aspect < 1.35 ? 1.35 / Math.max(0.75, camera.aspect) : 1.0;
      camera.position.set(
        cx + maxSpan * 0.62 * aspectScale,
        cy - maxSpan * 0.68 * aspectScale,
        maxSpan * 0.48 * aspectScale
      );
      controls.target.set(cx, cy, 0.8);
      controls.update();
    }

    const groundGeo = new THREE.PlaneGeometry(spanX * 1.06, spanY * 1.06);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x09101f,
      roughness: 0.92,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.set(cx, cy, -0.02);
    root.add(ground);

    const gridDivs = Math.min(44, Math.max(12, Math.round(maxSpan / 1.5)));
    const grid = new THREE.GridHelper(maxSpan * 1.06, gridDivs, 0x2c426e, 0x16223b);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(cx, cy, -0.005);
    root.add(grid);

    if (sf.nx >= 2 && sf.ny >= 2) {
      const geo = new THREE.BufferGeometry();
      const nVerts = sf.nx * sf.ny;
      const positions = new Float32Array(nVerts * 3);
      const colors = new Float32Array(nVerts * 3);
      const indices: number[] = [];

      for (let iy = 0; iy < sf.ny; iy++) {
        const y = ymin + ((ymax - ymin) * iy) / (sf.ny - 1);
        for (let ix = 0; ix < sf.nx; ix++) {
          const x = xmin + ((xmax - xmin) * ix) / (sf.nx - 1);
          const idx = (iy * sf.nx + ix) * 3;
          positions[idx] = x;
          positions[idx + 1] = y;
          positions[idx + 2] = sf.z_ear_m * 0.2;
        }
      }
      for (let iy = 0; iy < sf.ny - 1; iy++) {
        for (let ix = 0; ix < sf.nx - 1; ix++) {
          const a = iy * sf.nx + ix;
          const b = a + 1;
          const c = a + sf.nx;
          const d = c + 1;
          indices.push(a, b, d, a, d, c);
        }
      }

      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.setIndex(indices);

      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.84,
        side: THREE.DoubleSide,
      });
      fieldMesh = new THREE.Mesh(geo, mat);
      fieldMesh.renderOrder = 1;
      root.add(fieldMesh);
      updateFieldMeshColors();
    }

    const modelMap = new Map<string, VisualCabinetModel>();
    for (const m of bundle.cabinet_models) modelMap.set(m.model_id, m);

    const arrowLen = Math.max(0.65, maxSpan * 0.085);
    for (const pl of variant.placements) {
      const model = modelMap.get(pl.cabinet_spec_id);
      if (!model) continue;
      const cabObj = buildCabinetObject(model, 0.86, false, null, 0, false);
      const mat4 = transformToMatrix4(pl.transform);
      cabObj.applyMatrix4(mat4);
      root.add(cabObj);

      const origin = new THREE.Vector3(
        0,
        model.dims_m[1] * 0.5,
        model.dims_m[2] * 0.5
      ).applyMatrix4(mat4);
      const tip = new THREE.Vector3(
        0,
        model.dims_m[1] * 0.5 + arrowLen,
        model.dims_m[2] * 0.5
      ).applyMatrix4(mat4);
      const dir = tip.clone().sub(origin).normalize();
      const arrow = new THREE.ArrowHelper(
        dir,
        origin,
        arrowLen,
        0x38bdf8,
        arrowLen * 0.22,
        arrowLen * 0.11
      );
      root.add(arrow);
    }

    for (const z of bundle.zones) {
      const zw = Math.max(0.2, z.x_max_m - z.x_min_m);
      const zd = Math.max(0.2, z.y_max_m - z.y_min_m);
      const zcx = 0.5 * (z.x_min_m + z.x_max_m);
      const zcy = 0.5 * (z.y_min_m + z.y_max_m);
      const color =
        z.role === 'sweet_spot'
          ? 0x34d399
          : z.role === 'stage_quiet'
            ? 0xfbbf24
            : 0xa78bfa;

      const boxGeo = new THREE.BoxGeometry(zw, zd, 0.06);
      const edges = new THREE.EdgesGeometry(boxGeo);
      boxGeo.dispose();
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
      );
      line.position.set(zcx, zcy, Math.max(0.18, z.z_ear_m * 0.45));
      root.add(line);
    }

    const pinRadius = Math.max(0.08, maxSpan * 0.011);
    variant.virtual_mics.forEach((vm, idx) => {
      const isSelected = idx === activeMicIdx;
      const sphGeo = new THREE.SphereGeometry(isSelected ? pinRadius * 1.45 : pinRadius, 18, 14);
      const sphMat = new THREE.MeshBasicMaterial({
        color: isSelected ? 0xfbbf24 : 0x38bdf8,
      });
      const pin = new THREE.Mesh(sphGeo, sphMat);
      pin.position.set(vm.position_m[0], vm.position_m[1], Math.max(0.3, vm.position_m[2] * 0.55));
      root.add(pin);
    });
  }

  function updateFieldMeshColors() {
    if (!fieldMesh) return;
    const sf = variant.spatial_field;
    const geo = fieldMesh.geometry;
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = geo.getAttribute('color') as THREE.BufferAttribute;
    if (!posAttr || !colAttr) return;

    const maxSpan = Math.max(sf.bounds_m[1] - sf.bounds_m[0], sf.bounds_m[3] - sf.bounds_m[2]);
    const reliefAmp = relief3d ? maxSpan * 0.045 : 0;
    const baseZ = Math.min(0.25, sf.z_ear_m * 0.22);

    const n = sf.nx * sf.ny;
    if (fieldMode === 'spl') {
      const slice = sf.spl_slices_db[sliceFreqIdx] ?? [];
      const [lo, hi] = splRange;
      for (let i = 0; i < n; i++) {
        const db = slice[i] ?? lo;
        const u = Math.max(0, Math.min(1, (db - lo) / Math.max(1e-6, hi - lo)));
        const [r, g, b] = splNormalizedToRgb(u);
        colAttr.setXYZ(i, r, g, b);
        posAttr.setZ(i, baseZ + u * reliefAmp);
      }
    } else if (fieldMode === 'phase') {
      const slice = sf.wave_real_slices[sliceFreqIdx] ?? [];
      for (let i = 0; i < n; i++) {
        const w = slice[i] ?? 0;
        const [r, g, b] = wavePressureToRgb(w);
        colAttr.setXYZ(i, r, g, b);
        posAttr.setZ(i, baseZ + 0.45 * w * reliefAmp);
      }
    } else {
      const frame = sf.transient_frames[transientFrameIdx] ?? [];
      let pk = 1e-6;
      for (let i = 0; i < frame.length; i++) {
        const a = Math.abs(frame[i]);
        if (a > pk) pk = a;
      }
      for (let i = 0; i < n; i++) {
        const w = (frame[i] ?? 0) / pk;
        const [r, g, b] = wavePressureToRgb(w);
        colAttr.setXYZ(i, r, g, b);
        posAttr.setZ(i, baseZ + 0.65 * w * reliefAmp);
      }
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  function buildCutawayScene(root: THREE.Group) {
    const cab = activeCab;
    if (!cab) return;

    const maxDim = Math.max(...cab.dims_m, 0.35);
    const cz = cab.dims_m[2] * 0.5;
    const camKey = `cutaway:${bundle.id}:${cab.model_id}`;
    if (camera && controls && lastCameraKey !== camKey) {
      lastCameraKey = camKey;
      const aspectScale = camera.aspect < 1.35 ? 1.35 / Math.max(0.75, camera.aspect) : 1.0;
      camera.position.set(
        maxDim * 1.88 * aspectScale,
        maxDim * 1.55 * aspectScale,
        cz + maxDim * 0.72 * aspectScale
      );
      controls.target.set(0, 0, cz * 0.96);
      controls.update();
    }

    const pedGrid = new THREE.GridHelper(maxDim * 3.8, 16, 0x2c426e, 0x16223b);
    pedGrid.rotation.x = Math.PI / 2;
    pedGrid.position.set(0, 0, 0);
    root.add(pedGrid);

    const clipPlane = computeClipPlane(cab);
    const cabObj = buildCabinetObject(cab, shellOpacity, true, clipPlane, explodeAmount, true);
    root.add(cabObj);

    if (clipPlane) {
      root.add(buildSectionCutContours(cab, clipPlane, explodeAmount));
    }

    // Optional 3D Directivity Polar Balloon overlay
    const dir = variant.directivity;
    if (
      showBalloon &&
      dir.theta_deg.length >= 2 &&
      dir.phi_deg.length >= 3 &&
      dir.balloon_spl_db[balloonFreqIdx]
    ) {
      const nT = dir.theta_deg.length;
      const nP = dir.phi_deg.length;
      const vals = dir.balloon_spl_db[balloonFreqIdx];
      let maxDb = -Infinity;
      for (const v of vals) if (v > maxDb) maxDb = v;
      const minDb = maxDb - 26;
      const isHemisphere = (dir.theta_deg[dir.theta_deg.length - 1] ?? 180) <= 95;
      const zOrigin = isHemisphere ? 0.02 : cz;
      const balloonRadius = maxDim * (isHemisphere ? 1.55 : 1.35);

      const positions: number[] = [];
      const colors: number[] = [];
      const indices: number[] = [];

      for (let it = 0; it < nT; it++) {
        const th = (dir.theta_deg[it] * Math.PI) / 180;
        for (let ip = 0; ip <= nP; ip++) {
          const ipWrap = ip % nP;
          const ph = (dir.phi_deg[ipWrap] * Math.PI) / 180;
          const db = vals[it * nP + ipWrap] ?? minDb;
          const norm = Math.max(0.12, Math.min(1, (db - minDb) / 26));
          const r = balloonRadius * norm;

          const x = r * Math.sin(th) * Math.cos(ph);
          const y = r * Math.sin(th) * Math.sin(ph);
          const z = zOrigin + r * Math.cos(th);
          positions.push(x, y, z);

          const [cr, cg, cb] = splNormalizedToRgb(norm);
          colors.push(cr, cg, cb);
        }
      }

      const cols = nP + 1;
      for (let it = 0; it < nT - 1; it++) {
        for (let ip = 0; ip < nP; ip++) {
          const a = it * cols + ip;
          const b = a + 1;
          const c = a + cols;
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }

      const bGeo = new THREE.BufferGeometry();
      bGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      bGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      bGeo.setIndex(indices);
      bGeo.computeVertexNormals();

      const bMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.44,
        roughness: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const balloonMesh = new THREE.Mesh(bGeo, bMat);
      balloonMesh.renderOrder = 4;
      root.add(balloonMesh);

      const wireMat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        wireframe: true,
        transparent: true,
        opacity: 0.22,
      });
      root.add(new THREE.Mesh(bGeo.clone(), wireMat));
    }
  }

  let pointerDownPos = { x: 0, y: 0 };

  function resetCameraView() {
    lastCameraKey = '';
    rebuildScene();
  }

  function pickPartAt(clientX: number, clientY: number) {
    if (viewMode !== 'cutaway' || !renderer || !camera || pickableMeshes.length === 0) {
      if (hoveredPart) hoveredPart = null;
      return;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointerNdc.y = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObjects(pickableMeshes, false);

    // Filter out hits on the clipped side of active section plane!
    const clip = activeCab ? computeClipPlane(activeCab) : null;
    const validHit = hits.find((h) => !clip || clip.distanceToPoint(h.point) >= -0.001);
    const nextPart = (validHit?.object?.userData?.submesh as VisualSubMesh | undefined) ?? null;
    if (nextPart?.part_id !== hoveredPart?.part_id) {
      hoveredPart = nextPart;
      for (const m of pickableMeshes) {
        const mat = m.material as THREE.MeshStandardMaterial;
        const isHi = nextPart && m.userData.submesh?.part_id === nextPart.part_id;
        mat.emissive.setHex(isHi ? 0x3b2a0a : 0x000000);
      }
    }
  }

  function handlePointerDown(ev: PointerEvent) {
    pointerDownPos = { x: ev.clientX, y: ev.clientY };
  }

  function handlePointerUp(ev: PointerEvent) {
    if (ev.pointerType !== 'mouse') {
      const dist = Math.hypot(ev.clientX - pointerDownPos.x, ev.clientY - pointerDownPos.y);
      if (dist < 9) {
        pickPartAt(ev.clientX, ev.clientY);
      }
    }
  }

  function handlePointerMove(ev: PointerEvent) {
    if (ev.pointerType !== 'mouse') return;
    pickPartAt(ev.clientX, ev.clientY);
  }

  $effect(() => {
    void bundle;
    void variant;
    void viewMode;
    void sectionAxis;
    void sectionRatio;
    void explodeAmount;
    void shellOpacity;
    void showShell;
    void showBaffle;
    void showInternals;
    void showBracing;
    void showDamping;
    void showDrivers;
    void showBalloon;
    void balloonFreqIdx;
    void selectedCabIdx;
    void activeMicIdx;
    rebuildScene();
  });

  $effect(() => {
    void fieldMode;
    void sliceFreqIdx;
    void transientFrameIdx;
    void relief3d;
    if (viewMode === 'venue') {
      updateFieldMeshColors();
    }
  });

  $effect(() => {
    if (!isPlayingWave) return;
    const nFrames = variant.spatial_field.transient_frames.length;
    if (nFrames < 2) return;
    const id = window.setInterval(() => {
      transientFrameIdx = (transientFrameIdx + 1) % nFrames;
    }, 65);
    return () => window.clearInterval(id);
  });

  onMount(() => {
    if (!containerEl) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060a13);

    const w = Math.max(320, containerEl.clientWidth);
    const h = Math.max(260, containerEl.clientHeight);
    camera = new THREE.PerspectiveCamera(42, w / h, 0.02, 500);
    camera.up.set(0, 0, 1);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.localClippingEnabled = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.5));
    renderer.setSize(w, h);
    renderer.domElement.style.touchAction = 'none';
    containerEl.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const amb = new THREE.AmbientLight(0xdbeafe, 0.9);
    scene.add(amb);
    const dir1 = new THREE.DirectionalLight(0xffffff, 1.25);
    dir1.position.set(14, 16, 22);
    scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0x60a5fa, 0.65);
    dir2.position.set(-16, -15, 10);
    scene.add(dir2);

    rebuildScene();

    let animId = 0;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls?.update();
      if (renderer && scene && camera) {
        renderer.render(scene, camera);
      }
    };
    animate();

    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || !renderer || !camera) return;
      const nw = Math.max(200, rect.width);
      const nh = Math.max(200, rect.height);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    });
    ro.observe(containerEl);

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
      if (contentGroup && scene) {
        scene.remove(contentGroup);
        disposeGroup(contentGroup);
      }
      controls?.dispose();
      renderer?.dispose();
    };
  });
</script>

<div class="viewport-shell">
  <div class="vp-toolbar">
    <div class="seg-group">
      <button
        class:active={viewMode === 'venue'}
        onclick={() => (viewMode = 'venue')}
      >
        3D Venue &amp; Sound Field
      </button>
      <button
        class:active={viewMode === 'cutaway'}
        onclick={() => (viewMode = 'cutaway')}
      >
        3D Cabinet CAD &amp; Section Cut
      </button>
    </div>

    {#if viewMode === 'venue'}
      <div class="seg-group">
        <button
          class:active={fieldMode === 'spl'}
          onclick={() => {
            isPlayingWave = false;
            fieldMode = 'spl';
          }}
        >
          SPL Heatmap
        </button>
        <button
          class:active={fieldMode === 'phase'}
          onclick={() => {
            isPlayingWave = false;
            fieldMode = 'phase';
          }}
        >
          Wave Phase
        </button>
        <button
          class:active={fieldMode === 'transient'}
          onclick={() => (fieldMode = 'transient')}
        >
          EDM Kick Pulse
        </button>
      </div>

      <label class="chk">
        <input type="checkbox" bind:checked={relief3d} />
        <span>3D Relief</span>
      </label>

      <button class="reset-cam-btn" onclick={resetCameraView} title="Re-center 3D camera">
        ⟳ Frame
      </button>
    {:else}
      {#if bundle.cabinet_models.length > 1}
        <select
          class="cab-select"
          value={selectedCabIdx}
          onchange={(e) => {
            const idx = Number((e.currentTarget as HTMLSelectElement).value);
            onSelectCab?.(idx);
          }}
        >
          {#each bundle.cabinet_models as cm, idx}
            <option value={idx}>{cm.title}</option>
          {/each}
        </select>
      {/if}

      <div class="seg-group">
        <button class:active={sectionAxis === 'x'} onclick={() => { sectionAxis = 'x'; sectionRatio = 0; }}>
          Side Cut X
        </button>
        <button class:active={sectionAxis === 'z'} onclick={() => { sectionAxis = 'z'; sectionRatio = 0; }}>
          Plan Cut Z
        </button>
        <button class:active={sectionAxis === 'y'} onclick={() => { sectionAxis = 'y'; sectionRatio = 0.25; }}>
          Depth Cut Y
        </button>
        <button class:active={sectionAxis === 'none'} onclick={() => (sectionAxis = 'none')}>
          Uncut Solid
        </button>
      </div>

      <button class="reset-cam-btn" onclick={resetCameraView} title="Re-center 3D camera">
        ⟳ Frame
      </button>

      {#if onOpenCadTab}
        <button class="cad-link-btn" onclick={onOpenCadTab}>
          2D Blueprints &amp; BOM →
        </button>
      {/if}
    {/if}
  </div>

  {#if viewMode === 'cutaway'}
    <div class="layer-strip">
      <span class="ctrl-lbl">CAD Layers:</span>
      <label class="lchk"><input type="checkbox" bind:checked={showShell} /><span>Shell</span></label>
      <label class="lchk"><input type="checkbox" bind:checked={showBaffle} /><span>Baffle</span></label>
      <label class="lchk"><input type="checkbox" bind:checked={showInternals} /><span>Horn/Ports</span></label>
      <label class="lchk"><input type="checkbox" bind:checked={showBracing} /><span>Braces</span></label>
      <label class="lchk"><input type="checkbox" bind:checked={showDamping} /><span>Damping</span></label>
      <label class="lchk"><input type="checkbox" bind:checked={showDrivers} /><span>Motors/Cones</span></label>
      <label class="lchk"><input type="checkbox" bind:checked={showBalloon} /><span>3D Balloon</span></label>
    </div>
  {/if}

  <div
    class="canvas-wrap"
    role="application"
    aria-label="3D Acoustic and Solid Cabinet CAD Viewport"
    bind:this={containerEl}
    onpointerdown={handlePointerDown}
    onpointerup={handlePointerUp}
    onpointermove={handlePointerMove}
    onpointerleave={(e) => {
      if (e.pointerType === 'mouse') hoveredPart = null;
    }}
  >
    <div class="hud-overlay">
      {#if viewMode === 'venue'}
        {#if fieldMode !== 'transient'}
          <div class="hud-badge">
            Field @ <strong>{formatFreq(currentSliceFreq)}</strong> ·
            {#if fieldMode === 'spl'}
              <span>{splRange[0].toFixed(0)}–{splRange[1].toFixed(0)} dB SPL</span>
            {:else}
              <span>Real Wavefront Phase cos(∠p)</span>
            {/if}
          </div>
        {:else}
          <div class="hud-badge">
            EDM Kick + Click Transient @ <strong>{currentTransientMs.toFixed(1)} ms</strong>
          </div>
        {/if}
        <div class="zone-legend">
          <span><i style="background:#34d399"></i> Sweet Spot</span>
          <span><i style="background:#fbbf24"></i> Quiet / Stage</span>
          <span><i style="background:#a78bfa"></i> Far Throw</span>
        </div>
      {:else if activeCab}
        {@const st = activeCab.structural}
        <div class="hud-badge">
          <strong>{activeCab.title}</strong> · Wall <strong>{st.wall_thickness_mm.toFixed(1)} mm</strong> · Baffle <strong>{st.baffle_thickness_mm.toFixed(1)} mm</strong> · {st.total_mass_kg.toFixed(1)} kg · Braced f₁₁ = {st.braced_f11_hz.toFixed(0)} Hz
        </div>
        {#if hoveredPart}
          <div class="hud-part-card">
            <div class="hp-title">{hoveredPart.name}</div>
            <div class="hp-meta">
              <strong>{hoveredPart.thickness_mm.toFixed(1)} mm</strong> · {hoveredPart.material_name} ·
              {hoveredPart.cut_dims_mm[0].toFixed(0)}×{hoveredPart.cut_dims_mm[1].toFixed(0)} mm ·
              {hoveredPart.mass_kg.toFixed(2)} kg
            </div>
          </div>
        {/if}
      {/if}
    </div>
  </div>

  <div class="vp-bottom-bar">
    {#if viewMode === 'venue'}
      {#if fieldMode !== 'transient'}
        <span class="ctrl-lbl">Frequency Slice:</span>
        <input
          type="range"
          min="0"
          max={Math.max(0, variant.spatial_field.slice_freqs_hz.length - 1)}
          step="1"
          bind:value={sliceFreqIdx}
        />
        <div class="freq-pills">
          {#each variant.spatial_field.slice_freqs_hz as sf, idx}
            <button
              class="fpill"
              class:active={sliceFreqIdx === idx}
              onclick={() => (sliceFreqIdx = idx)}
            >
              {formatFreq(sf)}
            </button>
          {/each}
        </div>
      {:else}
        <button
          class="play-btn"
          onclick={() => (isPlayingWave = !isPlayingWave)}
        >
          {isPlayingWave ? '⏸ Pause Wavefront' : '▶ Play Wavefront'}
        </button>
        <input
          type="range"
          min="0"
          max={Math.max(0, variant.spatial_field.transient_frames.length - 1)}
          step="1"
          bind:value={transientFrameIdx}
        />
        <span class="time-readout">{currentTransientMs.toFixed(1)} ms</span>
      {/if}
    {:else}
      {#if sectionAxis !== 'none'}
        <label class="slider-pair">
          <span class="ctrl-lbl">Section Pos:</span>
          <input
            type="range"
            class="cad-slider"
            aria-label="Section Cut Position"
            min="-0.92"
            max="0.92"
            step="0.02"
            bind:value={sectionRatio}
          />
        </label>
      {/if}
      <label class="slider-pair">
        <span class="ctrl-lbl">Explode CAD:</span>
        <input
          type="range"
          class="cad-slider"
          aria-label="Explode CAD Assembly"
          min="0"
          max="1"
          step="0.02"
          bind:value={explodeAmount}
        />
      </label>
      <label class="slider-pair">
        <span class="ctrl-lbl">Wall Opacity:</span>
        <input
          type="range"
          class="cad-slider"
          aria-label="Shell Wall Opacity"
          min="0.14"
          max="1"
          step="0.02"
          bind:value={shellOpacity}
        />
      </label>
      {#if showBalloon && variant.directivity.balloon_freqs_hz.length > 0}
        <label class="slider-pair">
          <span class="ctrl-lbl">Balloon:</span>
          <input
            type="range"
            class="cad-slider"
            min="0"
            max={Math.max(0, variant.directivity.balloon_freqs_hz.length - 1)}
            step="1"
            bind:value={balloonFreqIdx}
          />
          <strong class="time-readout">{formatFreq(currentBalloonFreq)}</strong>
        </label>
      {/if}
    {/if}
  </div>
</div>

<style>
  .viewport-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 375px;
    background: #060a13;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .vp-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 6px 9px;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .layer-strip {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 4px 10px;
    background: rgba(12, 19, 34, 0.92);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .lchk {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-1);
    cursor: pointer;
  }
  .seg-group {
    display: inline-flex;
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px;
    gap: 2px;
  }
  .seg-group button {
    background: transparent;
    border: none;
    color: var(--text-2);
    font-size: 11px;
    font-weight: 500;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.12s;
  }
  .seg-group button.active {
    background: var(--bg-3);
    color: var(--accent);
    font-weight: 600;
  }
  .cad-link-btn {
    background: rgba(52, 211, 153, 0.14);
    border: 1px solid rgba(52, 211, 153, 0.45);
    color: #34d399;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .reset-cam-btn {
    background: var(--bg-0);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .reset-cam-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .slider-pair {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 140px;
  }
  .cad-slider {
    max-width: 115px;
  }
  .chk {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--text-1);
    cursor: pointer;
  }
  .cab-select {
    background: var(--bg-0);
    color: var(--text-0);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 7px;
    font-size: 11px;
    max-width: 190px;
  }
  .canvas-wrap {
    position: relative;
    flex: 1;
    min-height: 260px;
    width: 100%;
    overflow: hidden;
  }
  .hud-overlay {
    position: absolute;
    top: 9px;
    left: 9px;
    right: 9px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    pointer-events: none;
    gap: 8px;
    flex-wrap: wrap;
  }
  .hud-badge {
    background: rgba(9, 14, 26, 0.86);
    backdrop-filter: blur(6px);
    border: 1px solid rgba(56, 189, 248, 0.35);
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 11px;
    color: var(--text-1);
  }
  .hud-badge strong {
    color: var(--accent);
  }
  .hud-part-card {
    background: rgba(15, 23, 42, 0.92);
    border: 1px solid #fbbf24;
    border-radius: 6px;
    padding: 5px 9px;
    max-width: 360px;
  }
  .hp-title {
    font-size: 11.5px;
    font-weight: 700;
    color: #fbbf24;
  }
  .hp-meta {
    font-size: 10.5px;
    color: #e2e8f0;
  }
  .zone-legend {
    display: flex;
    gap: 10px;
    background: rgba(9, 14, 26, 0.8);
    border: 1px solid var(--border);
    padding: 4px 9px;
    border-radius: 6px;
    font-size: 10.5px;
    color: var(--text-1);
  }
  .zone-legend i {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 4px;
  }
  .vp-bottom-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--bg-1);
    border-top: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .ctrl-lbl {
    font-size: 10.5px;
    color: var(--text-2);
    white-space: nowrap;
  }
  .vp-bottom-bar input[type='range'] {
    flex: 1;
    min-width: 70px;
    accent-color: var(--accent);
  }
  .freq-pills {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .fpill {
    background: var(--bg-0);
    border: 1px solid var(--border);
    color: var(--text-2);
    font-size: 10.5px;
    padding: 2px 7px;
    border-radius: 4px;
    cursor: pointer;
  }
  .fpill.active {
    border-color: var(--accent);
    color: var(--accent);
    background: rgba(56, 189, 248, 0.12);
  }
  .play-btn {
    background: rgba(56, 189, 248, 0.16);
    border: 1px solid var(--accent);
    color: var(--accent);
    border-radius: 5px;
    padding: 4px 10px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .time-readout {
    font-size: 11px;
    color: var(--accent);
    min-width: 54px;
    text-align: right;
  }

  @media (max-width: 1024px), (max-height: 540px) {
    .viewport-shell {
      min-height: 365px;
      height: auto;
    }
    .canvas-wrap {
      height: 300px;
      min-height: 270px;
      flex: none;
    }
    .vp-toolbar {
      padding: 6px 8px;
      gap: 6px;
    }
    .seg-group {
      overflow-x: auto;
      max-width: 100%;
      scrollbar-width: none;
    }
    .seg-group button {
      white-space: nowrap;
      padding: 6px 9px;
      font-size: 11.5px;
    }
    .layer-strip {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      padding: 6px 9px;
      gap: 11px;
    }
    .lchk {
      white-space: nowrap;
      font-size: 11.5px;
    }
    .cab-select {
      max-width: 100%;
      flex: 1 1 170px;
    }
    .hud-badge {
      font-size: 10.5px;
      padding: 4px 8px;
      max-width: 100%;
    }
    .zone-legend {
      display: none;
    }
    .slider-pair {
      flex: 1 1 165px;
    }
    .cad-slider {
      max-width: none;
      width: 100%;
    }
    .freq-pills {
      width: 100%;
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      padding-bottom: 2px;
    }
    .fpill {
      white-space: nowrap;
      padding: 5px 9px;
      font-size: 11px;
    }
  }

  @media (max-height: 500px) and (orientation: landscape) {
    .viewport-shell {
      min-height: 250px;
    }
    .canvas-wrap {
      height: 215px;
      min-height: 195px;
    }
  }
</style>
