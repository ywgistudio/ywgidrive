import * as THREE from 'three';
import { Rng } from './rng';
import type { Facade } from './City';
import { applyPatches } from './ShaderPatch';
import { worldUniforms } from './TrackMaterials';

/**
 * Real-world night signage drawn with Canvas2D at load: backlit lightboxes and channel-letter
 * fascias for ordinary businesses, blade signs, corporate tower lettering, billboards, bus-stop
 * posters and small icon signs (pharmacy cross, parking, exit...). All brands are fictional.
 * Everything is packed into one atlas and drawn as a single instanced, additive mesh.
 */

export type SignKind = 'h' | 'c' | 'v' | 'b' | 'p' | 'i' | 'd';
export interface Cell {
  kind: SignKind;
  name: string;
  u: number;
  v: number;
  w: number;
  h: number; // uv rect
  aspect: number; // world width / height
}

const W = 2048;
const H = 2560;

const SANS = 'Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif';
const COND = '"Arial Narrow", "Helvetica Neue", Arial, "DejaVu Sans Condensed", sans-serif';
const SERIF = 'Georgia, "Times New Roman", "DejaVu Serif", serif';
const SCRIPT = '"Brush Script MT", "Segoe Script", cursive';

type Ctx = CanvasRenderingContext2D;

function fitFont(ctx: Ctx, text: string, weight: string, size: number, family: string, maxW: number) {
  let sz = size;
  ctx.font = `${weight} ${sz}px ${family}`;
  while (ctx.measureText(text).width > maxW && sz > 8) {
    sz -= 2;
    ctx.font = `${weight} ${sz}px ${family}`;
  }
  return sz;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Backlit acrylic panel: evenly lit face with a soft hot-spot, slightly darker frame edge. */
function lightbox(ctx: Ctx, x: number, y: number, w: number, h: number, face: string, r = 6) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = face;
  ctx.fill();
  const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) * 0.6);
  g.addColorStop(0, 'rgba(255,255,255,0.10)');
  g.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();
  ctx.restore();
}

