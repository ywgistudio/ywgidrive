import * as THREE from 'three';
import { Rng } from './rng';
import type { Facade } from './City';
import { applyPatches } from './ShaderPatch';
import { worldUniforms } from './TrackMaterials';

/** Neon / lightbox sign atlas drawn with Canvas2D at load, plus instanced placement on facades. */

type Kind = 'h' | 'v' | 'b';
interface Cell {
  kind: Kind;
  u: number;
  v: number;
  w: number;
  h: number; // uv rect
  aspect: number; // world width / height
}

const SIZE = 2048;

const H_WORDS = [
  'RAMEN', 'HOTEL', 'BAR', 'KARAOKE', 'SUSHI', 'OPEN 24H', 'NOODLES', 'CLUB', 'ARCADE', 'CAFE', 'DINER', 'GARAGE',
  'TUNE SHOP', 'NITRO', 'PIZZA', 'LIQUOR', 'MOTEL', 'YWGI', 'DRIFT KING', 'NIGHT OWL', 'LOUNGE', 'GAME CENTER', 'PARKING', 'BOWLING',
];
const NEON_COLS = ['#ff2d95', '#00e5ff', '#ffcf3a', '#7cff4f', '#ff4b2b', '#b26bff', '#ff8a1f', '#3cffd0', '#ff5ce1', '#4f9bff'];
const ADS = [
  { t: 'YWGI ENERGY', s: 'DRINK THE NIGHT', a: '#ff2d95', b: '#2a0a3a' },
  { t: 'MIDNIGHT FM', s: '88.1  NON-STOP SYNTH', a: '#00e5ff', b: '#06142e' },
  { t: 'KAZE MOTORS', s: 'BUILT FOR THE DARK', a: '#ffcf3a', b: '#1c1206' },
  { t: 'NITRO+ FUEL', s: 'MORE BOOST. NO BRAKES.', a: '#7cff4f', b: '#071a0c' },
  { t: 'STAY FAST', s: 'NEON CITY TOURISM', a: '#ff8a1f', b: '#200c05' },
  { t: 'RAIDEN TIRES', s: 'GRIP THE MIDNIGHT', a: '#b26bff', b: '#12082a' },
  { t: 'AKUMA AUDIO', s: 'LOUDER THAN YOUR EXHAUST', a: '#ff4b2b', b: '#220707' },
  { t: 'NEO TOKYO BANK', s: '24H ATM  ▸  LEVEL B1', a: '#3cffd0', b: '#04181a' },
];

function pseudoGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, r: Rng) {
  // composes a kanji-like glyph from strokes on a 3x3 lattice
  const n = r.int(3, 6);
  const P = (k: number) => k * s * 0.4 + s * 0.1;
  ctx.beginPath();
  // frame strokes
  if (r.chance(0.5)) {
    ctx.moveTo(x + P(0), y + P(0));
    ctx.lineTo(x + P(2), y + P(0));
  }
  for (let k = 0; k < n; k++) {
    const a = r.int(0, 2), b = r.int(0, 2), c = r.int(0, 2), d = r.int(0, 2);
    if (r.chance(0.5)) {
      ctx.moveTo(x + P(a), y + P(b));
      ctx.lineTo(x + P(a), y + P(Math.max(b, d) === b ? 2 : d));
    } else {
      ctx.moveTo(x + P(a), y + P(b));
      ctx.lineTo(x + P(c === a ? 2 - a : c), y + P(b));
    }
  }
  if (r.chance(0.4)) {
    ctx.moveTo(x + P(0.2), y + P(2));
    ctx.lineTo(x + P(1), y + P(1.2));
    ctx.lineTo(x + P(1.8), y + P(2));
  }
  ctx.stroke();
}

