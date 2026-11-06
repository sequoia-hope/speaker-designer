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
