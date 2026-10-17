import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarModels, CarModelEntry, PreparedModel, MergedPart, MatRole } from './CarModels';

export interface CarVisualOptions {
  paint: number;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  wheelRadius: number;
  cgHeight: number;
  player: boolean;
  envMap: THREE.Texture | null;
  /** static front axle load fraction; used to place the body before the first updateWheels() call */
  frontWeight?: number;
  /** neon underglow color for the player car (null = none). Default cyan for the player. */
  underglow?: number | null;
}

// ---------------------------------------------------------------- shared resources

let _blobTex: THREE.Texture | null = null;
function blobTexture(): THREE.Texture {
  if (_blobTex) return _blobTex;
  // grayscale (alphaMap samples the green channel)
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 128);
  const grd = g.createRadialGradient(64, 64, 2, 64, 64, 63);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.35, '#c8c8c8');
  grd.addColorStop(0.7, '#3a3a3a');
  grd.addColorStop(1, '#000000');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  _blobTex = new THREE.CanvasTexture(c);
  return _blobTex;
}

let _shadowMat: THREE.MeshBasicMaterial | null = null;
function shadowMaterial(): THREE.MeshBasicMaterial {
  if (_shadowMat) return _shadowMat;
  _shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    alphaMap: blobTexture(),
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    toneMapped: false,
  });
  return _shadowMat;
}

const BEAM_LEN = 15;
const beamVert = /* glsl */ `
attribute float beamT;
varying float vT;
varying vec3 vN;
varying vec3 vV;
void main() {
  vT = beamT;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const beamFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying float vT;
varying vec3 vN;
varying vec3 vV;
void main() {
  float edge = pow(abs(dot(normalize(vN), normalize(vV))), 2.2);
  float fall = pow(1.0 - vT, 2.4) * smoothstep(0.0, 0.06, vT);
  gl_FragColor = vec4(uColor * (uIntensity * edge * fall), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function makeBeamMaterial(intensity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1.0, 0.93, 0.82) }, uIntensity: { value: intensity } },
    vertexShader: beamVert,
    fragmentShader: beamFrag,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}

/** Two light cones (one geometry) starting at the given lamp positions, aimed forward and slightly down. */
function makeBeamGeometry(lamps: THREE.Vector3[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const p of lamps.slice(0, 2)) {
    const g = new THREE.CylinderGeometry(2.1, 0.09, BEAM_LEN, 18, 1, true);
    g.rotateX(Math.PI / 2); // axis +Y -> +Z, wide end forward
    g.translate(0, 0, BEAM_LEN / 2);
    const pos = g.getAttribute('position');
    const t = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) t[i] = THREE.MathUtils.clamp(pos.getZ(i) / BEAM_LEN, 0, 1);
    g.setAttribute('beamT', new THREE.BufferAttribute(t, 1));
    g.rotateX(0.055); // aim slightly down
    g.rotateY(Math.sign(p.x) * 0.03); // slight toe-out
    g.translate(p.x, p.y, p.z + 0.02);
    g.deleteAttribute('uv');
    parts.push(g);
  }
  return mergeGeometries(parts, false)!;
}

/** Object-space metallic flake sparkle in the base layer (clearcoat stays mirror smooth). */
function addFlakes(mat: THREE.MeshPhysicalMaterial, strength = 0.16) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlake = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlakePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlakePos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vFlakePos;
uniform float uFlake;
vec3 flakeHash(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yxz + 19.19);
  return fract((p.xxy + p.yxx) * p.zyx);
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  vec3 cell = floor(vFlakePos * 700.0);
  float px = length(fwidth(vFlakePos)) * 700.0;
  float k = uFlake * clamp(1.4 - px, 0.0, 1.0);
  normal = normalize(normal + (flakeHash(cell) - 0.5) * k);
}`,
      );
  };
  mat.customProgramCacheKey = () => 'carpaint-flakes';
}

// ---------------------------------------------------------------- CarVisual

const _v = new THREE.Vector3();

export class CarVisual {
  readonly object = new THREE.Group();
  readonly body = new THREE.Group();
  readonly exhausts: THREE.Vector3[];
  readonly halfExtents: THREE.Vector3;
  readonly shadow: THREE.Mesh;
  readonly model: PreparedModel;
  /** model wheelbase vs spec wheelbase etc. (for tuning reports) */
  readonly fit: { modelWheelbase: number; modelTrackFront: number; modelTrackRear: number; modelWheelRadius: number; wheelScale: number };