function neonText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, size: number, color: string, font: string, family: string) {
  ctx.font = `${font} ${size}px ${family}`;
  let w = ctx.measureText(text).width;
  let sz = size;
  while (w > maxW && sz > 10) {
    sz -= 4;
    ctx.font = `${font} ${sz}px ${family}`;
    w = ctx.measureText(text).width;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.shadowColor = color;
  ctx.strokeStyle = color;
  for (const [lw, blur, alpha] of [
    [sz * 0.16, sz * 0.5, 0.55],
    [sz * 0.1, sz * 0.25, 0.9],
  ] as [number, number, number][]) {
    ctx.globalAlpha = alpha;
    ctx.shadowBlur = blur;
    ctx.lineWidth = lw;
    ctx.strokeText(text, cx, cy);
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = sz * 0.08;
  ctx.lineWidth = sz * 0.035;
  ctx.strokeStyle = '#fff6f0';
  ctx.strokeText(text, cx, cy);
  ctx.shadowBlur = 0;
}

export class NeonAtlas {
  readonly texture: THREE.CanvasTexture;
  readonly cells: Cell[] = [];

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    const r = new Rng(4242);
    const fonts = ['900 italic', 'bold', '800', 'bold italic'];
    const families = ['"Arial Black", Impact, sans-serif', 'Impact, "Arial Narrow", sans-serif', '"Trebuchet MS", Verdana, sans-serif', 'Georgia, "Times New Roman", serif', '"Courier New", monospace'];

    // block A: 24 horizontal neon words, 512x128
    for (let k = 0; k < 24; k++) {
      const x = (k % 4) * 512, y = Math.floor(k / 4) * 128;
      const col = NEON_COLS[k % NEON_COLS.length];
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, 512, 128);
      ctx.clip();
      if (k % 5 === 2) {
        // lightbox style
        const g = ctx.createLinearGradient(x, y, x, y + 128);
        g.addColorStop(0, col);
        g.addColorStop(1, '#ffffff');
        ctx.fillStyle = g;
        ctx.globalAlpha = 0.85;
        roundRect(ctx, x + 10, y + 12, 492, 104, 14);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#100810';
        ctx.font = `${fonts[k % 4]} 74px ${families[k % 3]}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(H_WORDS[k], x + 256, y + 66, 460);
      } else {
        neonText(ctx, H_WORDS[k], x + 256, y + 66, 440, 84, col, fonts[k % 4], families[k % families.length]);
        // decorative tube underline / arrow
        if (k % 3 === 0) {
          ctx.strokeStyle = NEON_COLS[(k + 3) % NEON_COLS.length];
          ctx.shadowColor = ctx.strokeStyle as string;
          ctx.shadowBlur = 14;
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(x + 40, y + 112);
          ctx.lineTo(x + 472, y + 112);
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
      }
      ctx.restore();
      this.cells.push({ kind: 'h', u: x / SIZE, v: 1 - (y + 128) / SIZE, w: 512 / SIZE, h: 128 / SIZE, aspect: 4 });
    }
    // block B: 16 vertical lightboxes / neon glyph banners, 128x512 at y=768
    for (let k = 0; k < 16; k++) {
      const x = k * 128, y = 768;
      const col = NEON_COLS[(k * 3) % NEON_COLS.length];
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, 128, 512);
      ctx.clip();
      const lightbox = k % 2 === 0;
      if (lightbox) {
        const g = ctx.createLinearGradient(x, y, x + 128, y);
        g.addColorStop(0, col);
        g.addColorStop(0.5, '#ffffff');
        g.addColorStop(1, col);
        ctx.fillStyle = g;
        ctx.globalAlpha = 0.9;
        roundRect(ctx, x + 8, y + 8, 112, 496, 10);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#120a14';
        ctx.lineWidth = 9;
        ctx.lineCap = 'square';
      } else {
        ctx.strokeStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = 16;
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.strokeRect(x + 10, y + 10, 108, 492);
      }
      const glyphs = r.int(3, 5);
      for (let gI = 0; gI < glyphs; gI++) {
        pseudoGlyph(ctx, x + 22, y + 30 + gI * (460 / glyphs), 84, r);
        if (!lightbox) {
          ctx.save();
          ctx.strokeStyle = '#fff4f4';
          ctx.lineWidth = 2.5;
          ctx.shadowBlur = 4;
          ctx.restore();
        }
      }
      ctx.restore();
      this.cells.push({ kind: 'v', u: x / SIZE, v: 1 - (y + 512) / SIZE, w: 128 / SIZE, h: 512 / SIZE, aspect: 0.25 });
    }
    // block C: 8 billboards 512x256 at y = 1280 (2 rows) + 4 more neon icons
    for (let k = 0; k < ADS.length; k++) {
      const x = (k % 4) * 512, y = 1280 + Math.floor(k / 4) * 256;
      const ad = ADS[k];
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, 512, 256);
      ctx.clip();
      const g = ctx.createLinearGradient(x, y, x + 512, y + 256);
      g.addColorStop(0, ad.b);
      g.addColorStop(1, '#000000');
      ctx.fillStyle = g;
      ctx.fillRect(x + 6, y + 6, 500, 244);
      // big diagonal accent
      ctx.fillStyle = ad.a;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(x + 330, y + 6);
      ctx.lineTo(x + 506, y + 6);
      ctx.lineTo(x + 506, y + 250);
      ctx.lineTo(x + 250, y + 250);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = ad.a;
      ctx.shadowBlur = 18;
      ctx.font = `900 italic 66px "Arial Black", Impact, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(ad.t, x + 26, y + 120, 460);
      ctx.shadowBlur = 0;
      ctx.fillStyle = ad.a;
      ctx.font = `bold 28px "Trebuchet MS", Verdana, sans-serif`;
      ctx.fillText(ad.s, x + 28, y + 172, 450);
      ctx.strokeStyle = ad.a;
      ctx.lineWidth = 5;
      ctx.strokeRect(x + 10, y + 10, 492, 236);
      ctx.restore();
      this.cells.push({ kind: 'b', u: x / SIZE, v: 1 - (y + 256) / SIZE, w: 512 / SIZE, h: 256 / SIZE, aspect: 2 });
    }
    // block D: neon icon signs (arrows, cocktail, star, heart, cross) 256x256 at y=1792
    const icons = ['arrow', 'glass', 'star', 'heart', 'cross', 'bolt', 'ring', 'chevrons'];
    icons.forEach((ic, k) => {
      const x = k * 256, y = 1792;
      const col = NEON_COLS[(k * 7 + 1) % NEON_COLS.length];
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, 256, 256);
      ctx.clip();
      ctx.strokeStyle = col;
      ctx.shadowColor = col;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const [lw, blur] of [
        [16, 30],
        [8, 12],
        [3, 4],
      ]) {
        ctx.lineWidth = lw;
        ctx.shadowBlur = blur;
        if (lw === 3) ctx.strokeStyle = '#fff';
        drawIcon(ctx, ic, x + 128, y + 128, 90);
      }
      ctx.restore();
      this.cells.push({ kind: 'h', u: x / SIZE, v: 1 - (y + 256) / SIZE, w: 256 / SIZE, h: 256 / SIZE, aspect: 1 });
    });

    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  pick(kind: Kind, r: Rng): number {
    const idx = this.cells.map((c, i) => (c.kind === kind ? i : -1)).filter((i) => i >= 0);
    return r.pick(idx);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawIcon(ctx: CanvasRenderingContext2D, ic: string, cx: number, cy: number, s: number) {
  ctx.beginPath();
  switch (ic) {
    case 'arrow':
      ctx.moveTo(cx - s, cy);
      ctx.lineTo(cx + s * 0.6, cy);
      ctx.moveTo(cx + s * 0.1, cy - s * 0.55);
      ctx.lineTo(cx + s * 0.7, cy);
      ctx.lineTo(cx + s * 0.1, cy + s * 0.55);
      break;
    case 'glass':
      ctx.moveTo(cx - s * 0.7, cy - s * 0.6);
      ctx.lineTo(cx + s * 0.7, cy - s * 0.6);
      ctx.lineTo(cx, cy + s * 0.15);
      ctx.closePath();
      ctx.moveTo(cx, cy + s * 0.15);
      ctx.lineTo(cx, cy + s * 0.75);
      ctx.moveTo(cx - s * 0.4, cy + s * 0.75);
      ctx.lineTo(cx + s * 0.4, cy + s * 0.75);
      break;
    case 'star':
      for (let k = 0; k <= 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const rr = k % 2 === 0 ? s : s * 0.42;
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      break;
    case 'heart':
      ctx.moveTo(cx, cy + s * 0.75);
      ctx.bezierCurveTo(cx - s * 1.2, cy - s * 0.1, cx - s * 0.5, cy - s * 0.95, cx, cy - s * 0.35);
      ctx.bezierCurveTo(cx + s * 0.5, cy - s * 0.95, cx + s * 1.2, cy - s * 0.1, cx, cy + s * 0.75);
      break;
    case 'cross':
      ctx.rect(cx - s * 0.25, cy - s * 0.8, s * 0.5, s * 1.6);
      ctx.rect(cx - s * 0.8, cy - s * 0.25, s * 1.6, s * 0.5);
      break;
    case 'bolt':
      ctx.moveTo(cx + s * 0.2, cy - s);
      ctx.lineTo(cx - s * 0.45, cy + s * 0.1);
      ctx.lineTo(cx + s * 0.05, cy + s * 0.1);
      ctx.lineTo(cx - s * 0.2, cy + s);
      ctx.lineTo(cx + s * 0.45, cy - s * 0.15);
      ctx.lineTo(cx - s * 0.05, cy - s * 0.15);
      ctx.closePath();
      break;
    case 'ring':
      ctx.arc(cx, cy, s * 0.8, 0, Math.PI * 2);
      ctx.moveTo(cx + s * 0.45, cy);
      ctx.arc(cx, cy, s * 0.45, 0, Math.PI * 2);
      break;
    default:
      for (let k = 0; k < 3; k++) {
        const ox = cx - s * 0.7 + k * s * 0.55;
        ctx.moveTo(ox, cy - s * 0.6);
        ctx.lineTo(ox + s * 0.45, cy);
        ctx.lineTo(ox, cy + s * 0.6);
      }
  }
  ctx.stroke();
}

export interface SignInstance {
  cell: number;
  pos: THREE.Vector3; // center
  normal: THREE.Vector3; // facing
  up: THREE.Vector3;
  width: number;
  height: number;
  color: THREE.Color;
  flicker: number; // 0 steady 1 buzz 2 broken
  phase: number;
}

/** Choose sign placements on road-facing facades. */
export function placeSigns(atlas: NeonAtlas, facades: Facade[], seed = 77): SignInstance[] {
  const r = new Rng(seed);
  const out: SignInstance[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const f of facades) {
    const dense = f.zone === 'downtown' ? 1 : f.zone === 'harbor' ? 0.6 : f.zone === 'docks' ? 0.25 : f.zone === 'park' ? 0.35 : 0.15;
    if (!r.chance(0.35 + dense * 0.6)) continue;
    const bright = () => r.range(2.2, 4.5);
    const flick = () => (r.chance(0.06) ? 2 : r.chance(0.15) ? 1 : 0);
    // shop sign above the ground floor
    if (f.shop && f.height > 6 && r.chance(0.85)) {
      const cell = atlas.pick('h', r);
      const c = atlas.cells[cell];
      const w = Math.min(f.width * r.range(0.4, 0.75), 11);
      const h = w / c.aspect;
      const pos = f.pos.clone().addScaledVector(f.normal, 0.2).addScaledVector(f.along, r.range(-0.2, 0.2) * f.width);
      pos.y += 4.0 + h / 2;
      out.push({ cell, pos, normal: f.normal.clone(), up, width: w, height: h, color: new THREE.Color(1, 1, 1).multiplyScalar(bright()), flicker: flick(), phase: r.next() });
    }
    // vertical blade signs perpendicular to the facade, visible down the street
    if (f.height > 12 && r.chance(0.35 + dense * 0.55)) {
      const nBlades = f.zone === 'downtown' && r.chance(0.4) ? 2 : 1;
      for (let b = 0; b < nBlades; b++) {
        const cell = atlas.pick('v', r);
        const h = Math.min(r.range(5, 10), f.height - 7);
        if (h < 3) continue;
        const w = h * 0.25;
        const endSign = b === 0 ? -1 : 1;
        const base = f.pos.clone().addScaledVector(f.along, endSign * (f.width * 0.5 - 1.0)).addScaledVector(f.normal, w / 2 + 0.4);
        base.y += r.range(5.5, Math.max(6, f.height - h - 1)) + h / 2;
        // two quads back to back so text reads from both directions
        for (const dir of [1, -1]) {
          out.push({ cell, pos: base.clone().addScaledVector(f.along, dir * 0.06), normal: f.along.clone().multiplyScalar(-dir), up, width: w, height: h, color: new THREE.Color(1, 1, 1).multiplyScalar(bright()), flicker: flick(), phase: r.next() });
        }
      }
    }
    // rooftop billboard
    if (f.height > 14 && f.height < 70 && r.chance(0.12 + dense * 0.15)) {
      const cell = atlas.pick('b', r);
      const w = Math.min(f.width * 0.9, r.range(12, 22));
      const h = w / 2;
      const pos = f.pos.clone().addScaledVector(f.normal, -1.5);
      pos.y += f.height + h / 2 + 1.2;
      out.push({ cell, pos, normal: f.normal.clone(), up, width: w, height: h, color: new THREE.Color(1, 1, 1).multiplyScalar(r.range(1.6, 2.6)), flicker: 0, phase: r.next() });
    }
    // small icon signs
    if (f.shop && r.chance(0.18 * dense)) {
      const icons = atlas.cells.map((c, i) => (c.aspect === 1 ? i : -1)).filter((i) => i >= 0);
      const cell = r.pick(icons);
      const s = r.range(1.4, 2.4);
      const pos = f.pos.clone().addScaledVector(f.normal, 0.25).addScaledVector(f.along, (r.chance(0.5) ? -1 : 1) * f.width * 0.35);
      pos.y += r.range(6, 9);
      out.push({ cell, pos, normal: f.normal.clone(), up, width: s, height: s, color: new THREE.Color(1, 1, 1).multiplyScalar(bright()), flicker: flick(), phase: r.next() });
    }
  }
  return out;
}

export function buildSignMesh(atlas: NeonAtlas, signs: SignInstance[]): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  const rect = new Float32Array(signs.length * 4);
  const fl = new Float32Array(signs.length * 2);
  const mat = new THREE.MeshBasicMaterial({
    map: atlas.texture,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    fog: true,
  });
  applyPatches(mat, [
    {
      key: 'neon',
      uniforms: { uTime: worldUniforms.uTime },
      vertexHeader: 'attribute vec4 aRect; attribute vec2 aFlick; uniform float uTime; varying float vFl;',
      vertex: [
        {
          after: 'uv_vertex',
          code: /* glsl */ `
          vMapUv = aRect.xy + uv * aRect.zw;
          float ph = aFlick.y * 100.0;
          vFl = 1.0;
          if (aFlick.x > 0.5 && aFlick.x < 1.5) vFl = 0.82 + 0.18 * sin(uTime * 37.0 + ph) * sin(uTime * 13.0 + ph * 2.0);
          if (aFlick.x > 1.5) { float k = floor(uTime * 9.0 + ph); vFl = fract(sin(k * 12.9898 + ph) * 43758.5) > 0.82 ? 0.08 : 1.0; }
          `,
        },
      ],
      fragmentHeader: 'varying float vFl;',
      fragment: [{ after: 'map_fragment', code: 'diffuseColor.rgb *= vFl;' }],
    },
  ]);
  const mesh = new THREE.InstancedMesh(geo, mat, signs.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const basis = new THREE.Matrix4();
  const xAxis = new THREE.Vector3();
  const s = new THREE.Vector3();
  signs.forEach((sg, i) => {
    const c = atlas.cells[sg.cell];
    rect.set([c.u, c.v, c.w, c.h], i * 4);
    fl.set([sg.flicker, sg.phase], i * 2);
    xAxis.crossVectors(sg.up, sg.normal).normalize();
    basis.makeBasis(xAxis, sg.up, sg.normal);
    q.setFromRotationMatrix(basis);
    s.set(sg.width, sg.height, 1);
    m.compose(sg.pos, q, s);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, sg.color);
  });
  geo.setAttribute('aRect', new THREE.InstancedBufferAttribute(rect, 4));
  geo.setAttribute('aFlick', new THREE.InstancedBufferAttribute(fl, 2));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.name = 'neonSigns';
  return mesh;
}
