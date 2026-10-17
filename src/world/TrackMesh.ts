import * as THREE from 'three';
import type { Track } from '../track/Track';
import { CURB_HEIGHT, WALL_HEIGHT, TUNNEL_HEIGHT } from '../track/TrackDef';

/** Barrier style on one side of one sample. */
export type BarrierKind = 'jersey' | 'guard' | 'rail' | 'tunnel';

export type SurfaceKind = 'road' | 'sidewalk' | 'concrete' | 'metal' | 'tunnelWall' | 'tunnelCeil' | 'retain';

interface Seg {
  a: [number, number]; // lateral, height
  b: [number, number];
  n: [number, number]; // normal in (right, up) basis
  u0: number;
  u1: number;
}

class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  sidx: number[] = [];
  idx: number[] = [];
  get vertexCount() {
    return this.pos.length / 3;
  }
  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, s: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.sidx.push(s);
    return this.pos.length / 3 - 1;
  }
  build(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('sampleIdx', new THREE.Float32BufferAttribute(this.sidx, 1));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _P0 = new THREE.Vector3();
const _P1 = new THREE.Vector3();
const _R0 = new THREE.Vector3();
const _R1 = new THREE.Vector3();
const _U0 = new THREE.Vector3();
const _U1 = new THREE.Vector3();
const _a0 = new THREE.Vector3();
const _b0 = new THREE.Vector3();
const _a1 = new THREE.Vector3();
const _b1 = new THREE.Vector3();
const _n0 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

export interface TrackMeshOptions {
  /** terrain height function (world x,z) used to raise retaining walls in cuttings */
  terrainHeight: (x: number, z: number) => number;
  chunkSamples?: number;
}

export interface TrackChunk {
  index: number;
  geometries: Partial<Record<SurfaceKind, THREE.BufferGeometry>>;
}

/** Builds the visible circuit surfaces. Cross-section matches the physics colliders exactly. */
export class TrackMesh {
  readonly chunks: TrackChunk[] = [];
  readonly kindLeft: BarrierKind[];
  readonly kindRight: BarrierKind[];
  /** per-sample retaining wall top height (above road center) per side, 0 = none */
  readonly retainLeft: Float32Array;
  readonly retainRight: Float32Array;

  constructor(readonly track: Track, opts: TrackMeshOptions) {
    const t = track;
    const n = t.count;
    this.kindLeft = new Array(n);
    this.kindRight = new Array(n);
    this.retainLeft = new Float32Array(n);
    this.retainRight = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.kindLeft[i] = barrierKind(t, i, -1);
      this.kindRight[i] = barrierKind(t, i, 1);
    }
    // retaining walls where the terrain outside sits well above the road (cuttings)
    for (const side of [-1, 1]) {
      const arr = side < 0 ? this.retainLeft : this.retainRight;
      const kinds = side < 0 ? this.kindLeft : this.kindRight;
      for (let i = 0; i < n; i++) {
        if (kinds[i] === 'tunnel') continue;
        const lat = side * (t.halfWidth + t.sidewalk[i] + 3.5);
        const x = t.px[i] + t.rx[i] * lat;
        const z = t.pz[i] + t.rz[i] * lat;
        const h = opts.terrainHeight(x, z) - t.py[i];
        arr[i] = h > CURB_HEIGHT + WALL_HEIGHT + 0.25 ? Math.min(h + 0.4, TUNNEL_HEIGHT + 2.5) : 0;
      }
      // smooth and dilate so walls don't flicker on and off
      const tmp = new Float32Array(arr);
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let k = -6; k <= 6; k++) m = Math.max(m, tmp[(i + k + n) % n]);
        arr[i] = m;
      }
    }

    const per = opts.chunkSamples ?? 100;
    const nChunks = Math.ceil(n / per);
    for (let c = 0; c < nChunks; c++) {
      const a = c * per;
      const b = Math.min(n, a + per);
      this.chunks.push(this.buildChunk(c, a, b));
    }
  }

  private frame(i: number, P: THREE.Vector3, R: THREE.Vector3, U: THREE.Vector3) {
    const t = this.track;
    const j = t.wrap(i);
    P.set(t.px[j], t.py[j], t.pz[j]);
    R.set(t.rx[j], t.ry[j], t.rz[j]);
    U.set(t.ux[j], t.uy[j], t.uz[j]);
  }

  /** Emit quads for segment list (function of sample) between samples i and i+1. */
  private strip(g: GeoBuilder, i: number, segsA: Seg[], segsB: Seg[]) {
    const t = this.track;
    this.frame(i, _P0, _R0, _U0);
    this.frame(i + 1, _P1, _R1, _U1);
    const s0 = i * t.step;
    const s1 = (i + 1) * t.step;
    const si = t.wrap(i);
    for (let k = 0; k < segsA.length; k++) {
      const A = segsA[k];
      const B = segsB[k];
      _a0.copy(_P0).addScaledVector(_R0, A.a[0]).addScaledVector(_U0, A.a[1]);
      _b0.copy(_P0).addScaledVector(_R0, A.b[0]).addScaledVector(_U0, A.b[1]);
      _a1.copy(_P1).addScaledVector(_R1, B.a[0]).addScaledVector(_U1, B.a[1]);
      _b1.copy(_P1).addScaledVector(_R1, B.b[0]).addScaledVector(_U1, B.b[1]);
      _n0.copy(_R0).multiplyScalar(A.n[0]).addScaledVector(_U0, A.n[1]).normalize();
      _n1.copy(_R1).multiplyScalar(B.n[0]).addScaledVector(_U1, B.n[1]).normalize();
      const ia0 = g.vert(_a0, _n0, A.u0, s0, si);
      const ib0 = g.vert(_b0, _n0, A.u1, s0, si);
      const ia1 = g.vert(_a1, _n1, B.u0, s1, si);
      const ib1 = g.vert(_b1, _n1, B.u1, s1, si);
      _e1.subVectors(_a1, _a0);
      _e2.subVectors(_b0, _a0);
      const facing = _e1.cross(_e2).dot(_n0);
      if (facing > 0) g.idx.push(ia0, ia1, ib0, ib0, ia1, ib1);
      else g.idx.push(ia0, ib0, ia1, ib0, ib1, ia1);
    }
  }

  private buildChunk(index: number, a: number, b: number): TrackChunk {
    const t = this.track;
    const hw = t.halfWidth;
    const builders: Partial<Record<SurfaceKind, GeoBuilder>> = {};
    const get = (k: SurfaceKind) => (builders[k] ??= new GeoBuilder());

    for (let i = a; i < b; i++) {
      const j = t.wrap(i + 1);
      // ---- road
      const road = (_i: number): Seg[] => [{ a: [-hw, 0], b: [hw, 0], n: [0, 1], u0: -hw, u1: hw }];
      this.strip(get('road'), i, road(i), road(j));

      // ---- curbs + sidewalks
      for (const side of [-1, 1]) {
        const sw = (k: number): Seg[] => {
          const outer = hw + t.sidewalk[k];
          return [
            { a: [side * hw, 0], b: [side * hw, CURB_HEIGHT], n: [-side, 0], u0: 0, u1: CURB_HEIGHT },
            { a: [side * hw, CURB_HEIGHT], b: [side * outer, CURB_HEIGHT], n: [0, 1], u0: 0, u1: outer - hw },
          ];
        };
        this.strip(get('sidewalk'), i, sw(i), sw(j));

        const kinds = side < 0 ? this.kindLeft : this.kindRight;
        const kind = kinds[i];
        const kindNext = kinds[j];
        if (kind === 'tunnel' && kindNext === 'tunnel') {
          this.strip(get('tunnelWall'), i, tunnelWall(t, i, side), tunnelWall(t, j, side));
          this.strip(get('tunnelCeil'), i, tunnelShell(t, i, side), tunnelShell(t, j, side));
        } else if (kind !== 'tunnel') {
          const k2 = kindNext === 'tunnel' ? kind : kindNext;
          if (kind === 'jersey' || k2 === 'jersey') {
            this.strip(get('concrete'), i, jersey(t, i, side), jersey(t, j, side));
          }
          if (kind === 'guard' && k2 !== 'jersey') {
            this.strip(get('metal'), i, guardrail(t, i, side), guardrail(t, j, side));
            this.strip(get('concrete'), i, lowCurb(t, i, side), lowCurb(t, j, side));
          }
          if (kind === 'rail' && k2 !== 'jersey') {
            this.strip(get('metal'), i, railing(t, i, side), railing(t, j, side));
            this.strip(get('concrete'), i, lowCurb(t, i, side), lowCurb(t, j, side));
          }
          // retaining wall behind the barrier in cuttings
          const ret = side < 0 ? this.retainLeft : this.retainRight;
          if (ret[i] > 0 || ret[j] > 0) {
            const rw = (k: number): Seg[] => {
              const o = side * (hw + t.sidewalk[k] + 0.64);
              const top = Math.max(ret[k], CURB_HEIGHT + WALL_HEIGHT);
              return [
                { a: [o, CURB_HEIGHT - 0.2], b: [o, top], n: [-side, 0], u0: 0, u1: top },
                { a: [o, top], b: [o + side * 0.5, top], n: [0, 1], u0: 0, u1: 0.5 },
              ];
            };
            this.strip(get('retain'), i, rw(i), rw(j));
          }
        }
      }
      // tunnel ceiling (once per sample, spans both sides)
      if (t.tunnel[t.wrap(i)] && t.tunnel[j]) {
        const ceil = (k: number): Seg[] => {
          const lat0 = hw + t.sidewalk[k] - 0.9;
          return [{ a: [-lat0, TUNNEL_HEIGHT], b: [lat0, TUNNEL_HEIGHT], n: [0, -1], u0: -lat0, u1: lat0 }];
        };
        this.strip(get('tunnelCeil'), i, ceil(i), ceil(j));
        const roof = (k: number): Seg[] => {
          const lat0 = hw + t.sidewalk[k] + 0.7;
          return [{ a: [-lat0, TUNNEL_HEIGHT + 0.8], b: [lat0, TUNNEL_HEIGHT + 0.8], n: [0, 1], u0: -lat0, u1: lat0 }];
        };
        this.strip(get('tunnelCeil'), i, roof(i), roof(j));
      }
    }

    const geometries: Partial<Record<SurfaceKind, THREE.BufferGeometry>> = {};
    for (const k of Object.keys(builders) as SurfaceKind[]) {
      const g = builders[k]!.build();
      if (g) geometries[k] = g;
    }
    return { index, geometries };
  }
}

