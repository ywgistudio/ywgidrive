import * as THREE from 'three';
import {
  CONTROL_POINTS,
  TRACK_SCALE,
  ROAD_HALF_WIDTH,
  LAMP_SPACING,
  TUNNEL_LAMP_SPACING,
  SIDEWALK_WIDTH,
  TUNNEL_SIDEWALK_WIDTH,
  LANE_WIDTH,
  type Zone,
} from './TrackDef';

export interface Lamp {
  pos: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  range: number;
  s: number;
  side: number; // -1 left, +1 right, 0 center (tunnel)
  tunnel: boolean;
}

export interface TrackFrame {
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
}

export interface Projection {
  index: number;
  s: number;
  lateral: number;
  height: number; // height above road center surface along up
}

const ZONES_ORDER: Zone[] = ['downtown', 'harbor', 'docks', 'tunnel', 'hills', 'park'];

/**
 * Arc-length parameterised closed street circuit. Everything track-related (mesh building,
 * AI racing line, traffic lanes, lap timing, lamps) derives from these samples.
 */
export class Track {
  readonly step = 2; // meters between samples
  readonly count: number;
  readonly length: number;
  readonly halfWidth = ROAD_HALF_WIDTH;

  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  readonly tz: Float32Array;
  readonly rx: Float32Array;
  readonly ry: Float32Array;
  readonly rz: Float32Array;
  readonly ux: Float32Array;
  readonly uy: Float32Array;
  readonly uz: Float32Array;
  readonly zone: Uint8Array;
  readonly tunnel: Uint8Array;
  readonly curvature: Float32Array; // signed horizontal curvature of centerline (1/m), + = turning right
  /** 0 outside tunnels, 1 inside, smoothly blended over ~40m at portals. */
  readonly tunnelBlend: Float32Array;
  /** Sidewalk width per sample (narrower inside the tunnel). Wall sits at halfWidth + sidewalk. */
  readonly sidewalk: Float32Array;

  /** Racing line lateral offset per sample (meters, + = right of center). */
  readonly racingLine: Float32Array;
  /** Racing line target speed per sample for a car with grip mu=1 (m/s). Scale by sqrt(mu). */
  readonly racingSpeed: Float32Array;

  readonly lamps: Lamp[] = [];
  /** For each sample, the indices of the 4 closest lamps (for analytic road lighting). */
  readonly nearLamps: Int32Array;

  readonly lanes = [-LANE_WIDTH * 1.5, -LANE_WIDTH * 0.5, LANE_WIDTH * 0.5, LANE_WIDTH * 1.5];

