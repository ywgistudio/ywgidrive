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
        // real interior light sources: tungsten, warm LED, office fluorescent (slightly green), cool LED
        vec3 winPalette(float h, float office) {
          vec3 tung = vec3(1.0, 0.52, 0.22);
          vec3 warmLed = vec3(1.0, 0.72, 0.45);
          vec3 fluo = vec3(0.8, 0.92, 0.82);
          vec3 coolLed = vec3(0.78, 0.86, 1.0);
          vec3 home = h < 0.55 ? tung : (h < 0.9 ? warmLed : coolLed);
          vec3 work = h < 0.55 ? fluo : (h < 0.85 ? coolLed : warmLed);
          return mix(home, work, office);
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
          // facade materials: concrete, limestone, brick, dark panel (picked per building)
          float matSel = fract(vSeed.y * 7.0);
          vec3 wallTint = matSel < 0.35 ? vec3(0.3, 0.295, 0.28) : (matSel < 0.55 ? vec3(0.34, 0.3, 0.24) : (matSel < 0.8 ? vec3(0.26, 0.12, 0.085) : vec3(0.11, 0.115, 0.12)));
          wallTint *= 0.42 + 0.33 * vSeed.y;
          float office = (style < 1.5 || style > 4.5) ? 1.0 : 0.0;
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
            vec2 lo = style < 0.5 ? vec2(0.2, 0.3) : (style < 1.5 ? vec2(0.05, 0.08) : (style < 2.5 ? vec2(0.24, 0.28) : (style < 3.5 ? vec2(0.3, 0.55) : vec2(0.25, 0.3))));
            vec2 hi = vec2(1.0) - lo * vec2(1.0, style < 1.5 ? 0.6 : 0.9);
            float area = (hi.x - lo.x) * (hi.y - lo.y);
            float win = mix(rect(cf, lo, hi, aa), area, lod);
            // window frame: mullion + transom inside the opening (offices / residential)
            vec2 wl = (cf - lo) / max(hi - lo, vec2(1e-3));
            float mull = 0.0;
            if (style < 0.5 || (style > 1.5 && style < 2.5)) {
              mull = (1.0 - smoothstep(0.0, 0.035 + aa.x * 2.0, abs(wl.x - 0.5))) + (1.0 - smoothstep(0.0, 0.03 + aa.y * 2.0, abs(wl.y - 0.72)));
              mull = clamp(mull, 0.0, 1.0) * (1.0 - lod);
            }
            float aboveGround = step(gh, fc.y) * step(fc.y, vBS.y - (style < 1.5 ? 1.2 : 0.6));
            // floors are lit coherently (offices) with individual variation
            float hf = wHash12(vec2(ci.y + seed * 13.0, faceId));
            float hw = wHash12(ci + vec2(seed * 71.0, faceId * 17.0));
            float litFrac = vStyle.z;
            float lit = step(hw, litFrac * (0.55 + hf * 0.9));
            // offices light whole runs of a floor (one tenant / one cleaning crew), not single windows
            float runLen = 3.0 + floor(wHash12(vec2(ci.y, seed + faceId)) * 7.0);
            float run = floor((ci.x + floor(wHash12(vec2(ci.y * 1.3, seed)) * 5.0)) / runLen);
            float litRun = step(wHash12(vec2(ci.y + seed * 13.0, run + faceId * 7.0)), litFrac * 1.15);
            lit = mix(lit, litRun * step(0.06, hw), office);
            if (style > 3.5 && style < 4.5) lit *= step(0.35, hf);
            float inten = (0.25 + 0.75 * pow(wHash12(ci * 1.7 + seed), 2.0)) * (0.55 + 0.6 * wl.y);
            // ceiling light band + interior clutter silhouettes
            inten *= 1.0 + 0.6 * smoothstep(0.78, 0.9, wl.y) * (1.0 - lod);
            float clutter = step(wl.y, 0.18 + 0.32 * wHash12(vec2(floor(wl.x * 3.0 + 0.5 * wHash12(ci)), ci.y + ci.x * 7.0 + seed))) * step(0.45, wHash12(ci + seed * 9.0));
            inten *= mix(1.0, 0.35, clutter * (1.0 - lod));
            // blinds: horizontal slats on some windows
            float blinds = step(0.8, wHash12(ci * 2.3 + seed * 5.0));
            inten *= mix(1.0, 0.55 + 0.45 * step(0.5, fract(cf.y * 9.0)), blinds * (1.0 - lod));
            vec3 wc = winPalette(wHash12(ci + seed * 3.0 + 0.5), office * (0.6 + 0.4 * vStyle.y));
            // TVs in homes: dim, cool, flickering
            float tv = (1.0 - office) * step(0.988, wHash12(ci * 3.1 + seed));
            if (tv > 0.5) { wc = vec3(0.55, 0.65, 0.95); inten *= 0.35 + 0.2 * sin(uTime * 7.0 + hw * 40.0) * sin(uTime * 2.3 + hw * 9.0); lit = 1.0; }
            // distance fallback: average glow so far towers don't shimmer
            float avgLit = litFrac * 0.75;
            vec3 avgCol = winPalette(0.45, office);
            vec3 glow = mix(wc * inten * lit, avgCol * 0.3 * avgLit, far);
            float winMask = win * aboveGround * (1.0 - mull);
            // dim curtains glow in some unlit windows
            float curtain = (1.0 - lit) * step(0.75, wHash12(ci * 5.1 + seed)) * 0.06;
            glow += vec3(1.0, 0.55, 0.3) * curtain * (1.0 - far);
            if (style > 0.5 && style < 1.5) {
              // glass curtain wall: dark reflective glass everywhere, mullions
              alb = mix(vec3(0.015, 0.02, 0.03), wallTint * 0.5, 1.0 - win);
              bRough = mix(0.5, 0.06, win);
              bMetal = 0.2;
            } else {
              alb = mix(wallTint, vec3(0.012, 0.014, 0.02), winMask);
              bRough = mix(0.9, 0.08, winMask);
            }
            bEmisCol += glow * winMask * 0.55;
            // ground floor shopfront
            if (fc.y < gh) {
              if (vStyle.w > 0.5) {
                float bay = max(1.0, floor(faceW / 4.2));
                float bf = fract(fc.x / (faceW / bay));
                float glass = rect(vec2(bf, fc.y), vec2(0.06, 0.25), vec2(0.94, 3.4), vec2(fwidth(bf), fwidth(fc.y)) * 1.2);
                float shopH = wHash12(vec2(floor(fc.x / (faceW / bay)), seed + faceId));
                float kind = wHash12(vec2(floor(fc.x / (faceW / bay)) * 3.7, seed * 2.0 + faceId));
                vec3 shopC = kind < 0.45 ? vec3(1.0, 0.68, 0.4) : (kind < 0.8 ? vec3(0.9, 0.95, 0.95) : vec3(1.0, 0.45, 0.18));
                // ~45% of shops are open late; closed ones keep a dim security light or have the shutter down
                float shopOn = step(0.55, shopH);
                float shutter = (1.0 - shopOn) * step(0.5, fract(shopH * 13.7));
                // interior: rows of ceiling fixtures, shelving with goods (stores) or table silhouettes (bars)
                float cellX = floor(bf * 10.0);
                float ceilRow = smoothstep(2.85, 3.1, fc.y) * (0.6 + 0.4 * step(0.35, fract(bf * 5.0)));
                float shelf = 0.0;
                for (int sh = 0; sh < 3; sh++) shelf += 1.0 - smoothstep(0.03, 0.06, abs(fc.y - (0.85 + float(sh) * 0.62)));
                float goods = 0.55 + 0.45 * wHash12(vec2(cellX, floor(fc.y * 3.2) + seed));
                float store = step(kind, 0.8);
                float interior = mix(0.75, goods, store * step(fc.y, 2.5)) * (1.0 - clamp(shelf, 0.0, 1.0) * 0.75 * store);
                // bars/diners: dimmer, a counter and seated silhouettes in the lower half
                interior *= mix(1.0, 0.55 + 0.45 * step(1.05, fc.y), 1.0 - store);
                interior += ceilRow * 1.4;
                // vertical mullions and a darker door bay
                float mullion = 1.0 - smoothstep(0.0, 0.012 + fwidth(bf), abs(bf - 0.5));
                float doorBay = step(0.8, fract(floor(fc.x / (faceW / bay)) * 0.37 + seed));
                interior *= mix(1.0, 0.25, mullion) * mix(1.0, 0.7, doorBay);
                float grad = 0.6 + 0.4 * smoothstep(0.2, 3.0, fc.y);
                vec3 open = shopC * (0.38 + 0.28 * kind) * interior * grad;
                vec3 closed = vec3(0.9, 0.85, 0.75) * 0.03 * smoothstep(1.5, 3.2, fc.y);
                bEmisCol += glass * mix(closed, open, shopOn) * (1.0 - shutter);
                alb = mix(vec3(0.02), vec3(0.02, 0.02, 0.025), glass);
                bRough = mix(0.6, 0.1, glass);
                float rib = 0.5 + 0.5 * sin(fc.y * 40.0);
                alb = mix(alb, vec3(0.1, 0.1, 0.105) * (0.7 + 0.3 * rib), glass * shutter);
                bRough = mix(bRough, 0.45, glass * shutter);
                bMetal = mix(bMetal, 0.6, glass * shutter);
                // awning / sign band
                float band = step(3.55, fc.y) * step(fc.y, 4.4);
                alb = mix(alb, vec3(0.03), band);
              } else if (office > 0.5 && style < 1.5) {
                // lit lobby: tall glass across the middle of the face, warm-white downlights
                float mid = 1.0 - smoothstep(0.28, 0.32, abs(fc.x / faceW - 0.5));
                float glassL = mid * step(0.15, fc.y) * step(fc.y, gh - 0.4);
                float lobbyOn = step(0.25, fract(seed * 5.3));
                // mullions every ~1.5 m, downlight pools near the ceiling, a reception desk silhouette
                float lx = fc.x / 1.5;
                float lm = 1.0 - smoothstep(0.0, 0.03 + fwidth(lx), abs(fract(lx) - 0.5) - 0.47);
                float down = smoothstep(gh - 1.2, gh - 0.55, fc.y) * (0.55 + 0.45 * cos(fc.x * 4.2));
                float desk = (1.0 - smoothstep(0.08, 0.1, abs(fc.x / faceW - 0.5))) * step(0.4, fc.y) * step(fc.y, 1.15);
                float lobby = (0.2 + 0.35 * down) * (1.0 - lm * 0.8) * (1.0 - desk * 0.7);
                bEmisCol += vec3(1.0, 0.82, 0.62) * glassL * lobbyOn * lobby;
                alb = mix(wallTint * 0.8, vec3(0.015), glassL);
                bRough = mix(0.8, 0.08, glassL);
              } else {
                // roller shutters
                float rib = 0.5 + 0.5 * sin(fc.y * 40.0);
                alb = vec3(0.08, 0.08, 0.085) * (0.7 + 0.3 * rib);
                bRough = 0.5;
                bMetal = 0.6;
              }
            }
            // pilasters between window columns
            float pil = 1.0 - smoothstep(0.02, 0.06 + aa.x, min(cf.x, 1.0 - cf.x));
            if (style < 0.5 || style > 1.5) alb *= 1.0 + pil * 0.5 * (1.0 - lod) * (1.0 - winMask);
            // warehouses: roller doors with sodium bay lights
            if (style > 2.5 && style < 3.5 && fc.y < 6.0) {
              float bayW = 8.0;
              float nb = max(1.0, floor(faceW / bayW));
              float bx = fc.x / (faceW / nb);
              float bi = floor(bx);
              float bfx = fract(bx);
              float hb = wHash12(vec2(bi, seed + faceId * 3.0));
              float door = rect(vec2(bfx, fc.y), vec2(0.18, 0.0), vec2(0.82, 4.6), vec2(fwidth(bx), fwidth(fc.y)) * 1.2);
              float open = step(0.82, hb);
              float rib = 0.5 + 0.5 * sin(fc.y * 30.0);
              alb = mix(alb, mix(vec3(0.09, 0.09, 0.1) * (0.75 + 0.25 * rib), vec3(0.01), open), door);
              bRough = mix(bRough, 0.45, door);
              bMetal = mix(bMetal, 0.7, door * (1.0 - open));
              bEmisCol += vec3(1.0, 0.6, 0.25) * door * open * 1.4 * smoothstep(0.0, 4.0, fc.y);
              // bay lamp above each door
              float lampM = rect(vec2(bfx, fc.y), vec2(0.45, 5.05), vec2(0.55, 5.35), vec2(fwidth(bx), fwidth(fc.y)));
              bEmisCol += vec3(1.0, 0.55, 0.2) * lampM * 9.0 * step(0.25, hb);
              // light spill below the lamp
              float spill = exp(-pow((bfx - 0.5) * 3.0, 2.0)) * smoothstep(5.2, 2.0, fc.y) * step(0.25, hb);
              alb += vec3(0.25, 0.13, 0.04) * spill * 0.35;
            }
            // horizontal floor slabs give towers structure
            float slab = 1.0 - smoothstep(0.0, 0.06 + aa.y, abs(fract((fc.y - gh) / fh) - 0.02));
            if (style < 0.5) alb *= 1.0 - slab * 0.35;
            // crown lights on landmark towers
            if (vSeed.z >= 0.0) {
              // uplight wash on the top floors, strongest at the fixtures and fading upward
              float wash = smoothstep(vBS.y - 9.0, vBS.y - 8.0, fc.y) * (1.0 - smoothstep(vBS.y - 0.6, vBS.y - 0.2, fc.y));
              float fall = exp(-(fc.y - (vBS.y - 9.0)) * 0.22);
              float bays = 0.65 + 0.35 * cos(fc.x * 1.3);
              vec3 cc = vSeed.z < 0.6 ? vec3(1.0, 0.86, 0.68) : vec3(0.86, 0.92, 1.0);
              bEmisCol += cc * wash * fall * bays * 1.1 * (1.0 - winMask);
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
