import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Track } from '../track/Track';
import { CURB_HEIGHT, TUNNEL_HEIGHT, START_S } from '../track/TrackDef';
import type { TrackMesh } from './TrackMesh';
import type { LampLighting } from './LampLighting';
import type { City } from './City';
import type { Terrain } from './Terrain';
import type { TrackGrid } from './TrackGrid';
import { applyPatches } from './ShaderPatch';
import { worldUniforms } from './TrackMaterials';
import { Rng } from './rng';

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _b = new THREE.Matrix4();

interface Inst {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  sample: number;
  color?: THREE.Color;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, list: Inst[], name: string, withSample = true): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
  mesh.count = list.length;
  const sidx = new Float32Array(Math.max(1, list.length));
  list.forEach((it, i) => {
    _m.compose(it.pos, it.quat, it.scale);
    mesh.setMatrixAt(i, _m);
    if (it.color) mesh.setColorAt(i, it.color);
    sidx[i] = it.sample;
  });
  if (withSample) geo.setAttribute('sampleIdx', new THREE.InstancedBufferAttribute(sidx, 1));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.name = name;
  return mesh;
}

function quatFromFrame(fwd: THREE.Vector3, up = UP): THREE.Quaternion {
  const f = fwd.clone().setY(0).normalize();
  const x = new THREE.Vector3().crossVectors(up, f).normalize();
  _b.makeBasis(x, up, f);
  return new THREE.Quaternion().setFromRotationMatrix(_b);
}

