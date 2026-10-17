import * as THREE from 'three';
import type { Track } from '../track/Track';
import { CURB_HEIGHT, WALL_HEIGHT } from '../track/TrackDef';
import type { CarSpec } from '../vehicle/CarSpec';

/** Minimal stand-in visuals used until the full Environment / car models load. */
export function buildPlaceholderWorld(scene: THREE.Scene, track: Track) {
  const n = track.count;
  const hw = track.halfWidth;
  const ribbon = (profile: (i: number) => [number, number][], mat: THREE.Material) => {
    const cols = profile(0).length;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const k = i % n;
      for (const [lat, h] of profile(k)) {
        pos.push(
          track.px[k] + track.rx[k] * lat + track.ux[k] * h,
          track.py[k] + track.ry[k] * lat + track.uy[k] * h,
          track.pz[k] + track.rz[k] * lat + track.uz[k] * h,
        );
      }
    }
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = i * cols + c, b = (i + 1) * cols + c;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    scene.add(m);
    return m;
  };
  ribbon(() => [[-hw, 0], [hw, 0]], new THREE.MeshStandardMaterial({ color: 0x1a1b20, roughness: 0.35, metalness: 0.0, side: THREE.DoubleSide }));
  // lane lines
  const lines = new THREE.MeshBasicMaterial({ color: 0xbbbbbb, side: THREE.DoubleSide });
  for (const lat of [-3.6, 3.6]) ribbon(() => [[lat - 0.07, 0.01], [lat + 0.07, 0.01]], lines);
  ribbon(() => [[-0.18, 0.01], [-0.06, 0.01]], new THREE.MeshBasicMaterial({ color: 0xd9a400, side: THREE.DoubleSide }));
  ribbon(() => [[0.06, 0.01], [0.18, 0.01]], new THREE.MeshBasicMaterial({ color: 0xd9a400, side: THREE.DoubleSide }));
  const side = new THREE.MeshStandardMaterial({ color: 0x3a3a42, roughness: 0.8, side: THREE.DoubleSide });
  ribbon((i) => [[hw, 0], [hw, CURB_HEIGHT], [hw + track.sidewalk[i], CURB_HEIGHT], [hw + track.sidewalk[i], CURB_HEIGHT + WALL_HEIGHT]], side);
  ribbon((i) => [[-hw - track.sidewalk[i], CURB_HEIGHT + WALL_HEIGHT], [-hw - track.sidewalk[i], CURB_HEIGHT], [-hw, CURB_HEIGHT], [-hw, 0]], side);

  // lamp heads
  const lampGeo = new THREE.BoxGeometry(0.6, 0.2, 1.4);
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3, 2) });
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, track.lamps.length);
  const m = new THREE.Matrix4();
  track.lamps.forEach((l, i) => lamps.setMatrixAt(i, m.makeTranslation(l.pos.x, l.pos.y, l.pos.z)));
  scene.add(lamps);

  // simple buildings
  const rng = mulberry(7);
  const bGeo = new THREE.BoxGeometry(1, 1, 1);
  bGeo.translate(0, 0.5, 0);
  const bMat = new THREE.MeshStandardMaterial({ color: 0x15161d, roughness: 0.9, emissive: 0x1a1030, emissiveIntensity: 0.6 });
  const count = 500;
  const bm = new THREE.InstancedMesh(bGeo, bMat, count);
  let placed = 0;
  for (let t = 0; t < 4000 && placed < count; t++) {
    const x = -450 + rng() * 1700;
    const z = -150 + rng() * 950;
    const w = 12 + rng() * 30, d = 12 + rng() * 30, h = 10 + rng() * 80;
    let ok = true;
    for (let i = 0; i < n; i += 3) {
      const dx = track.px[i] - x, dz = track.pz[i] - z;
      if (dx * dx + dz * dz < (Math.max(w, d) * 0.75 + hw + 7) ** 2) { ok = false; break; }
    }
    if (!ok) continue;
    bm.setMatrixAt(placed++, m.compose(new THREE.Vector3(x, -2, z), new THREE.Quaternion(), new THREE.Vector3(w, h, d)));
  }
  bm.count = placed;
  scene.add(bm);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -8;
  scene.add(ground);
}

export function makePlaceholderCar(spec: CarSpec): THREE.Group {
  const g = new THREE.Group();
  const [hx, hy, hz] = spec.bodyHalf;
  const paint = new THREE.MeshPhysicalMaterial({ color: spec.paint, metalness: 0.6, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), paint);
  body.position.y = spec.bodyOffsetY;
  g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(hx * 1.6, hy * 1.4, hz * 0.95), new THREE.MeshPhysicalMaterial({ color: 0x111111, metalness: 0.2, roughness: 0.05 }));
  cabin.position.set(0, spec.bodyOffsetY + hy * 1.6, -hz * 0.08);
  g.add(cabin);
  const head = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 5) });
  const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.1, 0.1) });
  for (const sx of [-1, 1]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.1, 0.05), head);
    h.position.set(sx * hx * 0.7, spec.bodyOffsetY + 0.08, hz);
    g.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.05), tail);
    t.position.set(sx * hx * 0.7, spec.bodyOffsetY + 0.12, -hz);
    t.name = 'tail';
    g.add(t);
  }
  g.userData.tailMat = tail;
  const wheels: THREE.Object3D[] = [];
  const wGeo = new THREE.CylinderGeometry(spec.wheelRadius, spec.wheelRadius, spec.wheelWidth, 20);
  wGeo.rotateZ(Math.PI / 2);
  const wMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 1, roughness: 0.25 });
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(wGeo, wMat);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(spec.wheelWidth * 1.02, spec.wheelRadius * 1.3, 0.08), rimMat);
    spin.add(tire, rim);
    pivot.add(spin);
    g.add(pivot);
    wheels.push(pivot);
  }
  g.userData.wheels = wheels;
  return g;
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
