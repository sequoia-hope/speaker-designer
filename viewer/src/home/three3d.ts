// Minimal Three.js viewer shared by the speaker and room 3D views.
// Renders on demand (only when the camera moves or content changes) so a phone
// is not running a GPU loop while you read the cut list.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface Viewer {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  content: THREE.Group;
  render: () => void;
  clear: () => void;
  frame: (box: THREE.Box3, dir?: THREE.Vector3) => void;
  pick: (clientX: number, clientY: number) => THREE.Object3D | null;
  dispose: () => void;
}

export function createViewer(host: HTMLElement, opts: { clipping?: boolean } = {}): Viewer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0a1020);
  renderer.localClippingEnabled = !!opts.clipping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
  scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x2a2018, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2.5, 4, 3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9ec5ff, 0.5);
  fill.position.set(-3, 1.5, -2);
  scene.add(fill);

  const content = new THREE.Group();
  scene.add(content);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;

  let raf = 0;
  const render = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderer.render(scene, camera);
    });
  };
  controls.addEventListener('change', render);

  const resize = () => {
    const w = host.clientWidth || 300;
    const h = host.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const disposeTree = (o: THREE.Object3D) => {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  };

  const raycaster = new THREE.Raycaster();
  return {
    scene,
    camera,
    renderer,
    controls,
    content,
    render,
    clear() {
      for (const c of [...content.children]) {
        content.remove(c);
        disposeTree(c);
      }
    },
    frame(box, dir = new THREE.Vector3(0.9, 0.55, 1.25)) {
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const r = size.length() / 2;
      const dist = r / Math.sin((camera.fov * Math.PI) / 360) * (camera.aspect < 1 ? 1.25 : 1.0);
      camera.position.copy(center).add(dir.clone().normalize().multiplyScalar(dist));
      camera.near = dist / 100;
      camera.far = dist * 20;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      render();
    },
    pick(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      const p = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(p, camera);
      const hits = raycaster.intersectObjects(content.children, true);
      for (const h of hits) {
        // respect clipping planes: skip hits on the cut-away side
        const mat = (h.object as THREE.Mesh).material as THREE.Material;
        const planes = mat?.clippingPlanes;
        if (planes && planes.some((pl) => pl.distanceToPoint(h.point) < 0)) continue;
        let o: THREE.Object3D | null = h.object;
        while (o && !o.userData.partId) o = o.parent;
        if (o) return o;
      }
      return null;
    },
    dispose() {
      ro.disconnect();
      cancelAnimationFrame(raf);
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** Attach "tap to select" that ignores drags (orbiting). */
export function onTap(el: HTMLElement, cb: (x: number, y: number) => void) {
  let sx = 0;
  let sy = 0;
  let t = 0;
  const down = (e: PointerEvent) => {
    sx = e.clientX;
    sy = e.clientY;
    t = performance.now();
  };
  const up = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - sx, e.clientY - sy) < 6 && performance.now() - t < 500) cb(e.clientX, e.clientY);
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', up);
  };
}

/**
 * Solid "section caps" for a clipped view: slices every closed, clipped mesh
 * under `root` with `plane` and returns flat filled faces for the cut, so a
 * cut-away shows solid wood (or magnet) instead of hollow shells. Open meshes
 * (cones, domes, open tubes) produce no closed loop and are skipped.
 */
