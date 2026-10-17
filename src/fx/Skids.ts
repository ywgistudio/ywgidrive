import * as THREE from 'three';

const vert = /* glsl */ `
attribute vec3 aData; // x alpha, y across (0..1), z birth time
uniform float uTime;
uniform float uFadeStart;
uniform float uFadeEnd;
varying float vAlpha;
varying float vAcross;
void main() {
  float age = uTime - aData.z;
  vAlpha = aData.x * (1.0 - smoothstep(uFadeStart, uFadeEnd, age));
  vAcross = aData.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying float vAcross;
void main() {
  float edge = smoothstep(0.0, 0.18, vAcross) * smoothstep(1.0, 0.82, vAcross);
  float tread = 0.72 + 0.28 * step(0.45, fract(vAcross * 4.0));
  float a = vAlpha * edge * tread * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

interface WheelTrail {
  lx: number; ly: number; lz: number; // left edge
  rx: number; ry: number; rz: number; // right edge
  cx: number; cy: number; cz: number; // center
  a: number;
  valid: boolean;
  frame: number;
}

export class Skids {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private pos: THREE.BufferAttribute;
  private data: THREE.BufferAttribute;
  private max: number;
  private head = 0;
  private lo = -1;
  private hi = -1;
  private trails = new Map<number, WheelTrail>();
  private frame = 0;
  private time = 0;
  readonly uniforms = {
    uTime: { value: 0 },
    uFadeStart: { value: 40 },
    uFadeEnd: { value: 70 },
    uColor: { value: new THREE.Color(0.012, 0.012, 0.014) },
    uOpacity: { value: 0.72 },
  };

  constructor(maxSegments: number) {
    this.max = maxSegments;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(maxSegments * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.data = new THREE.BufferAttribute(new Float32Array(maxSegments * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const idx = new Uint32Array(maxSegments * 6);
    for (let s = 0; s < maxSegments; s++) {
      const v = s * 4, i = s * 6;
      idx[i] = v; idx[i + 1] = v + 1; idx[i + 2] = v + 2;
      idx[i + 3] = v + 1; idx[i + 4] = v + 3; idx[i + 5] = v + 2;
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setAttribute('position', this.pos);
    g.setAttribute('aData', this.data);
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  add(wheelId: number, pos: THREE.Vector3, normal: THREE.Vector3, right: THREE.Vector3, width: number, intensity: number) {
    let t = this.trails.get(wheelId);
    if (!t) {
      t = { lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, cx: 0, cy: 0, cz: 0, a: 0, valid: false, frame: -10 };
      this.trails.set(wheelId, t);
    }
    if (intensity <= 0.03) {
      t.valid = false;
      return;
    }
    if (t.frame < this.frame - 2) t.valid = false;
    t.frame = this.frame;
    const lift = 0.015;
    const hw = width * 0.5;
    const cx = pos.x + normal.x * lift, cy = pos.y + normal.y * lift, cz = pos.z + normal.z * lift;
    const a = Math.min(1, intensity);
    if (!t.valid) {
      this.setEdges(t, cx, cy, cz, right, hw, a);
      t.valid = true;
      return;
    }
    const dx = cx - t.cx, dy = cy - t.cy, dz = cz - t.cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 0.2 * 0.2) return;
    if (d2 > 4 * 4) {
      this.setEdges(t, cx, cy, cz, right, hw, a);
      return;
    }
    const s = this.head;
    this.head = (this.head + 1) % this.max;
    const p = this.pos.array as Float32Array;
    const dd = this.data.array as Float32Array;
    const o = s * 12;
    const nlx = cx - right.x * hw, nly = cy - right.y * hw, nlz = cz - right.z * hw;
    const nrx = cx + right.x * hw, nry = cy + right.y * hw, nrz = cz + right.z * hw;
    p[o] = t.lx; p[o + 1] = t.ly; p[o + 2] = t.lz;
    p[o + 3] = t.rx; p[o + 4] = t.ry; p[o + 5] = t.rz;
    p[o + 6] = nlx; p[o + 7] = nly; p[o + 8] = nlz;
    p[o + 9] = nrx; p[o + 10] = nry; p[o + 11] = nrz;
    const tm = this.time;
    dd[o] = t.a; dd[o + 1] = 0; dd[o + 2] = tm;
    dd[o + 3] = t.a; dd[o + 4] = 1; dd[o + 5] = tm;
    dd[o + 6] = a; dd[o + 7] = 0; dd[o + 8] = tm;
    dd[o + 9] = a; dd[o + 10] = 1; dd[o + 11] = tm;
    if (this.lo < 0) this.lo = this.hi = s;
    else if (s === 0) this.lo = 0;
    else this.hi = Math.max(this.hi, s);
    t.lx = nlx; t.ly = nly; t.lz = nlz;
    t.rx = nrx; t.ry = nry; t.rz = nrz;
    t.cx = cx; t.cy = cy; t.cz = cz;
    t.a = a;
  }

  private setEdges(t: WheelTrail, cx: number, cy: number, cz: number, right: THREE.Vector3, hw: number, a: number) {
    t.cx = cx; t.cy = cy; t.cz = cz;
    t.lx = cx - right.x * hw; t.ly = cy - right.y * hw; t.lz = cz - right.z * hw;
    t.rx = cx + right.x * hw; t.ry = cy + right.y * hw; t.rz = cz + right.z * hw;
    t.a = a * 0.4; // soft start
  }

  update(dt: number) {
    this.time += dt;
    this.frame++;
    this.uniforms.uTime.value = this.time;
    if (this.lo >= 0) {
      const full = this.hi < this.lo || this.hi - this.lo >= this.max - 1;
      for (const attr of [this.pos, this.data]) {
        attr.clearUpdateRanges();
        if (full) attr.addUpdateRange(0, this.max * 12);
        else attr.addUpdateRange(this.lo * 12, (this.hi - this.lo + 1) * 12);
        attr.needsUpdate = true;
      }
      this.lo = this.hi = -1;
    }
  }

  clear() {
    (this.data.array as Float32Array).fill(0);
    this.data.clearUpdateRanges();
    this.data.needsUpdate = true;
    this.trails.clear();
  }

  dispose() {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