  private readonly opts: CarVisualOptions;
  private readonly pivots: THREE.Group[] = [];
  private readonly spins: THREE.Group[] = [];
  private readonly interior: THREE.Object3D[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly paintMat: THREE.MeshPhysicalMaterial;
  private readonly headMat: THREE.MeshStandardMaterial;
  private readonly tailMat: THREE.MeshStandardMaterial;
  private readonly reverseMat: THREE.MeshStandardMaterial;
  private readonly beamMat: THREE.ShaderMaterial;
  private readonly spots: THREE.SpotLight[] = [];
  private readonly glow: THREE.Mesh | null = null;
  private readonly glowMat: THREE.MeshBasicMaterial | null = null;
  private readonly bodyOffset = new THREE.Vector3();
  private fittedZ = false;
  private time = Math.random() * 10;

  constructor(models: CarModels, entry: CarModelEntry, opts: CarVisualOptions) {
    const pm = models.get(entry.id);
    if (!pm) throw new Error(`CarVisual: model ${entry.id} not loaded`);
    this.model = pm;
    this.opts = opts;
    const envMap = opts.envMap;

    // ---- per-instance materials
    this.paintMat = new THREE.MeshPhysicalMaterial({
      name: 'carpaint',
      color: opts.paint,
      metalness: 0.68,
      roughness: 0.3,
      clearcoat: 1,
      clearcoatRoughness: 0.035,
      envMap,
      envMapIntensity: 1.25,
    });
    addFlakes(this.paintMat);
    this.headMat = new THREE.MeshStandardMaterial({ name: 'headlight', color: 0xffffff, emissive: 0xfff1df, emissiveIntensity: 10, roughness: 0.15, metalness: 0 });
    this.tailMat = new THREE.MeshStandardMaterial({ name: 'taillight', color: 0x2a0000, emissive: 0xff1608, emissiveIntensity: 2.6, roughness: 0.25, metalness: 0 });
    this.reverseMat = new THREE.MeshStandardMaterial({ name: 'reverse', color: 0x111111, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
    this.ownedMaterials.push(this.paintMat, this.headMat, this.tailMat, this.reverseMat);

    const roleMat = (part: MergedPart): THREE.Material => {
      switch (part.role) {
        case 'paint':
          return this.paintMat;
        case 'head':
          return this.headMat;
        case 'tail':
          return this.tailMat;
        default:
          if (envMap && (part.material as THREE.MeshStandardMaterial).isMeshStandardMaterial && !(part.material as THREE.MeshStandardMaterial).envMap) {
            // shared template materials: only set once
            (part.material as THREE.MeshStandardMaterial).envMap = envMap;
          }
          return part.material;
      }
    };

    // ---- body
    this.object.add(this.body);
    const bodyMeshes = new THREE.Group();
    this.body.add(bodyMeshes);
    for (const part of pm.body) {
      const mesh = new THREE.Mesh(part.geometry, roleMat(part));
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      if (part.role === 'glass') mesh.renderOrder = 1;
      bodyMeshes.add(mesh);
      if (part.role === 'interior') this.interior.push(mesh);
    }

    // ---- fit model to physics
    const fw = opts.frontWeight ?? 0.53;
    const physMid = (opts.wheelbase * (1 - 2 * fw)) / 2;
    const R = opts.wheelRadius;
    this.bodyOffset.set(0, R - opts.cgHeight - pm.wheelCenterY, physMid - pm.axleMidZ);
    bodyMeshes.position.copy(this.bodyOffset);
    const wheelScale = pm.wheels ? R / pm.wheelRadius : 1;
    this.fit = { modelWheelbase: pm.wheelbase, modelTrackFront: pm.trackFront, modelTrackRear: pm.trackRear, modelWheelRadius: pm.wheelRadius, wheelScale };

    // ---- wheels
    if (pm.wheels) {
      for (const w of pm.wheels) {
        const pivot = new THREE.Group();
        const spin = new THREE.Group();
        spin.scale.setScalar(wheelScale);
        for (const part of w.parts) spin.add(new THREE.Mesh(part.geometry, roleMat(part)));
        pivot.add(spin);
        pivot.position.set(w.center.x, w.center.y + this.bodyOffset.y, w.center.z + this.bodyOffset.z);
        this.object.add(pivot);
        this.pivots.push(pivot);
        this.spins.push(spin);
      }
    } else {
      // model wheels are baked into the body: make invisible pivots so the API still works
      for (let i = 0; i < 4; i++) {
        const pivot = new THREE.Group();
        const spin = new THREE.Group();
        pivot.add(spin);
        this.object.add(pivot);
        this.pivots.push(pivot);
        this.spins.push(spin);
      }
    }

    // ---- lights (emissive quads if the model has no light materials)
    const lightQuad = (p: THREE.Vector3, w: number, h: number, mat: THREE.Material, facing: number) => {
      const g = new THREE.PlaneGeometry(w, h);
      if (facing < 0) g.rotateY(Math.PI);
      this.ownedGeometries.push(g);
      const m = new THREE.Mesh(g, mat);
      m.position.copy(p).add(this.bodyOffset);
      m.position.z += facing * 0.01;
      this.body.add(m);
      return m;
    };
    const W = pm.bounds.max.x - pm.bounds.min.x;
    if (!pm.hasHeadMat) for (const p of pm.headlights) lightQuad(p, W * 0.16, 0.07, this.headMat, 1);
    if (!pm.hasTailMat) for (const p of pm.taillights) lightQuad(p, W * 0.18, 0.07, this.tailMat, -1);
    for (const p of pm.taillights) {
      const rp = p.clone();
      rp.x *= 0.62;
      rp.y -= 0.03;
      rp.z = pm.bounds.min.z + 0.015;
      lightQuad(rp, 0.12, 0.045, this.reverseMat, -1);
    }

    // headlight beams (all cars) + spot lights (player)
    const lampPos = pm.headlights.map((p) => p.clone().add(this.bodyOffset));
    const beamGeo = makeBeamGeometry(lampPos);
    this.ownedGeometries.push(beamGeo);
    this.beamMat = makeBeamMaterial(opts.player ? 0.03 : 0.045);
    this.ownedMaterials.push(this.beamMat);
    const beams = new THREE.Mesh(beamGeo, this.beamMat);
    beams.renderOrder = 3;
    beams.frustumCulled = true;
    this.body.add(beams);

    if (opts.player) {
      for (const p of lampPos.slice(0, 2)) {
        const s = new THREE.SpotLight(0xfff2e2, 700, 140, 0.46, 0.65, 1.5);
        s.position.copy(p);
        s.position.z += 0.1;
        s.target.position.set(p.x * 1.6, p.y - 1.4, p.z + 26);
        s.castShadow = false;
        this.body.add(s, s.target);
        this.spots.push(s);
      }
    }

    // ---- blob shadow + underglow (stay with the chassis, not the leaning body)
    const ext = pm.bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    this.halfExtents = ext.clone();
    const shGeo = new THREE.PlaneGeometry(ext.x * 2 * 1.35, ext.z * 2 * 1.14);
    shGeo.rotateX(-Math.PI / 2);
    this.ownedGeometries.push(shGeo);
    this.shadow = new THREE.Mesh(shGeo, shadowMaterial());
    this.shadow.position.set(0, -opts.cgHeight + 0.03, (pm.bounds.max.z + pm.bounds.min.z) / 2 + this.bodyOffset.z);
    this.shadow.renderOrder = 2;
    this.object.add(this.shadow);

    const glowColor = opts.underglow === undefined ? (opts.player ? 0x18e2ff : null) : opts.underglow;
    if (glowColor !== null && glowColor !== undefined) {
      const gGeo = new THREE.PlaneGeometry(ext.x * 2 * 1.25, ext.z * 2 * 0.95);
      gGeo.rotateX(-Math.PI / 2);
      this.ownedGeometries.push(gGeo);
      this.glowMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(glowColor).multiplyScalar(1.1),
        alphaMap: blobTexture(),
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -6,
        polygonOffsetUnits: -6,
        toneMapped: false,
      });
      this.ownedMaterials.push(this.glowMat);
      this.glow = new THREE.Mesh(gGeo, this.glowMat);
      this.glow.position.copy(this.shadow.position);
      this.glow.position.y += 0.005;
      this.glow.renderOrder = 3;
      this.object.add(this.glow);
    }

    this.exhausts = pm.exhausts.map((p) => p.clone().add(this.bodyOffset));
  }

  /**
   * centers: physics wheel centers relative to COM (Vehicle.wheelLocalCenter), FL FR RL RR.
   * The wheels keep the model's x/z (so they sit in their arches) and take height from the suspension.
   */
  updateWheels(centers: THREE.Vector3[], steer: number[], spin: number[]) {
    const pm = this.model;
    if (!this.fittedZ && centers.length === 4) {
      const physMid = ((centers[0].z + centers[1].z) / 2 + (centers[2].z + centers[3].z) / 2) / 2;
      const dz = physMid - pm.axleMidZ - this.bodyOffset.z;
      if (Math.abs(dz) > 1e-4) {
        this.bodyOffset.z += dz;
        this.body.children[0].position.z = this.bodyOffset.z;
        for (const c of this.body.children) if (c !== this.body.children[0]) c.position.z += dz;
        this.shadow.position.z += dz;
        if (this.glow) this.glow.position.z += dz;
        for (const e of this.exhausts) e.z += dz;
      }
      this.fittedZ = true;
    }
    let groundY = 0;
    for (let i = 0; i < 4; i++) {
      const p = this.pivots[i];
      const c = centers[i];
      if (pm.wheels) {
        const w = pm.wheels[i];
        p.position.set(w.center.x, c.y, w.center.z + this.bodyOffset.z);
      } else p.position.copy(c);
      p.rotation.set(0, steer[i] ?? 0, 0);
      this.spins[i].rotation.x = spin[i] ?? 0;
      groundY += c.y;
    }
    // keep the contact shadow on the ground below the tires
    groundY = groundY / 4 - this.opts.wheelRadius + 0.03;
    this.shadow.position.y = groundY;
    if (this.glow) this.glow.position.y = groundY + 0.005;
  }

  setLights(o: { brake: number; reverse: boolean; headlights: boolean; nitro: boolean }) {
    this.tailMat.emissiveIntensity = 2.4 + 13 * THREE.MathUtils.clamp(o.brake, 0, 1);
    this.reverseMat.emissiveIntensity = o.reverse ? 7 : 0;
    this.headMat.emissiveIntensity = o.headlights ? 10 : 0.4;
    this.beamMat.uniforms.uIntensity.value = o.headlights ? (this.opts.player ? 0.03 : 0.045) : 0;
    for (const s of this.spots) s.visible = o.headlights;
    if (this.glowMat) {
      this.time += 1 / 60;
      this.glowMat.opacity = o.nitro ? 0.5 + Math.sin(this.time * 30) * 0.12 : 0.32;
    }
  }

  setBodyLean(roll: number, pitch: number) {
    this.body.rotation.set(pitch, 0, roll);
  }

  /** Hide interior details when far away (cheap LOD). */
  updateLod(camera: THREE.Vector3) {
    const d = this.object.getWorldPosition(_v).distanceTo(camera);
    const showInterior = d < 28;
    for (const m of this.interior) m.visible = showInterior;
  }

  setPaint(color: number) {
    this.paintMat.color.set(color);
  }

  dispose() {
    this.object.removeFromParent();
    for (const m of this.ownedMaterials) m.dispose();
    for (const g of this.ownedGeometries) g.dispose();
  }
}

// ---------------------------------------------------------------- traffic

interface TrafficTemplate {
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material; role: MatRole }[];
  beam: THREE.BufferGeometry;
  shadow: THREE.BufferGeometry;
  center: THREE.Vector3;
  half: THREE.Vector3;
}

