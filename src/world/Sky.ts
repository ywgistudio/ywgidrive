import * as THREE from 'three';

export const FOG_COLOR = new THREE.Color(0x120f22);

/**
 * Night sky dome rendered at the far plane: deep navy zenith, sodium/neon light-pollution glow at
 * the horizon, sparse twinkling stars, a hazy moon and slow drifting cloud banks lit from below.
 */
export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uTime: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(-0.45, 0.42, -0.78).normalize() },
    uHorizon: { value: new THREE.Color(0x3a1f3c) },
    uGlow: { value: new THREE.Color(0xff7a3a) },
    uZenith: { value: new THREE.Color(0x03040c) },
    uFog: { value: FOG_COLOR.clone() },
  };

  constructor() {
    const geo = new THREE.SphereGeometry(1, 48, 24);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uMoonDir;
        uniform vec3 uHorizon;
        uniform vec3 uGlow;
        uniform vec3 uZenith;
        uniform vec3 uFog;
        varying vec3 vDir;
        float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float n2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(h12(i), h12(i+vec2(1,0)), u.x), mix(h12(i+vec2(0,1)), h12(i+vec2(1,1)), u.x), u.y); }
        float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n2(p); p *= 2.02; a *= 0.5; } return s; }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          float up = clamp(h, 0.0, 1.0);
          // base gradient
          vec3 col = mix(uHorizon, uZenith, pow(up, 0.45));
          // light pollution: orange near horizon, magenta above
          float glow = exp(-max(h, -0.05) * 9.0);
          col += uGlow * glow * 0.35;
          col += vec3(0.35, 0.08, 0.4) * exp(-max(h, 0.0) * 3.5) * 0.12;
          // clouds
          vec2 cuv = d.xz / (h + 0.18) * 1.4 + vec2(uTime * 0.004, uTime * 0.0015);
          float c = smoothstep(0.45, 0.85, fbm(cuv));
          vec3 cloudCol = mix(vec3(0.16, 0.08, 0.12), vec3(0.42, 0.2, 0.16), exp(-up * 4.0));
          col = mix(col, cloudCol, c * smoothstep(-0.02, 0.15, h) * 0.75);
          // stars
          vec2 sp = vec2(atan(d.z, d.x) * 180.0, h * 300.0);
          vec2 cell = floor(sp);
          float r = h12(cell);
          float star = step(0.9965, r) * smoothstep(0.08, 0.35, h) * (1.0 - c);
          vec2 f = fract(sp) - 0.5;
          float tw = 0.6 + 0.4 * sin(uTime * (1.0 + r * 4.0) + r * 60.0);
          col += vec3(0.85, 0.9, 1.0) * star * smoothstep(0.35, 0.0, length(f)) * tw * 2.2;
          // moon
          float md = dot(d, normalize(uMoonDir));
          float disc = smoothstep(0.99955, 0.99975, md);
          float craters = fbm(d.xy * 400.0) * 0.35;
          col += vec3(1.0, 0.95, 0.85) * disc * (2.6 - craters * 2.0) * (1.0 - c * 0.7);
          col += vec3(0.5, 0.55, 0.75) * pow(max(md, 0.0), 120.0) * 0.35;
          col += vec3(0.3, 0.32, 0.45) * pow(max(md, 0.0), 12.0) * 0.06;
          // below horizon: blend into fog color
          col = mix(col, uFog, smoothstep(0.02, -0.08, h));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
  }

  update(time: number) {
    this.uniforms.uTime.value = time;
  }
}
