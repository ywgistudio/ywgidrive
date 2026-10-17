import { RAPIER, STATIC_GROUPS } from '../physics/Physics';
import { surfaceGrip } from '../vehicle/Vehicle';
import type { Track } from '../track/Track';
import { CURB_HEIGHT, WALL_COLLIDER_HEIGHT, TUNNEL_HEIGHT } from '../track/TrackDef';

/**
 * Static physics for the circuit, built from the same cross-section the visuals use:
 * road strip, curb faces + sidewalks, outer walls (taller than the visual barrier), tunnel ceiling,
 * and a catch-all ground plane far below.
 */
export function buildTrackColliders(world: RAPIER.World, track: Track) {
  const n = track.count;
  const hw = track.halfWidth;

  const pt = (i: number, lat: number, h: number, out: number[]) => {
    out.push(
      track.px[i] + track.rx[i] * lat + track.ux[i] * h,
      track.py[i] + track.ry[i] * lat + track.uy[i] * h,
      track.pz[i] + track.rz[i] * lat + track.uz[i] * h,
    );
  };

  // Build a strip mesh from a list of (lat, h) cross-section points per sample, as quads between samples.
  const strip = (profile: (i: number) => [number, number][], kind: number, friction: number) => {
    const verts: number[] = [];
    const idx: number[] = [];
    const cols = profile(0).length;
    for (let i = 0; i < n; i++) {
      for (const [lat, h] of profile(i)) pt(i, lat, h, verts);
    }
    for (let i = 0; i < n; i++) {
      const a = i * cols;
      const b = ((i + 1) % n) * cols;
      for (let c = 0; c < cols - 1; c++) {
        idx.push(a + c, b + c, a + c + 1);
        idx.push(a + c + 1, b + c, b + c + 1);
      }
    }
    const desc = RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES_TWO_SIDED)
      .setFriction(friction)
      .setRestitution(0.05)
      .setCollisionGroups(STATIC_GROUPS);
    const col = world.createCollider(desc);
    surfaceGrip.set(col.handle, { grip: kind === 0 ? 1 : 0.92, bump: kind, kind });
    return col;
  };

  const road = strip(() => [[-hw, 0], [-hw * 0.5, 0], [0, 0], [hw * 0.5, 0], [hw, 0]], 0, 0.9);

  // curb faces + sidewalks + walls, both sides. Profile ordered so triangles face the road side up.
  const sideR = strip((i) => {
    const sw = track.sidewalk[i];
    const wallH = WALL_COLLIDER_HEIGHT + track.tunnelBlend[i] * (TUNNEL_HEIGHT - WALL_COLLIDER_HEIGHT);
    return [[hw, 0], [hw, CURB_HEIGHT], [hw + sw, CURB_HEIGHT], [hw + sw, wallH]];
  }, 1, 0.6);
  const sideL = strip((i) => {
    const sw = track.sidewalk[i];
    const wallH = WALL_COLLIDER_HEIGHT + track.tunnelBlend[i] * (TUNNEL_HEIGHT - WALL_COLLIDER_HEIGHT);
    return [[-hw - sw, wallH], [-hw - sw, CURB_HEIGHT], [-hw, CURB_HEIGHT], [-hw, 0]];
  }, 1, 0.6);
  // walls should be slippery so cars slide along them; give the wall colliders their own low friction
  // (the side strips above include the wall; cars mostly touch it with the body collider whose friction is low)
  void sideR;
  void sideL;
  void road;

  // tunnel ceiling (only where fully inside)
  const ceilVerts: number[] = [];
  const ceilIdx: number[] = [];
  let runStart = -1;
  const flush = (end: number) => {
    if (runStart < 0) return;
    const base = ceilVerts.length / 3;
    let rows = 0;
    for (let i = runStart; i <= end; i++) {
      const w = hw + track.sidewalk[i];
      pt(i, -w, TUNNEL_HEIGHT, ceilVerts);
      pt(i, w, TUNNEL_HEIGHT, ceilVerts);
      rows++;
    }
    for (let r = 0; r < rows - 1; r++) {
      const a = base + r * 2;
      ceilIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    runStart = -1;
  };
  for (let i = 0; i < n; i++) {
    if (track.tunnelBlend[i] > 0.98) {
      if (runStart < 0) runStart = i;
    } else flush(i - 1);
  }
  flush(n - 1);
  if (ceilIdx.length) {
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(new Float32Array(ceilVerts), new Uint32Array(ceilIdx)).setFriction(0.2).setCollisionGroups(STATIC_GROUPS),
    );
  }

  // catch plane
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 1, 4000).setTranslation(400, -40, 300).setCollisionGroups(STATIC_GROUPS));
}
