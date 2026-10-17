import * as THREE from 'three';
import type { Track } from '../track/Track';
import type { Zone } from '../track/TrackDef';
import { START_S } from '../track/TrackDef';
import type { TrackGrid } from './TrackGrid';
import type { Terrain } from './Terrain';
import { Rng } from './rng';
import { createBuildingMaterial } from './BuildingMaterial';
import type { LampLighting } from './LampLighting';
import { applyPatches } from './ShaderPatch';
import { worldUniforms } from './TrackMaterials';

export interface Facade {
  /** world position of the bottom-center of the face that looks at the road */
  pos: THREE.Vector3;
  normal: THREE.Vector3; // outward (toward the road)
  along: THREE.Vector3; // horizontal, along the face (track direction)
  width: number;
  height: number;
  zone: Zone;
  s: number;
  side: number;
  shop: boolean;
}

interface B {
  x: number;
  z: number;
  y: number;
  w: number; // local x size
  d: number; // local z size
  h: number;
  yaw: number;
  style: number;
  hue: number;
  lit: number;
  shop: number;
  seed: number;
  tint: number;
  crown: number;
  floorH: number;
  sample: number;
}

const OCC = 4;

export class City {
  readonly buildings: B[] = [];
  readonly facades: Facade[] = [];
  readonly roofTops: { pos: THREE.Vector3; w: number; d: number; yaw: number; h: number; sample: number }[] = [];
  /** container yards in the docks (filled by props) */
  readonly yards: { x: number; z: number; w: number; d: number; yaw: number; y: number }[] = [];
  private occ: Uint8Array;
  private ow: number;
  private oh: number;
  private rng = new Rng(1337);

  constructor(
    readonly track: Track,
    readonly grid: TrackGrid,
    readonly terrain: Terrain,
    readonly density: number,
  ) {
    this.ow = Math.ceil((terrain.maxX - terrain.minX) / OCC);
    this.oh = Math.ceil((terrain.maxZ - terrain.minZ) / OCC);
    this.occ = new Uint8Array(this.ow * this.oh);
    this.frontRows();
    this.fill();
    this.skyline();
  }

  /** True if (x,z) is not covered by a building and is clear of the road walls by `clear` meters. */
  free(x: number, z: number, clear = 1.5): boolean {
    const k = this.occIdx(x, z);
    if (k < 0 || this.occ[k]) return false;
    return this.grid.clearance(x, z, clear + 20) > clear;
  }

  /** Reserve an area (used by props like container stacks). */
  reserve(x: number, z: number, w: number, d: number, yaw: number) {
    this.mark(x, z, w, d, yaw, 1);
  }

  private occIdx(x: number, z: number): number {
    const i = Math.floor((x - this.terrain.minX) / OCC);
    const j = Math.floor((z - this.terrain.minZ) / OCC);
    if (i < 0 || j < 0 || i >= this.ow || j >= this.oh) return -1;
    return j * this.ow + i;
  }

  /** Test a rotated footprint; returns false if it hits the corridor, water or another building. */
  private fits(x: number, z: number, w: number, d: number, yaw: number, minClear: number, allowWater = false): boolean {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const nx = Math.max(2, Math.ceil(w / 3.5));
    const nz = Math.max(2, Math.ceil(d / 3.5));
    for (let a = 0; a <= nx; a++) {
      for (let b = 0; b <= nz; b++) {
        const lx = (a / nx - 0.5) * w;
        const lz = (b / nz - 0.5) * d;
        const px = x + lx * c + lz * s;
        const pz = z - lx * s + lz * c;
        const k = this.occIdx(px, pz);
        if (k < 0 || this.occ[k]) return false;
        if (this.grid.clearance(px, pz, minClear + 30) < minClear) return false;
        if (!allowWater && this.terrain.basin(px, pz) > 0.05) return false;
      }
    }
    return true;
  }

