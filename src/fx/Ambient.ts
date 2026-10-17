import * as THREE from 'three';

/**
 * Camera-volume streak field. Particles are wrapped (mod) in a box around the camera but stay fixed
 * in world space, so rain falls and passes correctly while the camera moves. Each particle is a thin
 * quad stretched along (particle velocity - camera velocity) * exposure time.
 */
const vert = /* glsl */ `
attribute vec4 aSeed; // xyz in [0,1), w random
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uCamVel;
uniform vec3 uBox;
uniform vec3 uVel;      // particle velocity (rain: wind + fall)
uniform float uExposure;
uniform float uWidth;
uniform float uMaxLen;
uniform float uAmount;
varying float vA;
varying float vAcross;
varying float vAlong;
void main() {
  if (aSeed.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
  vec3 base = aSeed.xyz * uBox + uVel * uTime * (0.85 + 0.3 * aSeed.w);
  vec3 p = mod(base - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  vec3 rel = uVel - uCamVel;
  vec3 streak = rel * uExposure;
  float L = length(streak);
  if (L > uMaxLen) streak *= uMaxLen / L;
  vec3 tail = p - streak;
  vec3 pos = mix(p, tail, position.y);
  vec3 viewDir = normalize(cameraPosition - pos);
  vec3 side = normalize(cross(streak + vec3(0.0, 1e-4, 0.0), viewDir));
  pos += side * position.x * uWidth;
  vec4 mv = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  // fade near the box edges and very close to the lens
  vec3 d = abs(p - uCam) / (uBox * 0.5);
  float edge = 1.0 - smoothstep(0.7, 1.0, max(max(d.x, d.y), d.z));
  float nearF = smoothstep(0.4, 1.8, -mv.z);
  vA = edge * nearF;
  vAcross = position.x;
  vAlong = position.y;
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
varying float vAcross;
varying float vAlong;
void main() {
  float a = vA * (1.0 - abs(vAcross)) * (1.0 - vAlong * 0.7) * uOpacity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`;

export class StreakField {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  private geo: THREE.InstancedBufferGeometry;

  constructor(count: number, opts: { box: THREE.Vector3; vel: THREE.Vector3; exposure: number; width: number; maxLen: number; color: THREE.Color; opacity: number; additive: boolean }) {
    const g = new THREE.InstancedBufferGeometry();
    const verts = new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]);
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = Math.random();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = count;
    this.geo = g;
    this.uniforms = {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uCamVel: { value: new THREE.Vector3() },
      uBox: { value: opts.box.clone() },
      uVel: { value: opts.vel.clone() },
      uExposure: { value: opts.exposure },
      uWidth: { value: opts.width },
      uMaxLen: { value: opts.maxLen },
      uAmount: { value: 0 },
      uColor: { value: opts.color.clone() },
      uOpacity: { value: opts.opacity },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
  }

  set amount(v: number) {
    this.uniforms.uAmount.value = v;
    this.mesh.visible = v > 0.001;
  }

  update(time: number, cam: THREE.Vector3, camVel: THREE.Vector3) {
    this.uniforms.uTime.value = time;
    (this.uniforms.uCam.value as THREE.Vector3).copy(cam);
    (this.uniforms.uCamVel.value as THREE.Vector3).copy(camVel);
  }

  dispose() {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
