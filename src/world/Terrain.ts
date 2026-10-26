import * as THREE from 'three';
import type { Track } from '../track/Track';
import { TUNNEL_HEIGHT } from '../track/TrackDef';
import type { TrackGrid } from './TrackGrid';
import { applyPatches, GLSL_NOISE } from './ShaderPatch';
import type { LampLighting } from './LampLighting';

export const WATER_LEVEL = -1.6;

/**
 * Ground height field around the circuit. Near the road it follows the road's elevation (or the
 * tunnel roof), further away it relaxes to the city datum with a residential hill to the south and
 * the harbor basin to the north-east.
 */
export class Terrain {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly center = new THREE.Vector2();
  private near: number[] = [];

  constructor(readonly track: Track, readonly grid: TrackGrid) {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (let i = 0; i < track.count; i++) {
      a = Math.min(a, track.px[i]);
      b = Math.max(b, track.px[i]);
      c = Math.min(c, track.pz[i]);
      d = Math.max(d, track.pz[i]);
    }
    this.minX = a - 800;
    this.maxX = b + 800;
    this.minZ = c - 800;
    this.maxZ = d + 800;
    this.center.set((a + b) / 2, (c + d) / 2);
    grid.buildField(this.minX, this.minZ, this.maxX, this.maxZ, 150);
  }

  /** 0..1 how much (x,z) is harbor water. */
  basin(x: number, z: number): number {
    // north-east of the harbor boulevard and east of the docks hairpin, only on the outside (left) of the circuit
    const north = smooth(555, 600, x) * smooth(480, 455, z) * smooth(-900, -700, z);
    const east = smooth(1172, 1205, x) * smooth(760, 720, z);
    const m = Math.max(north, east);
    if (m <= 0) return 0;
    const t = this.track;
    const n = this.grid.nearest(x, z, 140);
    if (n.index >= 0) {
      const i = n.index;
      const lat = (x - t.px[i]) * t.rx[i] + (z - t.pz[i]) * t.rz[i];
      if (lat > 0) return 0; // inside of the loop: dry land
      const cl = -lat - (t.halfWidth + t.sidewalk[i]);
      return m * smooth(4.5, 9, cl);
    }
    return m;
  }

  /** Background relief away from the track (hills to the south). */
  private background(x: number, z: number): number {
    const hill = 26 * Math.exp(-((x - 230) ** 2 + (z - 860) ** 2) / (260 * 260));
    const ridge = 14 * Math.exp(-((x + 260) ** 2 + (z - 820) ** 2) / (220 * 220));
    const swell = 4 * Math.sin(x * 0.004) * Math.cos(z * 0.005);
    return hill + ridge + swell * smooth(-200, 200, z);
  }

  height(x: number, z: number): number {
    const t = this.track;
    const R = 55;
    if (this.grid.distApprox(x, z) > R * 2.2 + 6) {
      const bgOnly = this.background(x, z);
      const b = this.basin(x, z);
      return b > 0 ? bgOnly * (1 - b) + (WATER_LEVEL - 5) * b : bgOnly;
    }
    const list = this.grid.within(x, z, R * 2.2, this.near);
    let ws = 0;
    let ys = 0;
    let minD = Infinity;
    let minI = -1;
    for (let k = 0; k < list.length; k += 2) {
      const i = list[k];
      const dx = t.px[i] - x;
      const dz = t.pz[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD) {
        minD = d2;
        minI = i;
      }
      const w = Math.exp(-d2 / (R * R));
      const y = t.tunnel[i] ? t.py[i] + TUNNEL_HEIGHT + 0.7 : t.py[i];
      ws += w;
      ys += w * y;
    }
    const bg = this.background(x, z);
    const w0 = 0.35;
    let h = (ys + bg * w0) / (ws + w0);
    // inside / right beside the corridor the ground must stay below the road (or on the tunnel roof)
    if (minI >= 0) {
      const d = Math.sqrt(minD);
      const edge = t.halfWidth + t.sidewalk[minI];
      const target = t.tunnel[minI] ? t.py[minI] + TUNNEL_HEIGHT + 0.75 : t.py[minI] - 0.4;
      const f = smooth(edge + 9, edge + 1, d);
      if (t.tunnel[minI]) h = h * (1 - f) + Math.max(h, target) * f;
      else h = h * (1 - f) + Math.min(h, target) * f;
    }
    const b = this.basin(x, z);
    if (b > 0) h = h * (1 - b) + (WATER_LEVEL - 5) * b;
    return h;
  }

