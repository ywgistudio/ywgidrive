import * as THREE from 'three';

const flameVert = /* glsl */ `
attribute vec4 aFlame; // x intensity, y fireMix (0 nitro .. 1 fire), z seed, w unused
uniform float uTime;
varying float vAlong;
varying float vI;
varying float vFire;
varying float vSeed;
varying vec3 vN;
varying vec3 vV;
void main() {
  vAlong = clamp(-position.z, 0.0, 1.0);
  vI = aFlame.x;
  vFire = aFlame.y;
  vSeed = aFlame.z;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  mat3 nm = mat3(modelMatrix * instanceMatrix);
  vN = normalize(nm * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const flameFrag = /* glsl */ `
uniform float uTime;
varying float vAlong;
varying float vI;
varying float vFire;
varying float vSeed;
varying vec3 vN;
varying vec3 vV;
void main() {
  if (vI < 0.01) discard;
  float a = vAlong;
  float fl = 0.5 + 0.5 * sin(uTime * 70.0 + vSeed * 31.0 - a * 26.0);
  fl = mix(fl, 0.5 + 0.5 * sin(uTime * 43.0 + vSeed * 13.0 - a * 11.0), 0.5);
  float prof = pow(1.0 - a, 1.4) * (0.65 + 0.35 * fl);
  float core = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
  vec3 nitroCore = vec3(3.5, 4.5, 9.0);
  vec3 nitroEdge = vec3(0.25, 0.7, 6.0);
  vec3 fireCore = vec3(9.0, 5.5, 2.2);
  vec3 fireEdge = vec3(5.0, 1.0, 0.08);
  vec3 cCore = mix(nitroCore, fireCore, vFire);
  vec3 cEdge = mix(nitroEdge, fireEdge, vFire);
  vec3 c = mix(cEdge, cCore, core * (1.0 - a * 0.6));
  float alpha = prof * (0.25 + 0.75 * core) * vI;
  gl_FragColor = vec4(c * alpha, 1.0);
}
`;

const glowVert = /* glsl */ `
attribute vec4 aFlame;
varying vec2 vUv;
varying float vI;
varying float vFire;
void main() {
  vI = aFlame.x;
  vFire = aFlame.y;
  vUv = position.xy;
  vec4 c = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 mv = viewMatrix * c;
  float size = (0.12 + 0.16 * vI) * (vI > 0.01 ? 1.0 : 0.0);
  mv.xy += position.xy * size;
  mv.z += 0.05;
  gl_Position = projectionMatrix * mv;
}
`;

const glowFrag = /* glsl */ `
varying vec2 vUv;
varying float vI;
varying float vFire;
void main() {
  float r = length(vUv);
  if (r > 1.0 || vI < 0.01) discard;
  float g = exp(-r * r * 5.0);
  vec3 c = mix(vec3(1.2, 2.2, 6.0), vec3(6.0, 2.6, 0.5), vFire);
  gl_FragColor = vec4(c * g * vI * 0.8, 1.0);
}
`;

interface Slot {
  nitro: number;
  fire: number;
  popTimer: number;
  frame: number;
  seed: number;
}

const _m = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _s = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

export class Exhaust {
  readonly group = new THREE.Group();
  private flames: THREE.InstancedMesh;
  private glows: THREE.InstancedMesh;
  private attr: THREE.InstancedBufferAttribute;
  private slots: Slot[] = [];
  private carSlots = new Map<number, number>();
  private nextSlot = 0;
  private max: number;
  private frame = 0;
  private time = 0;
  dt = 1 / 60;
  /** called on each backfire pop (sparks hook) */
  onPop: ((worldPos: THREE.Vector3, intensity: number) => void) | null = null;
  /** called every frame per boosting tip (nitro ember hook): world pos + world backward dir */
  onBoost: ((worldPos: THREE.Vector3, back: THREE.Vector3, intensity: number) => void) | null = null;
  private _back = new THREE.Vector3();
  private uniforms = { uTime: { value: 0 } };
  private _wp = new THREE.Vector3();

  constructor(max = 48) {
    this.max = max;
    const cone = new THREE.CylinderGeometry(0.02, 0.07, 1, 12, 6, true);
    cone.rotateX(-Math.PI / 2);
    cone.translate(0, 0, -0.5);
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    cone.setAttribute('aFlame', this.attr);
    const flameMat = new THREE.ShaderMaterial({
      vertexShader: flameVert,
      fragmentShader: flameFrag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.flames = new THREE.InstancedMesh(cone, flameMat, max);
    this.flames.frustumCulled = false;
    this.flames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flames.renderOrder = 7;

    const quad = new THREE.PlaneGeometry(2, 2);
    quad.setAttribute('aFlame', this.attr);
    const glowMat = new THREE.ShaderMaterial({
      vertexShader: glowVert,
      fragmentShader: glowFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.glows = new THREE.InstancedMesh(quad, glowMat, max);
    this.glows.frustumCulled = false;
    this.glows.instanceMatrix = this.flames.instanceMatrix; // share transforms
    this.glows.renderOrder = 7;

    for (let i = 0; i < max; i++) {
      this.slots.push({ nitro: 0, fire: 0, popTimer: 0, frame: -10, seed: Math.random() });
      this.flames.setMatrixAt(i, _zero);
    }
    this.group.add(this.flames, this.glows);
  }

  set(carId: number, carMatrix: THREE.Matrix4, tips: THREE.Vector3[], boosting: boolean, backfire: boolean, throttle: number) {
    let base = this.carSlots.get(carId);
    if (base === undefined) {
      if (this.nextSlot + tips.length > this.max) return;
      base = this.nextSlot;
      this.nextSlot += tips.length;
      this.carSlots.set(carId, base);
    }
    const dt = this.dt;
    const arr = this.attr.array as Float32Array;
    for (let k = 0; k < tips.length; k++) {
      const i = base + k;
      const s = this.slots[i];
      s.frame = this.frame;
      const nt = boosting ? 1 : 0;
      s.nitro += (nt - s.nitro) * (1 - Math.exp(-(boosting ? 18 : 7) * dt));
      s.popTimer -= dt;
      if (backfire && s.popTimer <= 0) {
        s.popTimer = 0.04 + Math.random() * 0.09;
        if (Math.random() < 0.7) {
          s.fire = 0.55 + Math.random() * 0.45;
          if (this.onPop) {
            this._wp.copy(tips[k]).applyMatrix4(carMatrix);
            this.onPop(this._wp, s.fire);
          }
        }
      }
      s.fire *= Math.exp(-dt * 16);
      if (boosting && this.onBoost && s.nitro > 0.3) {
        this._wp.copy(tips[k]).applyMatrix4(carMatrix);
        this._back.set(carMatrix.elements[8], carMatrix.elements[9], carMatrix.elements[10]).normalize().negate();
        this.onBoost(this._wp, this._back, s.nitro);
      }
      const inten = Math.max(s.nitro, s.fire);
      if (inten < 0.01) {
        this.flames.setMatrixAt(i, _zero);
        arr[i * 4] = 0;
        continue;
      }
      const fireMix = s.fire / (s.fire + s.nitro + 1e-4);
      const flick = 0.85 + 0.3 * Math.random();
      const len = (s.nitro * (1.05 + 0.45 * throttle) + s.fire * 0.6) * flick;
      const wid = 1 + s.fire * 1.5 + s.nitro * 0.45;
      _t.makeTranslation(tips[k].x, tips[k].y, tips[k].z);
      _r.makeRotationZ(Math.random() * Math.PI * 2);
      _s.makeScale(wid, wid, Math.max(0.05, len));
      _m.multiplyMatrices(carMatrix, _t).multiply(_r).multiply(_s);
      this.flames.setMatrixAt(i, _m);
      arr[i * 4] = inten;
      arr[i * 4 + 1] = fireMix;
      arr[i * 4 + 2] = s.seed;
    }
  }

  update(dt: number) {
    this.dt = dt;
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    const arr = this.attr.array as Float32Array;
    for (let i = 0; i < this.nextSlot; i++) {
      const s = this.slots[i];
      if (s.frame < this.frame) {
        // car not updated this frame: hide
        this.flames.setMatrixAt(i, _zero);
        arr[i * 4] = 0;
        s.nitro = 0;
        s.fire = 0;
      }
    }
    this.frame++;
    this.flames.instanceMatrix.needsUpdate = true;
    this.attr.needsUpdate = true;
  }

  release(carId: number) {
    // slots are kept for reuse by the same id; nothing to free in a fixed pool
    void carId;
  }

  dispose() {
    this.flames.geometry.dispose();
    this.glows.geometry.dispose();
    (this.flames.material as THREE.Material).dispose();
    (this.glows.material as THREE.Material).dispose();
  }
}