  constructor() {
    const pts = CONTROL_POINTS.map((c) => new THREE.Vector3(c.x * TRACK_SCALE, c.y, c.z * TRACK_SCALE));
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    const banks = CONTROL_POINTS.map((c) => c.bank ?? 0);

    // Dense sampling by curve parameter, then resample to uniform arc length.
    const dense = 20000;
    const dpos: THREE.Vector3[] = [];
    const dlen: number[] = [0];
    const dt: number[] = [];
    for (let i = 0; i <= dense; i++) {
      const t = i / dense;
      dpos.push(curve.getPoint(t % 1));
      dt.push(t);
      if (i > 0) dlen.push(dlen[i - 1] + dpos[i].distanceTo(dpos[i - 1]));
    }
    const total = dlen[dense];
    const count = Math.floor(total / this.step);
    this.count = count;
    this.length = count * this.step;
    const scaleS = total / this.length;

    const alloc = () => new Float32Array(count);
    this.px = alloc(); this.py = alloc(); this.pz = alloc();
    this.tx = alloc(); this.ty = alloc(); this.tz = alloc();
    this.rx = alloc(); this.ry = alloc(); this.rz = alloc();
    this.ux = alloc(); this.uy = alloc(); this.uz = alloc();
    this.curvature = alloc();
    this.racingLine = alloc();
    this.racingSpeed = alloc();
    this.zone = new Uint8Array(count);
    this.tunnel = new Uint8Array(count);
    const bank = new Float32Array(count);

    const N = CONTROL_POINTS.length;
    let j = 0;
    for (let i = 0; i < count; i++) {
      const target = i * this.step * scaleS;
      while (j < dense - 1 && dlen[j + 1] < target) j++;
      const f = (target - dlen[j]) / Math.max(1e-6, dlen[j + 1] - dlen[j]);
      const p = dpos[j].clone().lerp(dpos[j + 1], f);
      this.px[i] = p.x; this.py[i] = p.y; this.pz[i] = p.z;
      const t = dt[j] + (dt[j + 1] - dt[j]) * f;
      const seg = t * N;
      const a = Math.floor(seg) % N;
      const b = (a + 1) % N;
      const sf = seg - Math.floor(seg);
      // smoothstep blend of bank between control points
      const sm = sf * sf * (3 - 2 * sf);
      bank[i] = banks[a] + (banks[b] - banks[a]) * sm;
      const zA = CONTROL_POINTS[a].zone;
      const zB = CONTROL_POINTS[b].zone;
      const z = sf < 0.5 ? zA : zB;
      this.zone[i] = ZONES_ORDER.indexOf(z);
      this.tunnel[i] = zA === 'tunnel' && zB === 'tunnel' ? 1 : (zA === 'tunnel' && sf < 0.25) || (zB === 'tunnel' && sf > 0.75) ? 1 : 0;
    }

    // Smooth elevation a bit so the road has no kinks.
    for (let pass = 0; pass < 3; pass++) {
      const y2 = new Float32Array(this.py);
      for (let i = 0; i < count; i++) {
        let acc = 0;
        for (let k = -6; k <= 6; k++) acc += y2[(i + k + count) % count];
        this.py[i] = acc / 13;
      }
    }

    // Frames
    const up = new THREE.Vector3(0, 1, 0);
    const T = new THREE.Vector3();
    const R = new THREE.Vector3();
    const U = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const a = (i - 1 + count) % count;
      const b = (i + 1) % count;
      T.set(this.px[b] - this.px[a], this.py[b] - this.py[a], this.pz[b] - this.pz[a]).normalize();
      R.crossVectors(T, up).normalize();
      // bank: rotate right vector around tangent
      const bk = THREE.MathUtils.degToRad(bank[i]);
      R.applyAxisAngle(T, -bk);
      U.crossVectors(R, T).normalize();
      this.tx[i] = T.x; this.ty[i] = T.y; this.tz[i] = T.z;
      this.rx[i] = R.x; this.ry[i] = R.y; this.rz[i] = R.z;
      this.ux[i] = U.x; this.uy[i] = U.y; this.uz[i] = U.z;
    }

    this.tunnelBlend = alloc();
    this.sidewalk = alloc();
    for (let i = 0; i < count; i++) {
      let acc = 0;
      for (let k = -10; k <= 10; k++) acc += this.tunnel[(i + k + count) % count];
      this.tunnelBlend[i] = acc / 21;
      this.sidewalk[i] = SIDEWALK_WIDTH + (TUNNEL_SIDEWALK_WIDTH - SIDEWALK_WIDTH) * this.tunnelBlend[i];
    }

    // Horizontal signed curvature of centerline
    for (let i = 0; i < count; i++) {
      this.curvature[i] = this.signedCurvature(i, 4, null);
    }

