import * as THREE from 'three';
import type { Track } from '../track/Track';
import { START_S } from '../track/TrackDef';
import { applyPatches, GLSL_NOISE, type Patch } from './ShaderPatch';
import type { LampLighting } from './LampLighting';
import type { SurfaceKind } from './TrackMesh';
import { GRID_SLOTS } from './Grid';

export interface TrackTextures {
  asphalt: { map: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture };
  sidewalk: { map: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture };
  concrete: { map: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture };
}

export const worldUniforms = {
  uTime: { value: 0 },
  uWet: { value: 1 },
};

/** Varyings in road space (uv = lateral meters, arc length meters) plus world position. */
function roadSpacePatch(): Patch {
  return {
    key: 'roadspace',
    vertexHeader: 'varying vec2 vRoad;\nvarying vec3 vWPos;',
    vertex: [{ after: 'begin_vertex', code: 'vRoad = uv; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;' }],
    fragmentHeader: 'varying vec2 vRoad;\nvarying vec3 vWPos;\n' + GLSL_NOISE,
  };
}

function roadPatch(track: Track, zebras: number[]): Patch {
  const L = track.length;
  const dash = L / Math.round(L / 12);
  const z = zebras.slice(0, 8);
  while (z.length < 8) z.push(-1e6);
  const grid = GRID_SLOTS.slice(0, 12);
  const gridGlsl = grid.map((g) => `vec2(${g.lateral.toFixed(3)}, ${(g.s - START_S).toFixed(3)})`).join(',');
  return {
    key: 'road',
    uniforms: {
      ...worldUniforms,
      uTrackLen: { value: L },
      uStartS: { value: START_S },
      uDash: { value: dash },
      uZebra: { value: z },
    },
    fragmentHeader: /* glsl */ `
      uniform float uTrackLen;
      uniform float uStartS;
      uniform float uDash;
      uniform float uZebra[8];
      uniform float uWet;
      const vec2 GRID[${grid.length}] = vec2[${grid.length}](${gridGlsl});
      float lineM(float x, float c, float hw) {
        float aa = max(fwidth(x), 0.002) * 0.9;
        return 1.0 - smoothstep(hw - aa, hw + aa, abs(x - c));
      }
      float boxM(vec2 p, vec2 c, vec2 h) {
        vec2 aa = max(fwidth(p), vec2(0.002)) * 0.9;
        vec2 d = abs(p - c);
        vec2 m = 1.0 - smoothstep(h - aa, h + aa, d);
        return m.x * m.y;
      }
      float wrapD(float d) { return d - uTrackLen * floor(d / uTrackLen + 0.5); }
    `,
    fragment: [
      {
        after: 'map_fragment',
        code: /* glsl */ `
        vec2 rc = vRoad;
        float au = abs(rc.x);
        // --- wetness: puddles cluster near the gutters and in dips
        float pn = wFbm(vWPos.xz * 0.085 + vec2(3.1, 7.7));
        float pn2 = wNoise(vWPos.xz * 0.6);
        float gutter = smoothstep(6.0, 8.2, au);
        float puddle = smoothstep(0.6, 0.7, pn + gutter * 0.16 + pn2 * 0.05) * uWet;
        // wheel paths: polished darker strips in every lane
        float wp = 0.0;
        for (int l = 0; l < 4; l++) {
          float lc = -5.4 + float(l) * 3.6;
          wp = max(wp, 1.0 - smoothstep(0.25, 0.7, abs(abs(rc.x - lc) - 0.85)));
        }
        // large scale patching
        float patchN = wNoise(vWPos.xz * 0.02);
        diffuseColor.rgb *= mix(0.75, 1.2, patchN);
        diffuseColor.rgb *= mix(1.0, 0.8, wp);
        // --- paint
        float paint = 0.0;
        vec3 paintCol = vec3(0.78, 0.78, 0.74);
        float yel = max(lineM(rc.x, 0.17, 0.06), lineM(rc.x, -0.17, 0.06));
        float dsh = step(fract(rc.y / uDash), 0.28);
        float wht = max(lineM(rc.x, 3.6, 0.065), lineM(rc.x, -3.6, 0.065)) * dsh;
        wht = max(wht, max(lineM(rc.x, 7.45, 0.09), lineM(rc.x, -7.45, 0.09)));
        float ds = wrapD(rc.y - uStartS);
        // start / finish checker band
        if (abs(ds) < 1.65 && au < 7.36) {
          float ch = mod(floor(rc.x / 0.6) + floor((ds + 1.65) / 0.55), 2.0);
          paint = 1.0;
          paintCol = mix(vec3(0.012), vec3(0.8), ch);
          yel = 0.0; wht = 0.0;
        }
        // grid boxes behind the line
        if (ds < 2.0 && ds > -110.0) {
          for (int g = 0; g < ${grid.length}; g++) {
            vec2 gc = GRID[g];
            vec2 p = vec2(rc.x, ds);
            float m = boxM(p, vec2(gc.x, gc.y + 2.6), vec2(1.25, 0.08));
            m = max(m, boxM(p, vec2(gc.x - 1.25, gc.y + 1.9), vec2(0.07, 0.75)));
            m = max(m, boxM(p, vec2(gc.x + 1.25, gc.y + 1.9), vec2(0.07, 0.75)));
            wht = max(wht, m);
          }
        }
        // zebra crossings
        for (int k = 0; k < 8; k++) {
          float dz = wrapD(rc.y - uZebra[k]);
          if (abs(dz) < 2.4 && au < 7.2) {
            float st = 1.0 - smoothstep(0.42, 0.48, abs(fract(rc.x / 1.1) - 0.5));
            wht = max(wht, st * (1.0 - smoothstep(2.2, 2.4, abs(dz))));
            yel = 0.0;
          }
          // stop lines either side
          if (abs(abs(dz) - 3.4) < 0.3 && au < 7.2) wht = max(wht, boxM(vec2(rc.x, abs(dz)), vec2(rc.x, 3.4), vec2(8.0, 0.2)));
        }
        float wear = mix(0.55, 1.0, smoothstep(0.2, 0.55, wNoise(vWPos.xz * 1.9) * 0.6 + wNoise(vWPos.xz * 0.35) * 0.6));
        if (paint < 0.5) {
          paint = max(yel, wht) * wear;
          paintCol = yel > wht ? vec3(0.85, 0.48, 0.03) : vec3(0.78, 0.78, 0.74);
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, paintCol, paint);
        // wet darkening (water fills micro-pores)
        diffuseColor.rgb *= mix(1.0, 0.45, puddle) * mix(1.0, 0.82, uWet);
        `,
      },
      {
        after: 'roughnessmap_fragment',
        code: /* glsl */ `
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.62, uWet);
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.7, wp);
        roughnessFactor = mix(roughnessFactor, 0.5, paint * 0.8);
        roughnessFactor = mix(roughnessFactor, 0.03, puddle);
        `,
      },
      { after: 'normal_fragment_begin', code: 'vec3 roadBaseNormal = normal;' },
      { after: 'normal_fragment_maps', code: 'normal = normalize(mix(normal, roadBaseNormal, clamp(puddle * 0.95 + paint * 0.5, 0.0, 1.0)));' },
    ],
  };
}

