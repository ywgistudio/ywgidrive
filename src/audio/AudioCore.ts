import * as THREE from 'three';

/** Shared state handed from AudioSystem to every VehicleSound. */
export interface AudioCore {
  ctx: AudioContext | null;
  /** world sfx bus input (affected by menu lowpass and tunnel reverb) */
  world: AudioNode | null;
  buffers: Map<string, AudioBuffer>;
  noise: AudioBuffer | null;
  pops: AudioBuffer[];
  bangs: AudioBuffer[];
  crackles: AudioBuffer[];
  listenerPos: THREE.Vector3;
  listenerVel: THREE.Vector3;
}

const SILENCE = 1e-4;

/** Trim encoder priming / padding so MP3 loops are seamless. */
export function loopRegion(buf: AudioBuffer): [number, number] {
  const d = buf.getChannelData(0);
  const scan = Math.min(d.length >> 2, 4096);
  let s = 0;
  while (s < scan && Math.abs(d[s]) < SILENCE) s++;
  if (s >= scan) s = 0;
  let e = d.length - 1;
  const minE = d.length - 1 - scan;
  while (e > minE && Math.abs(d[e]) < SILENCE) e--;
  if (e <= minE) e = d.length - 1;
  return [s / buf.sampleRate, (e + 1) / buf.sampleRate];
}

export function loopSource(ctx: BaseAudioContext, buf: AudioBuffer, randomStart = false): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const [a, b] = loopRegion(buf);
  src.loopStart = a;
  src.loopEnd = b;
  const off = randomStart ? a + Math.random() * (b - a) : a;
  src.start(ctx.currentTime, off);
  return src;
}

export function noiseSource(core: AudioCore): AudioBufferSourceNode | null {
  if (!core.ctx || !core.noise) return null;
  const src = core.ctx.createBufferSource();
  src.buffer = core.noise;
  src.loop = true;
  src.start(core.ctx.currentTime, Math.random() * core.noise.duration);
  return src;
}

/** Smoothly move an AudioParam (never jumps, so no clicks). */
export function setParam(p: AudioParam, v: number, ctx: BaseAudioContext, tc = 0.03) {
  if (!Number.isFinite(v)) return;
  p.setTargetAtTime(v, ctx.currentTime, tc);
}

export function makePanner(ctx: BaseAudioContext, hrtf = true): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = hrtf ? 'HRTF' : 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = 6;
  p.rolloffFactor = 1.2;
  p.maxDistance = 10000;
  return p;
}

export function setPannerPos(p: PannerNode, pos: THREE.Vector3, ctx: BaseAudioContext) {
  if (p.positionX) {
    const t = ctx.currentTime;
    p.positionX.setTargetAtTime(pos.x, t, 0.02);
    p.positionY.setTargetAtTime(pos.y, t, 0.02);
    p.positionZ.setTargetAtTime(pos.z, t, 0.02);
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z);
  }
}

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------- tiny offline DSP for procedurally generated one-shots ----------

class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  constructor(type: 'bp' | 'hp' | 'lp', f: number, q: number, sr: number) {
    const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al;
    if (type === 'bp') {
      this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0;
    } else if (type === 'hp') {
      this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = (1 + c) / 2 / a0;
    } else {
      this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = (1 - c) / 2 / a0;
    }
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al) / a0;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function normalize(d: Float32Array, peak = 0.95) {
  let m = 1e-9;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  const k = peak / m;
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

/** Exhaust pop: short bandpassed noise burst plus a falling sine thump. */
export function renderPop(ctx: BaseAudioContext, big: boolean): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * (big ? 0.16 : 0.07));
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const bp = new Biquad('bp', big ? 380 + Math.random() * 200 : 450 + Math.random() * 450, 1.1, sr);
  const lp = new Biquad('lp', big ? 2600 : 3800, 0.7, sr);
  const burst = (big ? 0.08 : 0.02 + Math.random() * 0.02) * sr;
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const envN = i < burst ? Math.min(1, i / (0.0008 * sr)) * Math.exp(-i / (burst * 0.45)) : Math.exp(-i / (burst * 0.3)) * 0.2;
    const n = bp.run(Math.random() * 2 - 1) * 3.2 * envN;
    const f = (big ? 95 : 110) * Math.exp(-t * (big ? 18 : 28)) + 42;
    ph += (2 * Math.PI * f) / sr;
    const thump = Math.sin(ph) * Math.exp(-t / (big ? 0.06 : 0.025)) * (big ? 1.2 : 0.8);
    d[i] = Math.tanh(lp.run(n + thump) * (big ? 3 : 2.2));
  }
  normalize(d, 0.9);
  return buf;
}

export function renderCrackle(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.012);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const hp = new Biquad('hp', 2000 + Math.random() * 1500, 0.8, sr);
  const clickLen = (0.001 + Math.random() * 0.002) * sr;
  for (let i = 0; i < len; i++) {
    const env = i < clickLen ? 1 : Math.exp(-(i - clickLen) / (0.002 * sr));
    d[i] = hp.run((Math.random() * 2 - 1) * env);
  }
  normalize(d, 0.8);
  return buf;
}

/** Stereo impulse response for the tunnel: early slaps + dense concrete tail. */
export function renderTunnelIR(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 2.4);
  const buf = ctx.createBuffer(2, len, sr);
  const early = [0.019, 0.031, 0.047, 0.066, 0.083, 0.112, 0.141];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const lp = new Biquad('lp', 5200, 0.6, sr);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const tail = (Math.random() * 2 - 1) * Math.exp(-t / 0.42) * Math.min(1, t / 0.02) * 0.55;
      d[i] = lp.run(tail);
    }
    for (const e of early) {
      const i = Math.floor((e + (ch ? 0.0037 : 0)) * sr);
      const amp = 0.8 * Math.exp(-e / 0.09);
      for (let k = 0; k < 64 && i + k < len; k++) d[i + k] += amp * (Math.random() * 2 - 1) * Math.exp(-k / 12);
    }
  }
  return buf;
}

export function renderNoise(ctx: BaseAudioContext, seconds = 3): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