const trafficTemplates = new Map<string, TrafficTemplate>();
const trafficPaint = new Map<number, THREE.MeshStandardMaterial>();
let trafficHead: THREE.MeshStandardMaterial | null = null;
let trafficBeamMat: THREE.ShaderMaterial | null = null;

function trafficTemplate(models: CarModels, entry: CarModelEntry): TrafficTemplate {
  const cached = trafficTemplates.get(entry.id);
  if (cached) return cached;
  const pm = models.get(entry.id);
  if (!pm) throw new Error(`traffic model ${entry.id} not loaded`);
  const center = pm.bounds.getCenter(new THREE.Vector3());
  const half = pm.bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  // collect body + static wheels into one list, recentered on the bounds center, then merge per material
  const byMat = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; role: MatRole }>();
  const push = (g: THREE.BufferGeometry, mat: THREE.Material, role: MatRole) => {
    let e = byMat.get(mat);
    if (!e) byMat.set(mat, (e = { geos: [], role }));
    e.geos.push(g);
  };
  const toCenter = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
  for (const p of pm.body) push(p.geometry.clone().applyMatrix4(toCenter), p.material, p.role);
  if (pm.wheels) {
    for (const w of pm.wheels) {
      const m = new THREE.Matrix4().makeTranslation(w.center.x - center.x, w.center.y - center.y, w.center.z - center.z);
      for (const p of w.parts) push(p.geometry.clone().applyMatrix4(m), p.material, p.role);
    }
  }
  const W = half.x * 2;
  const quad = (p: THREE.Vector3, w: number, h: number, facing: number) => {
    const g = new THREE.PlaneGeometry(w, h);
    if (facing < 0) g.rotateY(Math.PI);
    g.translate(p.x - center.x, p.y - center.y, p.z - center.z + facing * 0.01);
    return g;
  };
  const dummy = new THREE.MeshStandardMaterial();
  if (!pm.hasHeadMat) for (const p of pm.headlights) push(quad(p, W * 0.16, 0.07, 1), dummy, 'head');
  const tailDummy = new THREE.MeshStandardMaterial();
  if (!pm.hasTailMat) for (const p of pm.taillights) push(quad(p, W * 0.18, 0.07, -1), tailDummy, 'tail');

  // merge all roles that share a final material: head parts -> one, tail parts -> one, paint -> one
  const roleBuckets = new Map<string, { geos: THREE.BufferGeometry[]; material: THREE.Material; role: MatRole }>();
  for (const [mat, e] of byMat) {
    const key = e.role === 'paint' || e.role === 'head' || e.role === 'tail' ? e.role : mat.uuid;
    let b = roleBuckets.get(key);
    if (!b) roleBuckets.set(key, (b = { geos: [], material: mat, role: e.role }));
    b.geos.push(...e.geos);
  }
  const parts: TrafficTemplate['parts'] = [];
  for (const b of roleBuckets.values()) {
    for (const g of b.geos) {
      if (!g.index) g.setIndex([...Array(g.getAttribute('position').count).keys()]);
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    }
    const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (merged) {
      merged.computeBoundingSphere();
      parts.push({ geometry: merged, material: b.material, role: b.role });
    }
  }
  const beam = makeBeamGeometry(pm.headlights.map((p) => p.clone().sub(center)));
  const shadow = new THREE.PlaneGeometry(half.x * 2 * 1.3, half.z * 2 * 1.12);
  shadow.rotateX(-Math.PI / 2);
  shadow.translate(0, -half.y + 0.03, 0);
  const t: TrafficTemplate = { parts, beam, shadow, center, half };
  trafficTemplates.set(entry.id, t);
  return t;
}

