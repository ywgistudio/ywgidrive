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

  private key(cx: number, cz: number): number {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  /** Nearest sample within maxDist (horizontal). Returns -1 if none. */
  nearest(x: number, z: number, maxDist = 200): { index: number; dist: number } {
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
