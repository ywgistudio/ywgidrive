import * as THREE from 'three';

/**
 * GPU-animated tire smoke. Each particle stores its spawn state; the vertex shader integrates
 * drag, wind and buoyancy analytically, so the CPU only writes when spawning.
 */
const vert = /* glsl */ `
attribute vec4 aP0;     // xyz spawn pos, w spawn time
attribute vec4 aV0;     // xyz velocity, w life
attribute vec4 aParams; // x size0, y size1, z seed, w alpha
uniform float uTime;
uniform vec3 uWind;
varying vec2 vUv;
varying float vAlpha;
varying float vLight;
varying float vCell;
void main() {
  float age = uTime - aP0.w;
  float life = aV0.w;
  float t = age / life;
  if (t < 0.0 || t > 1.0 || aParams.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
  float k = 1.8;
  vec3 disp = aV0.xyz * (1.0 - exp(-k * age)) / k + uWind * age + vec3(0.0, 0.45 * age + 0.06 * age * age, 0.0);
  vec3 center = aP0.xyz + disp;
  float grow = 1.0 - (1.0 - t) * (1.0 - t);
  float size = mix(aParams.x, aParams.y, grow);
  vec4 mv = viewMatrix * vec4(center, 1.0);
  float ang = aParams.z * 6.2831 + age * (aParams.z - 0.5) * 1.6;
  float c = cos(ang), s = sin(ang);
  vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
  mv.xy += q * size;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy + 0.5;
  vCell = floor(aParams.z * 3.999);
  float fadeIn = smoothstep(0.0, 0.07, t);
  float fadeOut = pow(1.0 - t, 1.6);
  float nearFade = smoothstep(0.6, 2.6, -mv.z);
  vAlpha = aParams.w * fadeIn * fadeOut * nearFade;
  vLight = 0.85 + 0.25 * (1.0 - t);
}
`;

const frag = /* glsl */ `
uniform sampler2D uTex;
uniform vec3 uColor;
uniform vec3 uLight;
uniform float uOpacity;
varying vec2 vUv;
varying float vAlpha;
varying float vLight;
varying float vCell;
void main() {
  vec2 cell = vec2(mod(vCell, 2.0), floor(vCell / 2.0)) * 0.5;
  vec4 tx = texture2D(uTex, cell + clamp(vUv, 0.01, 0.99) * 0.5);
  float a = tx.r * vAlpha * uOpacity;
  if (a < 0.004) discard;
  vec3 col = uColor * uLight * (0.55 + 0.6 * tx.g) * vLight;
  gl_FragColor = vec4(col, a);
}
`;

/** Upload only the touched instance range [lo, hi] (falls back to full upload on wrap). */
export function markRange(attr: THREE.BufferAttribute, lo: number, hi: number, max: number, itemSize: number) {
  attr.clearUpdateRanges();
  if (hi < lo || hi - lo >= max - 1) {
    attr.addUpdateRange(0, max * itemSize);
  } else {
    attr.addUpdateRange(lo * itemSize, (hi - lo + 1) * itemSize);
  }
  attr.needsUpdate = true;
}

export class Smoke {
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
  readonly uniforms: {
    uTime: THREE.IUniform<number>;
    uWind: THREE.IUniform<THREE.Vector3>;
    uTex: THREE.IUniform<THREE.Texture>;
    uColor: THREE.IUniform<THREE.Color>;
    uLight: THREE.IUniform<THREE.Color>;
    uOpacity: THREE.IUniform<number>;
  };
  private spawnAcc = 0;

  constructor(tex: THREE.Texture, max: number) {
    this.max = max;
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    this.p0 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.v0 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aP0', this.p0);
    g.setAttribute('aV0', this.v0);
    g.setAttribute('aParams', this.params);
    g.instanceCount = max;
    this.geo = g;
    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector3(0.6, 0, 0.25) },
      uTex: { value: tex },
      uColor: { value: new THREE.Color(0.78, 0.8, 0.86) },
      uLight: { value: new THREE.Color(0.55, 0.55, 0.6) },
      uOpacity: { value: 0.6 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** Spawn rate ~ intensity * 60/s, distributed with an accumulator for frame-rate independence. */
  emit(pos: THREE.Vector3, vel: THREE.Vector3, intensity: number, dt: number) {
    if (intensity <= 0.01) return;
    this.spawnAcc += intensity * 55 * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      this.spawn(pos, vel, intensity);
    }
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, intensity: number) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const r = Math.random;
    const p = this.p0.array as Float32Array;
    const v = this.v0.array as Float32Array;
    const pr = this.params.array as Float32Array;
    p[i * 4] = pos.x + (r() - 0.5) * 0.3;
    p[i * 4 + 1] = pos.y + 0.12 + r() * 0.1;
    p[i * 4 + 2] = pos.z + (r() - 0.5) * 0.3;
    p[i * 4 + 3] = this.time;
    if (this.lo < 0) this.lo = this.hi = i;
    else if (i === 0) this.lo = 0; // wrapped: upload everything up to hi plus the head range
    else this.hi = Math.max(this.hi, i);
    v[i * 4] = vel.x * 0.35 + (r() - 0.5) * 1.6;
    v[i * 4 + 1] = vel.y * 0.2 + 0.4 + r() * 0.8;
    v[i * 4 + 2] = vel.z * 0.35 + (r() - 0.5) * 1.6;
    v[i * 4 + 3] = 1.6 + r() * 1.6 + intensity * 1.2;
    pr[i * 4] = 0.5 + r() * 0.4;
    pr[i * 4 + 1] = 2.6 + r() * 2.2 + intensity * 1.8;
    pr[i * 4 + 2] = r();
    pr[i * 4 + 3] = Math.min(1, 0.25 + intensity * 0.75);
  }

  update(dt: number) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    if (this.lo >= 0) {
      markRange(this.p0, this.lo, this.hi, this.max, 4);
      markRange(this.v0, this.lo, this.hi, this.max, 4);
      markRange(this.params, this.lo, this.hi, this.max, 4);
      this.lo = this.hi = -1;
    }
  }

  dispose() {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
