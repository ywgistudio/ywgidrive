import * as THREE from 'three';

function makeCanvas(size: number): [HTMLCanvasElement | OffscreenCanvas, CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D] {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return [c, c.getContext('2d')!];
  }
  const c = new OffscreenCanvas(size, size);
  return [c, c.getContext('2d')!];
}

// small deterministic value noise
function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (a: number) => ((a % period) + period) % period;
  const a = hash(w(xi), w(yi), seed), b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed), d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * Soft smoke puff atlas: 2x2 grid of distinct puffs (fBm noise masked by a radial falloff).
 * R = density, G = "lighting" (denser toward the upper-left to fake self shadowing).
 */
export function createSmokeTexture(size = 256): THREE.Texture {
  const [canvas, ctx] = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  const half = size / 2;
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * half, oy = Math.floor(cell / 2) * half;
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const nx = x / half, ny = y / half;
        const dx = nx - 0.5, dy = ny - 0.5;
        const r = Math.sqrt(dx * dx + dy * dy) * 2;
        let n = 0, amp = 0.5, f = 4, norm = 0;
        for (let o = 0; o < 5; o++) {
          n += valueNoise(nx * f + cell * 17.3, ny * f + cell * 9.1, 1e9, cell * 7 + o) * amp;
          norm += amp;
          amp *= 0.5;
          f *= 2;
        }
        n /= norm;
        const fall = Math.max(0, 1 - r);
        const mask = fall * fall * (3 - 2 * fall);
        const d = Math.max(0, Math.min(1, (n - 0.28) * 1.9)) * mask;
        const light = Math.max(0, Math.min(1, 0.55 + (0.5 - nx) * 0.35 + (0.5 - ny) * 0.45 + (n - 0.5) * 0.6));
        const i = ((oy + y) * size + (ox + x)) * 4;
        img.data[i] = Math.round(d * 255);
        img.data[i + 1] = Math.round(light * 255);
        img.data[i + 2] = 0;
        img.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Radial glow (for flame cores / pops). */
export function createGlowTexture(size = 64): THREE.Texture {
  const [canvas, ctx] = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.65)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
