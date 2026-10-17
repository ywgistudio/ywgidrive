import * as THREE from 'three';
import { markRange } from './Smoke';

/**
 * Additive HDR spark streaks. Ballistic motion is evaluated in the vertex shader; each instance is a
 * camera-facing quad stretched between the spark's position and a point slightly back along its velocity.
 */
const vert = /* glsl */ `
attribute vec4 aP0; // xyz, spawn time
attribute vec4 aV0; // xyz, life
attribute vec2 aParams; // x seed, y brightness
uniform float uTime;
uniform float uStreak;
uniform float uWidth;
varying float vT;
varying float vB;
varying float vAcross;
void main() {
  float age = uTime - aP0.w;
  float t = age / aV0.w;
  if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vT = 1.0; vB = 0.0; return; }
  vec3 g = vec3(0.0, -9.81, 0.0);
  float drag = exp(-1.2 * age);
  vec3 v = aV0.xyz * drag + g * age;
  vec3 p = aP0.xyz + aV0.xyz * (1.0 - drag) / 1.2 + 0.5 * g * age * age;
  vec3 tail = p - v * uStreak;
  vec4 vp = viewMatrix * vec4(p, 1.0);
  vec4 vt = viewMatrix * vec4(tail, 1.0);
  vec3 dir = vp.xyz - vt.xyz;
  vec3 side = normalize(cross(dir, vec3(0.0, 0.0, 1.0)) + vec3(1e-5, 0.0, 0.0));
  vec4 cpos = mix(vp, vt, position.y);
  float w = uWidth * (1.0 - 0.6 * t) * (0.6 + 0.4 * aParams.x);
  cpos.xyz += side * position.x * w;
  gl_Position = projectionMatrix * cpos;
  vT = t;
  vB = aParams.y;
  vAcross = position.x;
}
`;

const frag = /* glsl */ `
varying float vT;
varying float vB;
varying float vAcross;
void main() {
  float core = 1.0 - abs(vAcross);
  vec3 hot = vec3(7.0, 5.2, 3.2);
  vec3 cool = vec3(4.5, 1.1, 0.15);
  vec3 c = mix(hot, cool, smoothstep(0.0, 0.7, vT)) * vB;
  float a = core * (1.0 - vT * vT);
  gl_FragColor = vec4(c * a, 1.0);
}
`;

export class Sparks {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private p0: THREE.InstancedBufferAttribute;
  private v0: THREE.InstancedBufferAttribute;
  private params: THREE.InstancedBufferAttribute;
  private max: number;
  private head = 0;
  private lo = -1;
  private hi = -1;
  private time = 0;
  readonly uniforms = {
    uTime: { value: 0 },
    uStreak: { value: 0.03 },
    uWidth: { value: 0.022 },
  };

  constructor(max: number) {
    this.max = max;
    const g = new THREE.InstancedBufferGeometry();
    // quad: x in [-1,1] across, y in [0,1] along (0 = head, 1 = tail)
    const verts = new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]);
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    this.p0 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.v0 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    // start everything dead
    const p = this.p0.array as Float32Array;
    const v = this.v0.array as Float32Array;
    for (let i = 0; i < max; i++) {
      p[i * 4 + 3] = -100;
      v[i * 4 + 3] = 1;
    }
    g.setAttribute('aP0', this.p0);
    g.setAttribute('aV0', this.v0);
    g.setAttribute('aParams', this.params);
    g.instanceCount = max;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  spawn(px: number, py: number, pz: number, vx: number, vy: number, vz: number, life: number, brightness: number) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const p = this.p0.array as Float32Array;
    const v = this.v0.array as Float32Array;
    const pr = this.params.array as Float32Array;
    p[i * 4] = px; p[i * 4 + 1] = py; p[i * 4 + 2] = pz; p[i * 4 + 3] = this.time;
    v[i * 4] = vx; v[i * 4 + 1] = vy; v[i * 4 + 2] = vz; v[i * 4 + 3] = life;
    pr[i * 2] = Math.random();
    pr[i * 2 + 1] = brightness;
    if (this.lo < 0) this.lo = this.hi = i;
    else if (i === 0) this.lo = 0;
    else this.hi = Math.max(this.hi, i);
  }

  update(dt: number) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    if (this.lo >= 0) {
      markRange(this.p0, this.lo, this.hi, this.max, 4);
      markRange(this.v0, this.lo, this.hi, this.max, 4);
      markRange(this.params, this.lo, this.hi, this.max, 2);
      this.lo = this.hi = -1;
    }
  }

  dispose() {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
