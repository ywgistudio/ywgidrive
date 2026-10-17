import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
// @ts-expect-error untyped three addon
import { MeshoptSimplifier as _MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';

const MeshoptSimplifier = _MeshoptSimplifier as {
  ready: Promise<void>;
  simplify(indices: Uint32Array, positions: Float32Array, stride: number, targetIndexCount: number, targetError: number, flags?: string[]): [Uint32Array, number];
  simplifySloppy(indices: Uint32Array, positions: Float32Array, stride: number, lock: Uint8Array | null, targetIndexCount: number, targetError: number): [Uint32Array, number];
};

export type WheelKey = 'fl' | 'fr' | 'rl' | 'rr';
export const WHEEL_KEYS: WheelKey[] = ['fl', 'fr', 'rl', 'rr']; // same order as Vehicle.wheels

type Axis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/** One entry of public/assets/cars/manifest.{sports,traffic}.json. Everything but id/file is optional. */
export interface CarModelEntry {
  id: string;
  file: string;
  role?: 'hero' | 'rival' | 'traffic';
  kind?: string;
  name?: string;
  source?: string;
  license?: string;
  credit?: string;
  forwardAxis?: Axis;
  upAxis?: Axis;
  lengthMeters?: number;
  massKg?: number;
  maxSpeed?: number;
  bounds?: { min: number[]; max: number[] };
  wheels?: Partial<Record<WheelKey, string>> | null;
  wheelCenters?: Partial<Record<WheelKey, number[]>>;
  wheelRadius?: number;
  paintMaterials?: string[];
  glassMaterials?: string[];
  headlightMaterials?: string[];
  taillightMaterials?: string[];
  tris?: number;
  sizeBytes?: number;
}

export type MatRole = 'paint' | 'glass' | 'chrome' | 'rubber' | 'metal' | 'head' | 'tail' | 'reverse' | 'interior' | 'other';

export interface MergedPart {
  geometry: THREE.BufferGeometry;
  /** simplified version sharing the same vertex attributes (== geometry for small parts) */
  lod: THREE.BufferGeometry | null; // null = drop this part at distance (interior)
  material: THREE.Material; // template material (already converted for its role)
  role: MatRole;
}

let simplifierReady = false;

/**
 * Build a cheaper index buffer over the same vertices with meshoptimizer.
 * Many car exports are "double sided" by duplicating every triangle, and split at every uv/normal
 * seam, which locks the simplifier. So: weld by position, drop the inward copy of duplicated faces,
 * compact, simplify, and map back to the original vertices (keeping their normals/uvs).
 */
function makeLod(g: THREE.BufferGeometry, ratio: number, error: number, center: THREE.Vector3): THREE.BufferGeometry {
  const idx = g.index;
  if (!simplifierReady || !idx || idx.count < 900) return g;
  try {
    const pos = g.getAttribute('position').array as Float32Array;
    const ix = idx.array as ArrayLike<number>;
    const key = (i: number) => `${Math.round(pos[i * 3] * 4000)},${Math.round(pos[i * 3 + 1] * 4000)},${Math.round(pos[i * 3 + 2] * 4000)}`;
    const nv = pos.length / 3;
    const canon = new Uint32Array(nv);
    const seen = new Map<string, number>();
    for (let i = 0; i < nv; i++) {
      const k = key(i);
      const c = seen.get(k);
      if (c === undefined) {
        seen.set(k, i);
        canon[i] = i;
      } else canon[i] = c;
    }
    const best = new Map<string, { t: number; score: number }>();
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t], b = ix[t + 1], c = ix[t + 2];
      const A = canon[a], B = canon[b], C = canon[c];
      if (A === B || B === C || A === C) continue;
      const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3 - center.x;
      const cy = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3 - center.y;
      const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3 - center.z;
      const score = nx * cx + ny * cy + nz * cz;
      const s3 = A < B ? (B < C ? [A, B, C] : A < C ? [A, C, B] : [C, A, B]) : A < C ? [B, A, C] : B < C ? [B, C, A] : [C, B, A];
      const k = `${s3[0]},${s3[1]},${s3[2]}`;
      const prev = best.get(k);
      if (!prev || score > prev.score) best.set(k, { t, score });
    }
    // re-weld with the kept faces' own vertices, then compact for the simplifier
    const canon2 = new Map<string, number>();
    const remap = new Map<number, number>();
    const back: number[] = [];
    const cpos: number[] = [];
    const welded = new Uint32Array(best.size * 3);
    let w = 0;
    for (const { t } of best.values()) {
      for (let e = 0; e < 3; e++) {
        const v = ix[t + e];
        const k = key(v);
        let cv = canon2.get(k);
        if (cv === undefined) canon2.set(k, (cv = v));
        let ci = remap.get(cv);
        if (ci === undefined) {
          ci = back.length;
          remap.set(cv, ci);
          back.push(cv);
          cpos.push(pos[cv * 3], pos[cv * 3 + 1], pos[cv * 3 + 2]);
        }
        welded[w++] = ci;
      }
    }
    const target = Math.max(3, Math.floor((welded.length * ratio) / 3) * 3);
    const [out] = MeshoptSimplifier.simplify(welded, new Float32Array(cpos), 3, target, error, ['Prune']);
    if (out.length === 0 || out.length >= idx.count * 0.9) return g;
    const mapped = new Uint32Array(out.length);
    for (let i = 0; i < out.length; i++) mapped[i] = back[out[i]];
    const lod = new THREE.BufferGeometry();
    for (const name of Object.keys(g.attributes)) lod.setAttribute(name, g.getAttribute(name));
    lod.setIndex(new THREE.BufferAttribute(mapped, 1));
    lod.boundingBox = g.boundingBox;
    lod.boundingSphere = g.boundingSphere;
    return lod;
  } catch (e) {
    console.warn('[CarModels] simplify failed', e);
    return g;
  }
}