export function barrierKind(t: Track, i: number, side: number): BarrierKind {
  if (t.tunnel[t.wrap(i)]) return 'tunnel';
  const z = t.zoneAt(i);
  if (z === 'harbor' || z === 'docks') return side < 0 ? 'rail' : 'jersey';
  if (z === 'park' || z === 'hills') return 'guard';
  return 'jersey';
}

// ---- profiles (lateral, height) --------------------------------------------------------------
function profile(side: number, base: number, pts: [number, number][], uStart = 0): Seg[] {
  // pts are (outward offset, height above road) from the inner face; returns segments with normals
  const segs: Seg[] = [];
  let u = uStart;
  for (let k = 0; k < pts.length - 1; k++) {
    const [o0, h0] = pts[k];
    const [o1, h1] = pts[k + 1];
    const dO = o1 - o0;
    const dH = h1 - h0;
    const len = Math.hypot(dO, dH);
    // left normal when walking inner foot -> over the top -> back: (-dH, dO)
    const nO = -dH / len;
    const nH = dO / len;
    segs.push({ a: [side * (base + o0), h0], b: [side * (base + o1), h1], n: [side * nO, nH], u0: u, u1: u + len });
    u += len;
  }
  return segs;
}

function jersey(t: Track, i: number, side: number): Seg[] {
  const k = t.wrap(i);
  const base = t.halfWidth + t.sidewalk[k];
  const c = CURB_HEIGHT;
  const H = WALL_HEIGHT;
  return profile(side, base, [
    [0, c - 0.02],
    [0.03, c + 0.1],
    [0.17, c + 0.34],
    [0.22, c + H - 0.06],
    [0.28, c + H],
    [0.44, c + H],
    [0.5, c + H - 0.06],
    [0.62, c - 0.3],
  ]);
}