/** Front-lit channel letters: solid lit letters with only a faint diffusion halo. */
function channel(ctx: Ctx, text: string, cx: number, cy: number, maxW: number, size: number, color: string, family = SANS, weight = 'bold') {
  fitFont(ctx, text, weight, size, family, maxW);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.12;
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

/** Halo-lit (reverse channel) letters: glow on the wall behind dark letter faces. */
function halo(ctx: Ctx, text: string, cx: number, cy: number, maxW: number, size: number, color: string, family = SANS, weight = 'bold') {
  fitFont(ctx, text, weight, size, family, maxW);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.35;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.fillText(text, cx, cy);
  ctx.restore();
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.92)';
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

function text(ctx: Ctx, t: string, x: number, y: number, maxW: number, size: number, color: string, family = SANS, weight = 'bold', align: CanvasTextAlign = 'center') {
  fitFont(ctx, t, weight, size, family, maxW);
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(t, x, y);
}

function cross(ctx: Ctx, cx: number, cy: number, s: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(cx - s * 0.18, cy - s * 0.5, s * 0.36, s);
  ctx.fillRect(cx - s * 0.5, cy - s * 0.18, s, s * 0.36);
}

// ----------------------------------------------------------------------------------------- content

const FASCIAS: { name: string; draw: (ctx: Ctx, x: number, y: number, w: number, h: number) => void }[] = [
  { name: 'pharmacy', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 14, w - 12, h - 28, '#f4f6f2'); cross(c, x + 58, y + h / 2, 62, '#1c9a4c'); text(c, 'PHARMACY', x + w / 2 + 34, y + h / 2 + 2, w - 150, 64, '#127a3a'); } },
  { name: 'diner', draw: (c, x, y, w, h) => { channel(c, 'Rosie’s Diner', x + w / 2, y + h / 2, w - 40, 78, '#ff3b30', SCRIPT, 'bold'); } },
  { name: 'hotel', draw: (c, x, y, w, h) => { channel(c, 'HOTEL CARLYLE', x + w / 2, y + h / 2 + 3, w - 50, 62, '#fff2dc', SERIF, 'normal'); } },
  { name: 'bank', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 16, w - 12, h - 32, '#1d4f9e'); text(c, 'FIRST CITY BANK', x + w / 2, y + h / 2 + 2, w - 60, 52, '#ffffff', SANS); } },
  { name: 'market', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 14, w - 12, h - 28, '#d8262c'); text(c, '24H MARKET', x + w / 2, y + h / 2 + 2, w - 60, 68, '#ffffff', COND); } },
  { name: 'bar', draw: (c, x, y, w, h) => { halo(c, 'THE ANCHOR', x + w / 2, y + h / 2, w - 60, 66, '#ffb35c', SERIF, 'bold'); } },
  { name: 'parking', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 14, w - 12, h - 28, '#1e5bc6'); c.fillStyle = '#fff'; roundRect(c, x + 22, y + 24, 80, 80, 8); c.fill(); text(c, 'P', x + 62, y + 66, 70, 72, '#1e5bc6', SANS); text(c, 'PUBLIC PARKING', x + w / 2 + 50, y + h / 2 + 2, w - 160, 46, '#ffffff', SANS); } },
  { name: 'laundry', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 18, w - 12, h - 36, '#f2f0ea'); text(c, 'COIN LAUNDRY', x + w / 2, y + h / 2 + 2, w - 60, 52, '#1d7c8c', SANS); } },
  { name: 'optician', draw: (c, x, y, w, h) => { channel(c, 'OPTICIAN', x + w / 2, y + h / 2 + 2, w - 80, 60, '#e9f2ff', SANS, '300'); } },
  { name: 'bakery', draw: (c, x, y, w, h) => { halo(c, 'Main St. Bakery', x + w / 2, y + h / 2, w - 50, 60, '#ffd9a0', SERIF, 'italic bold'); } },
  { name: 'deli', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 14, w - 12, h - 28, '#f6e7c1'); text(c, 'GOLDMAN’S DELI', x + w / 2, y + h / 2 + 2, w - 60, 52, '#7a1c14', SERIF); } },
  { name: 'books', draw: (c, x, y, w, h) => { channel(c, 'BOOKS', x + w / 2, y + h / 2 + 2, w - 120, 70, '#fff6e6', SERIF, 'normal'); } },
  { name: 'barber', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 18, w - 12, h - 36, '#151515'); text(c, 'BARBER', x + w / 2, y + h / 2 + 2, w - 60, 54, '#f0f0f0', COND); } },
  { name: 'coffee', draw: (c, x, y, w, h) => { halo(c, 'brewd coffee', x + w / 2, y + h / 2, w - 40, 64, '#ffffff', SANS, '300'); } },
  { name: 'cleaners', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 18, w - 12, h - 36, '#ffffff'); text(c, 'DRY CLEANERS', x + w / 2, y + h / 2 + 2, w - 60, 50, '#2a2a7a', SANS); } },
  { name: 'hardware', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 14, w - 12, h - 28, '#f2b01e'); text(c, 'HARDWARE', x + w / 2, y + h / 2 + 2, w - 60, 66, '#151515', COND); } },
  { name: 'liquor', draw: (c, x, y, w, h) => { channel(c, 'LIQUOR', x + w / 2, y + h / 2 + 2, w - 140, 66, '#ff4a3d', SANS); } },
  { name: 'pizza', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 14, w - 12, h - 28, '#fbf6ea'); text(c, 'LUIGI’S PIZZA', x + w / 2, y + h / 2 + 2, w - 60, 56, '#b81d1d', SERIF, 'bold'); } },
  { name: 'fitness', draw: (c, x, y, w, h) => { channel(c, 'IRONWORKS GYM', x + w / 2, y + h / 2 + 2, w - 60, 54, '#e6ecf2', COND); } },
  { name: 'dental', draw: (c, x, y, w, h) => { lightbox(c, x + 6, y + 18, w - 12, h - 36, '#e7f3f6'); text(c, 'CITY DENTAL', x + w / 2, y + h / 2 + 2, w - 60, 50, '#16718a', SANS); } },
];

const CORPORATE: [string, string, string][] = [
  ['MERIDIAN', '#ffffff', SANS],
  ['HALDEN', '#fff3e0', SERIF],
  ['NORTHWIND', '#dfeaff', SANS],
  ['ARCADIA LIFE', '#ffffff', SANS],
  ['KESTREL', '#ff3b30', SANS],
  ['VANTAGE', '#2f7bff', SANS],
  ['CALDER & CO', '#fff0d8', SERIF],
  ['OAKMONT', '#ffffff', COND],
];

const DOCKS = ['PIER 7', 'LOGISTICS', 'CUSTOMS', 'COLD STORAGE', 'DRY DOCK 3', 'GATE 4', 'BERTH 12', 'FREIGHT'];

interface Ad {
  name: string;
  draw: (ctx: Ctx, x: number, y: number, w: number, h: number, portrait: boolean) => void;
}