// ---------------------------------------------------------------- draw-call collapsing

const _vertexPbr: (THREE.MeshStandardMaterial | null)[] = [null, null];
/** One material for many untextured parts: color + roughness/metalness come from vertex attributes. */
export function vertexPbrMaterial(doubleSided = false): THREE.MeshStandardMaterial {
  const k = doubleSided ? 1 : 0;
  if (_vertexPbr[k]) return _vertexPbr[k]!;
  const m = new THREE.MeshStandardMaterial({ name: 'vertex-pbr', vertexColors: true, roughness: 1, metalness: 1, envMapIntensity: 1.1, side: doubleSided ? THREE.DoubleSide : THREE.FrontSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 pbr;\nvarying vec2 vPbr;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPbr;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;');
  };
  m.customProgramCacheKey = () => 'vertex-pbr';
  _vertexPbr[k] = m;
  return m;
}

/** Indexed copy holding only the vertices the index references (inputs may be index-only LOD views). */
function compactIndexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  const src = g.index ? (g.index.array as ArrayLike<number>) : null;
  const count = src ? src.length : pos.count;
  const remap = new Int32Array(pos.count).fill(-1);
  const order: number[] = [];
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const v = src ? src[i] : i;
    let r = remap[v];
    if (r < 0) {
      r = remap[v] = order.length;
      order.push(v);
    }
    idx[i] = r;
  }
  const n = order.length;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = order[i];
    P[i * 3] = pos.getX(v); P[i * 3 + 1] = pos.getY(v); P[i * 3 + 2] = pos.getZ(v);
    N[i * 3] = nrm.getX(v); N[i * 3 + 1] = nrm.getY(v); N[i * 3 + 2] = nrm.getZ(v);
    if (uv) { U[i * 2] = uv.getX(v); U[i * 2 + 1] = uv.getY(v); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

const _texCache = new Map<THREE.Texture, ImageData | null>();
function texturePixels(t: THREE.Texture): ImageData | null {
  if (_texCache.has(t)) return _texCache.get(t)!;
  let data: ImageData | null = null;
  try {
    const img = t.image as CanvasImageSource & { width: number; height: number };
    if (img && img.width) {
      const S = 256;
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, S, S);
      data = g.getImageData(0, 0, S, S);
    }
  } catch {
    data = null;
  }
  _texCache.set(t, data);
  return data;
}

const _srgb = new THREE.Color();
/**
 * Collapse parts into as few draw calls as possible: paint / glass / head / tail / reverse buckets,
 * one bucket per textured material, and everything else baked into a single vertex-PBR mesh.
 * With `bakeTextures`, textured parts are folded into the vertex-PBR mesh too by sampling their
 * texture at each vertex (fine for traffic seen at speed). Output geometries are non-indexed copies.
 */
