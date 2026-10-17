import * as THREE from 'three';
import type { Terrain } from './Terrain';
import { WATER_LEVEL } from './Terrain';
import type { TrackGrid } from './TrackGrid';
import type { LampLighting } from './LampLighting';
import { applyPatches, GLSL_NOISE } from './ShaderPatch';
import { worldUniforms } from './TrackMaterials';

/** Dark harbor water: glassy, slowly rippling, reflecting the city env and every harbor lamp. */
export function buildWater(terrain: Terrain, grid: TrackGrid, lamps: LampLighting): THREE.Mesh {
  const x0 = 520, x1 = terrain.maxX, z0 = terrain.minZ, z1 = 780;
  const cell = 12;
  const nx = Math.ceil((x1 - x0) / cell);
  const nz = Math.ceil((z1 - z0) / cell);
  const pos: number[] = [];
  const sid: number[] = [];
  const idx: number[] = [];
  const keep = new Uint8Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * cell, z = z0 + j * cell;
      pos.push(x, WATER_LEVEL, z);
      const n = grid.nearest(x, z, 70);
      sid.push(n.index);
      keep[j * (nx + 1) + i] = terrain.basin(x, z) > 0.01 || terrain.height(x, z) < WATER_LEVEL + 0.5 ? 1 : 0;
    }
  }
  const w = nx + 1;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      if (keep[a] || keep[b] || keep[c] || keep[d]) idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('sampleIdx', new THREE.Float32BufferAttribute(sid, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({ color: 0x02040a, roughness: 0.06, metalness: 0.0, envMapIntensity: 1.6 });
  applyPatches(mat, [
    lamps.patch({ flat: true }),
    {
      key: 'water',
      uniforms: { uTime: worldUniforms.uTime },
      vertexHeader: 'varying vec3 vWW;',
      vertex: [{ after: 'begin_vertex', code: 'vWW = (modelMatrix * vec4(transformed, 1.0)).xyz;' }],
      fragmentHeader: 'uniform float uTime;\nvarying vec3 vWW;\n' + GLSL_NOISE + `\nfloat waterH(vec2 p, float t) { return wNoise(p * vec2(0.08, 0.3) + vec2(t * 0.06, t * 0.1)) + 0.45 * wNoise(p * 0.55 - vec2(t * 0.2, -t * 0.13)) + 0.12 * wNoise(p * 1.7 + t * 0.4); }`,
      fragment: [
        {
          after: 'normal_fragment_begin',
          code: /* glsl */ `
          {
            vec2 p = vWW.xz;
            float e = 0.35;
            float h0 = waterH(p, uTime);
            float hx = waterH(p + vec2(e, 0.0), uTime);
            float hz = waterH(p + vec2(0.0, e), uTime);
            vec3 wn = normalize(vec3(-(hx - h0) / e * 0.14, 1.0, -(hz - h0) / e * 0.14));
            normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
          }
          `,
        },
      ],
    },
  ]);
  const m = new THREE.Mesh(g, mat);
  m.name = 'water';
  return m;
}