function sidewalkPatch(): Patch {
  return {
    key: 'sidewalk',
    uniforms: { ...worldUniforms },
    fragmentHeader: 'uniform float uWet;',
    fragment: [
      {
        after: 'map_fragment',
        code: /* glsl */ `
        float pn = wFbm(vWPos.xz * 0.15 + vec2(9.0, 1.0));
        float puddle = smoothstep(0.66, 0.74, pn) * uWet;
        diffuseColor.rgb *= mix(0.55, 0.95, wNoise(vWPos.xz * 0.05));
        diffuseColor.rgb *= mix(1.0, 0.5, puddle) * mix(1.0, 0.8, uWet);
        `,
      },
      { after: 'roughnessmap_fragment', code: 'roughnessFactor = mix(roughnessFactor * mix(1.0, 0.7, uWet), 0.05, puddle);' },
      { after: 'normal_fragment_begin', code: 'vec3 swBaseNormal = normal;' },
      { after: 'normal_fragment_maps', code: 'normal = normalize(mix(normal, swBaseNormal, puddle));' },
    ],
  };
}

function concretePatch(): Patch {
  return {
    key: 'concrete',
    uniforms: { ...worldUniforms },
    fragmentHeader: 'uniform float uWet;',
    fragment: [
      {
        after: 'map_fragment',
        code: /* glsl */ `
        float grime = wFbm(vWPos.xz * 0.08 + vWPos.y * 0.3);
        float streak = smoothstep(0.3, 1.0, wNoise(vec2(vWPos.x * 1.7 + vWPos.z * 1.7, vWPos.y * 0.15)));
        diffuseColor.rgb *= mix(0.5, 1.05, grime) * mix(1.0, 0.8, streak);
        `,
      },
      { after: 'roughnessmap_fragment', code: 'roughnessFactor *= mix(1.0, 0.75, uWet);' },
    ],
  };
}

