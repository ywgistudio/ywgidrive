import * as THREE from 'three';
import type { Track } from '../track/Track';
import type { Patch } from './ShaderPatch';

/** Number of lamp slots evaluated per fragment. */
export const LAMP_SLOTS = 8;
const POS_W = 256;
const NEAR_W = 1024;

/**
 * Analytic streetlight lighting for static world surfaces.
 *
 * Every lamp of the circuit is packed into float DataTextures. For each centerline sample we
 * precompute the (up to 8) lamps that can reach it. World meshes carry a `sampleIdx` vertex (or
 * instance) attribute and the fragment shader evaluates those lamps through three's own RE_Direct
 * physical BRDF, so wet asphalt gets real GGX highlights from hundreds of lamps for the cost of 8.
 *
 * Patched materials also drop three's point-light loop: the game moves a handful of real
 * PointLights onto the lamps nearest the camera to light the cars, and static surfaces would
 * otherwise be lit twice.
 */
export class LampLighting {
  readonly posTex: THREE.DataTexture;
  readonly colTex: THREE.DataTexture;
  readonly nearTex: THREE.DataTexture;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(readonly track: Track) {
    const lamps = track.lamps;
    const n = lamps.length;
    const rows = Math.ceil(n / POS_W);
    const pos = new Float32Array(POS_W * rows * 4);
    const col = new Float32Array(POS_W * rows * 4);
    lamps.forEach((l, i) => {
      pos.set([l.pos.x, l.pos.y, l.pos.z, l.range], i * 4);
      col.set([l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity, l.tunnel ? 1 : 0], i * 4);
    });
    this.posTex = makeTex(pos, POS_W, rows);
    this.colTex = makeTex(col, POS_W, rows);

    // near list: lamps whose range reaches within ~14m of the sample (covers the corridor + sidewalks)
    const count = track.count;
    const texels = count * (LAMP_SLOTS / 4);
    const nrows = Math.ceil(texels / NEAR_W);
    const near = new Float32Array(NEAR_W * nrows * 4).fill(-1);
    const cand: { d: number; i: number }[] = [];
    // lamps sorted by s
    const sorted = lamps.map((l, i) => ({ s: l.s, i })).sort((a, b) => a.s - b.s);
    for (let i = 0; i < count; i++) {
      cand.length = 0;
      const sx = track.px[i], sy = track.py[i], sz = track.pz[i];
      for (const e of sorted) {
        const L = lamps[e.i];
        const dx = L.pos.x - sx, dy = L.pos.y - sy, dz = L.pos.z - sz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < L.range + 16) cand.push({ d: d - L.range, i: e.i });
      }
      cand.sort((a, b) => a.d - b.d);
      for (let k = 0; k < Math.min(LAMP_SLOTS, cand.length); k++) near[i * LAMP_SLOTS + k] = cand[k].i;
    }
    this.nearTex = makeTex(near, NEAR_W, nrows);

    this.uniforms = {
      uLampPos: { value: this.posTex },
      uLampCol: { value: this.colTex },
      uLampNear: { value: this.nearTex },
      uLampScale: { value: 1.0 },
    };
  }

  /** Patch for materials whose geometry has a float `sampleIdx` attribute (vertex or instanced). */
  patch(opts: { flat?: boolean } = {}): Patch {
    const flat = opts.flat ? 'flat ' : '';
    return {
      key: 'lamps' + (opts.flat ? 'F' : ''),
      uniforms: this.uniforms,
      vertexHeader: `attribute float sampleIdx;\n${flat}varying float vSampleIdx;`,
      vertex: [{ after: 'begin_vertex', code: 'vSampleIdx = sampleIdx;' }],
      fragmentHeader: /* glsl */ `
        ${flat}varying float vSampleIdx;
        uniform highp sampler2D uLampPos;
        uniform highp sampler2D uLampCol;
        uniform highp sampler2D uLampNear;
        uniform float uLampScale;
      `,
      fragment: [{ replace: 'lights_fragment_begin', code: lightsChunkWithLamps() }],
    };
  }
}

function makeTex(data: Float32Array, w: number, h: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Remove a `#if ... #endif` block (with nesting) that starts with `startLine`. */
export function stripBlock(src: string, startLine: string): string {
  const start = src.indexOf(startLine);
  if (start < 0) return src;
  const lines = src.slice(start).split('\n');
  let depth = 0;
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    consumed += lines[i].length + 1;
    if (t.startsWith('#if')) depth++;
    else if (t.startsWith('#endif')) {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(0, start) + src.slice(start + consumed);
}

let cachedChunk: string | null = null;
function lightsChunkWithLamps(): string {
  if (cachedChunk) return cachedChunk;
  let chunk = THREE.ShaderChunk.lights_fragment_begin;
  chunk = stripBlock(chunk, '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
  chunk += /* glsl */ `
  #if defined( RE_Direct )
  {
    int sIdx = int( vSampleIdx + 0.5 );
    if ( vSampleIdx >= 0.0 ) {
      vec3 downV = normalize( ( viewMatrix * vec4( 0.0, -1.0, 0.0, 0.0 ) ).xyz );
      for ( int k = 0; k < ${LAMP_SLOTS}; k ++ ) {
        int t = sIdx * ${LAMP_SLOTS / 4} + ( k >> 2 );
        vec4 nl = texelFetch( uLampNear, ivec2( t % ${NEAR_W}, t / ${NEAR_W} ), 0 );
        int c = k & 3;
        float fi = c == 0 ? nl.x : ( c == 1 ? nl.y : ( c == 2 ? nl.z : nl.w ) );
        if ( fi < 0.0 ) break;
        int li = int( fi + 0.5 );
        ivec2 lt = ivec2( li % ${POS_W}, li / ${POS_W} );
        vec4 lp = texelFetch( uLampPos, lt, 0 );
        vec4 lc = texelFetch( uLampCol, lt, 0 );
        vec3 lView = ( viewMatrix * vec4( lp.xyz, 1.0 ) ).xyz;
        vec3 lVec = lView - geometryPosition;
        float d = length( lVec );
        if ( d > lp.w ) continue;
        vec3 L = lVec / d;
        float cosA = dot( -L, downV );
        float cone = lc.a > 0.5 ? mix( 0.28, 1.0, smoothstep( -0.35, 0.55, cosA ) ) : smoothstep( 0.05, 0.62, cosA ) * 0.97 + 0.03;
        directLight.color = lc.rgb * getDistanceAttenuation( d, lp.w, 2.0 ) * cone * uLampScale;
        directLight.direction = L;
        directLight.visible = true;
        RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
      }
    }
  }
  #endif
  `;
  cachedChunk = chunk;
  return chunk;
}

/** Patch that only strips point lights (for static materials without sample indices). */
export function noPointLightsPatch(): Patch {
  return {
    key: 'nopl',
    fragment: [{ replace: 'lights_fragment_begin', code: stripBlock(THREE.ShaderChunk.lights_fragment_begin, '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )') }],
  };
}