/** Canvas texture helper for gantry banners / road signs. */
function bannerTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export class StreetProps {
  readonly group = new THREE.Group();
  private startLights!: THREE.InstancedMesh;
  private trafficLenses: { mesh: THREE.InstancedMesh; phases: number[] } | null = null;
  readonly darkMetal: THREE.MeshStandardMaterial;

  constructor(
    readonly track: Track,
    readonly trackMesh: TrackMesh,
    readonly lamps: LampLighting,
    readonly city: City,
    readonly terrain: Terrain,
    readonly grid: TrackGrid,
    readonly zebras: number[],
    readonly quality: { particles: number; bloom: boolean },
  ) {
    this.group.name = 'streetProps';
    this.darkMetal = applyPatches(new THREE.MeshStandardMaterial({ color: 0x2b2e34, metalness: 0.75, roughness: 0.42 }), [lamps.patch({ flat: true })]);
    this.buildStreetlights();
    this.buildTunnel();
    this.buildGantry();
    this.buildOverheadSigns();
    this.buildBarrierPosts();
    this.buildTrafficLights();
    this.buildTrees();
    this.buildDocks();
  }

  private nearestSample(p: THREE.Vector3): number {
    return this.grid.nearest(p.x, p.z, 80).index;
  }

  // ------------------------------------------------------------------ streetlights
  private buildStreetlights() {
    const t = this.track;
    const poles: Inst[] = [];
    const arms: Inst[] = [];
    const heads: Inst[] = [];
    const lenses: Inst[] = [];
    const cones: Inst[] = [];
    const fixtures: Inst[] = [];
    for (const L of t.lamps) {
      const f = t.frameAt(L.s);
      const si = t.wrap(Math.round(L.s / t.step));
      if (L.tunnel) {
        fixtures.push({ pos: L.pos.clone().add(new THREE.Vector3(0, 0.15, 0)), quat: quatFromFrame(f.tangent), scale: new THREE.Vector3(0.45, 0.14, 2.6), sample: si, color: L.color.clone().multiplyScalar(9) });
        continue;
      }
      const baseLat = L.side * (t.halfWidth + 0.9);
      const base = f.pos.clone().addScaledVector(f.right, baseLat).addScaledVector(f.up, CURB_HEIGHT);
      const topY = L.pos.y + 0.35;
      const h = topY - base.y;
      poles.push({ pos: base, quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, h, 1), sample: si });
      // arm from pole top to the head
      const head = L.pos.clone();
      const dir = new THREE.Vector3().subVectors(head, base).setY(0);
      const len = dir.length();
      dir.normalize();
      const armQ = quatFromFrame(dir);
      arms.push({ pos: new THREE.Vector3(base.x, topY - 0.05, base.z).addScaledVector(dir, len * 0.5), quat: armQ, scale: new THREE.Vector3(0.12, 0.12, len + 0.2), sample: si });
      heads.push({ pos: head.clone().add(new THREE.Vector3(0, 0.12, 0)), quat: armQ, scale: new THREE.Vector3(0.5, 0.2, 1.05), sample: si });
      lenses.push({ pos: head.clone().add(new THREE.Vector3(0, -0.0, 0)), quat: armQ, scale: new THREE.Vector3(0.38, 0.04, 0.85), sample: si, color: L.color.clone().multiplyScalar(14) });
      const coneH = head.y - (f.pos.y - 0.2);
      cones.push({ pos: head.clone(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(coneH * 0.62, coneH, coneH * 0.62), sample: si, color: L.color.clone() });
    }
    const poleGeo = new THREE.CylinderGeometry(0.085, 0.14, 1, 10, 1).translate(0, 0.5, 0);
    this.group.add(instanced(poleGeo, this.darkMetal, poles, 'lampPoles'));
    this.group.add(instanced(new THREE.BoxGeometry(1, 1, 1), this.darkMetal, arms, 'lampArms'));
    this.group.add(instanced(new THREE.BoxGeometry(1, 1, 1), this.darkMetal, heads, 'lampHeads'));
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
    this.group.add(instanced(new THREE.BoxGeometry(1, 1, 1), lensMat, lenses, 'lampLenses', false));
    this.group.add(instanced(new THREE.BoxGeometry(1, 1, 1), lensMat, fixtures, 'tunnelFixtures', false));
    if (this.quality.bloom) this.group.add(this.lightCones(cones));
  }

  private lightCones(list: Inst[]): THREE.InstancedMesh {
    const geo = new THREE.ConeGeometry(1, 1, 28, 6, true).translate(0, -0.5, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsLib.fog, uStrength: { value: 0.05 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        varying float vY;
        varying vec3 vN;
        varying vec3 vV;
        varying vec3 vCol;
        void main() {
          vY = -position.y;
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vec4 mvPosition = viewMatrix * wp;
          vN = normalize(mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          vV = normalize(-mvPosition.xyz);
          #ifdef USE_INSTANCING_COLOR
            vCol = instanceColor;
          #else
            vCol = vec3(1.0);
          #endif
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uStrength;
        varying float vY;
        varying vec3 vN;
        varying vec3 vV;
        varying vec3 vCol;
        void main() {
          float facing = abs(dot(normalize(vN), normalize(vV)));
          float a = pow(facing, 2.0) * pow(1.0 - vY, 1.3) * smoothstep(0.0, 0.08, vY) * smoothstep(1.0, 0.85, vY);
          gl_FragColor = vec4(vCol * a * uStrength, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true,
    });
    const m = instanced(geo, mat, list, 'lightCones', false);
    m.renderOrder = 6;
    return m;
  }

  // ------------------------------------------------------------------ tunnel
  private buildTunnel() {
    const t = this.track;
    const geos: THREE.BufferGeometry[] = [];
    const fans: Inst[] = [];
    const leds: Inst[] = [];
    // find tunnel runs
    const runs: [number, number][] = [];
    let start = -1;
    for (let i = 0; i < t.count; i++) {
      if (t.tunnel[i] && start < 0) start = i;
      if (!t.tunnel[i] && start >= 0) {
        runs.push([start, i - 1]);
        start = -1;
      }
    }
    if (start >= 0) runs.push([start, t.count - 1]);
    const concrete = applyPatches(new THREE.MeshStandardMaterial({ color: 0x55534f, roughness: 0.9 }), [this.lamps.patch({ flat: true })]);
    for (const [a, b] of runs) {
      for (const [idx, dirSign] of [
        [a, -1],
        [b, 1],
      ] as [number, number][]) {
        const f = t.frameAt(idx * t.step);
        const lat0 = t.halfWidth + t.sidewalk[idx];
        const q = quatFromFrame(f.tangent);
        const W = lat0 + 0.7;
        const add = (lat: number, h0: number, h1: number, w: number) => {
          const g = new THREE.BoxGeometry(w, h1 - h0, 2.4);
          const p = f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, (h0 + h1) / 2).addScaledVector(f.tangent, dirSign * 1.2);
          g.applyQuaternion(q);
          g.translate(p.x, p.y, p.z);
          const s = new Float32Array(g.attributes.position.count).fill(idx);
          g.setAttribute('sampleIdx', new THREE.BufferAttribute(s, 1));
          geos.push(g);
        };
        add(0, TUNNEL_HEIGHT, TUNNEL_HEIGHT + 3.8, 2 * W + 8);
        add(W + 2, -1, TUNNEL_HEIGHT, 4);
        add(-W - 2, -1, TUNNEL_HEIGHT, 4);
      }
      // jet fans and wall LEDs
      for (let i = a + 20; i < b - 10; i += 45) {
        const f = t.frameAt(i * t.step);
        for (const sd of [-1, 1]) {
          fans.push({ pos: f.pos.clone().addScaledVector(f.right, sd * 1.6).addScaledVector(f.up, TUNNEL_HEIGHT - 0.75), quat: quatFromFrame(f.tangent), scale: new THREE.Vector3(1, 1, 1), sample: i });
        }
      }
      for (let i = a; i < b; i += 6) {
        const f = t.frameAt(i * t.step);
        for (const sd of [-1, 1]) {
          const lat = sd * (t.halfWidth + t.sidewalk[i] - 0.02);
          leds.push({ pos: f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, 0.95), quat: quatFromFrame(f.tangent), scale: new THREE.Vector3(0.05, 0.08, 0.5), sample: i, color: (i / 6) % 4 === 0 ? new THREE.Color(0.1, 3, 0.6) : new THREE.Color(2.5, 1.2, 0.2) });
        }
      }
    }
    if (geos.length) {
      const merged = mergeGeometries(geos)!;
      const mesh = new THREE.Mesh(merged, concrete);
      mesh.name = 'tunnelPortals';
      this.group.add(mesh);
    }
    const fanGeo = new THREE.CylinderGeometry(0.55, 0.55, 3.2, 14, 1).rotateX(Math.PI / 2);
    this.group.add(instanced(fanGeo, this.darkMetal, fans, 'jetFans'));
    this.group.add(instanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), leds, 'tunnelLeds', false));
  }

  // ------------------------------------------------------------------ start / finish gantry
  private buildGantry() {
    const t = this.track;
    const f = t.frameAt(START_S);
    const q = quatFromFrame(f.tangent);
    const si = t.wrap(Math.round(START_S / t.step));
    const span = t.halfWidth + 2.4;
    const geos: THREE.BufferGeometry[] = [];
    const box = (lat: number, h: number, w: number, hh: number, d: number, along = 0) => {
      const g = new THREE.BoxGeometry(w, hh, d);
      g.applyQuaternion(q);
      const p = f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, h).addScaledVector(f.tangent, along);
      g.translate(p.x, p.y, p.z);
      g.setAttribute('sampleIdx', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(si), 1));
      geos.push(g);
    };
    for (const sd of [-1, 1]) {
      box(sd * span, 4.3 + CURB_HEIGHT, 0.9, 8.6, 0.9);
      box(sd * span, 0.3 + CURB_HEIGHT, 1.6, 0.6, 1.6);
    }
    // truss: top + bottom chords and diagonals
    box(0, 8.4, span * 2 + 1, 0.35, 0.35, -0.5);
    box(0, 8.4, span * 2 + 1, 0.35, 0.35, 0.5);
    box(0, 7.0, span * 2 + 1, 0.35, 0.35, -0.5);
    box(0, 7.0, span * 2 + 1, 0.35, 0.35, 0.5);
    for (let k = -8; k <= 8; k++) {
      const g = new THREE.BoxGeometry(0.16, 1.9, 0.16);
      g.rotateZ(k % 2 === 0 ? 0.6 : -0.6);
      g.applyQuaternion(q);
      const p = f.pos.clone().addScaledVector(f.right, k * (span / 8.5)).addScaledVector(f.up, 7.7);
      for (const al of [-0.5, 0.5]) {
        const gg = g.clone();
        const pp = p.clone().addScaledVector(f.tangent, al);
        gg.translate(pp.x, pp.y, pp.z);
        gg.setAttribute('sampleIdx', new THREE.BufferAttribute(new Float32Array(gg.attributes.position.count).fill(si), 1));
        geos.push(gg);
      }
    }
    // start light housing
    box(0, 6.05, 6.6, 1.25, 0.4, -0.75);
    const mesh = new THREE.Mesh(mergeGeometries(geos)!, this.darkMetal);
    mesh.name = 'gantry';
    this.group.add(mesh);

    // banners (front faces oncoming cars: normal = -tangent)
    const front = bannerTexture(2048, 256, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 2048, 0);
      g.addColorStop(0, '#0a0012');
      g.addColorStop(0.5, '#1a0630');
      g.addColorStop(1, '#0a0012');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 2048, 256);
      // checker ends
      for (let x = 0; x < 6; x++) for (let y = 0; y < 4; y++) {
        ctx.fillStyle = (x + y) % 2 ? '#ffffff' : '#000000';
        ctx.fillRect(x * 32 + 20, y * 64, 32, 64);
        ctx.fillRect(2048 - 212 + x * 32, y * 64, 32, 64);
      }
      ctx.font = '900 italic 170px "Arial Black", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#ff2d95';
      ctx.shadowBlur = 40;
      ctx.fillStyle = '#ff5cb3';
      ctx.fillText('YWGI  DRIVE', 1024, 132);
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#ffffff';
      ctx.fillText('YWGI  DRIVE', 1024, 132);
    });
    const back = bannerTexture(2048, 256, (ctx) => {
      ctx.fillStyle = '#05060f';
      ctx.fillRect(0, 0, 2048, 256);
      ctx.font = '900 italic 130px "Arial Black", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 36;
      ctx.fillStyle = '#7ff3ff';
      ctx.fillText('MIDNIGHT CIRCUIT', 1024, 132);
    });
    const bw = span * 2 + 0.5;
    for (const [tex, dir] of [
      [front, -1],
      [back, 1],
    ] as [THREE.Texture, number][]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(bw, bw / 8), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(2.2, 2.2, 2.2), fog: true }));
      const p = f.pos.clone().addScaledVector(f.up, 7.7).addScaledVector(f.tangent, dir * 0.72);
      m.position.copy(p);
      m.quaternion.copy(quatFromFrame(f.tangent.clone().multiplyScalar(dir)));
      m.name = 'gantryBanner';
      this.group.add(m);
    }
    // start lights: 5 columns x 2 rows, on the face toward the grid
    const lights: Inst[] = [];
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 2; r++) {
        const p = f.pos.clone().addScaledVector(f.right, (c - 2) * 1.25).addScaledVector(f.up, 6.35 - r * 0.6).addScaledVector(f.tangent, -0.98);
        lights.push({ pos: p, quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1), sample: si, color: new THREE.Color(0.05, 0.0, 0.0) });
      }
    }
    this.startLights = instanced(new THREE.SphereGeometry(0.24, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }), lights, 'startLights', false);
    this.group.add(this.startLights);
  }

  /** 0..5 red columns lit; -1 = all green (go); -2 = all off. */
  setStartLights(n: number) {
    const off = new THREE.Color(0.06, 0.005, 0.005);
    const red = new THREE.Color(14, 0.4, 0.2);
    const green = new THREE.Color(0.3, 14, 1.5);
    const offG = new THREE.Color(0.01, 0.02, 0.01);
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 2; r++) {
        const i = c * 2 + r;
        let col = off;
        if (n === -1) col = green;
        else if (n === -2) col = offG;
        else if (c < n) col = red;
        this.startLights.setColorAt(i, col);
      }
    }
    this.startLights.instanceColor!.needsUpdate = true;
  }

  // ------------------------------------------------------------------ overhead road signs
  private buildOverheadSigns() {
    const t = this.track;
    const defs = [
      { s: 420, lines: ['HARBOR  ⟶', 'DOCKS 1.2 km'] },
      { s: 1240, lines: ['MIDNIGHT TUNNEL', 'NO STOPPING  700 m'] },
      { s: 2620, lines: ['DOWNTOWN', 'CITY CENTRE  ⟶'] },
      { s: 3330, lines: ['YWGI DRIVE', 'START / FINISH 500 m'] },
    ];
    const geos: THREE.BufferGeometry[] = [];
    for (const d of defs) {
      const i = t.wrap(Math.round(d.s / t.step));
      if (t.tunnel[i]) continue;
      const f = t.frameAt(d.s);
      const q = quatFromFrame(f.tangent);
      const span = t.halfWidth + 1.8;
      const add = (lat: number, h: number, w: number, hh: number, dd: number) => {
        const g = new THREE.BoxGeometry(w, hh, dd);
        g.applyQuaternion(q);
        const p = f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, h);
        g.translate(p.x, p.y, p.z);
        g.setAttribute('sampleIdx', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(i), 1));
        geos.push(g);
      };
      for (const sd of [-1, 1]) add(sd * span, 3.8 + CURB_HEIGHT, 0.35, 7.6, 0.35);
      add(0, 7.4, span * 2, 0.3, 0.3);
      const tex = bannerTexture(1024, 384, (ctx) => {
        ctx.fillStyle = '#0b5a2a';
        ctx.fillRect(0, 0, 1024, 384);
        ctx.strokeStyle = '#e8f2e8';
        ctx.lineWidth = 12;
        ctx.strokeRect(14, 14, 996, 356);
        ctx.fillStyle = '#f2f6f0';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 110px "Arial Narrow", Arial, sans-serif';
        ctx.fillText(d.lines[0], 512, 135, 940);
        ctx.font = 'bold 70px "Arial Narrow", Arial, sans-serif';
        ctx.fillText(d.lines[1], 512, 275, 940);
      });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(0.55, 0.55, 0.55), fog: true }));
      sign.position.copy(f.pos.clone().addScaledVector(f.up, 6.2).addScaledVector(f.right, 3.2).addScaledVector(f.tangent, -0.25));
      sign.quaternion.copy(quatFromFrame(f.tangent.clone().negate()));
      sign.name = 'roadSign';
      this.group.add(sign);
    }
    if (geos.length) {
      const m = new THREE.Mesh(mergeGeometries(geos)!, this.darkMetal);
      m.name = 'signGantries';
      this.group.add(m);
    }
  }

  // ------------------------------------------------------------------ barrier posts
  private buildBarrierPosts() {
    const t = this.track;
    const tm = this.trackMesh;
    const posts: Inst[] = [];
    for (let i = 0; i < t.count; i++) {
      for (const side of [-1, 1]) {
        const k = side < 0 ? tm.kindLeft[i] : tm.kindRight[i];
        if (k !== 'guard' && k !== 'rail') continue;
        const every = k === 'guard' ? 2 : 1;
        if (i % every !== 0) continue;
        const f = t.frameAt(i * t.step);
        const lat = side * (t.halfWidth + t.sidewalk[i] + (k === 'guard' ? 0.2 : 0.06));
        const h = k === 'guard' ? 0.85 : 1.08;
        const p = f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, CURB_HEIGHT);
        posts.push({ pos: p, quat: quatFromFrame(f.tangent), scale: new THREE.Vector3(k === 'guard' ? 0.1 : 0.06, h, k === 'guard' ? 0.16 : 0.06), sample: i });
      }
    }
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = applyPatches(new THREE.MeshStandardMaterial({ color: 0x8c9298, metalness: 0.8, roughness: 0.4 }), [this.lamps.patch({ flat: true })]);
    this.group.add(instanced(geo, mat, posts, 'barrierPosts'));
  }

  // ------------------------------------------------------------------ traffic lights at crossings
  private buildTrafficLights() {
    const t = this.track;
    const geos: THREE.BufferGeometry[] = [];
    const lenses: Inst[] = [];
    const phases: number[] = [];
    this.zebras.forEach((zs, zi) => {
      for (const side of [-1, 1]) {
        const s = zs - side * 4.5;
        const i = t.wrap(Math.round(s / t.step));
        const f = t.frameAt(s);
        const q = quatFromFrame(f.tangent.clone().multiplyScalar(-side));
        const base = f.pos.clone().addScaledVector(f.right, side * (t.halfWidth + 0.7)).addScaledVector(f.up, CURB_HEIGHT);
        const add = (p: THREE.Vector3, w: number, h: number, d: number) => {
          const g = new THREE.BoxGeometry(w, h, d);
          g.applyQuaternion(q);
          g.translate(p.x, p.y, p.z);
          g.setAttribute('sampleIdx', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(i), 1));
          geos.push(g);
        };
        add(base.clone().add(new THREE.Vector3(0, 2.9, 0)), 0.2, 5.8, 0.2);
        const armEnd = base.clone().addScaledVector(f.right, -side * 4.2);
        const armMid = base.clone().addScaledVector(f.right, -side * 2.1);
        armMid.y += 5.6;
        const ag = new THREE.BoxGeometry(4.3, 0.14, 0.14);
        ag.applyQuaternion(q);
        ag.translate(armMid.x, armMid.y, armMid.z);
        ag.setAttribute('sampleIdx', new THREE.BufferAttribute(new Float32Array(ag.attributes.position.count).fill(i), 1));
        geos.push(ag);
        const head = armEnd.clone();
        head.y += 5.0;
        add(head, 0.45, 1.3, 0.35);
        const facing = f.tangent.clone().multiplyScalar(-side);
        for (let k = 0; k < 3; k++) {
          const lp = head.clone().addScaledVector(facing, 0.19);
          lp.y += 0.4 - k * 0.4;
          lenses.push({ pos: lp, quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1), sample: i, color: new THREE.Color(0, 0, 0) });
          phases.push(zi * 0.37 + (side > 0 ? 0.5 : 0));
        }
      }
    });
    if (geos.length) {
      const m = new THREE.Mesh(mergeGeometries(geos)!, this.darkMetal);
      m.name = 'trafficLightPoles';
      this.group.add(m);
      const lm = instanced(new THREE.SphereGeometry(0.15, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), lenses, 'trafficLenses', false);
      this.group.add(lm);
      this.trafficLenses = { mesh: lm, phases };
    }
  }

  // ------------------------------------------------------------------ trees
  private buildTrees() {
    const t = this.track;
    const r = new Rng(555);
    const list: Inst[] = [];
    const tryTree = (x: number, z: number, scale: number) => {
      if (!this.city.free(x, z, 2.5)) return false;
      if (this.terrain.basin(x, z) > 0.01) return false;
      const y = this.terrain.height(x, z);
      const c = new THREE.Color().setHSL(r.range(0.2, 0.33), r.range(0.25, 0.5), r.range(0.025, 0.06));
      list.push({ pos: new THREE.Vector3(x, y - 0.2, z), quat: new THREE.Quaternion().setFromAxisAngle(UP, r.next() * 6.28), scale: new THREE.Vector3(scale, scale * r.range(0.85, 1.25), scale), sample: this.grid.nearest(x, z, 70).index, color: c });
      this.city.reserve(x, z, 3, 3, 0);
      return true;
    };
    // rows behind barriers in the park/hills
    for (let i = 0; i < t.count; i += 4) {
      const zone = t.zoneAt(i);
      if (zone !== 'park' && zone !== 'hills' && !(zone === 'harbor' && i % 12 === 0)) continue;
      for (const side of [-1, 1]) {
        if (!r.chance(zone === 'park' ? 0.85 : 0.55)) continue;
        const lat = side * (t.halfWidth + t.sidewalk[i] + r.range(3.5, 9));
        tryTree(t.px[i] + t.rx[i] * lat + r.range(-1.5, 1.5), t.pz[i] + t.rz[i] * lat + r.range(-1.5, 1.5), r.range(0.8, 1.3));
      }
    }
    // scattered groves in free park/hill space
    for (let k = 0; k < 2600; k++) {
      const i = r.int(0, t.count - 1);
      const zone = t.zoneAt(i);
      if (zone !== 'park' && zone !== 'hills') continue;
      const side = r.chance(0.5) ? 1 : -1;
      const lat = side * r.range(20, 160);
      tryTree(t.px[i] + t.rx[i] * lat, t.pz[i] + t.rz[i] * lat, r.range(0.9, 1.6));
    }
    const trunk = new THREE.CylinderGeometry(0.16, 0.24, 3.2, 6).translate(0, 1.6, 0);
    const crown = new THREE.IcosahedronGeometry(2.3, 1).scale(1, 1.15, 1).translate(0, 4.6, 0);
    const crown2 = new THREE.IcosahedronGeometry(1.6, 1).translate(0.9, 6.0, 0.4);
    const colorize = (g: THREE.BufferGeometry, c: THREE.Color) => {
      const arr = new Float32Array(g.attributes.position.count * 3);
      for (let k = 0; k < arr.length; k += 3) arr.set([c.r, c.g, c.b], k);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g.toNonIndexed();
    };
    const tree = mergeGeometries([colorize(trunk, new THREE.Color(0.25, 0.18, 0.12)), colorize(crown, new THREE.Color(1, 1, 1)), colorize(crown2, new THREE.Color(1, 1, 1))])!;
    tree.computeVertexNormals();
    const mat = applyPatches(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), [this.lamps.patch({ flat: true })]);
    const mesh = instanced(tree, mat, list, 'trees');
    this.group.add(mesh);
  }

  // ------------------------------------------------------------------ docks: cranes & containers
  private buildDocks() {
    const r = new Rng(808);
    const boxes: Inst[] = [];
    const colors = [0xb0301f, 0x1f4fa8, 0xd2731c, 0x2c7a3c, 0x8a8f96, 0xd8d8d0, 0x6b2a7a, 0x0f6f7a].map((c) => new THREE.Color(c));
    for (const y of this.city.yards) {
      const c = Math.cos(y.yaw), s = Math.sin(y.yaw);
      const nx = Math.max(1, Math.floor(y.w / 13));
      const nz = Math.max(1, Math.floor(y.d / 3.0));
      for (let a = 0; a < nx; a++) {
        for (let b = 0; b < nz; b++) {
          if (r.chance(0.15)) continue;
          const lx = (a + 0.5) * (y.w / nx) - y.w / 2;
          const lz = (b + 0.5) * (y.d / nz) - y.d / 2;
          const px = y.x + lx * c + lz * s;
          const pz = y.z - lx * s + lz * c;
          const stack = r.int(1, 4);
          for (let k = 0; k < stack; k++) {
            boxes.push({
              pos: new THREE.Vector3(px, y.y - 0.1 + k * 2.6, pz),
              quat: new THREE.Quaternion().setFromAxisAngle(UP, y.yaw + Math.PI / 2 + r.range(-0.02, 0.02)),
              scale: new THREE.Vector3(12.2, 2.59, 2.44),
              sample: this.grid.nearest(px, pz, 70).index,
              color: r.pick(colors).clone().multiplyScalar(r.range(0.55, 1.0)),
            });
          }
        }
      }
    }
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = applyPatches(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.5 }), [
      this.lamps.patch({ flat: true }),
      {
        key: 'container',
        vertexHeader: 'varying vec3 vCL;',
        vertex: [{ after: 'begin_vertex', code: 'vCL = position * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));' }],
        fragmentHeader: 'varying vec3 vCL;',
        fragment: [{ after: 'color_fragment', code: 'float rib = 0.75 + 0.25 * step(0.5, fract((vCL.x + vCL.z) * 3.2)); diffuseColor.rgb *= rib * mix(0.6, 1.0, smoothstep(0.0, 0.3, vCL.y));' }],
      },
    ]);
    if (boxes.length) this.group.add(instanced(geo, mat, boxes, 'containers'));

    // ship-to-shore cranes along the docks quay (left side, booms over the water)
    const t = this.track;
    const craneGeos: THREE.BufferGeometry[] = [];
    const add = (w: number, h: number, d: number, x: number, y: number, z: number) => craneGeos.push(new THREE.BoxGeometry(w, h, d).translate(x, y, z));
    // legs
    for (const lx of [-8, 8]) for (const lz of [-6, 6]) add(1.2, 42, 1.2, lx, 21, lz);
    add(18, 1.6, 1.6, 0, 42, -6);
    add(18, 1.6, 1.6, 0, 42, 6);
    add(1.4, 1.4, 14, -8, 30, 0);
    add(1.4, 1.4, 14, 8, 30, 0);
    // boom (extends toward -x over the water) and back reach
    add(70, 2.2, 2.2, -22, 44.5, -2.5);
    add(70, 2.2, 2.2, -22, 44.5, 2.5);
    add(3, 8, 3, 6, 50, 0);
    add(6, 4, 7, 2, 39, 0);
    const crane = mergeGeometries(craneGeos)!;
    const craneMat = applyPatches(new THREE.MeshStandardMaterial({ color: 0x8a1c14, roughness: 0.6, metalness: 0.4 }), [this.lamps.patch({ flat: true })]);
    const cranes: Inst[] = [];
    for (const s of [1290, 1390, 1490, 1660, 1740]) {
      const i = t.wrap(Math.round(s / t.step));
      const f = t.frameAt(s);
      // left side is the water side along the harbor & docks
      const lat = -(t.halfWidth + t.sidewalk[i] + 14);
      const p = f.pos.clone().addScaledVector(f.right, lat);
      p.y = Math.max(-1.2, this.terrain.height(p.x, p.z)) - 0.5;
      // crane local -x should point away from the road (toward the water): local x = right
      const x = f.right.clone().setY(0).normalize();
      const z = new THREE.Vector3().crossVectors(x, UP).normalize();
      _b.makeBasis(x, UP, z);
      cranes.push({ pos: p, quat: new THREE.Quaternion().setFromRotationMatrix(_b), scale: new THREE.Vector3(1, r.range(0.9, 1.1), 1), sample: i });
    }
    this.group.add(instanced(crane, craneMat, cranes, 'cranes'));
  }

  update(time: number) {
    if (this.trafficLenses) {
      const { mesh, phases } = this.trafficLenses;
      const red = new THREE.Color(9, 0.3, 0.1), amb = new THREE.Color(9, 4, 0.2), grn = new THREE.Color(0.2, 8, 2), off = new THREE.Color(0.03, 0.03, 0.03);
      for (let i = 0; i < phases.length; i += 3) {
        const ph = (time / 24 + phases[i]) % 1;
        const state = ph < 0.45 ? 2 : ph < 0.52 ? 1 : 0; // 2 green, 1 amber, 0 red
        mesh.setColorAt(i, state === 0 ? red : off);
        mesh.setColorAt(i + 1, state === 1 ? amb : off);
        mesh.setColorAt(i + 2, state === 2 ? grn : off);
      }
      mesh.instanceColor!.needsUpdate = true;
    }
    void _p;
    void _q;
    void _s;
  }
}

export { worldUniforms };
