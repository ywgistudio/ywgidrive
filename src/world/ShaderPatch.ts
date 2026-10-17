import * as THREE from 'three';

/** A composable onBeforeCompile patch. Several patches can be stacked on one material. */
export interface Patch {
  key: string;
  uniforms?: Record<string, THREE.IUniform>;
  vertexHeader?: string;
  vertex?: { after: string; code: string }[];
  fragmentHeader?: string;
  fragment?: { after?: string; replace?: string; code: string }[];
}

export function applyPatches<T extends THREE.Material>(mat: T, patches: Patch[]): T {
  mat.onBeforeCompile = (shader) => {
    for (const p of patches) {
      if (p.uniforms) for (const k in p.uniforms) shader.uniforms[k] = p.uniforms[k];
      if (p.vertexHeader) shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + p.vertexHeader);
      if (p.fragmentHeader) shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + p.fragmentHeader);
      for (const v of p.vertex ?? []) {
        const inc = `#include <${v.after}>`;
        if (!shader.vertexShader.includes(inc)) console.warn('patch: missing vertex include', v.after, p.key);
        shader.vertexShader = shader.vertexShader.replace(inc, inc + '\n' + v.code);
      }
      for (const f of p.fragment ?? []) {
        if (f.replace) {
          const inc = `#include <${f.replace}>`;
          if (!shader.fragmentShader.includes(inc)) console.warn('patch: missing fragment include', f.replace, p.key);
          shader.fragmentShader = shader.fragmentShader.replace(inc, f.code);
        } else if (f.after) {
          const inc = `#include <${f.after}>`;
          if (!shader.fragmentShader.includes(inc)) console.warn('patch: missing fragment include', f.after, p.key);
          shader.fragmentShader = shader.fragmentShader.replace(inc, inc + '\n' + f.code);
        }
      }
    }
  };
  const key = patches.map((p) => p.key).join('|');
  mat.customProgramCacheKey = () => key;
  return mat;
}

/** GLSL helpers shared by world shaders. */
export const GLSL_NOISE = /* glsl */ `
float wHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 wHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float wNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash12(i), wHash12(i + vec2(1.0, 0.0)), u.x), mix(wHash12(i + vec2(0.0, 1.0)), wHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float wFbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * wNoise(p); p = p * 2.03 + vec2(17.1, 3.7); a *= 0.5; }
  return s;
}
`;
