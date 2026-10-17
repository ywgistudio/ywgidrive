import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

/**
 * Zoom/radial blur toward the screen center. Strength 0 short-circuits to a single tap.
 * Used for speed sensation and nitro. Cheap: 10 taps with interleaved-gradient jitter.
 */
const radialFrag = /* glsl */ `
uniform float strength;
uniform vec2 center;
uniform float innerRadius;

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (strength < 0.0005) { outputColor = inputColor; return; }
  vec2 dir = uv - center;
  dir.x *= aspect;
  float d = length(dir);
  dir.x /= aspect;
  float s = strength * smoothstep(innerRadius, innerRadius + 0.55, d);
  if (s < 0.0005) { outputColor = inputColor; return; }
  float j = ign(gl_FragCoord.xy);
  vec3 acc = inputColor.rgb;
  float wsum = 1.0;
  for (int i = 1; i < 10; i++) {
    float t = (float(i) + j - 0.5) / 9.0;
    float w = 1.0 - t * 0.55;
    acc += texture2D(inputBuffer, uv - dir * s * t).rgb * w;
    wsum += w;
  }
  outputColor = vec4(acc / wsum, inputColor.a);
}
`;

export class RadialBlurEffect extends Effect {
  constructor() {
    super('RadialBlurEffect', radialFrag, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['strength', new THREE.Uniform(0)],
        ['center', new THREE.Uniform(new THREE.Vector2(0.5, 0.52))],
        ['innerRadius', new THREE.Uniform(0.18)],
      ]),
    });
  }
  get strength(): number {
    return this.uniforms.get('strength')!.value as number;
  }
  set strength(v: number) {
    this.uniforms.get('strength')!.value = v;
  }
  get center(): THREE.Vector2 {
    return this.uniforms.get('center')!.value as THREE.Vector2;
  }
}

/**
 * HDR grading before tone mapping: exposure, saturation, tint, impact flash and menu dim.
 * Not a convolution, so it merges freely into any EffectPass.
 */
const gradeFrag = /* glsl */ `
uniform float exposure;
uniform float saturation;
uniform vec3 tint;
uniform float flash;
uniform vec3 flashColor;
uniform float dim;
uniform vec3 lift;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * exposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  c *= tint;
  c += lift * (1.0 - smoothstep(0.0, 0.25, l));
  c += flashColor * flash;
  c *= 1.0 - dim;
  outputColor = vec4(max(c, vec3(0.0)), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', gradeFrag, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['exposure', new THREE.Uniform(1)],
        ['saturation', new THREE.Uniform(1.08)],
        ['tint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['flash', new THREE.Uniform(0)],
        ['flashColor', new THREE.Uniform(new THREE.Vector3(1, 0.9, 0.85))],
        ['dim', new THREE.Uniform(0)],
        ['lift', new THREE.Uniform(new THREE.Vector3(0.0, 0.004, 0.012))],
      ]),
    });
  }
  u<T>(name: string): THREE.Uniform<T> {
    return this.uniforms.get(name)! as THREE.Uniform<T>;
  }
}

/**
 * Film grain applied on LDR output (after tone mapping), luminance-weighted so blacks stay clean.
 */
const grainFrag = /* glsl */ `
uniform float amount;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float n = h12(gl_FragCoord.xy + fract(time * 13.37) * 1000.0) - 0.5;
  float l = dot(inputColor.rgb, vec3(0.299, 0.587, 0.114));
  float w = amount * (0.35 + 0.65 * smoothstep(0.02, 0.5, l)) * (1.0 - smoothstep(0.7, 1.0, l));
  outputColor = vec4(inputColor.rgb + n * w, inputColor.a);
}
`;

export class GrainEffect extends Effect {
  constructor(amount = 0.035) {
    super('GrainEffect', grainFrag, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([['amount', new THREE.Uniform(amount)]]),
    });
  }
  set amount(v: number) {
    this.uniforms.get('amount')!.value = v;
  }
}