/** Normalized half extents (meters) of a model — use for traffic colliders. */
export function modelHalfExtents(models: CarModels, entry: CarModelEntry): THREE.Vector3 {
  const pm = models.get(entry.id);
  if (!pm) return new THREE.Vector3(0.9, 0.75, 2.3);
  return pm.bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
}

const TRAFFIC_COLORS = [0xe8e8e8, 0x1b1c1f, 0x8a9099, 0x2d4a7a, 0x7a1f22, 0xc9b28a, 0x3d5a40, 0xf2c500, 0x55606e, 0xffffff];

/**
 * Cheap traffic car. Origin = center of the model's bounding box (matches a cuboid collider of
 * `modelHalfExtents`), +Z forward, +Y up. userData.setBrake(0..1) drives the tail lights.
 */
export function makeTrafficVisual(models: CarModels, entry: CarModelEntry, paint?: number): THREE.Object3D {
  const t = trafficTemplate(models, entry);
  const color = paint ?? (entry.kind === 'taxi' ? 0xf2c500 : TRAFFIC_COLORS[(Math.random() * TRAFFIC_COLORS.length) | 0]);
  let pmat = trafficPaint.get(color);
  if (!pmat) {
    pmat = new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.32, envMapIntensity: 1.1 });
    trafficPaint.set(color, pmat);
  }
  if (!trafficHead) trafficHead = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1df, emissiveIntensity: 8, roughness: 0.2 });
  if (!trafficBeamMat) trafficBeamMat = makeBeamMaterial(0.04);
  const tail = new THREE.MeshStandardMaterial({ color: 0x2a0000, emissive: 0xff1608, emissiveIntensity: 2.2, roughness: 0.3 });
  const root = new THREE.Group();
  for (const p of t.parts) {
    const mat = p.role === 'paint' ? pmat : p.role === 'head' ? trafficHead : p.role === 'tail' ? tail : p.material;
    root.add(new THREE.Mesh(p.geometry, mat));
  }
  const beam = new THREE.Mesh(t.beam, trafficBeamMat);
  beam.renderOrder = 3;
  root.add(beam);
  const sh = new THREE.Mesh(t.shadow, shadowMaterial());
  sh.renderOrder = 2;
  root.add(sh);
  root.userData.setBrake = (b: number) => {
    tail.emissiveIntensity = 2.2 + 12 * THREE.MathUtils.clamp(b, 0, 1);
  };
  root.userData.halfExtents = t.half.clone();
  root.userData.dispose = () => tail.dispose();
  return root;
}