  private mark(x: number, z: number, w: number, d: number, yaw: number, pad = 2) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const W = w + pad * 2, D = d + pad * 2;
    const nx = Math.ceil(W / (OCC * 0.5));
    const nz = Math.ceil(D / (OCC * 0.5));
    for (let a = 0; a <= nx; a++) {
      for (let b = 0; b <= nz; b++) {
        const lx = (a / nx - 0.5) * W;
        const lz = (b / nz - 0.5) * D;
        const k = this.occIdx(x + lx * c + lz * s, z - lx * s + lz * c);
        if (k >= 0) this.occ[k] = 1;
      }
    }
  }

  private baseY(x: number, z: number, w: number, d: number, yaw: number): number {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let m = Infinity;
    for (const [lx, lz] of [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
      [0, 0],
    ]) {
      const px = x + lx * w * c + lz * d * s;
      const pz = z - lx * w * s + lz * d * c;
      m = Math.min(m, this.terrain.height(px, pz));
    }
    return m - 0.6;
  }

  private add(b: Omit<B, 'seed' | 'tint' | 'sample'> & Partial<Pick<B, 'seed' | 'tint' | 'sample'>>): B {
    const r = this.rng;
    const full: B = {
      seed: b.seed ?? r.next() * 100,
      tint: b.tint ?? r.next(),
      sample: b.sample ?? this.grid.nearest(b.x, b.z, 70).index,
      ...b,
    } as B;
    this.buildings.push(full);
    return full;
  }

  /** Heights / styles by zone. */
  private design(zone: Zone, x: number, z: number, front: boolean) {
    const r = this.rng;
    // downtown core intensity: west end + start straight
    const core = Math.exp(-(((x + 60) / 420) ** 2 + ((z - 160) / 380) ** 2));
    let h: number;
    let style: number;
    let lit = r.range(0.16, 0.5);
    switch (zone) {
      case 'downtown':
        h = r.range(18, 55) + core * r.range(20, 140) * (r.chance(0.35) ? 1.6 : 1);
        style = h > 70 && r.chance(0.45) ? 1 : 0;
        break;
      case 'harbor':
        h = r.range(14, 48);
        style = r.chance(0.3) ? 1 : r.chance(0.5) ? 0 : 2;
        break;
      case 'docks':
        h = r.range(9, 16);
        style = 3;
        lit = r.range(0.1, 0.35);
        break;
      case 'hills':
        h = r.range(6, 11);
        style = r.chance(0.7) ? 4 : 2;
        lit = r.range(0.3, 0.6);
        break;
      case 'park':
        h = r.range(10, 32);
        style = r.chance(0.6) ? 2 : 0;
        break;
      default:
        h = r.range(12, 40);
        style = 0;
    }
    if (front && zone === 'downtown') h = Math.max(h, r.range(14, 28));
    return { h, style, lit };
  }

  private frontRows() {
    const t = this.track;
    const r = this.rng;
    for (const side of [-1, 1]) {
      let s = 0;
      while (s < t.length) {
        const i = Math.floor(s / t.step);
        const zone = t.zoneAt(i);
        if (t.tunnel[i] || (Math.abs(t.deltaS(s, START_S)) < 30 && false)) {
          s += 20;
          continue;
        }
        let placed = false;
        const big = zone === 'docks' ? 1.6 : zone === 'hills' ? 0.55 : 1;
        for (let attempt = 0; attempt < 4 && !placed; attempt++) {
          const w = r.range(14, 36) * big * (1 - attempt * 0.18);
          const d = r.range(16, 32) * big * (1 - attempt * 0.15);
          const setback = r.range(2.2, 5.5) + (zone === 'hills' ? r.range(2, 8) : 0);
          const sc = s + w / 2;
          const f = t.frameAt(sc);
          const ci = t.wrap(Math.floor(sc / t.step));
          const lat = side * (t.halfWidth + t.sidewalk[ci] + 0.7 + setback + d / 2);
          const x = f.pos.x + f.right.x * lat;
          const z = f.pos.z + f.right.z * lat;
          const yaw = Math.atan2(f.tangent.x, f.tangent.z);
          // footprint: local x = depth (across road), local z = width (along road)
          if (this.fits(x, z, d, w, yaw, 1.6)) {
            const des = this.design(zone, x, z, true);
            const y = this.baseY(x, z, d, w, yaw);
            const shop = zone === 'downtown' || zone === 'harbor' ? (r.chance(0.85) ? 1 : 0) : zone === 'park' ? (r.chance(0.3) ? 1 : 0) : 0;
            const b = this.add({
              x, z, y, w: d, d: w, h: des.h + (0.6 - (y - f.pos.y)),
              yaw,
              style: des.style,
              hue: r.next(),
              lit: des.lit,
              shop,
              crown: des.h > 90 && r.chance(0.6) ? r.next() : -1,
              floorH: des.style === 3 ? 6 : des.style === 4 ? 3.0 : r.range(3.1, 3.8),
            });
            this.mark(x, z, d, w, yaw, 1.5);
            // facade facing the road: local +X points left (-right); road-facing normal = -side*right
            const nrm = new THREE.Vector3(-f.right.x * side, 0, -f.right.z * side).normalize();
            const facePos = new THREE.Vector3(x, b.y + 0.6, z).addScaledVector(nrm, d / 2);
            facePos.y = Math.max(b.y + 0.6, this.terrain.height(facePos.x, facePos.z));
            this.facades.push({
              pos: facePos,
              normal: nrm,
              along: new THREE.Vector3(f.tangent.x, 0, f.tangent.z).normalize(),
              width: w,
              height: b.h - (facePos.y - b.y),
              zone,
              s: sc,
              side,
              shop: shop > 0,
            });
            this.setback(b);
            s += w + r.range(0.5, 4);
            placed = true;
          }
        }
        if (!placed) s += 6;
      }
    }
  }

  /** Taller downtown towers get a stepped upper section. */
  private setback(b: B) {
    const r = this.rng;
    if (b.h > 60 && r.chance(0.55)) {
      const k = r.range(0.55, 0.8);
      const h2 = b.h * r.range(0.25, 0.6);
      this.add({ ...b, y: b.y + b.h, w: b.w * k, d: b.d * k, h: h2, shop: 0, crown: b.crown, seed: b.seed + 3.3, sample: b.sample });
      b.crown = -1;
      if (h2 > 30 && r.chance(0.5)) {
        this.add({ ...b, y: b.y + b.h + h2, w: b.w * k * 0.6, d: b.d * k * 0.6, h: h2 * 0.4, shop: 0, crown: r.next(), seed: b.seed + 7.7, sample: b.sample });
      }
    }
  }

  private fill() {
    const t = this.track;
    const r = this.rng;
    const T = this.terrain;
    const step = 30;
    for (let z = T.minZ + 20; z < T.maxZ - 20; z += step) {
      for (let x = T.minX + 20; x < T.maxX - 20; x += step) {
        if (!r.chance(this.density)) continue;
        const px = x + r.range(-8, 8);
        const pz = z + r.range(-8, 8);
        const near = this.grid.nearest(px, pz, 400);
        const zone: Zone = near.index >= 0 ? t.zoneAt(near.index) : 'downtown';
        if (T.basin(px, pz) > 0.02) continue;
        let yaw = 0;
        if (near.index >= 0 && near.dist < 220) {
          yaw = Math.atan2(t.tx[near.index], t.tz[near.index]);
          yaw = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2) + (yaw % (Math.PI / 2)) * 0.0;
          yaw = Math.atan2(t.tx[near.index], t.tz[near.index]);
        }
        const big = zone === 'docks' ? 1.5 : zone === 'hills' ? 0.5 : 1;
        const w = r.range(14, 30) * big;
        const d = r.range(14, 30) * big;
        const nearTrack = near.dist < 260;
        if (nearTrack && zone === 'park' && r.chance(0.6)) continue; // leave room for trees
        if (nearTrack && zone === 'hills' && r.chance(0.25)) continue;
        if (!this.fits(px, pz, w, d, yaw, 3)) continue;
        if (nearTrack && zone === 'docks' && r.chance(0.5)) {
          this.yards.push({ x: px, z: pz, w, d, yaw, y: this.terrain.height(px, pz) });
          this.mark(px, pz, w, d, yaw, 1);
          continue;
        }
        const des = this.design(near.dist > 300 ? 'downtown' : zone, px, pz, false);
        // fade height a little with distance from the circuit so the skyline reads layered
        const y = this.baseY(px, pz, w, d, yaw);
        const b = this.add({
          x: px, z: pz, y, w, d,
          h: des.h * (near.dist > 250 ? r.range(0.8, 1.4) : 1),
          yaw,
          style: des.style,
          hue: r.next(),
          lit: des.lit,
          shop: zone === 'downtown' && near.dist < 120 ? 1 : 0,
          crown: des.h > 100 && r.chance(0.5) ? r.next() : -1,
          floorH: des.style === 3 ? 6 : des.style === 4 ? 3.0 : r.range(3.1, 3.8),
        });
        this.mark(px, pz, w, d, yaw, 2);
        this.setback(b);
      }
    }
  }

  private skyline() {
    const r = this.rng;
    const c = this.terrain.center;
    const n = Math.floor(520 * Math.max(0.4, this.density));
    for (let k = 0; k < n; k++) {
      const a = r.next() * Math.PI * 2;
      const rad = r.range(1500, 3200);
      const x = c.x + Math.cos(a) * rad;
      const z = c.y + Math.sin(a) * rad;
      // keep the harbor horizon open toward the north-east (sea)
      const dirNE = Math.cos(a - -0.6);
      if (dirNE > 0.75 && r.chance(0.85)) continue;
      const w = r.range(30, 80);
      const d = r.range(30, 80);
      const tall = Math.cos(a - Math.PI * 1.1) * 0.5 + 0.5; // tallest toward the west
      const h = r.range(30, 90) + tall * r.range(20, 220) * (r.chance(0.3) ? 1.4 : 1);
      this.add({
        x, z, y: -8, w, d, h: h + 8,
        yaw: r.next() * Math.PI,
        style: 5,
        hue: r.next(),
        lit: r.range(0.35, 0.7),
        shop: 0,
        crown: h > 200 && r.chance(0.4) ? r.next() : -1,
        floorH: 3.5,
        sample: -1,
      });
    }
  }

  build(lamps: LampLighting): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    const n = this.buildings.length;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    // drop bottom face (index group of -y)
    const mat = createBuildingMaterial(lamps);
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    const style = new Float32Array(n * 4);
    const seed = new Float32Array(n * 4);
    const sidx = new Float32Array(n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    this.buildings.forEach((b, i) => {
      q.setFromAxisAngle(up, b.yaw);
      p.set(b.x, b.y, b.z);
      s.set(b.w, b.h, b.d);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      style.set([b.style, b.hue, b.lit, b.shop], i * 4);
      seed.set([b.seed, b.tint, b.crown, b.floorH], i * 4);
      sidx[i] = b.sample;
    });
    geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 4));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    geo.setAttribute('sampleIdx', new THREE.InstancedBufferAttribute(sidx, 1));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = 'buildings';
    mesh.frustumCulled = false;
    out.push(mesh);

    // rooftop clutter: AC units, water tanks, antennas + aircraft beacons
    const r = new Rng(99);
    const roofM: THREE.Matrix4[] = [];
    const roofS: number[] = [];
    const beacons: THREE.Vector3[] = [];
    const mtmp = new THREE.Matrix4();
    for (const b of this.buildings) {
      if (b.style === 5) {
        if (b.h > 150) beacons.push(new THREE.Vector3(b.x, b.y + b.h + 1, b.z));
        continue;
      }
      const top = b.y + b.h;
      const c = Math.cos(b.yaw), sn = Math.sin(b.yaw);
      const k = b.h > 50 ? r.int(1, 3) : r.int(0, 2);
      for (let j = 0; j < k; j++) {
        const lx = r.range(-0.35, 0.35) * b.w;
        const lz = r.range(-0.35, 0.35) * b.d;
        const sw = r.range(1.5, 4.5), sh = r.range(1.0, 3.2), sd = r.range(1.5, 4.5);
        q.setFromAxisAngle(up, b.yaw);
        p.set(b.x + lx * c + lz * sn, top, b.z - lx * sn + lz * c);
        s.set(sw, sh, sd);
        roofM.push(mtmp.compose(p, q, s).clone());
        roofS.push(b.sample);
      }
      if (b.h > 45 && r.chance(0.6)) {
        // antenna mast
        const ah = r.range(6, 22);
        q.setFromAxisAngle(up, 0);
        p.set(b.x, top, b.z);
        s.set(0.35, ah, 0.35);
        roofM.push(mtmp.compose(p, q, s).clone());
        roofS.push(b.sample);
        beacons.push(new THREE.Vector3(b.x, top + ah + 0.2, b.z));
      } else if (b.h > 60) {
        beacons.push(new THREE.Vector3(b.x + b.w * 0.45 * c, top + 0.4, b.z - b.w * 0.45 * sn));
        beacons.push(new THREE.Vector3(b.x - b.w * 0.45 * c, top + 0.4, b.z + b.w * 0.45 * sn));
      }
    }
    const roofGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    roofGeo.setAttribute('sampleIdx', new THREE.InstancedBufferAttribute(new Float32Array(roofS), 1));
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.7, metalness: 0.3 });
    applyPatches(roofMat, [lamps.patch({ flat: true })]);
    const roof = new THREE.InstancedMesh(roofGeo, roofMat, roofM.length);
    roofM.forEach((mm, i) => roof.setMatrixAt(i, mm));
    roof.frustumCulled = false;
    roof.name = 'roofProps';
    out.push(roof);

    // blinking aviation beacons
    const bGeo = new THREE.SphereGeometry(0.7, 8, 6);
    const phase = new Float32Array(beacons.length);
    beacons.forEach((_, i) => (phase[i] = r.next()));
    bGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    const bMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 0.4, 0.2), fog: true });
    applyPatches(bMat, [
      {
        key: 'beacon',
        uniforms: { uTime: worldUniforms.uTime },
        vertexHeader: 'attribute float aPhase; varying float vBlink; uniform float uTime;',
        vertex: [{ after: 'begin_vertex', code: 'float bt = fract(uTime * 0.55 + aPhase * 0.25); vBlink = smoothstep(0.0, 0.05, bt) * (1.0 - smoothstep(0.25, 0.45, bt)); transformed *= 1.0 + 1.5 * vBlink * smoothstep(400.0, 1500.0, length((modelViewMatrix * instanceMatrix * vec4(0,0,0,1)).xyz));' }],
        fragmentHeader: 'varying float vBlink;',
        fragment: [{ after: 'color_fragment', code: 'diffuseColor.rgb *= 0.04 + vBlink;' }],
      },
    ]);
    const bMesh = new THREE.InstancedMesh(bGeo, bMat, beacons.length);
    beacons.forEach((v, i) => {
      mtmp.makeTranslation(v.x, v.y, v.z);
      bMesh.setMatrixAt(i, mtmp);
    });
    bMesh.frustumCulled = false;
    bMesh.name = 'beacons';
    out.push(bMesh);
    return out;
  }
}
