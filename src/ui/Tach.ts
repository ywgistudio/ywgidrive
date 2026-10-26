// Canvas tachometer: cached static face (dial, ticks, numerals, redline segment) + per-frame rpm arc,
// tip marker and a small shift light. Restrained broadcast style: white on dark glass, amber accent.

const START = Math.PI * (5 / 6); // 150deg: bottom-left
const SWEEP = Math.PI * (4 / 3); // 240deg clockwise, open at the bottom for speed/gear
const SHIFT_SEGS = 5;

const ACCENT = '#ffb400';
const TEXT = 'rgba(244, 242, 238, 0.92)';
const FONT = "'Barlow Condensed', 'Arial Narrow', sans-serif";

export class Tach {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private face: HTMLCanvasElement | null = null;
  private faceKey = '';
  private w = 0;
  private h = 0;
  private dpr = 1;
  private shown = 0; // smoothed rpm

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
    const r = Math.min(w * 0.45, h * 0.47);
    return { cx: w / 2, cy: h * 0.5, r };
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
    const u = r / 100;

    // dark glass dial so the cluster reads on bright frames
    g.fillStyle = 'rgba(14, 15, 17, 0.62)';
    g.beginPath();
    g.arc(cx, cy, r * 1.04, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    g.lineWidth = 1 * u;
    g.beginPath();
    g.arc(cx, cy, r * 1.04, 0, Math.PI * 2);
    g.stroke();

    // rpm track
    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    g.lineWidth = 4.2 * u;
    g.beginPath();
    g.arc(cx, cy, r * 0.88, START, START + SWEEP);
    g.stroke();

    // redline segment (accent), drawn on the outer edge
    const ra = this.angle(redline, max);
    g.strokeStyle = ACCENT;
    g.lineWidth = 2.2 * u;
    g.beginPath();
    g.arc(cx, cy, r * 0.955, ra, START + SWEEP);
    g.stroke();

    // ticks + numerals
    const majors = Math.round(max / 1000);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i <= majors * 2; i++) {
      const rpm = i * 500;
      const a = this.angle(rpm, max);
      const major = i % 2 === 0;
      const red = rpm >= redline;
      const r0 = r * (major ? 0.93 : 0.945);
      const r1 = r * 0.985;
      g.strokeStyle = red ? ACCENT : major ? 'rgba(244, 242, 238, 0.85)' : 'rgba(244, 242, 238, 0.35)';
      g.lineWidth = (major ? 1.6 : 1) * u;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.stroke();
      if (major) {
        const rn = r * 0.72;
        g.fillStyle = red ? ACCENT : 'rgba(244, 242, 238, 0.7)';
        g.font = `600 ${Math.round(10 * u)}px ${FONT}`;
        g.fillText(String(i / 2), cx + Math.cos(a) * rn, cy + Math.sin(a) * rn);
      }
    }
  }

  private shiftLayout() {
    const { cx, cy, r } = this.geometry();
    const segW = r * 0.085;
    const gap = r * 0.022;
    const total = SHIFT_SEGS * segW + (SHIFT_SEGS - 1) * gap;
    return { x0: cx - total / 2, y: cy - r * 0.47, segW, segH: r * 0.028, gap };
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

    this.shown += (rpm - this.shown) * 0.5;
    const val = Math.max(0, this.shown);
    const a = this.angle(val, max);

    // rpm fill: white, turning accent past 92% of redline
    const warn = redline * 0.92;
    g.lineCap = 'butt';
    g.lineWidth = 4.2 * u;
    const aw = this.angle(Math.min(val, warn), max);
    g.strokeStyle = TEXT;
    g.beginPath();
    g.arc(cx, cy, r * 0.88, START, aw);
    g.stroke();
    if (val > warn) {
      g.strokeStyle = ACCENT;
      g.beginPath();
      g.arc(cx, cy, r * 0.88, aw, a);
      g.stroke();
    }

    // tip marker
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    g.strokeStyle = val > warn ? ACCENT : '#ffffff';
    g.lineWidth = 2 * u;
    g.beginPath();
    g.moveTo(cx + ca * r * 0.8, cy + sa * r * 0.8);
    g.lineTo(cx + ca * r * 0.93, cy + sa * r * 0.93);
    g.stroke();

    // shift light: segments fill from 86% of redline; all flash at the limit
    const { x0, y, segW, segH, gap } = this.shiftLayout();
    const start = redline * 0.86;
    const atLimit = rpm >= redline * 0.985;
    const blink = Math.floor(time * 12) % 2 === 0;
    for (let i = 0; i < SHIFT_SEGS; i++) {
      const thr = start + ((redline * 0.985 - start) * i) / SHIFT_SEGS;
      const on = atLimit ? blink : rpm >= thr;
      g.fillStyle = on ? (atLimit || i >= SHIFT_SEGS - 2 ? ACCENT : 'rgba(244, 242, 238, 0.9)') : 'rgba(255, 255, 255, 0.1)';
      g.fillRect(x0 + i * (segW + gap), y - segH / 2, segW, segH);
    }
  }
}
