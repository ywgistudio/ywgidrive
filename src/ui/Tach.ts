// Canvas tachometer: cached static face (ticks, numbers, redline band) + per-frame lit segments,
// needle and shift lights.

const START = Math.PI * 0.75; // 135deg, bottom-left
const SWEEP = Math.PI * 1.5; // 270deg clockwise
const SEGMENTS = 54;
const LEDS = 7;

export class Tach {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private face: HTMLCanvasElement | null = null;
  private faceKey = '';
  private w = 0;
  private h = 0;
  private dpr = 1;
  private shown = 0; // smoothed rpm for the needle

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
    this.invalidate();
  }

  invalidate() {
    this.faceKey = '';
  }

  private geometry() {
    const w = this.w;
    const h = this.h;
    const r = Math.min(w * 0.46, h * 0.56);
    return { cx: w / 2, cy: h * 0.57, r };
  }

  private angle(rpm: number, max: number) {
    return START + SWEEP * Math.min(1, Math.max(0, rpm / max));
  }

  private buildFace(max: number, redline: number) {
    const key = `${this.w}x${this.h}:${max}:${redline}`;
    if (key === this.faceKey && this.face) return;
    this.faceKey = key;
    const c = this.face ?? document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    this.face = c;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    const { cx, cy, r } = this.geometry();
    const u = r / 100; // unit scale

    // glass dial
    const bg = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r * 1.08);
    bg.addColorStop(0, 'rgba(18, 12, 40, 0.78)');
    bg.addColorStop(0.75, 'rgba(8, 6, 22, 0.72)');
    bg.addColorStop(1, 'rgba(8, 6, 22, 0)');
    g.fillStyle = bg;
    g.beginPath();
    g.arc(cx, cy, r * 1.06, 0, Math.PI * 2);
    g.fill();

    // outer rim
    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.lineWidth = 1.2 * u;
    g.beginPath();
    g.arc(cx, cy, r * 1.0, START, START + SWEEP);
    g.stroke();

    // redline band
    const ra = this.angle(redline, max);
    g.strokeStyle = 'rgba(255, 51, 85, 0.85)';
    g.lineWidth = 3.2 * u;
    g.shadowColor = 'rgba(255, 51, 85, 0.9)';
    g.shadowBlur = 8 * u;
    g.beginPath();
    g.arc(cx, cy, r * 0.965, ra, START + SWEEP);
    g.stroke();
    g.shadowBlur = 0;

    // ticks
    const majors = Math.round(max / 1000);
    for (let i = 0; i <= majors * 4; i++) {
      const rpm = (i / 4) * 1000;
      const a = this.angle(rpm, max);
      const major = i % 4 === 0;
      const half = i % 2 === 0;
      const r0 = r * (major ? 0.8 : half ? 0.85 : 0.875);
      const r1 = r * 0.93;
      g.strokeStyle = rpm >= redline ? 'rgba(255, 90, 110, 0.95)' : major ? 'rgba(242, 244, 255, 0.92)' : 'rgba(242, 244, 255, 0.4)';
      g.lineWidth = (major ? 2.4 : 1.2) * u;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.stroke();
      if (major) {
        const rn = r * 0.66;
        g.fillStyle = rpm >= redline ? '#ff5a6e' : 'rgba(242, 244, 255, 0.9)';
        g.font = `italic 700 ${Math.round(10.5 * u)}px Orbitron, 'Chakra Petch', sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(i / 4), cx + Math.cos(a) * rn, cy + Math.sin(a) * rn);
      }
    }

    // caption between the arc ends
    g.fillStyle = 'rgba(214, 220, 255, 0.45)';
    g.font = `700 ${Math.round(6.4 * u)}px 'Chakra Petch', sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText('×1000 RPM', cx - r * 0.72, cy + r * 0.86);

    // led housing
    const { x0, ly, step, lr } = this.ledLayout();
    g.fillStyle = 'rgba(0, 0, 0, 0.35)';
    g.beginPath();
    g.roundRect(x0 - lr * 1.8, ly - lr * 1.7, step * (LEDS - 1) + lr * 3.6, lr * 3.4, lr * 1.7);
    g.fill();
  }

  private ledLayout() {
    const { cx, cy, r } = this.geometry();
    const step = r * 0.13;
    const lr = r * 0.042;
    const x0 = cx - (step * (LEDS - 1)) / 2;
    const ly = cy - r * 0.6;
    return { x0, ly, step, lr };
  }

  draw(rpm: number, redline: number, limiter: number, time: number) {
    if (this.w < 2) this.resize();
    const max = Math.max(1000, Math.ceil((limiter + 200) / 1000) * 1000);
    this.buildFace(max, redline);
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    if (this.face) g.drawImage(this.face, 0, 0);
    const { cx, cy, r } = this.geometry();
    const u = r / 100;

    // smooth the needle a little; real tachs have mass too
    this.shown += (rpm - this.shown) * 0.45;
    const val = this.shown;

    // lit segments
    const gap = (SWEEP / SEGMENTS) * 0.22;
    g.lineWidth = 7.5 * u;
    g.lineCap = 'butt';
    const rs = r * 0.89 - 0.5 * u;
    for (let i = 0; i < SEGMENTS; i++) {
      const f0 = i / SEGMENTS;
      const segRpm = f0 * max;
      const a0 = START + SWEEP * f0 + gap / 2;
      const a1 = START + SWEEP * ((i + 1) / SEGMENTS) - gap / 2;
      const lit = segRpm < val;
      if (lit) {
        g.strokeStyle = segRpm >= redline ? '#ff3355' : segColor(segRpm / redline);
      } else {
        g.strokeStyle = segRpm >= redline ? 'rgba(255, 51, 85, 0.16)' : 'rgba(255, 255, 255, 0.06)';
      }
      g.beginPath();
      g.arc(cx, cy, rs, a0, a1);
      g.stroke();
    }

    // shift lights
    const { x0, ly, step, lr } = this.ledLayout();
    const startLed = redline * 0.8;
    const flashing = rpm >= redline * 0.985;
    const blink = Math.floor(time * 14) % 2 === 0;
    for (let i = 0; i < LEDS; i++) {
      const on = flashing ? blink : rpm >= startLed + ((redline - startLed) * i) / (LEDS - 1);
      const col = flashing ? '#4fd8ff' : i < 2 ? '#3dffa8' : i < 4 ? '#ffb020' : '#ff3355';
      g.beginPath();
      g.arc(x0 + i * step, ly, lr, 0, Math.PI * 2);
      if (on) {
        g.fillStyle = col;
        g.shadowColor = col;
        g.shadowBlur = 10 * u;
      } else {
        g.fillStyle = 'rgba(255, 255, 255, 0.08)';
        g.shadowBlur = 0;
      }
      g.fill();
    }
    g.shadowBlur = 0;

    // needle
    const a = this.angle(val, max);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const n0 = r * 0.16;
    const n1 = r * 0.95;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255, 43, 214, 0.35)';
    g.lineWidth = 7 * u;
    g.beginPath();
    g.moveTo(cx + ca * n0, cy + sa * n0);
    g.lineTo(cx + ca * n1, cy + sa * n1);
    g.stroke();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2.4 * u;
    g.beginPath();
    g.moveTo(cx + ca * n0, cy + sa * n0);
    g.lineTo(cx + ca * n1, cy + sa * n1);
    g.stroke();
    // hub
    g.fillStyle = '#ff2bd6';
    g.beginPath();
    g.arc(cx, cy, 4.2 * u, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0b0818';
    g.beginPath();
    g.arc(cx, cy, 2 * u, 0, Math.PI * 2);
    g.fill();
  }
}

function segColor(f: number): string {
  // cyan -> violet -> pink as rpm approaches redline
  const t = Math.min(1, Math.max(0, f));
  let r: number, gg: number, b: number;
  if (t < 0.6) {
    const k = t / 0.6;
    r = 33 + (138 - 33) * k;
    gg = 230 + (92 - 230) * k;
    b = 255;
  } else {
    const k = (t - 0.6) / 0.4;
    r = 138 + (255 - 138) * k;
    gg = 92 + (43 - 92) * k;
    b = 255 + (214 - 255) * k;
  }
  return `rgb(${r | 0},${gg | 0},${b | 0})`;
}