function lowCurb(t: Track, i: number, side: number): Seg[] {
  const k = t.wrap(i);
  const base = t.halfWidth + t.sidewalk[k];
  const c = CURB_HEIGHT;
  return profile(side, base, [
    [0, c - 0.02],
    [0, c + 0.14],
    [0.32, c + 0.14],
    [0.34, c - 0.3],
  ]);
}

function guardrail(t: Track, i: number, side: number): Seg[] {
  const k = t.wrap(i);
  const base = t.halfWidth + t.sidewalk[k];
  const c = CURB_HEIGHT;
  // W-beam: front face zig-zag, top lip, back face
  return profile(side, base, [
    [0.1, c + 0.42],
    [0.03, c + 0.52],
    [0.09, c + 0.62],
    [0.03, c + 0.72],
    [0.1, c + 0.82],
    [0.14, c + 0.82],
    [0.14, c + 0.42],
    [0.1, c + 0.42],
  ]);
}

function railing(t: Track, i: number, side: number): Seg[] {
  const k = t.wrap(i);
  const base = t.halfWidth + t.sidewalk[k];
  const c = CURB_HEIGHT;
  const segs: Seg[] = [];
  // three rails + a chunky handrail
  for (const [h, r] of [
    [0.42, 0.035],
    [0.72, 0.035],
    [1.04, 0.06],
  ] as [number, number][]) {
    segs.push(
      ...profile(side, base, [
        [0.06, c + h - r],
        [0.06 - r, c + h],
        [0.06, c + h + r],
        [0.06 + r, c + h],
        [0.06, c + h - r],
      ]),
    );
  }
  return segs;
}

function tunnelWall(t: Track, i: number, side: number): Seg[] {
  const k = t.wrap(i);
  const base = t.halfWidth + t.sidewalk[k];
  const c = CURB_HEIGHT;
  const H = TUNNEL_HEIGHT;
  return profile(side, base, [
    [0, c - 0.02],
    [0, H - 0.9],
    [-0.9, H],
  ]);
}

function tunnelShell(t: Track, i: number, side: number): Seg[] {
  const k = t.wrap(i);
  const base = t.halfWidth + t.sidewalk[k] + 0.7;
  const H = TUNNEL_HEIGHT;
  // outer wall seen from outside (walk from roof edge down to below ground, normal outward)
  return profile(side, base, [
    [0, H + 0.8],
    [0, -2.5],
  ]).map((s) => ({ ...s, n: [side, 0] as [number, number] }));
}