export function collapseParts(parts: { geometry: THREE.BufferGeometry; material: THREE.Material; role: MatRole }[], bakeTextures = false, keepInterior = false, doubleSided = false): MergedPart[] {
  const buckets = new Map<string, { geos: THREE.BufferGeometry[]; material: THREE.Material; role: MatRole }>();
  const add = (key: string, g: THREE.BufferGeometry, material: THREE.Material, role: MatRole) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { geos: [], material, role }));
    b.geos.push(g);
  };
  for (const p of parts) {
    const std = p.material as THREE.MeshStandardMaterial;
    const g = compactIndexed(p.geometry);
    if (p.role === 'paint' || p.role === 'glass' || p.role === 'head' || p.role === 'tail' || p.role === 'reverse') {
      add(p.role, g, p.material, p.role);
    } else if ((p.material as THREE.Material & { transparent: boolean }).transparent || ((std.map || std.normalMap) && !(bakeTextures && (!std.map || texturePixels(std.map))))) {
      add(p.material.uuid, g, p.material, p.role);
    } else {
      const n = g.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      const pbr = new Float32Array(n * 2);
      const c = std.color ?? new THREE.Color(0.5, 0.5, 0.5);
      const r = std.roughness ?? 0.6;
      const m = std.metalness ?? 0;
      const px = std.map ? texturePixels(std.map) : null;
      const uv = g.getAttribute('uv');
      for (let i = 0; i < n; i++) {
        let cr = c.r, cg = c.g, cb = c.b;
        if (px) {
          let u = uv.getX(i) % 1;
          let v = uv.getY(i) % 1;
          if (u < 0) u += 1;
          if (v < 0) v += 1;
          const x = Math.min(px.width - 1, (u * px.width) | 0);
          const y = Math.min(px.height - 1, (v * px.height) | 0);
          const o = (y * px.width + x) * 4;
          _srgb.setRGB(px.data[o] / 255, px.data[o + 1] / 255, px.data[o + 2] / 255, THREE.SRGBColorSpace);
          cr *= _srgb.r;
          cg *= _srgb.g;
          cb *= _srgb.b;
        }
        col[i * 3] = cr;
        col[i * 3 + 1] = cg;
        col[i * 3 + 2] = cb;
        pbr[i * 2] = r;
        pbr[i * 2 + 1] = m;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('pbr', new THREE.BufferAttribute(pbr, 2));
      if (keepInterior && p.role === 'interior') add('interior', g, vertexPbrMaterial(doubleSided), 'interior');
      else add('rest', g, vertexPbrMaterial(doubleSided), 'other');
    }
  }
  const out: MergedPart[] = [];
  for (const b of buckets.values()) {
    const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (!merged) continue;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    out.push({ geometry: merged, lod: merged, material: b.material, role: b.role });
  }
  return out;
}

export interface PreparedWheel {
  key: WheelKey;
  /** collapsed distance-LOD parts relative to the wheel center */
  lodParts: MergedPart[];
  /** wheel center in normalized model space (+Z fwd, +Y up, meters, ground y=0, x/z centered on the bbox) */
  center: THREE.Vector3;
  radius: number;
  /** meshes relative to the wheel center, axle along X */
  parts: MergedPart[];
}

/** A model normalized to the physics convention, with merged geometry ready for cheap instancing. */
export interface PreparedModel {
  entry: CarModelEntry;
  body: MergedPart[];
  /** collapsed distance LOD of the body (few draw calls, no interior) */
  lodBody: MergedPart[];
  wheels: PreparedWheel[] | null; // FL, FR, RL, RR
  bounds: THREE.Box3; // normalized space, including wheels
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  wheelRadius: number;
  wheelCenterY: number;
  axleMidZ: number;
  headlights: THREE.Vector3[]; // left/right lamp centers (normalized space)
  taillights: THREE.Vector3[];
  exhausts: THREE.Vector3[];
  hasHeadMat: boolean;
  hasTailMat: boolean;
  tris: number;
  lodTris: number;
}

/** Built-in fallbacks (none shipped: every model must have a verified license). */
const FALLBACK_SPORTS: CarModelEntry[] = [];

const AXES: Record<Axis, THREE.Vector3> = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+y': new THREE.Vector3(0, 1, 0),
  '-y': new THREE.Vector3(0, -1, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
};