  /** Build the ground mesh (chunked) with per-vertex lamp sample indices. */
  build(lamps: LampLighting, cellSize = 8): THREE.Mesh[] {
    const t = this.track;
    const nx = Math.ceil((this.maxX - this.minX) / cellSize);
    const nz = Math.ceil((this.maxZ - this.minZ) / cellSize);
    const H = new Float32Array((nx + 1) * (nz + 1));
    const S = new Float32Array((nx + 1) * (nz + 1));
    const Z = new Float32Array((nx + 1) * (nz + 1)); // zone tint: 0 city, 1 grass, 2 quay
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = this.minX + i * cellSize;
        const z = this.minZ + j * cellSize;
        const k = j * (nx + 1) + i;
        H[k] = this.height(x, z);
        const n = this.grid.nearest(x, z, 70);
        S[k] = n.index >= 0 ? n.index : -1;
        const zoneIdx = n.index >= 0 ? t.zoneAt(n.index) : 'none';
        Z[k] = zoneIdx === 'park' || zoneIdx === 'hills' ? 1 : zoneIdx === 'harbor' || zoneIdx === 'docks' ? 2 : 0;
        if (n.index < 0) {
          // far field: hills read as grass, the rest is city
          Z[k] = H[k] > 6 ? 1 : 0;
        }
      }
    }

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    applyPatches(mat, [
      lamps.patch({ flat: true }),
      {
        key: 'terrain',
        vertexHeader: 'varying vec3 vTW;',
        vertex: [{ after: 'begin_vertex', code: 'vTW = (modelMatrix * vec4(transformed, 1.0)).xyz;' }],
        fragmentHeader: 'varying vec3 vTW;\n' + GLSL_NOISE,
        fragment: [
          {
            after: 'color_fragment',
            code: 'diffuseColor.rgb *= mix(0.6, 1.25, wFbm(vTW.xz * 0.05)) * mix(0.85, 1.1, wNoise(vTW.xz * 0.7));',
          },
        ],
      },
    ]);

    const meshes: THREE.Mesh[] = [];
    const tiles = 6;
    const tx = Math.ceil(nx / tiles);
    const tz = Math.ceil(nz / tiles);
    const city = new THREE.Color(0.055, 0.052, 0.058);
    const grass = new THREE.Color(0.03, 0.045, 0.025);
    const quay = new THREE.Color(0.075, 0.07, 0.066);
    const tmpC = new THREE.Color();
    for (let bj = 0; bj < tiles; bj++) {
      for (let bi = 0; bi < tiles; bi++) {
        const i0 = bi * tx, i1 = Math.min(nx, i0 + tx);
        const j0 = bj * tz, j1 = Math.min(nz, j0 + tz);
        if (i1 <= i0 || j1 <= j0) continue;
        const w = i1 - i0 + 1;
        const pos: number[] = [];
        const col: number[] = [];
        const sid: number[] = [];
        const idx: number[] = [];
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const k = j * (nx + 1) + i;
            pos.push(this.minX + i * cellSize, H[k], this.minZ + j * cellSize);
            const z = Z[k];
            tmpC.copy(z === 1 ? grass : z === 2 ? quay : city);
            if (H[k] < WATER_LEVEL - 0.5) tmpC.multiplyScalar(0.4);
            col.push(tmpC.r, tmpC.g, tmpC.b);
            sid.push(S[k]);
          }
        }
        for (let j = 0; j < j1 - j0; j++) {
          for (let i = 0; i < i1 - i0; i++) {
            const a = j * w + i;
            const b = a + 1;
            const c = a + w;
            const d = c + 1;
            idx.push(a, c, b, b, c, d);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.setAttribute('sampleIdx', new THREE.Float32BufferAttribute(sid, 1));
        g.setIndex(idx);
        g.computeVertexNormals();
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, mat);
        m.name = 'terrain';
        m.receiveShadow = true;
        meshes.push(m);
      }
    }
    // a huge far plane so the horizon never shows a void beyond the terrain tiles
    const far = new THREE.Mesh(
      new THREE.RingGeometry(1, 9000, 32, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x07080a }),
    );
    far.position.set(this.center.x, -9, this.center.y);
    far.scale.setScalar(1);
    far.name = 'farGround';
    meshes.push(far);
    return meshes;
  }
}

export function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