function tunnelWallPatch(): Patch {
  return {
    key: 'tunnelwall',
    fragment: [
      {
        after: 'map_fragment',
        code: /* glsl */ `
        float hgt = vRoad.x; // meters up the wall
        float tileZone = 1.0 - smoothstep(3.6, 3.7, hgt);
        vec3 tileCol = vec3(0.62, 0.58, 0.48);
        vec3 upper = vec3(0.05, 0.05, 0.055);
        float band = (1.0 - smoothstep(0.02, 0.04, abs(hgt - 1.05))) + (1.0 - smoothstep(0.1, 0.12, abs(hgt - 3.5)));
        vec3 base = mix(upper, tileCol * diffuseColor.rgb * 1.8, tileZone);
        base = mix(base, vec3(0.75, 0.25, 0.03), clamp(band, 0.0, 1.0));
        // grime at the bottom
        base *= mix(0.45, 1.0, smoothstep(0.0, 1.2, hgt));
        diffuseColor.rgb = base;
        `,
      },
      { after: 'roughnessmap_fragment', code: 'roughnessFactor = mix(0.85, roughnessFactor * 0.35, 1.0 - smoothstep(3.6, 3.7, vRoad.x));' },
    ],
  };
}

function configure(tex: THREE.Texture, rx: number, ry: number, srgb = false) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(rx, ry);
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createTrackMaterials(track: Track, tex: TrackTextures, lamps: LampLighting, zebras: number[]): Record<SurfaceKind, THREE.MeshStandardMaterial> {
  const L = track.length;
  // tile sizes that divide the loop length so the texture is seamless at the wrap
  const vRep = (size: number) => Math.round(L / size) / L;

  const clone = (t: THREE.Texture) => {
    const c = t.clone();
    c.needsUpdate = true;
    return c;
  };

  const asphaltSize = 7;
  const road = new THREE.MeshStandardMaterial({
    map: configure(clone(tex.asphalt.map), 1 / asphaltSize, vRep(asphaltSize), true),
    normalMap: configure(clone(tex.asphalt.normal), 1 / asphaltSize, vRep(asphaltSize)),
    roughnessMap: configure(clone(tex.asphalt.rough), 1 / asphaltSize, vRep(asphaltSize)),
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 1.0,
    metalness: 0.0,
    color: new THREE.Color(1.0, 1.0, 1.0),
  });
  applyPatches(road, [lamps.patch({ flat: true }), roadSpacePatch(), roadPatch(track, zebras)]);

  const swSize = 2.4;
  const sidewalk = new THREE.MeshStandardMaterial({
    map: configure(clone(tex.sidewalk.map), 1 / swSize, vRep(swSize), true),
    normalMap: configure(clone(tex.sidewalk.normal), 1 / swSize, vRep(swSize)),
    roughnessMap: configure(clone(tex.sidewalk.rough), 1 / swSize, vRep(swSize)),
    color: new THREE.Color(0.55, 0.55, 0.57),
    roughness: 1.0,
  });
  applyPatches(sidewalk, [lamps.patch({ flat: true }), roadSpacePatch(), sidewalkPatch()]);

  const cSize = 3;
  const mkConcrete = (color: THREE.ColorRepresentation, key: string) => {
    const m = new THREE.MeshStandardMaterial({
      map: configure(clone(tex.concrete.map), 1 / cSize, vRep(cSize), true),
      normalMap: configure(clone(tex.concrete.normal), 1 / cSize, vRep(cSize)),
      roughnessMap: configure(clone(tex.concrete.rough), 1 / cSize, vRep(cSize)),
      color: new THREE.Color(color),
      roughness: 1.0,
    });
    m.userData.key = key;
    return applyPatches(m, [lamps.patch({ flat: true }), roadSpacePatch(), concretePatch()]);
  };
  const concrete = mkConcrete(0x8d8c88, 'concrete');
  const retain = mkConcrete(0x6d6b66, 'retain');
  const tunnelCeil = mkConcrete(0x2a2a2c, 'tunnelCeil');
  tunnelCeil.roughnessMap = null;
  tunnelCeil.roughness = 0.95;

  const metal = new THREE.MeshStandardMaterial({ color: 0xa7adb4, metalness: 0.9, roughness: 0.3 });
  applyPatches(metal, [lamps.patch({ flat: true })]);

  const tunnelWall = new THREE.MeshStandardMaterial({
    map: configure(clone(tex.sidewalk.map), 1 / 1.2, vRep(1.2), true),
    normalMap: configure(clone(tex.sidewalk.normal), 1 / 1.2, vRep(1.2)),
    roughnessMap: configure(clone(tex.sidewalk.rough), 1 / 1.2, vRep(1.2)),
    roughness: 1.0,
  });
  applyPatches(tunnelWall, [lamps.patch({ flat: true }), roadSpacePatch(), tunnelWallPatch()]);

  return { road, sidewalk, concrete, metal, tunnelWall, tunnelCeil, retain };
}