const RE = {
  paint: /(body|paint|carpaint|car_paint|exterior|bodywork|shell|coat|livery)/i,
  glass: /(glass|window|windshield|windscreen)/i,
  head: /(head(?!rest|liner|board)|front_?light|front_?lamp|projector|drl)/i,
  tail: /(tail|brake_?light|rear_?light|stop_?light|backlight|rear_?lamp)/i,
  reverse: /(reverse|backup|rear_?lights?_white|white_?rear)/i,
  chrome: /(chrome|mirror_?metal|polished)/i,
  rubber: /(tire|tyre|rubber)/i,
  interior: /(interior|leather|carpet|seat|dash|cabin|steering)/i,
  metal: /(metal|rim|alloy|steel|alu)/i,
  exhaust: /(exhaust|muffler|tailpipe|tail_pipe)/i,
};

function classify(name: string, entry: CarModelEntry): MatRole {
  const inList = (l?: string[]) => !!l && l.some((n) => n === name);
  if (inList(entry.paintMaterials)) return 'paint';
  if (inList(entry.glassMaterials)) return 'glass';
  if (inList(entry.headlightMaterials)) return 'head';
  if (inList(entry.taillightMaterials)) return 'tail';
  const explicit = !!(entry.paintMaterials?.length || entry.glassMaterials?.length);
  if (RE.reverse.test(name)) return 'reverse';
  if (RE.glass.test(name) && !RE.head.test(name) && !RE.tail.test(name) && !explicit) return 'glass';
  if (RE.head.test(name) && !entry.headlightMaterials?.length) return 'head';
  if (RE.tail.test(name) && !entry.taillightMaterials?.length) return 'tail';
  if (RE.interior.test(name)) return 'interior';
  if (RE.rubber.test(name)) return 'rubber';
  if (RE.chrome.test(name)) return 'chrome';
  if (!explicit && RE.paint.test(name)) return 'paint';
  if (RE.metal.test(name)) return 'metal';
  return 'other';
}

/** Dequantize / de-interleave an attribute into a plain Float32 attribute. */
function toFloatAttr(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const n = attr.count;
  const size = attr.itemSize;
  const out = new Float32Array(n * size);
  for (let i = 0; i < n; i++) {
    out[i * size] = attr.getX(i);
    if (size > 1) out[i * size + 1] = attr.getY(i);
    if (size > 2) out[i * size + 2] = attr.getZ(i);
    if (size > 3) out[i * size + 3] = attr.getW(i);
  }
  return new THREE.BufferAttribute(out, size);
}

/** Clone a mesh geometry into float position/normal/uv, transformed by `m`. */
function bakeGeometry(src: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', toFloatAttr(src.getAttribute('position')));
  if (src.getAttribute('normal')) g.setAttribute('normal', toFloatAttr(src.getAttribute('normal')));
  const uv = src.getAttribute('uv');
  if (uv) g.setAttribute('uv', toFloatAttr(uv));
  else g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(src.getAttribute('position').count * 2), 2));
  if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>));
  else {
    const n = src.getAttribute('position').count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  g.applyMatrix4(m);
  // mirrored transforms flip winding
  if (m.determinant() < 0) {
    const ix = g.index!.array as Uint32Array | Uint16Array;
    for (let i = 0; i < ix.length; i += 3) {
      const t = ix[i + 1];
      ix[i + 1] = ix[i + 2];
      ix[i + 2] = t;
    }
  }
  return g;
}

function convertMaterial(src: THREE.Material, role: MatRole): THREE.Material {
  const s = src as THREE.MeshStandardMaterial;
  const map = s.map ?? null;
  const normalMap = s.normalMap ?? null;
  const color = s.color ? s.color.clone() : new THREE.Color(0x888888);
  switch (role) {
    case 'glass':
      return new THREE.MeshPhysicalMaterial({
        name: src.name,
        color: 0x07090c,
        metalness: 0.0,
        roughness: 0.02,
        transparent: true,
        opacity: 0.62,
        envMapIntensity: 2.2,
        specularIntensity: 1,
        ior: 1.52,
        depthWrite: false,
      });
    case 'chrome':
      return new THREE.MeshStandardMaterial({ name: src.name, color: 0xe8e8ea, metalness: 1, roughness: 0.12, envMapIntensity: 1.6 });
    case 'rubber':
      return new THREE.MeshStandardMaterial({ name: src.name, color: 0x0d0d0e, metalness: 0, roughness: 0.86, map, normalMap });
    case 'metal': {
      const m = new THREE.MeshStandardMaterial({ name: src.name, color: color.lerp(new THREE.Color(0xb8bcc4), 0.4), metalness: 1, roughness: 0.28, map, normalMap, envMapIntensity: 1.4 });
      return m;
    }
    case 'interior': {
      const m = (src as THREE.MeshStandardMaterial).clone();
      if ('envMapIntensity' in m) m.envMapIntensity = 0.4;
      return m;
    }
    case 'head':
    case 'tail':
    case 'reverse':
    case 'paint':
      // per-instance materials are created by CarVisual; keep a placeholder
      return src;
    default: {
      const m = (src as THREE.MeshStandardMaterial).clone ? (src as THREE.MeshStandardMaterial).clone() : src;
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) (m as THREE.MeshStandardMaterial).envMapIntensity = 1.0;
      return m;
    }
  }
}