export function sectionCaps(root: THREE.Object3D, plane: THREE.Plane): THREE.Group {
  const out = new THREE.Group();
  root.updateMatrixWorld(true);
  // cap a hair inside the kept side so vertices lying exactly on the cut don't degenerate
  const eps = 1e-5;
  const cut = new THREE.Plane(plane.normal.clone(), plane.constant - eps);
  const n = cut.normal.clone().normalize();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(n.dot(u)) > 0.9) u.set(0, 1, 0);
  u.sub(n.clone().multiplyScalar(n.dot(u))).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const origin = n.clone().multiplyScalar(-cut.constant);
  const to2 = (p: THREE.Vector3) => {
    const d = p.clone().sub(origin);
    return new THREE.Vector2(d.dot(u), d.dot(v));
  };
  const basis = new THREE.Matrix4().makeBasis(u, v, n).setPosition(origin);

  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (Array.isArray(mat) || !mat.clippingPlanes?.length || mat.transparent || mat.wireframe) return;
    meshes.push(m);
  });

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const m of meshes) {
    const geo = m.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) continue;
    const idx = geo.getIndex();
    const nTri = (idx ? idx.count : pos.count) / 3;
    const segs: [THREE.Vector2, THREE.Vector2][] = [];
    const vtx = (i: number, out: THREE.Vector3) =>
      out.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
    for (let t = 0; t < nTri; t++) {
      vtx(3 * t, a);
      vtx(3 * t + 1, b);
      vtx(3 * t + 2, c);
      const da = cut.distanceToPoint(a);
      const db = cut.distanceToPoint(b);
      const dc = cut.distanceToPoint(c);
      const pts: THREE.Vector3[] = [];
      for (const [p, q, dp, dq] of [
        [a, b, da, db],
        [b, c, db, dc],
        [c, a, dc, da],
      ] as [THREE.Vector3, THREE.Vector3, number, number][]) {
        if (dp > 0 !== dq > 0) pts.push(p.clone().lerp(q, dp / (dp - dq)));
      }
      if (pts.length === 2) segs.push([to2(pts[0]), to2(pts[1])]);
    }
    if (segs.length < 3) continue;
    const loops = chainLoops(segs);
    if (!loops.length) continue;
    // even-odd nesting: a loop inside an odd number of others is a hole
    const info = loops.map((l) => ({ l, area: Math.abs(THREE.ShapeUtils.area(l)) })).sort((x, y) => y.area - x.area);
    const shapes: { shape: THREE.Shape; outer: THREE.Vector2[] }[] = [];
    for (const it of info) {
      const depth = info.filter((o) => o !== it && o.area > it.area && pointInPoly(it.l[0], o.l)).length;
      if (depth % 2 === 0) shapes.push({ shape: new THREE.Shape(it.l), outer: it.l });
      else {
        const owner = [...shapes].reverse().find((s) => pointInPoly(it.l[0], s.outer));
        owner?.shape.holes.push(new THREE.Path(it.l));
      }
    }
    const src = m.material as THREE.MeshStandardMaterial;
    const capMat = src.clone();
    capMat.clippingPlanes = [];
    capMat.side = THREE.DoubleSide;
    capMat.color = src.color.clone().multiplyScalar(0.82); // end grain reads a touch darker
    capMat.polygonOffset = true;
    capMat.polygonOffsetFactor = -1;
    const cap = new THREE.Mesh(new THREE.ShapeGeometry(shapes.map((s) => s.shape)), capMat);
    cap.applyMatrix4(basis);
    // carry the part id so tap-to-identify still works on the cut face
    let o: THREE.Object3D | null = m;
    while (o && !o.userData.partId) o = o.parent;
    if (o) cap.userData.partId = o.userData.partId;
    out.add(cap);
    const edgePts: THREE.Vector3[] = [];
    for (const l of loops)
      for (let i = 0; i < l.length; i++) {
        const p = l[i];
        const q = l[(i + 1) % l.length];
        edgePts.push(new THREE.Vector3(p.x, p.y, 0), new THREE.Vector3(q.x, q.y, 0));
      }
    const edges = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(edgePts),
      new THREE.LineBasicMaterial({ color: 0x1b1208, transparent: true, opacity: 0.7 })
    );
    edges.applyMatrix4(basis);
    out.add(edges);
  }
  return out;
}

/** Join unordered 2D segments into closed loops (open chains are dropped). */
function chainLoops(segs: [THREE.Vector2, THREE.Vector2][]): THREE.Vector2[][] {
  const q = 1e-6;
  const key = (p: THREE.Vector2) => `${Math.round(p.x / q)},${Math.round(p.y / q)}`;
  const adj = new Map<string, number[]>();
  segs.forEach(([p, r], i) => {
    for (const k of [key(p), key(r)]) {
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k)!.push(i);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops: THREE.Vector2[][] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const start = key(segs[s][0]);
    const loop = [segs[s][0]];
    let cur = segs[s][1];
    let closed = false;
    for (let guard = 0; guard < segs.length; guard++) {
      const k = key(cur);
      if (k === start) {
        closed = true;
        break;
      }
      loop.push(cur);
      const next = adj.get(k)?.find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      const [p, r] = segs[next];
      cur = key(p) === k ? r : p;
    }
    if (closed && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function pointInPoly(p: THREE.Vector2, poly: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