    this.computeRacingLine();
    this.computeLamps();
    this.nearLamps = new Int32Array(count * 4);
    this.computeNearLamps();
  }

  wrap(i: number): number {
    return ((i % this.count) + this.count) % this.count;
  }

  wrapS(s: number): number {
    return ((s % this.length) + this.length) % this.length;
  }

  /** Signed curvature using points offset laterally by `offsets` (or centerline). */
  private signedCurvature(i: number, k: number, offsets: Float32Array | null): number {
    const a = this.wrap(i - k), b = this.wrap(i + k);
    const oa = offsets ? offsets[a] : 0, oi = offsets ? offsets[i] : 0, ob = offsets ? offsets[b] : 0;
    const ax = this.px[a] + this.rx[a] * oa, az = this.pz[a] + this.rz[a] * oa;
    const ix = this.px[i] + this.rx[i] * oi, iz = this.pz[i] + this.rz[i] * oi;
    const bx = this.px[b] + this.rx[b] * ob, bz = this.pz[b] + this.rz[b] * ob;
    const d1x = ix - ax, d1z = iz - az, d2x = bx - ix, d2z = bz - iz;
    const cross = d1x * d2z - d1z * d2x;
    const la = Math.hypot(d1x, d1z), lb = Math.hypot(d2x, d2z), lc = Math.hypot(bx - ax, bz - az);
    const denom = la * lb * lc;
    if (denom < 1e-6) return 0;
    // 2*cross/(a*b*c) = 1/R ; sign: cross>0 => turning toward +right? right = T x up.
    // In xz with y up, T x up = (tz*0 - ty*0 ..). For T=(1,0,0): right=(0,0,1).
    // Turning toward +z from +x gives d1=(1,0), d2=(1,1): cross = 1*1 - 0*1 = 1 > 0 => right turn positive.
    return (2 * cross) / denom;
  }

  private computeRacingLine() {
    const n = this.count;
    const lim = this.halfWidth - 1.9;
    const off = this.racingLine;
    off.fill(0);
    const tmp = new Float32Array(n);
    const ks = [24, 16, 10, 6, 3, 2];
    for (const k of ks) {
      for (let it = 0; it < 60; it++) {
        for (let i = 0; i < n; i++) {
          const a = this.wrap(i - k), b = this.wrap(i + k);
          const mx = (this.px[a] + this.rx[a] * off[a] + this.px[b] + this.rx[b] * off[b]) * 0.5;
          const mz = (this.pz[a] + this.rz[a] * off[a] + this.pz[b] + this.rz[b] * off[b]) * 0.5;
          // project midpoint onto lateral line of sample i
          const d = (mx - this.px[i]) * this.rx[i] + (mz - this.pz[i]) * this.rz[i];
          const w = this.tunnel[i] ? lim * 0.75 : lim;
          tmp[i] = THREE.MathUtils.clamp(off[i] + (d - off[i]) * 0.6, -w, w);
        }
        off.set(tmp);
      }
    }
    // light smoothing
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < n; i++) tmp[i] = (off[this.wrap(i - 1)] + off[i] * 2 + off[this.wrap(i + 1)]) * 0.25;
      off.set(tmp);
    }

    // speed profile from curvature (mu = 1)
    const g = 9.81;
    const v = this.racingSpeed;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.signedCurvature(i, 6, off));
      v[i] = Math.min(95, Math.sqrt(g / Math.max(k, 1e-4)));
    }
    // braking pass (backwards), deceleration ~ 0.85 g, 3 loops to handle wrap
    const aBrake = 0.85 * g;
    for (let loop = 0; loop < 3; loop++) {
      for (let i = n - 1; i >= 0; i--) {
        const nx = v[this.wrap(i + 1)];
        const lim2 = Math.sqrt(nx * nx + 2 * aBrake * this.step);
        if (v[i] > lim2) v[i] = lim2;
      }
    }
  }

  private computeLamps() {
    const warmCols = [new THREE.Color(1.0, 0.78, 0.52), new THREE.Color(1.0, 0.86, 0.68)];
    const sodium = new THREE.Color(1.0, 0.62, 0.28);
    const cool = new THREE.Color(0.75, 0.86, 1.0);
    let side = 1;
    let s = 6;
    while (s < this.length - 4) {
      const i = Math.floor(s / this.step);
      const tunnel = this.tunnel[i] === 1;
      const f = this.frameAt(s);
      if (tunnel) {
        for (const sd of [-1, 1]) {
          const pos = f.pos.clone().addScaledVector(f.right, sd * 4.2).addScaledVector(f.up, 5.6);
          this.lamps.push({ pos, color: sodium.clone(), intensity: 26, range: 16, s, side: sd, tunnel: true });
        }
        s += TUNNEL_LAMP_SPACING;
      } else {
        const zone = ZONES_ORDER[this.zone[i]];
        const col = zone === 'harbor' || zone === 'docks' ? sodium : zone === 'park' ? cool : warmCols[(i >> 3) & 1];
        const lat = side * (this.halfWidth + 0.9);
        const pos = f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, 0);
        pos.y += 9.2;
        // lamp head overhangs the road
        pos.addScaledVector(f.right, -side * 2.2);
        this.lamps.push({ pos, color: col.clone(), intensity: 120, range: 38, s, side, tunnel: false });
        side = -side;
        s += LAMP_SPACING;
      }
    }
  }

  private computeNearLamps() {
    const idx: { d: number; i: number }[] = [];
    let start = 0;
    for (let i = 0; i < this.count; i++) {
      const s = i * this.step;
      idx.length = 0;
      // lamps are sorted by s; search a window
      while (start < this.lamps.length - 1 && this.lamps[start].s < s - 80) start++;
      for (let k = -12; k < 24; k++) {
        const li = (start + k + this.lamps.length) % this.lamps.length;
        const L = this.lamps[li];
        const dx = L.pos.x - this.px[i], dz = L.pos.z - this.pz[i], dy = L.pos.y - this.py[i];
        idx.push({ d: dx * dx + dz * dz + dy * dy * 0.2, i: li });
      }
      idx.sort((a, b) => a.d - b.d);
      // dedupe
      const out: number[] = [];
      for (const e of idx) {
        if (!out.includes(e.i)) out.push(e.i);
        if (out.length === 4) break;
      }
      for (let k = 0; k < 4; k++) this.nearLamps[i * 4 + k] = out[k] ?? out[0];
    }
  }

  zoneAt(i: number): Zone {
    return ZONES_ORDER[this.zone[this.wrap(i)]];
  }

  /** Interpolated frame at arc length s. */
  frameAt(s: number, out?: TrackFrame): TrackFrame {
    const o = out ?? { pos: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
    const ss = this.wrapS(s) / this.step;
    const i = Math.floor(ss);
    const j = this.wrap(i + 1);
    const f = ss - i;
    const ii = this.wrap(i);
    o.pos.set(
      this.px[ii] + (this.px[j] - this.px[ii]) * f,
      this.py[ii] + (this.py[j] - this.py[ii]) * f,
      this.pz[ii] + (this.pz[j] - this.pz[ii]) * f,
    );
    o.tangent.set(this.tx[ii] + (this.tx[j] - this.tx[ii]) * f, this.ty[ii] + (this.ty[j] - this.ty[ii]) * f, this.tz[ii] + (this.tz[j] - this.tz[ii]) * f).normalize();
    o.right.set(this.rx[ii] + (this.rx[j] - this.rx[ii]) * f, this.ry[ii] + (this.ry[j] - this.ry[ii]) * f, this.rz[ii] + (this.rz[j] - this.rz[ii]) * f).normalize();
    o.up.set(this.ux[ii] + (this.ux[j] - this.ux[ii]) * f, this.uy[ii] + (this.uy[j] - this.uy[ii]) * f, this.uz[ii] + (this.uz[j] - this.uz[ii]) * f).normalize();
    return o;
  }

  /** World point at arc length s and lateral offset (meters, + right), on the road surface. */
  pointAt(s: number, lateral: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = this.frameAt(s, _frame);
    return out.copy(f.pos).addScaledVector(f.right, lateral);
  }

  racingLineAt(s: number): number {
    const ss = this.wrapS(s) / this.step;
    const i = Math.floor(ss);
    const f = ss - i;
    return this.racingLine[this.wrap(i)] * (1 - f) + this.racingLine[this.wrap(i + 1)] * f;
  }

  racingSpeedAt(s: number): number {
    const ss = this.wrapS(s) / this.step;
    const i = Math.floor(ss);
    const f = ss - i;
    return this.racingSpeed[this.wrap(i)] * (1 - f) + this.racingSpeed[this.wrap(i + 1)] * f;
  }

  /** Find the nearest centerline sample. Pass hint (last index) for O(window) lookups. */
  project(p: THREE.Vector3, hint = -1, out?: Projection): Projection {
    const o = out ?? { index: 0, s: 0, lateral: 0, height: 0 };
    let best = -1;
    let bestD = Infinity;
    if (hint >= 0) {
      for (let k = -40; k <= 40; k++) {
        const i = this.wrap(hint + k);
        const dx = p.x - this.px[i], dy = p.y - this.py[i], dz = p.z - this.pz[i];
        const d = dx * dx + dz * dz + dy * dy * 4;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best < 0 || bestD > 40 * 40) {
      for (let i = 0; i < this.count; i++) {
        const dx = p.x - this.px[i], dy = p.y - this.py[i], dz = p.z - this.pz[i];
        const d = dx * dx + dz * dz + dy * dy * 4;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    const i = best;
    const dx = p.x - this.px[i], dy = p.y - this.py[i], dz = p.z - this.pz[i];
    const along = dx * this.tx[i] + dy * this.ty[i] + dz * this.tz[i];
    o.index = i;
    o.s = this.wrapS(i * this.step + along);
    o.lateral = dx * this.rx[i] + dy * this.ry[i] + dz * this.rz[i];
    o.height = dx * this.ux[i] + dy * this.uy[i] + dz * this.uz[i];
    return o;
  }

  /** Signed distance along the track from a to b in (-L/2, L/2]. */
  deltaS(a: number, b: number): number {
    let d = b - a;
    const L = this.length;
    if (d > L / 2) d -= L;
    if (d <= -L / 2) d += L;
    return d;
  }

  get outerEdge(): number {
    return this.halfWidth + SIDEWALK_WIDTH;
  }
}

const _frame: TrackFrame = { pos: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
