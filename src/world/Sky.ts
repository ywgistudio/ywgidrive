import * as THREE from 'three';

/** Neutral, slightly blue-grey night haze (matches the sky right at the horizon). */
export const FOG_COLOR = new THREE.Color(0x14171d);

/**
 * Overcast city night sky rendered at the far plane: a low cloud deck lit from below by sodium
 * light pollution (grey-orange near the horizon, deep blue-grey overhead), a few breaks showing a
 * darker sky with the odd star, and a moon glow diffused through the clouds.
 */
export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uTime: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(-0.45, 0.42, -0.78).normalize() },
    // light pollution glow under the cloud deck (sodium + LED mix, desaturated)
    uGlow: { value: new THREE.Color(0.2, 0.13, 0.075) },
    // clear sky between clouds
    uZenith: { value: new THREE.Color(0.006, 0.008, 0.014) },
    // cloud underside far from the city glow
    uCloudHi: { value: new THREE.Color(0.028, 0.03, 0.038) },
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
        uniform vec3 uGlow;
        uniform vec3 uZenith;
        uniform vec3 uCloudHi;
        uniform vec3 uFog;
        varying vec3 vDir;
        float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float n2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(h12(i), h12(i+vec2(1,0)), u.x), mix(h12(i+vec2(0,1)), h12(i+vec2(1,1)), u.x), u.y); }
        float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * n2(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s; }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          float up = clamp(h, 0.0, 1.0);
          // clear sky (seen only through breaks in the deck)
          vec3 sky = mix(uFog * 0.9, uZenith, pow(up, 0.35));
          // low overcast deck: project onto a plane, slow drift
          vec2 cuv = d.xz / (h + 0.07) * 0.9 + vec2(uTime * 0.0025, uTime * 0.001);
          float dens = fbm(cuv);
          float cover = smoothstep(0.3, 0.62, dens);
          float detail = fbm(cuv * 3.1 + 4.0);
          // underside brightness: strongest near the horizon where the city lights it from below
          float under = exp(-up * 5.5);
          vec3 cloud = mix(uCloudHi, uGlow, under) * (0.75 + 0.5 * detail);
          // thicker billows catch more light; thin edges darker
          cloud *= mix(0.7, 1.15, smoothstep(0.45, 0.85, dens));
          vec3 col = mix(sky, cloud, cover * smoothstep(-0.03, 0.06, h));
          // haze band of light pollution hugging the skyline
          col += uGlow * exp(-max(h, 0.0) * 22.0) * 0.55;
          // a handful of stars in the breaks
          vec2 sp = vec2(atan(d.z, d.x) * 160.0, h * 260.0);
          float r = h12(floor(sp));
          float star = step(0.998, r) * smoothstep(0.25, 0.5, h) * (1.0 - cover);
          col += vec3(0.8, 0.85, 1.0) * star * smoothstep(0.35, 0.0, length(fract(sp) - 0.5)) * 0.9;
          // moon diffused through the deck (no hard disc)
          float md = max(dot(d, normalize(uMoonDir)), 0.0);
          col += vec3(0.32, 0.34, 0.4) * pow(md, 60.0) * (0.25 + 0.4 * (1.0 - cover));
          col += vec3(0.08, 0.09, 0.11) * pow(md, 8.0) * 0.4;
          // below the horizon: haze
          col = mix(col, uFog, smoothstep(0.02, -0.06, h));
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
