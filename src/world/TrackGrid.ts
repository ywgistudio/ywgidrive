import type { Track } from '../track/Track';

/** Spatial hash over track centerline samples for fast "distance to the circuit" queries. */
export class TrackGrid {
  readonly cell = 16;
  private map = new Map<number, number[]>();
  constructor(readonly track: Track) {
    for (let i = 0; i < track.count; i++) {
      const k = this.key(Math.floor(track.px[i] / this.cell), Math.floor(track.pz[i] / this.cell));
      let arr = this.map.get(k);
      if (!arr) this.map.set(k, (arr = []));
      arr.push(i);
    }
  }

  // coarse raster of distance-to-centerline and clearance-from-walls (lazy)
  private fDist: Float32Array | null = null;
  private fClear: Float32Array | null = null;
  private fIdx: Int32Array | null = null;
  private fx0 = 0;
  private fz0 = 0;
  private fw = 0;
  private fh = 0;
  private readonly fc = 4;
  private fR = 150;

  /** Precompute a raster over the given bounds so far-field queries are O(1). */
  buildField(minX: number, minZ: number, maxX: number, maxZ: number, radius = 150) {
    const c = this.fc;
    this.fx0 = minX;
    this.fz0 = minZ;
    this.fw = Math.ceil((maxX - minX) / c) + 1;
    this.fh = Math.ceil((maxZ - minZ) / c) + 1;
    this.fR = radius;
    const n = this.fw * this.fh;
    const dist = new Float32Array(n).fill(radius);
    const clear = new Float32Array(n).fill(radius);
    const idx = new Int32Array(n).fill(-1);
    const t = this.track;
    const r = Math.ceil(radius / c);
    for (let i = 0; i < t.count; i++) {
      const ci = Math.round((t.px[i] - minX) / c);
      const cj = Math.round((t.pz[i] - minZ) / c);
      const edge = t.halfWidth + t.sidewalk[i];
      for (let b = Math.max(0, cj - r); b <= Math.min(this.fh - 1, cj + r); b++) {
        const dz = minZ + b * c - t.pz[i];
        for (let a = Math.max(0, ci - r); a <= Math.min(this.fw - 1, ci + r); a++) {
          const dx = minX + a * c - t.px[i];
          const d = Math.sqrt(dx * dx + dz * dz);
          const k = b * this.fw + a;
          if (d < dist[k]) {
            dist[k] = d;
            idx[k] = i;
          }
          const cl = d - edge;
          if (cl < clear[k]) clear[k] = cl;
        }
      }
    }
    this.fDist = dist;
    this.fClear = clear;
    this.fIdx = idx;
  }

  private sampleField(f: Float32Array, x: number, z: number): number {
    const fx = (x - this.fx0) / this.fc;
    const fz = (z - this.fz0) / this.fc;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= this.fw - 1 || j >= this.fh - 1) return this.fR;
    const u = fx - i, v = fz - j;
    const k = j * this.fw + i;
    return (f[k] * (1 - u) + f[k + 1] * u) * (1 - v) + (f[k + this.fw] * (1 - u) + f[k + this.fw + 1] * u) * v;
  }

  /** Approximate distance to the centerline (accurate to ~3m, capped at the field radius). */
  distApprox(x: number, z: number): number {
    return this.fDist ? this.sampleField(this.fDist, x, z) : this.nearest(x, z, this.fR).dist;
  }

  /** Approximate clearance from the corridor walls; exact when close to the threshold. */
  clearanceFast(x: number, z: number, threshold: number): number {
    if (!this.fClear) return this.clearance(x, z, threshold + 30);
    const a = this.sampleField(this.fClear, x, z);
    if (Math.abs(a - threshold) < 6) return this.clearance(x, z, threshold + 30);
    return a;
  }

  private key(cx: number, cz: number): number {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  /** Nearest sample within maxDist (horizontal). Returns -1 if none. */
  nearest(x: number, z: number, maxDist = 200): { index: number; dist: number } {
    if (this.fDist && maxDist <= this.fR) {
      if (this.sampleField(this.fDist, x, z) > maxDist + 6) return { index: -1, dist: Infinity };
      const fx = Math.floor((x - this.fx0) / this.fc);
      const fz = Math.floor((z - this.fz0) / this.fc);
      if (fx >= 0 && fz >= 0 && fx < this.fw - 1 && fz < this.fh - 1) {
        // refine around the raster's candidates (4 surrounding nodes) with a short local search
        const t = this.track;
        let best = -1;
        let bestD = maxDist * maxDist;
        for (const k of [fz * this.fw + fx, fz * this.fw + fx + 1, (fz + 1) * this.fw + fx, (fz + 1) * this.fw + fx + 1]) {
          const c = this.fIdx![k];
          if (c < 0) continue;
          for (let o = -6; o <= 6; o++) {
            const i = t.wrap(c + o);
            const ex = t.px[i] - x, ez = t.pz[i] - z;
            const d = ex * ex + ez * ez;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
        if (best >= 0) return { index: best, dist: Math.sqrt(bestD) };
        return { index: -1, dist: Infinity };
      }
    }
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let best = -1;
    let bestD = maxDist * maxDist;
    const t = this.track;
    // search expanding rings so near queries stay cheap
    for (let ring = 0; ring <= r; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const arr = this.map.get(this.key(cx + dx, cz + dz));
          if (!arr) continue;
          for (const i of arr) {
            const ex = t.px[i] - x;
            const ez = t.pz[i] - z;
            const d = ex * ex + ez * ez;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // once found, one more ring guarantees correctness
      if (best >= 0 && (ring * this.cell) ** 2 > bestD + this.cell * this.cell * 2) break;
    }
    return { index: best, dist: best >= 0 ? Math.sqrt(bestD) : Infinity };
  }

  /** Clearance from the walled corridor (negative = inside the corridor). */
  clearance(x: number, z: number, maxDist = 200): number {
    const n = this.nearest(x, z, maxDist);
    if (n.index < 0) return maxDist;
    return n.dist - (this.track.halfWidth + this.track.sidewalk[n.index]);
  }

  /** All samples within radius (horizontal). */
  within(x: number, z: number, radius: number, out: number[] = []): number[] {
    out.length = 0;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const t = this.track;
    const r2 = radius * radius;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const arr = this.map.get(this.key(cx + dx, cz + dz));
        if (!arr) continue;
        for (const i of arr) {
          const ex = t.px[i] - x;
          const ez = t.pz[i] - z;
          if (ex * ex + ez * ez < r2) out.push(i);
        }
      }
    }
    return out;
  }
}
