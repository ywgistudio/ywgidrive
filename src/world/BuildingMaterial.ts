import * as THREE from 'three';
import { applyPatches, GLSL_NOISE } from './ShaderPatch';
import type { LampLighting } from './LampLighting';
import { worldUniforms } from './TrackMaterials';

/**
 * Procedural night facades for instanced unit boxes (y from 0..1).
 * Per-instance attributes:
 *   aStyle: x = facade type (0 office, 1 glass tower, 2 residential, 3 warehouse, 4 house, 5 skyline),
 *           y = window hue (0 warm .. 1 cool), z = lit fraction, w = shopfront (0/1)
 *   aSeed:  x = random seed, y = wall tint, z = crown light hue (-1 none), w = floor height
 *   sampleIdx: nearest track sample for streetlight lighting (-1 none)
 */
export function createBuildingMaterial(lamps: LampLighting): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  applyPatches(mat, [
    lamps.patch({ flat: true }),
    {
      key: 'building',
      uniforms: { uTime: worldUniforms.uTime },
      vertexHeader: /* glsl */ `
        attribute vec4 aStyle;
        attribute vec4 aSeed;
        varying vec3 vBL;
        varying vec3 vBN;
        varying vec3 vBS;
        flat varying vec4 vStyle;
        flat varying vec4 vSeed;
      `,
      vertex: [
        {
          after: 'begin_vertex',
          code: /* glsl */ `
          vec3 bsc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vBL = position * bsc;
          vBN = normal;
          vBS = bsc;
          vStyle = aStyle;
          vSeed = aSeed;
          `,
        },
      ],
      fragmentHeader: /* glsl */ `
        uniform float uTime;
        varying vec3 vBL;
        varying vec3 vBN;
        varying vec3 vBS;
        flat varying vec4 vStyle;
        flat varying vec4 vSeed;
        ${GLSL_NOISE}
        vec3 winPalette(float h, float hue) {
          vec3 warm = vec3(1.0, 0.66, 0.36);
          vec3 warm2 = vec3(1.0, 0.82, 0.55);
          vec3 cool = vec3(0.62, 0.78, 1.0);
          vec3 fluo = vec3(0.8, 1.0, 0.86);
          vec3 c = h < 0.4 ? warm : (h < 0.65 ? warm2 : (h < 0.85 ? fluo : cool));
          return mix(c, cool, hue * 0.6);
        }
        float rect(vec2 f, vec2 lo, vec2 hi, vec2 aa) {
          vec2 a = smoothstep(lo - aa, lo + aa, f) * (1.0 - smoothstep(hi - aa, hi + aa, f));
          return a.x * a.y;
        }
      `,
      fragment: [
        {
          after: 'map_fragment',
          code: /* glsl */ `
          vec3 bn = normalize(vBN);
          float style = vStyle.x;
          float seed = vSeed.x;
          vec3 wallTint = mix(vec3(0.16, 0.155, 0.15), vec3(0.2, 0.12, 0.09), step(0.5, fract(vSeed.y * 7.0)));
          wallTint *= 0.35 + 0.65 * vSeed.y;
          float bEmis = 0.0;
          vec3 bEmisCol = vec3(0.0);
          float bRough = 0.88;
          float bMetal = 0.0;
          vec3 alb = wallTint;
          bool roof = bn.y > 0.5;
          vec2 fc;
          float faceW;
          if (abs(bn.x) > 0.5) { fc = vec2(vBL.z * sign(bn.x), vBL.y); faceW = vBS.z; }
          else { fc = vec2(-vBL.x * sign(bn.z), vBL.y); faceW = vBS.x; }
          fc.x += faceW * 0.5;
          float faceId = abs(bn.x) > 0.5 ? (bn.x > 0.0 ? 1.0 : 2.0) : (bn.z > 0.0 ? 3.0 : 4.0);
          if (roof) {
            alb = vec3(0.035, 0.035, 0.04) * (0.7 + 0.6 * wNoise(vBL.xz * 0.2 + seed));
          } else {
            float fh = vSeed.w;
            float gh = vStyle.w > 0.5 ? 4.6 : fh;
            float ws = style < 0.5 ? 2.6 + fract(seed * 3.1) * 1.2 : (style < 1.5 ? 1.8 : (style < 2.5 ? 3.4 : (style < 3.5 ? 6.0 : 3.0)));
            // fit an integer number of window columns to the face
            float cols = max(1.0, floor(faceW / ws));
            ws = faceW / cols;
            vec2 cellF = vec2(fc.x / ws, (fc.y - gh) / fh);
            vec2 ci = floor(cellF);
            vec2 cf = fract(cellF);
            vec2 aa = fwidth(cellF) * 1.2;
            float lod = smoothstep(0.18, 0.5, max(aa.x, aa.y));
            float far = smoothstep(0.6, 1.4, max(aa.x, aa.y));
            vec2 lo = style < 0.5 ? vec2(0.14, 0.24) : (style < 1.5 ? vec2(0.05, 0.08) : (style < 2.5 ? vec2(0.24, 0.28) : (style < 3.5 ? vec2(0.3, 0.55) : vec2(0.25, 0.3))));
            vec2 hi = vec2(1.0) - lo * vec2(1.0, style < 1.5 ? 0.6 : 0.9);
            float area = (hi.x - lo.x) * (hi.y - lo.y);
            float win = mix(rect(cf, lo, hi, aa), area, lod);
            float aboveGround = step(gh, fc.y) * step(fc.y, vBS.y - (style < 1.5 ? 1.2 : 0.6));
            // floors are lit coherently (offices) with individual variation
            float hf = wHash12(vec2(ci.y + seed * 13.0, faceId));
            float hw = wHash12(ci + vec2(seed * 71.0, faceId * 17.0));
            float litFrac = vStyle.z;
            float lit = step(hw, litFrac * (0.55 + hf * 0.9));
            if (style > 3.5 && style < 4.5) lit *= step(0.35, hf);
            float inten = (0.8 + 1.8 * wHash12(ci * 1.7 + seed)) * (0.65 + 0.5 * cf.y);
            vec3 wc = winPalette(wHash12(ci + seed * 3.0 + 0.5), vStyle.y);
            // TVs / flicker
            float tv = step(0.985, wHash12(ci * 3.1 + seed));
            if (tv > 0.5) { wc = vec3(0.45, 0.6, 1.0); inten *= 0.6 + 0.4 * sin(uTime * 7.0 + hw * 40.0) * sin(uTime * 2.3 + hw * 9.0); lit = 1.0; }
            // distance fallback: average glow so far towers don't shimmer
            float avgLit = litFrac * 0.75;
            vec3 avgCol = winPalette(0.5, vStyle.y);
            vec3 glow = mix(wc * inten * lit, avgCol * 1.35 * avgLit, far);
            float winMask = win * aboveGround;
            if (style > 0.5 && style < 1.5) {
              // glass curtain wall: dark reflective glass everywhere, mullions
              alb = mix(vec3(0.015, 0.02, 0.03), wallTint * 0.5, 1.0 - win);
              bRough = mix(0.5, 0.06, win);
              bMetal = 0.2;
            } else {
              alb = mix(wallTint, vec3(0.012, 0.014, 0.02), winMask);
              bRough = mix(0.9, 0.08, winMask);
            }
            bEmisCol += glow * winMask * 1.6;
            // ground floor shopfront
            if (fc.y < gh) {
              if (vStyle.w > 0.5) {
                float bay = max(1.0, floor(faceW / 4.2));
                float bf = fract(fc.x / (faceW / bay));
                float glass = rect(vec2(bf, fc.y), vec2(0.06, 0.25), vec2(0.94, 3.4), vec2(fwidth(bf), fwidth(fc.y)) * 1.2);
                float shopH = wHash12(vec2(floor(fc.x / (faceW / bay)), seed + faceId));
                vec3 shopC = shopH < 0.5 ? vec3(1.0, 0.85, 0.65) : (shopH < 0.75 ? vec3(0.85, 0.95, 1.0) : (shopH < 0.9 ? vec3(1.0, 0.5, 0.75) : vec3(0.5, 1.0, 0.85)));
                float shopOn = step(0.18, shopH);
                float grad = 0.6 + 0.4 * smoothstep(0.2, 3.2, fc.y);
                bEmisCol += shopC * glass * shopOn * (2.2 + 2.0 * shopH) * grad;
                alb = mix(vec3(0.02), vec3(0.02, 0.02, 0.025), glass);
                bRough = mix(0.6, 0.1, glass);
                // awning / sign band
                float band = step(3.55, fc.y) * step(fc.y, 4.4);
                alb = mix(alb, vec3(0.03), band);
              } else {
                // roller shutters
                float rib = 0.5 + 0.5 * sin(fc.y * 40.0);
                alb = vec3(0.08, 0.08, 0.085) * (0.7 + 0.3 * rib);
                bRough = 0.5;
                bMetal = 0.6;
              }
            }
            // horizontal floor slabs give towers structure
            float slab = 1.0 - smoothstep(0.0, 0.06 + aa.y, abs(fract((fc.y - gh) / fh) - 0.02));
            if (style < 0.5) alb *= 1.0 - slab * 0.35;
            // crown lights on landmark towers
            if (vSeed.z >= 0.0) {
              float crown = smoothstep(vBS.y - 3.0, vBS.y - 2.5, fc.y) * (1.0 - smoothstep(vBS.y - 0.9, vBS.y - 0.5, fc.y));
              vec3 cc = 0.5 + 0.5 * cos(6.2831 * (vSeed.z + vec3(0.0, 0.33, 0.67)));
              bEmisCol += cc * crown * 6.0 * (0.85 + 0.15 * sin(uTime * 1.3 + seed * 10.0));
            }
            // rooftop edge
            alb *= 1.0 - smoothstep(vBS.y - 0.6, vBS.y - 0.5, fc.y) * 0.6;
            // dirt at street level
            alb *= mix(0.6, 1.0, smoothstep(0.0, 2.5, fc.y));
          }
          diffuseColor.rgb = alb;
          `,
        },
        { after: 'roughnessmap_fragment', code: 'roughnessFactor = bRough;' },
        { after: 'metalnessmap_fragment', code: 'metalnessFactor = bMetal;' },
        { after: 'emissivemap_fragment', code: 'totalEmissiveRadiance += bEmisCol;' },
      ],
    },
  ]);
  return mat;
}
