// Heading-up circular minimap drawn on a canvas. World convention: car yaw `heading` is
// atan2(forward.x, forward.z), i.e. forward = (sin h, 0, cos h) in world xz.

export interface MapCar {
  x: number;
  z: number;
  color: string;
  player: boolean;
}

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private path: Path2D | null = null;
  private start: { x: number; z: number; dx: number; dz: number } | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  /** meters shown from the center to the rim */
  range = 340;

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
  }

  setTrack(points: { x: number; z: number }[], startIndex = 0) {
    if (points.length < 2) {
      this.path = null;
      return;
    }
    // decimate to keep per-frame stroking cheap
    const stride = Math.max(1, Math.floor(points.length / 700));
    const p = new Path2D();
    p.moveTo(points[0].x, points[0].z);
    for (let i = stride; i < points.length; i += stride) p.lineTo(points[i].x, points[i].z);
    p.closePath();
    this.path = p;
    const a = points[startIndex % points.length];
    const b = points[(startIndex + 1) % points.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    this.start = { x: a.x, z: a.z, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len };
  }

  draw(cars: MapCar[], heading: number) {
    if (this.w < 2) this.resize();
    const g = this.ctx;
    const w = this.w;
    const h = this.h;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const R = Math.min(w, h) / 2;
    const cx = w / 2;
    const cy = h / 2;

    let px = 0;
    let pz = 0;
    for (const c of cars) {
      if (c.player) {
        px = c.x;
        pz = c.z;
        break;
      }
    }

    const s = (R * 0.92) / this.range;
    const ch = Math.cos(heading);
    const sh = Math.sin(heading);
    // world (x,z) -> screen: forward up, car-right to screen-right
    const a = -ch * s;
    const c = sh * s;
    const b = -sh * s;
    const d = -ch * s;
    const e = cx - (a * px + c * pz);
    const f = cy - (b * px + d * pz);

    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.clip();

    // range rings
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.lineWidth = this.dpr;
    for (const k of [0.33, 0.66]) {
      g.beginPath();
      g.arc(cx, cy, R * k, 0, Math.PI * 2);
      g.stroke();
    }

    if (this.path) {
      g.setTransform(a, b, c, d, e, f);
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(138, 92, 255, 0.28)';
      g.lineWidth = (14 * this.dpr) / s;
      g.stroke(this.path);
      g.strokeStyle = 'rgba(33, 230, 255, 0.35)';
      g.lineWidth = (7 * this.dpr) / s;
      g.stroke(this.path);
      g.strokeStyle = 'rgba(232, 246, 255, 0.92)';
      g.lineWidth = (2.6 * this.dpr) / s;
      g.stroke(this.path);
      if (this.start) {
        // start/finish line across the track
        const st = this.start;
        const half = (9 * this.dpr) / s;
        g.strokeStyle = '#ffffff';
        g.lineWidth = (3 * this.dpr) / s;
        g.beginPath();
        g.moveTo(st.x - st.dz * half, st.z + st.dx * half);
        g.lineTo(st.x + st.dz * half, st.z - st.dx * half);
        g.stroke();
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
    }

    // opponents (clamped to the rim when out of range)
    const dot = 4.2 * this.dpr;
    for (const car of cars) {
      if (car.player) continue;
      let sx = a * car.x + c * car.z + e;
      let sy = b * car.x + d * car.z + f;
      const dx = sx - cx;
      const dy = sy - cy;
      const dist = Math.hypot(dx, dy);
      const lim = R - dot * 1.6;
      let edge = false;
      if (dist > lim) {
        sx = cx + (dx / dist) * lim;
        sy = cy + (dy / dist) * lim;
        edge = true;
      }
      g.globalAlpha = edge ? 0.6 : 1;
      g.fillStyle = 'rgba(0,0,0,0.65)';
      g.beginPath();
      g.arc(sx, sy, dot + 1.6 * this.dpr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = car.color;
      g.beginPath();
      g.arc(sx, sy, dot, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // player arrow
    const u = this.dpr;
    g.translate(cx, cy);
    g.shadowColor = '#21e6ff';
    g.shadowBlur = 10 * u;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(0, -9 * u);
    g.lineTo(6.5 * u, 7 * u);
    g.lineTo(0, 3.5 * u);
    g.lineTo(-6.5 * u, 7 * u);
    g.closePath();
    g.fill();
    g.shadowBlur = 0;
    g.setTransform(1, 0, 0, 1, 0, 0);

    // edge vignette
    const vg = g.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
    vg.addColorStop(0, 'rgba(6,4,16,0)');
    vg.addColorStop(1, 'rgba(6,4,16,0.75)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);
    g.restore();
  }
}