function grad(ctx: Ctx, x: number, y: number, w: number, h: number, a: string, b: string, vertical = true) {
  const g = vertical ? ctx.createLinearGradient(x, y, x, y + h) : ctx.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

function carSilhouette(ctx: Ctx, x: number, y: number, s: number, body: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-1.0, 0.05);
  ctx.bezierCurveTo(-1.0, -0.12, -0.9, -0.16, -0.62, -0.2);
  ctx.bezierCurveTo(-0.42, -0.42, -0.1, -0.46, 0.15, -0.42);
  ctx.bezierCurveTo(0.42, -0.36, 0.55, -0.22, 0.86, -0.18);
  ctx.bezierCurveTo(1.0, -0.15, 1.02, -0.05, 1.0, 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(20,24,30,0.9)';
  ctx.beginPath();
  ctx.moveTo(-0.5, -0.22);
  ctx.bezierCurveTo(-0.32, -0.38, -0.05, -0.4, 0.15, -0.37);
  ctx.lineTo(0.38, -0.22);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#0b0b0d';
  for (const wx of [-0.62, 0.62]) {
    ctx.beginPath();
    ctx.arc(wx, 0.05, 0.17, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(-0.9, -0.1, 1.75, 0.012);
  ctx.restore();
}

const ADS: Ad[] = [
  {
    name: 'car',
    draw: (c, x, y, w, h, p) => {
      grad(c, x, y, w, h, '#2a2d33', '#07080a');
      carSilhouette(c, x + w * 0.5, y + h * (p ? 0.62 : 0.68), (p ? w : h) * (p ? 0.42 : 0.6), '#b9bec6');
      text(c, 'AURELIA GT', x + (p ? w / 2 : 26), y + h * (p ? 0.16 : 0.2), w * 0.8, p ? 40 : 52, '#ffffff', SANS, 'bold', p ? 'center' : 'left');
      text(c, 'Every road. Every night.', x + (p ? w / 2 : 28), y + h * (p ? 0.27 : 0.36), w * 0.8, p ? 18 : 22, '#c9cdd4', SANS, 'normal', p ? 'center' : 'left');
    },
  },
  {
    name: 'phone',
    draw: (c, x, y, w, h, p) => {
      grad(c, x, y, w, h, '#eef0f2', '#c7cbd1');
      const pw = p ? w * 0.36 : h * 0.42, ph = pw * 2.0;
      const px = x + (p ? w / 2 - pw / 2 : w * 0.66), py = y + (p ? h * 0.32 : h * 0.5 - ph / 2);
      roundRect(c, px, py, pw, Math.min(ph, h * 0.9), pw * 0.16);
      c.fillStyle = '#16181c';
      c.fill();
      const g = c.createLinearGradient(px, py, px + pw, py + ph);
      g.addColorStop(0, '#203a5c');
      g.addColorStop(1, '#0d1420');
      c.fillStyle = g;
      roundRect(c, px + 5, py + 5, pw - 10, Math.min(ph, h * 0.9) - 10, pw * 0.13);
      c.fill();
      text(c, 'LUMEN X', x + (p ? w / 2 : 30), y + h * (p ? 0.12 : 0.36), w * 0.6, p ? 40 : 56, '#111317', SANS, 'bold', p ? 'center' : 'left');
      text(c, 'See more in the dark.', x + (p ? w / 2 : 32), y + h * (p ? 0.22 : 0.56), w * 0.6, p ? 17 : 22, '#41464e', SANS, 'normal', p ? 'center' : 'left');
    },
  },
  {
    name: 'watch',
    draw: (c, x, y, w, h, p) => {
      grad(c, x, y, w, h, '#14110d', '#050403');
      const r = (p ? w : h) * (p ? 0.3 : 0.32);
      const cx = x + (p ? w / 2 : w * 0.72), cy = y + (p ? h * 0.58 : h / 2);
      c.strokeStyle = '#c9a25a';
      c.lineWidth = r * 0.12;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = '#1b2230';
      c.beginPath();
      c.arc(cx, cy, r * 0.92, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = '#e8e1d0';
      c.lineWidth = r * 0.05;
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + r * 0.45, cy - r * 0.35);
      c.moveTo(cx, cy);
      c.lineTo(cx - r * 0.12, cy - r * 0.7);
      c.stroke();
      text(c, 'HALDEN', x + (p ? w / 2 : 34), y + h * (p ? 0.13 : 0.42), w * 0.55, p ? 40 : 54, '#e9dcc0', SERIF, 'normal', p ? 'center' : 'left');
      text(c, 'Time, refined.', x + (p ? w / 2 : 36), y + h * (p ? 0.23 : 0.62), w * 0.55, p ? 17 : 22, '#a8977a', SERIF, 'italic', p ? 'center' : 'left');
    },
  },
  {
    name: 'airline',
    draw: (c, x, y, w, h, p) => {
      grad(c, x, y, w, h, '#2b5c8f', '#e9a868');
      c.save();
      c.translate(x + w * 0.6, y + h * (p ? 0.5 : 0.42));
      c.rotate(-0.18);
      c.fillStyle = '#ffffff';
      const s = (p ? w : h) * 0.5;
      c.beginPath();
      c.ellipse(0, 0, s * 0.55, s * 0.06, 0, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.moveTo(-s * 0.05, 0);
      c.lineTo(-s * 0.3, s * 0.35);
      c.lineTo(-s * 0.18, s * 0.35);
      c.lineTo(s * 0.12, 0);
      c.fill();
      c.beginPath();
      c.moveTo(-s * 0.45, 0);
      c.lineTo(-s * 0.6, -s * 0.2);
      c.lineTo(-s * 0.52, -s * 0.2);
      c.lineTo(-s * 0.35, 0);
      c.fill();
      c.restore();
      text(c, 'NORTHWIND AIR', x + (p ? w / 2 : 28), y + h * (p ? 0.14 : 0.74), w * 0.8, p ? 30 : 44, '#ffffff', SANS, 'bold', p ? 'center' : 'left');
      text(c, 'Nonstop to 40 cities', x + (p ? w / 2 : 30), y + h * (p ? 0.85 : 0.88), w * 0.8, p ? 17 : 20, '#fff6ea', SANS, 'normal', p ? 'center' : 'left');
    },
  },
  {
    name: 'bank',
    draw: (c, x, y, w, h, p) => {
      c.fillStyle = '#f5f6f8';
      c.fillRect(x, y, w, h);
      c.fillStyle = '#123a7a';
      c.fillRect(x, y + h * (p ? 0.7 : 0.66), w, h * 0.34);
      text(c, 'MERIDIAN', x + w / 2, y + h * (p ? 0.3 : 0.32), w * 0.8, p ? 40 : 60, '#123a7a', SANS, 'bold');
      text(c, 'Banking that never closes.', x + w / 2, y + h * (p ? 0.85 : 0.83), w * 0.85, p ? 16 : 22, '#ffffff', SANS, 'normal');
    },
  },
  {
    name: 'coffee',
    draw: (c, x, y, w, h, p) => {
      grad(c, x, y, w, h, '#4a2e1c', '#1d120b');
      const cx = x + (p ? w / 2 : w * 0.74), cy = y + h * (p ? 0.6 : 0.56);
      const s = (p ? w : h) * 0.3;
      c.fillStyle = '#f2ece2';
      c.beginPath();
      c.moveTo(cx - s * 0.5, cy - s * 0.5);
      c.lineTo(cx + s * 0.5, cy - s * 0.5);
      c.lineTo(cx + s * 0.38, cy + s * 0.55);
      c.lineTo(cx - s * 0.38, cy + s * 0.55);
      c.fill();
      c.fillStyle = '#9b6a43';
      c.fillRect(cx - s * 0.45, cy - s * 0.1, s * 0.9, s * 0.25);
      text(c, 'brewd', x + (p ? w / 2 : 34), y + h * (p ? 0.15 : 0.36), w * 0.6, p ? 44 : 64, '#f2ece2', SANS, '300', p ? 'center' : 'left');
      text(c, 'Open late downtown', x + (p ? w / 2 : 36), y + h * (p ? 0.26 : 0.6), w * 0.6, p ? 16 : 22, '#d6b894', SANS, 'normal', p ? 'center' : 'left');
    },
  },
  {
    name: 'insurance',
    draw: (c, x, y, w, h, p) => {
      grad(c, x, y, w, h, '#0f6b6b', '#0a3d45');
      text(c, 'KESTREL', x + (p ? w / 2 : 30), y + h * (p ? 0.3 : 0.36), w * 0.8, p ? 40 : 58, '#ffffff', SANS, 'bold', p ? 'center' : 'left');
      text(c, 'INSURANCE', x + (p ? w / 2 : 32), y + h * (p ? 0.4 : 0.56), w * 0.8, p ? 20 : 24, '#bfe6e3', SANS, 'normal', p ? 'center' : 'left');
      text(c, 'Drive safe. We’ve got you.', x + (p ? w / 2 : 32), y + h * (p ? 0.82 : 0.8), w * 0.85, p ? 15 : 20, '#e9f6f4', SANS, 'italic', p ? 'center' : 'left');
    },
  },
  {
    name: 'film',
    draw: (c, x, y, w, h, p) => {
      grad(c, x, y, w, h, '#11151c', '#020203');
      // figure silhouette against a lit window
      c.fillStyle = '#c98a3a';
      c.fillRect(x + w * 0.58, y + h * 0.12, w * (p ? 0.3 : 0.2), h * 0.5);
      c.fillStyle = '#0a0b0d';
      c.beginPath();
      c.arc(x + w * (p ? 0.73 : 0.68), y + h * 0.3, h * 0.07, 0, Math.PI * 2);
      c.fill();
      c.fillRect(x + w * (p ? 0.67 : 0.64), y + h * 0.36, w * (p ? 0.12 : 0.08), h * 0.3);
      text(c, 'NIGHTSHIFT', x + (p ? w / 2 : 30), y + h * (p ? 0.75 : 0.42), w * 0.85, p ? 34 : 54, '#f2f2f2', COND, 'bold', p ? 'center' : 'left');
      text(c, 'IN THEATERS FRIDAY', x + (p ? w / 2 : 32), y + h * (p ? 0.86 : 0.62), w * 0.8, p ? 14 : 18, '#a8adb6', SANS, 'normal', p ? 'center' : 'left');
    },
  },
];

const BLADES: { name: string; draw: (ctx: Ctx, x: number, y: number, w: number, h: number) => void }[] = [
  { name: 'hotel', draw: (c, x, y, w, h) => stacked(c, 'HOTEL', x, y, w, h, '#fff1d6', '#000', 'channel') },
  { name: 'cinema', draw: (c, x, y, w, h) => { bulbs(c, x + 8, y + 8, w - 16, h - 16, '#ffd59a'); stacked(c, 'CINEMA', x + 6, y + 10, w - 12, h - 20, '#fff6ea', '#000', 'channel'); } },
  { name: 'parking', draw: (c, x, y, w, h) => { lightbox(c, x + 10, y + 8, w - 20, h - 16, '#1e5bc6', 8); stacked(c, 'PARKING', x + 10, y + 12, w - 20, h - 24, '#ffffff', null, 'plain'); } },
  { name: 'bar', draw: (c, x, y, w, h) => stacked(c, 'BAR', x, y + h * 0.18, w, h * 0.64, '#ff5a3c', null, 'channel') },
  { name: 'diner', draw: (c, x, y, w, h) => { lightbox(c, x + 10, y + 8, w - 20, h - 16, '#f4efe4', 8); stacked(c, 'DINER', x + 10, y + 12, w - 20, h - 24, '#c8201c', null, 'plain'); } },
  { name: 'open24', draw: (c, x, y, w, h) => { lightbox(c, x + 10, y + 8, w - 20, h - 16, '#cf1f25', 8); stacked(c, 'OPEN24', x + 10, y + 12, w - 20, h - 24, '#ffffff', null, 'plain'); } },
  { name: 'pharmacy', draw: (c, x, y, w, h) => { lightbox(c, x + 10, y + 8, w - 20, h - 16, '#f4f6f2', 8); cross(c, x + w / 2, y + 70, 70, '#1c9a4c'); stacked(c, 'RX', x + 10, y + 130, w - 20, h - 150, '#127a3a', null, 'plain'); } },
  { name: 'theatre', draw: (c, x, y, w, h) => { bulbs(c, x + 8, y + 8, w - 16, h - 16, '#fff0d0'); stacked(c, 'ROXY', x + 6, y + 30, w - 12, h - 60, '#ffe2b0', '#000', 'channel'); } },
];

function stacked(ctx: Ctx, word: string, x: number, y: number, w: number, h: number, color: string, _bg: string | null, mode: 'channel' | 'plain') {
  const n = word.length;
  const cellH = h / n;
  const size = Math.min(cellH * 0.82, w * 0.78);
  for (let i = 0; i < n; i++) {
    const cy = y + cellH * (i + 0.5) + 2;
    if (mode === 'channel') channel(ctx, word[i], x + w / 2, cy, w * 0.85, size, color, SANS, 'bold');
    else text(ctx, word[i], x + w / 2, cy, w * 0.85, size, color, SANS, 'bold');
  }
}

function bulbs(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 5;
  const step = 16;
  for (let px = x; px <= x + w; px += step) {
    for (const py of [y, y + h]) {
      ctx.beginPath();
      ctx.arc(px, py, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (let py = y + step; py < y + h; py += step) {
    for (const px of [x, x + w]) {
      ctx.beginPath();
      ctx.arc(px, py, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

const ICONS: { name: string; draw: (ctx: Ctx, cx: number, cy: number, s: number) => void }[] = [
  { name: 'cross', draw: (c, cx, cy, s) => { c.save(); c.shadowColor = '#2bd66b'; c.shadowBlur = 10; cross(c, cx, cy, s * 1.5, '#2bd66b'); c.restore(); } },
  { name: 'p', draw: (c, cx, cy, s) => { lightbox(c, cx - s * 0.8, cy - s * 0.8, s * 1.6, s * 1.6, '#1e5bc6', 12); text(c, 'P', cx, cy + 4, s * 1.4, s * 1.4, '#ffffff', SANS, 'bold'); } },
  { name: 'atm', draw: (c, cx, cy, s) => { lightbox(c, cx - s * 0.9, cy - s * 0.5, s * 1.8, s, '#1b7f4a', 8); text(c, 'ATM', cx, cy + 3, s * 1.6, s * 0.7, '#ffffff', SANS, 'bold'); } },
  { name: 'bus', draw: (c, cx, cy, s) => { c.fillStyle = '#f4f4f0'; c.beginPath(); c.arc(cx, cy, s * 0.85, 0, Math.PI * 2); c.fill(); c.fillStyle = '#1b4fa0'; c.beginPath(); c.arc(cx, cy, s * 0.72, 0, Math.PI * 2); c.fill(); text(c, 'BUS', cx, cy + 3, s * 1.2, s * 0.55, '#ffffff', SANS, 'bold'); } },
  {
    name: 'exit',
    draw: (c, cx, cy, s) => {
      lightbox(c, cx - s * 0.9, cy - s * 0.55, s * 1.8, s * 1.1, '#14a04a', 6);
      // running figure + door
      c.fillStyle = '#ffffff';
      c.fillRect(cx + s * 0.3, cy - s * 0.38, s * 0.42, s * 0.76);
      c.fillStyle = '#14a04a';
      c.fillRect(cx + s * 0.38, cy - s * 0.3, s * 0.26, s * 0.68);
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(cx - s * 0.2, cy - s * 0.28, s * 0.09, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = '#ffffff';
      c.lineWidth = s * 0.09;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(cx - s * 0.24, cy - s * 0.16);
      c.lineTo(cx - s * 0.3, cy + s * 0.12);
      c.lineTo(cx - s * 0.5, cy + s * 0.36);
      c.moveTo(cx - s * 0.3, cy + s * 0.12);
      c.lineTo(cx - s * 0.08, cy + s * 0.36);
      c.moveTo(cx - s * 0.5, cy - s * 0.06);
      c.lineTo(cx - s * 0.24, cy - s * 0.12);
      c.lineTo(cx - s * 0.02, cy - s * 0.02);
      c.stroke();
    },
  },
  { name: 'open', draw: (c, cx, cy, s) => { c.save(); c.strokeStyle = '#ff3b30'; c.shadowColor = '#ff3b30'; c.shadowBlur = 8; c.lineWidth = 5; roundRect(c, cx - s * 0.95, cy - s * 0.45, s * 1.9, s * 0.9, 18); c.stroke(); c.shadowBlur = 6; text(c, 'OPEN', cx, cy + 3, s * 1.6, s * 0.62, '#ff4a3d', SANS, 'bold'); c.restore(); } },
  { name: 'cup', draw: (c, cx, cy, s) => { lightbox(c, cx - s * 0.8, cy - s * 0.8, s * 1.6, s * 1.6, '#2a1a10', 80); c.fillStyle = '#f2ece2'; c.fillRect(cx - s * 0.35, cy - s * 0.3, s * 0.6, s * 0.6); c.strokeStyle = '#f2ece2'; c.lineWidth = s * 0.08; c.beginPath(); c.arc(cx + s * 0.3, cy, s * 0.17, -1.2, 1.2); c.stroke(); } },
  {
    name: 'fuel',
    draw: (c, cx, cy, s) => {
      lightbox(c, cx - s * 0.65, cy - s * 0.95, s * 1.3, s * 1.9, '#f2f2f0', 6);
      c.fillStyle = '#c4161c';
      c.fillRect(cx - s * 0.65, cy - s * 0.95, s * 1.3, s * 0.5);
      text(c, 'FUEL', cx, cy - s * 0.7, s * 1.1, s * 0.36, '#ffffff', SANS, 'bold');
      text(c, '3.89', cx, cy - s * 0.12, s * 1.1, s * 0.42, '#151515', SANS, 'bold');
      text(c, '4.19', cx, cy + s * 0.48, s * 1.1, s * 0.42, '#151515', SANS, 'bold');
    },
  },
];

export class SignAtlas {
  readonly texture: THREE.CanvasTexture;
  readonly cells: Cell[] = [];

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const add = (kind: SignKind, name: string, x: number, y: number, w: number, h: number, aspect: number, draw: () => void) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      draw();
      ctx.restore();
      this.cells.push({ kind, name, u: x / W, v: 1 - (y + h) / H, w: w / W, h: h / H, aspect });
    };

    // fascias 512x128 (5 rows of 4) at y 0..640
    FASCIAS.forEach((f, k) => {
      const x = (k % 4) * 512, y = Math.floor(k / 4) * 128;
      add('h', f.name, x, y, 512, 128, 4, () => f.draw(ctx, x, y, 512, 128));
    });
    // corporate channel letters 512x128 at y 640..896
    CORPORATE.forEach(([name, col, fam], k) => {
      const x = (k % 4) * 512, y = 640 + Math.floor(k / 4) * 128;
      add('c', name, x, y, 512, 128, 4, () => channel(ctx, name, x + 256, y + 66, 470, 82, col, fam, fam === SERIF ? 'normal' : 'bold'));
    });
    // dock lightboxes 512x128 at y 896..1152
    DOCKS.forEach((word, k) => {
      const x = (k % 4) * 512, y = 896 + Math.floor(k / 4) * 128;
      add('d', word, x, y, 512, 128, 4, () => {
        const safety = k % 3 === 0;
        lightbox(ctx, x + 8, y + 16, 496, 96, safety ? '#f2c21b' : '#eef1f4', 4);
        text(ctx, word, x + 256, y + 66, 460, 66, safety ? '#151515' : '#0d2a55', COND, 'bold');
      });
    });
    // blade signs 128x512 at y 1152..1664, x 0..1024
    BLADES.forEach((b, k) => {
      const x = k * 128, y = 1152;
      add('v', b.name, x, y, 128, 512, 0.25, () => b.draw(ctx, x, y, 128, 512));
    });
    // bus-stop posters 192x288 at x 1024.., y 1152..1728 (5 per row)
    ADS.forEach((ad, k) => {
      const x = 1024 + (k % 5) * 204, y = 1152 + Math.floor(k / 5) * 290;
      add('p', ad.name, x, y, 192, 288, 192 / 288, () => ad.draw(ctx, x, y, 192, 288, true));
    });
    // billboards 512x256 at y 1728..2240
    ADS.forEach((ad, k) => {
      const x = (k % 4) * 512, y = 1728 + Math.floor(k / 4) * 256;
      add('b', ad.name, x, y, 512, 256, 2, () => {
        ad.draw(ctx, x + 6, y + 6, 500, 244, false);
        ctx.strokeStyle = '#0b0b0b';
        ctx.lineWidth = 6;
        ctx.strokeRect(x + 3, y + 3, 506, 250);
      });
    });
    // icons 256x256 at y 2240..2496
    ICONS.forEach((ic, k) => {
      const x = k * 256, y = 2240;
      add('i', ic.name, x, y, 256, 256, 1, () => ic.draw(ctx, x + 128, y + 128, 90));
    });

    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  pick(kind: SignKind, r: Rng): number {
    const idx = this.cells.map((c, i) => (c.kind === kind ? i : -1)).filter((i) => i >= 0);
    return r.pick(idx);
  }

  byName(kind: SignKind, name: string): number {
    return this.cells.findIndex((c) => c.kind === kind && c.name === name);
  }
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

const UPV = new THREE.Vector3(0, 1, 0);

/** Choose sign placements on road-facing facades. Restrained: a real street, not a casino strip. */
export function placeSigns(atlas: SignAtlas, facades: Facade[], seed = 77): SignInstance[] {
  const r = new Rng(seed);
  const out: SignInstance[] = [];
  const white = (k: number) => new THREE.Color(1, 1, 1).multiplyScalar(k);
  const flick = () => (r.chance(0.015) ? 2 : r.chance(0.03) ? 1 : 0);
  for (const f of facades) {
    if ((f.zone === 'docks' || f.zone === 'harbor') && f.height > 8 && f.height < 20 && r.chance(0.55)) {
      const w = Math.min(f.width * 0.5, 12);
      const h = w / 4;
      const pos = f.pos.clone().addScaledVector(f.normal, 0.2);
      pos.y += f.height - h / 2 - 1.2;
      out.push({ cell: atlas.pick('d', r), pos, normal: f.normal.clone(), up: UPV, width: w, height: h, color: white(r.range(0.9, 1.3)), flicker: r.chance(0.08) ? 2 : 0, phase: r.next() });
      if (f.zone === 'docks') continue;
    }
    // ground-floor business fascia: most shops have one; many are switched off after closing
    if (f.shop && f.height > 6 && r.chance(0.8)) {
      const c = atlas.cells[atlas.pick('h', r)];
      const cell = atlas.cells.indexOf(c);
      const w = Math.min(f.width * r.range(0.35, 0.6), 7.5);
      const h = w / c.aspect;
      const pos = f.pos.clone().addScaledVector(f.normal, 0.15).addScaledVector(f.along, r.range(-0.18, 0.18) * f.width);
      pos.y += 3.85 + h / 2;
      const on = r.chance(0.72);
      out.push({ cell, pos, normal: f.normal.clone(), up: UPV, width: w, height: h, color: white(on ? r.range(1.0, 1.6) : 0.06), flicker: flick(), phase: r.next() });
    }
    // small icon by the door (pharmacy cross, ATM, OPEN...)
    if (f.shop && r.chance(0.16)) {
      const name = r.pick(['cross', 'atm', 'open', 'open', 'cup', 'p']);
      const cell = atlas.byName('i', name);
      const s = name === 'cross' ? r.range(1.1, 1.5) : r.range(0.8, 1.2);
      const pos = f.pos.clone().addScaledVector(f.normal, name === 'cross' ? 0.6 : 0.12).addScaledVector(f.along, (r.chance(0.5) ? -1 : 1) * f.width * 0.38);
      pos.y += name === 'cross' ? r.range(4.6, 6) : r.range(1.8, 2.6);
      out.push({ cell, pos, normal: f.normal.clone(), up: UPV, width: s, height: s, color: white(r.range(1.1, 1.6)), flicker: 0, phase: r.next() });
    }
    const dense = f.zone === 'downtown' ? 1 : f.zone === 'harbor' ? 0.4 : f.zone === 'park' ? 0.3 : 0.1;
    // projecting blade sign: occasional, mostly downtown
    if (f.height > 12 && r.chance(0.12 * dense)) {
      const cell = atlas.pick('v', r);
      const h = Math.min(r.range(4.5, 8), f.height - 7);
      if (h >= 3) {
        const w = h * 0.25;
        const endSign = r.chance(0.5) ? -1 : 1;
        const base = f.pos.clone().addScaledVector(f.along, endSign * (f.width * 0.5 - 1.2)).addScaledVector(f.normal, w / 2 + 0.35);
        base.y += r.range(5.5, Math.max(6, f.height - h - 2)) + h / 2;
        const k = r.range(1.0, 1.5);
        for (const dir of [1, -1]) {
          out.push({ cell, pos: base.clone().addScaledVector(f.along, dir * 0.05), normal: f.along.clone().multiplyScalar(-dir), up: UPV, width: w, height: h, color: white(k), flicker: flick(), phase: r.next() });
        }
      }
    }
    // corporate lettering near the top of office towers
    if (f.height > 45 && r.chance(0.3 * dense + 0.05)) {
      const cell = atlas.pick('c', r);
      const w = Math.min(f.width * r.range(0.55, 0.8), 22);
      const h = w / 4;
      const pos = f.pos.clone().addScaledVector(f.normal, 0.3);
      pos.y += f.height - h / 2 - r.range(1.5, 3.5);
      out.push({ cell, pos, normal: f.normal.clone(), up: UPV, width: w, height: h, color: white(r.range(1.3, 2.0)), flicker: 0, phase: r.next() });
    }
    // rooftop billboard on mid-rise buildings
    if (f.height > 14 && f.height < 45 && r.chance(0.07 + dense * 0.06)) {
      const cell = atlas.pick('b', r);
      const w = Math.min(f.width * 0.85, r.range(12, 16));
      const h = w / 2;
      const pos = f.pos.clone().addScaledVector(f.normal, -1.5);
      pos.y += f.height + h / 2 + 1.6;
      out.push({ cell, pos, normal: f.normal.clone(), up: UPV, width: w, height: h, color: white(r.range(0.9, 1.2)), flicker: 0, phase: r.next() });
    }
  }
  return out;
}

export function buildSignMesh(atlas: SignAtlas, signs: SignInstance[]): THREE.InstancedMesh {
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
      key: 'signs',
      uniforms: { uTime: worldUniforms.uTime },
      vertexHeader: 'attribute vec4 aRect; attribute vec2 aFlick; uniform float uTime; varying float vFl;',
      vertex: [
        {
          after: 'uv_vertex',
          code: /* glsl */ `
          vMapUv = aRect.xy + uv * aRect.zw;
          float ph = aFlick.y * 100.0;
          vFl = 1.0;
          if (aFlick.x > 0.5 && aFlick.x < 1.5) vFl = 0.9 + 0.1 * sin(uTime * 37.0 + ph) * sin(uTime * 13.0 + ph * 2.0);
          if (aFlick.x > 1.5) { float k = floor(uTime * 6.0 + ph); vFl = fract(sin(k * 12.9898 + ph) * 43758.5) > 0.9 ? 0.1 : 1.0; }
          `,
        },
      ],
      fragmentHeader: 'varying float vFl;',
      // signs are emissive surfaces: convert the sRGB artwork to a modest linear radiance
      fragment: [{ after: 'map_fragment', code: 'diffuseColor.rgb *= vFl;' }],
    },
  ]);
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, signs.length));
  mesh.count = signs.length;
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
  mesh.name = 'signs';
  return mesh;
}