/** Merge meshes (already baked into a common space) by material. */
function mergeByMaterial(items: { geo: THREE.BufferGeometry; mat: THREE.Material; role: MatRole }[]): MergedPart[] {
  const groups = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; role: MatRole }>();
  for (const it of items) {
    let g = groups.get(it.mat);
    if (!g) groups.set(it.mat, (g = { geos: [], role: it.role }));
    g.geos.push(it.geo);
  }
  const out: MergedPart[] = [];
  for (const [mat, g] of groups) {
    const merged = g.geos.length === 1 ? g.geos[0] : mergeGeometries(g.geos, false);
    if (!merged) continue;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    out.push({ geometry: merged, lod: null, material: mat, role: g.role });
  }
  return out;
}

function sideCenters(parts: { geo: THREE.BufferGeometry }[]): THREE.Vector3[] {
  const acc = [new THREE.Vector3(), new THREE.Vector3()];
  const cnt = [0, 0];
  for (const p of parts) {
    const pos = p.geo.getAttribute('position');
    for (let i = 0; i < pos.count; i += 3) {
      const x = pos.getX(i);
      const k = x >= 0 ? 0 : 1;
      acc[k].x += x;
      acc[k].y += pos.getY(i);
      acc[k].z += pos.getZ(i);
      cnt[k]++;
    }
  }
  const out: THREE.Vector3[] = [];
  for (let k = 0; k < 2; k++) if (cnt[k] > 0) out.push(acc[k].divideScalar(cnt[k]));
  return out;
}

/** Find wheel nodes by common naming schemes (wheel_fl, Wheel.FL, FrontLeftWheel, tire_rr ...). */
function autoFindWheels(scene: THREE.Object3D, out: Partial<Record<WheelKey, THREE.Object3D>>) {
  const codes: Record<WheelKey, RegExp> = {
    fl: /(^|[^a-z])(fl|lf)([^a-z]|$)|front[_\-. ]?left|left[_\-. ]?front/i,
    fr: /(^|[^a-z])(fr|rf)([^a-z]|$)|front[_\-. ]?right|right[_\-. ]?front/i,
    rl: /(^|[^a-z])(rl|lr|bl)([^a-z]|$)|(rear|back)[_\-. ]?left|left[_\-. ]?(rear|back)/i,
    rr: /(^|[^a-z])(rr|br)([^a-z]|$)|(rear|back)[_\-. ]?right|right[_\-. ]?(rear|back)/i,
  };
  const isWheel = /(wheel|whl|tire|tyre|rim)/i;
  const depth = (o: THREE.Object3D) => {
    let d = 0;
    for (let p = o.parent; p; p = p.parent) d++;
    return d;
  };
  for (const k of WHEEL_KEYS) {
    if (out[k]) continue;
    let best: THREE.Object3D | null = null;
    scene.traverse((o) => {
      if (!o.name || !isWheel.test(o.name) || !codes[k].test(o.name.replace(/(wheel|whl|tire|tyre|rim)/gi, '_'))) return;
      if (!best || depth(o) < depth(best)) best = o;
    });
    if (best) out[k] = best;
  }
}

export class CarModels {
  /** Optional filter applied to the sports manifest before loading (skip unused models). */
  sportsFilter?: (e: CarModelEntry) => boolean;
  sports: CarModelEntry[] = [];
  traffic: CarModelEntry[] = [];
  private prepared = new Map<string, PreparedModel>();
  private loader: GLTFLoader;
  readonly base: string;

  constructor(base = 'assets/cars/') {
    this.base = base;
    const draco = new DRACOLoader();
    draco.setDecoderPath(base.replace(/cars\/?$/, 'draco/'));
    this.loader = new GLTFLoader();
    this.loader.setDRACOLoader(draco);
    this.loader.setMeshoptDecoder(MeshoptDecoder);
  }

  private async manifest(name: string): Promise<CarModelEntry[]> {
    try {
      const r = await fetch(this.base + name, { cache: 'no-cache' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j?.models) ? (j.models as CarModelEntry[]) : [];
    } catch {
      return [];
    }
  }

  /** `extra` lets a dev page add entries that are not in a manifest yet. */
  async load(onProgress?: (p: number) => void, extra?: CarModelEntry[]): Promise<void> {
    const [sports, traffic] = await Promise.all([this.manifest('manifest.sports.json'), this.manifest('manifest.traffic.json')]);
    for (const e of extra ?? []) {
      const list = e.role === 'traffic' ? traffic : sports;
      if (!list.some((x) => x.id === e.id)) list.push(e);
    }
    try {
      await MeshoptSimplifier.ready;
      simplifierReady = true;
    } catch {
      simplifierReady = false;
    }
    this.sports = this.sportsFilter ? sports.filter(this.sportsFilter) : sports;
    this.traffic = traffic;
    // the built-in ferrari is always loaded as a guaranteed realistic fallback
    for (const f of FALLBACK_SPORTS) if (!this.sports.some((e) => e.file === f.file)) this.sports.push(f);
    const all = [...this.sports, ...this.traffic];
    let done = 0;
    onProgress?.(0);
    const failed: CarModelEntry[] = [];
    await Promise.all(
      all.map(async (e) => {
        try {
          const gltf = await this.loader.loadAsync(this.base + e.file);
          this.prepared.set(e.id, this.prepare(e, gltf.scene));
        } catch (err) {
          console.warn(`[CarModels] failed to load ${e.file}`, err);
          failed.push(e);
        }
        done++;
        onProgress?.(done / all.length);
      }),
    );
    this.sports = this.sports.filter((e) => !failed.includes(e));
    this.traffic = this.traffic.filter((e) => !failed.includes(e));
    // put real (non-fallback) heroes first
    this.sports.sort((a, b) => Number(FALLBACK_SPORTS.includes(a)) - Number(FALLBACK_SPORTS.includes(b)));
  }

  get(id: string): PreparedModel | undefined {
    return this.prepared.get(id);
  }

  credits(): string[] {
    const out: string[] = [];
    for (const e of [...this.sports, ...this.traffic]) {
      if (!this.prepared.has(e.id)) continue;
      const c = e.credit || (e.name ? `${e.name}${e.license ? ` (${e.license})` : ''}` : '');
      if (c && !out.includes(c)) out.push(c + (e.license && !c.includes(e.license) ? ` — ${e.license}` : ''));
    }
    return out;
  }

  /** Normalize a loaded scene into physics space and merge its geometry per material. */
  private prepare(entry: CarModelEntry, scene: THREE.Object3D): PreparedModel {
    scene.updateMatrixWorld(true);
    // --- orientation
    let fwd = entry.forwardAxis ? AXES[entry.forwardAxis].clone() : null;
    const up = (entry.upAxis ? AXES[entry.upAxis] : AXES['+y']).clone();
    const wheelNodes: Partial<Record<WheelKey, THREE.Object3D>> = {};
    if (entry.wheels) {
      for (const k of WHEEL_KEYS) {
        const n = entry.wheels[k];
        const o = n ? scene.getObjectByName(n) : undefined;
        if (o) wheelNodes[k] = o;
      }
    }
    if (!WHEEL_KEYS.every((k) => wheelNodes[k])) autoFindWheels(scene, wheelNodes);
    const haveWheels = WHEEL_KEYS.every((k) => wheelNodes[k]);
    const nodeCenter = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o, true).getCenter(new THREE.Vector3());
    if (!fwd && haveWheels) {
      const f = nodeCenter(wheelNodes.fl!).add(nodeCenter(wheelNodes.fr!)).multiplyScalar(0.5);
      const r = nodeCenter(wheelNodes.rl!).add(nodeCenter(wheelNodes.rr!)).multiplyScalar(0.5);
      const d = f.sub(r);
      const ax = Math.abs(d.x) > Math.abs(d.z) ? (d.x > 0 ? '+x' : '-x') : d.z > 0 ? '+z' : '-z';
      fwd = AXES[ax as Axis].clone();
    }
    if (!fwd) fwd = AXES['+z'].clone();
    const left = new THREE.Vector3().crossVectors(up, fwd).normalize();
    const basis = new THREE.Matrix4().makeBasis(left, up, fwd); // target -> model
    const rot = basis.clone().invert(); // model -> target

    // --- scale + center
    const tmpBox = new THREE.Box3();
    const meshes: THREE.Mesh[] = [];
    const hidden = /(invisible|hidden|collider|collision|shadow_?plane|shadowcatcher)/i;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry?.getAttribute('position')) return;
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
      if (!m.visible || !mat || mat.visible === false || hidden.test(mat.name) || hidden.test(m.name) || (mat.transparent && mat.opacity < 0.02)) return;
      meshes.push(m);
    });
    const box = new THREE.Box3();
    for (const m of meshes) {
      tmpBox.setFromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute);
      tmpBox.applyMatrix4(new THREE.Matrix4().multiplyMatrices(rot, m.matrixWorld));
      box.union(tmpBox);
    }
    const size = box.getSize(new THREE.Vector3());
    const scale = entry.lengthMeters && size.z > 1e-6 ? entry.lengthMeters / size.z : 1;
    const center = box.getCenter(new THREE.Vector3());
    // final: p' = S * (R * p - offset), with ground at y = 0 and x/z centered
    const offset = new THREE.Vector3(center.x, box.min.y, center.z);
    const norm = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(new THREE.Matrix4().makeTranslation(-offset.x, -offset.y, -offset.z)).multiply(rot);

    // --- which meshes belong to which wheel
    const wheelOf = new Map<THREE.Mesh, WheelKey>();
    if (haveWheels) {
      for (const k of WHEEL_KEYS) wheelNodes[k]!.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) wheelOf.set(o as THREE.Mesh, k);
      });
    }

    const matCache = new Map<THREE.Material, { mat: THREE.Material; role: MatRole }>();
    const matFor = (m: THREE.Mesh) => {
      const src = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
      let c = matCache.get(src);
      if (!c) {
        const role = classify(src.name || '', entry);
        c = { mat: convertMaterial(src, role), role };
        matCache.set(src, c);
      }
      return c;
    };

    const bodyItems: { geo: THREE.BufferGeometry; mat: THREE.Material; role: MatRole }[] = [];
    const wheelItems: Record<WheelKey, { geo: THREE.BufferGeometry; mat: THREE.Material; role: MatRole }[]> = { fl: [], fr: [], rl: [], rr: [] };
    const headParts: { geo: THREE.BufferGeometry }[] = [];
    const tailParts: { geo: THREE.BufferGeometry }[] = [];
    const exhaustParts: { geo: THREE.BufferGeometry }[] = [];
    let tris = 0;
    const mw = new THREE.Matrix4();
    for (const m of meshes) {
      mw.multiplyMatrices(norm, m.matrixWorld);
      const geo = bakeGeometry(m.geometry, mw);
      tris += (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
      const { mat, role } = matFor(m);
      const wk = wheelOf.get(m);
      if (wk) wheelItems[wk].push({ geo, mat, role });
      else {
        bodyItems.push({ geo, mat, role });
        if (role === 'head') headParts.push({ geo });
        if (role === 'tail') tailParts.push({ geo });
        if (RE.exhaust.test(m.name) || RE.exhaust.test(m.parent?.name ?? '')) exhaustParts.push({ geo });
      }
    }

    // --- bounds in normalized space
    const bounds = new THREE.Box3();
    for (const it of [...bodyItems, ...WHEEL_KEYS.flatMap((k) => wheelItems[k])]) {
      it.geo.computeBoundingBox();
      bounds.union(it.geo.boundingBox!);
    }

    // --- wheels
    let wheels: PreparedWheel[] | null = null;
    if (haveWheels) {
      wheels = WHEEL_KEYS.map((k) => {
        const wb = new THREE.Box3();
        for (const it of wheelItems[k]) wb.union(it.geo.boundingBox!);
        const c = wb.getCenter(new THREE.Vector3());
        const sz = wb.getSize(new THREE.Vector3());
        const radius = Math.max(sz.y, sz.z) * 0.5;
        const t = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
        for (const it of wheelItems[k]) it.geo.applyMatrix4(t);
        return { key: k, center: c, radius, parts: mergeByMaterial(wheelItems[k]), lodParts: [] as MergedPart[] };
      });
    }

    const bodyMerged = mergeByMaterial(bodyItems);
    // distance LOD: ~22% of the triangles, interior dropped entirely
    const lodCenter = bounds.getCenter(new THREE.Vector3());
    for (const p of bodyMerged) p.lod = p.role === 'interior' ? null : makeLod(p.geometry, 0.3, 0.004, lodCenter);
    if (wheels) for (const w of wheels) for (const p of w.parts) p.lod = makeLod(p.geometry, 0.3, 0.01, new THREE.Vector3());
    // LOD keeps one copy of each double-sided face; render it double sided so wrongly kept copies don't leave holes
    const lodBody = collapseParts(bodyMerged.filter((p) => p.lod).map((p) => ({ geometry: p.lod!, material: p.material, role: p.role })), true, false, true);
    // full detail: untextured parts share one vertex-PBR draw call (interior kept separate so it can be hidden)
    const body = collapseParts(bodyMerged, false, true);
    if (wheels) {
      for (const w of wheels) {
        w.lodParts = collapseParts(w.parts.filter((p) => p.lod).map((p) => ({ geometry: p.lod!, material: p.material, role: p.role })), true);
        w.parts = collapseParts(w.parts);
      }
    }
    let wheelbase = bounds.max.z - bounds.min.z;
    let trackFront = bounds.max.x - bounds.min.x;
    let trackRear = trackFront;
    let wheelRadius = 0.33;
    let wheelCenterY = 0.33;
    let axleMidZ = 0;
    if (wheels) {
      const [fl, fr, rl, rr] = wheels;
      wheelbase = (fl.center.z + fr.center.z) / 2 - (rl.center.z + rr.center.z) / 2;
      trackFront = Math.abs(fl.center.x - fr.center.x);
      trackRear = Math.abs(rl.center.x - rr.center.x);
      wheelRadius = (fl.radius + fr.radius + rl.radius + rr.radius) / 4;
      wheelCenterY = (fl.center.y + fr.center.y + rl.center.y + rr.center.y) / 4;
      axleMidZ = (fl.center.z + fr.center.z + rl.center.z + rr.center.z) / 4;
    } else {
      // estimate from bounds: typical overhangs
      const L = bounds.max.z - bounds.min.z;
      wheelbase = L * 0.6;
      trackFront = trackRear = (bounds.max.x - bounds.min.x) * 0.84;
      wheelRadius = Math.min(0.42, (bounds.max.y - bounds.min.y) * 0.24);
      wheelCenterY = wheelRadius;
      axleMidZ = (bounds.max.z + bounds.min.z) / 2;
    }

    const W = bounds.max.x - bounds.min.x;
    const H = bounds.max.y - bounds.min.y;
    let headlights = sideCenters(headParts);
    let taillights = sideCenters(tailParts);
    const hasHeadMat = headlights.length > 0;
    const hasTailMat = taillights.length > 0;
    if (headlights.length < 2) headlights = [new THREE.Vector3(W * 0.33, H * 0.48, bounds.max.z - 0.12), new THREE.Vector3(-W * 0.33, H * 0.48, bounds.max.z - 0.12)];
    if (taillights.length < 2) taillights = [new THREE.Vector3(W * 0.36, H * 0.6, bounds.min.z + 0.1), new THREE.Vector3(-W * 0.36, H * 0.6, bounds.min.z + 0.1)];
    let exhausts = exhaustParts.length ? sideCenters(exhaustParts) : [];
    if (!exhausts.length) exhausts = [new THREE.Vector3(W * 0.2, H * 0.22, bounds.min.z + 0.05), new THREE.Vector3(-W * 0.2, H * 0.22, bounds.min.z + 0.05)];

    let lodTris = 0;
    for (const p of [...lodBody, ...(wheels ?? []).flatMap((w) => w.lodParts)]) lodTris += (p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute('position').count) / 3;
    return { entry, body, lodBody, wheels, bounds, wheelbase, trackFront, trackRear, wheelRadius, wheelCenterY, axleMidZ, headlights, taillights, exhausts, hasHeadMat, hasTailMat, tris: Math.round(tris), lodTris: Math.round(lodTris) };
  }
}
