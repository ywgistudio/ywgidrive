import * as THREE from 'three';
import type { CarSpec } from '../vehicle/CarSpec';
import { ENGINE_PROFILES, cycleCoefficients, tanhCurve, type EngineProfile } from './engineProfiles';
import { type AudioCore, loopSource, noiseSource, setParam, makePanner, setPannerPos, pick } from './AudioCore';

export interface VehicleSoundState {
  rpm: number;
  redline: number;
  limiter: boolean;
  load: number; // -1..1.6 engine load (negative = engine braking)
  throttle: number; // 0..1 effective throttle
  boosting: boolean; // nitro
  gear: number;
  shiftEvent: number; // increments on every shift
  backfire: boolean; // true for a short moment after an aggressive upshift or lift-off
  speed: number; // m/s
  skid: number; // 0..1 tire squeal amount
  surface: number; // 0 road, 1 curb/sidewalk
  position: THREE.Vector3;
  velocity: THREE.Vector3;
}

export interface VehicleSoundOptions {
  /** traffic: one cheap oscillator, no tires/turbo */
  minimal?: boolean;
  /** overall level multiplier */
  volume?: number;
}

const waveCache = new Map<string, PeriodicWave>();
function engineWave(ctx: AudioContext, p: EngineProfile): PeriodicWave {
  const key = p.kind;
  let w = waveCache.get(key);
  if (!w) {
    const { real, imag } = cycleCoefficients(p);
    w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    waveCache.set(key, w);
  }
  return w;
}

let shaperCurve: Float32Array<ArrayBuffer> | null = null;
function curve(): Float32Array<ArrayBuffer> {
  const c = shaperCurve ?? tanhCurve(4096, 1.0);
  shaperCurve = c;
  return c;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const SPEED_OF_SOUND = 343;

/**
 * Public handle returned by AudioSystem.createVehicleSound. Builds its graph lazily, so it can be created
 * before the AudioContext exists (methods are no-ops until then).
 */
export class VehicleSound {
  protected core: AudioCore;
  protected spec: CarSpec;
  protected profile: EngineProfile;
  readonly player: boolean;
  protected opts: VehicleSoundOptions;
  private impl: EngineVoice | null = null;
  private active = true;
  private disposed = false;

  constructor(core: AudioCore, spec: CarSpec, player: boolean, opts: VehicleSoundOptions = {}) {
    this.core = core;
    this.spec = spec;
    this.player = player;
    this.opts = opts;
    this.profile = ENGINE_PROFILES[spec.engineSound] ?? ENGINE_PROFILES.v6tt;
  }

  update(s: VehicleSoundState, dt: number): void {
    if (this.disposed) return;
    const ctx = this.core.ctx;
    if (!ctx || !this.core.world) return;
    if (!this.impl) {
      try {
        this.impl = this.player
          ? new PlayerVoice(this.core, this.spec, this.profile, this.opts)
          : new NpcVoice(this.core, this.spec, this.profile, this.opts);
        this.impl.setActive(this.active);
      } catch (e) {
        console.warn('[audio] failed to build vehicle voice', e);
        this.disposed = true;
        return;
      }
    }
    try {
      this.impl.update(s, Math.min(dt, 0.1));
    } catch (e) {
      console.warn('[audio] vehicle voice update failed', e);
    }
  }

  setActive(on: boolean): void {
    this.active = on;
    this.impl?.setActive(on);
  }

  dispose(): void {
    this.disposed = true;
    this.impl?.dispose();
    this.impl = null;
  }
}

interface EngineVoice {
  update(s: VehicleSoundState, dt: number): void;
  setActive(on: boolean): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------------------
// Player: full procedural engine + turbo + pops + tires + road + nitro
// ---------------------------------------------------------------------------------------------------------
class PlayerVoice implements EngineVoice {
  private ctx: AudioContext;
  private core: AudioCore;
  private p: EngineProfile;
  private spec: CarSpec;
  private sources: AudioScheduledSourceNode[] = [];
  private nodes: AudioNode[] = [];

  private out: GainNode;
  private cycleOsc: OscillatorNode;
  private fireOsc: OscillatorNode;
  private subOsc: OscillatorNode;
  private subGain: GainNode;
  private noiseAM: GainNode;
  private amDepth: GainNode;
  private preDrive: GainNode;
  private postGain: GainNode;
  private lp: BiquadFilterNode;
  private lopeGain: GainNode;
  private gate: GainNode;
  private limDepth: GainNode;
  private shiftCut: GainNode;
  private engineGain: GainNode;
  private intakeBP: BiquadFilterNode;
  private intakeGain: GainNode;
  private turboOsc: OscillatorNode;
  private turboOsc2: OscillatorNode;
  private turboToneGain: GainNode;
  private turboBP: BiquadFilterNode;
  private turboNoiseGain: GainNode;
  private flutterDepth: GainNode;
  private bovGain: GainNode;
  private oneShots: GainNode;
  private popGain: GainNode;
  private squealGain: GainNode;
  private squealBP: BiquadFilterNode;
  private squealSrc: AudioBufferSourceNode | null = null;
  private slideGain: GainNode;
  private roadGain: GainNode;
  private roadLP: BiquadFilterNode;
  private roadSrc: AudioBufferSourceNode | null = null;
  private curbGain: GainNode;
  private hissGain: GainNode;
  private nitroLoop: AudioBufferSourceNode | null = null;
  private nitroLoopGain: GainNode;

  private L = 0;
  private boost = 0;
  private lastShift = -1;
  private lastThrottle = 0;
  private throttleHist: { t: number; v: number }[] = [];
  private popWindow = 0;
  private popWindowTotal = 1;
  private popTimer = 0;
  private crackleTimer = 0;
  private wasBackfire = false;
  private limTimer = 0;
  private wasBoosting = false;
  private time = 0;
  private skidSm = 0;
  private lopeT = 0;

  constructor(core: AudioCore, spec: CarSpec, p: EngineProfile, opts: VehicleSoundOptions) {
    const ctx = core.ctx!;
    this.ctx = ctx;
    this.core = core;
    this.p = p;
    this.spec = spec;
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      this.nodes.push(n);
      return n;
    };
    const f = (type: BiquadFilterType, freq: number, q = 0.7, gain = 0) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = freq;
      n.Q.value = q;
      n.gain.value = gain;
      this.nodes.push(n);
      return n;
    };

    this.out = g(opts.volume ?? 1);
    this.out.connect(core.world!);

    // --- engine core ---
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.nodes.push(comp);
    comp.connect(this.out);

    this.engineGain = g(0);
    this.engineGain.connect(comp);
    this.shiftCut = g(1);
    this.shiftCut.connect(this.engineGain);
    this.gate = g(1);
    this.gate.connect(this.shiftCut);
    this.lopeGain = g(1);
    this.lopeGain.connect(this.gate);
    this.lp = f('lowpass', 2000, 0.8);
    this.lp.connect(this.lopeGain);
    let chainIn: AudioNode = this.lp;
    for (let i = p.peaks.length - 1; i >= 0; i--) {
      const pk = p.peaks[i];
      const n = f('peaking', pk.freq, pk.q, pk.gain);
      n.connect(chainIn);
      chainIn = n;
    }
    const hp = f('highpass', 32, 0.7);
    hp.connect(chainIn);
    this.postGain = g(0.5);
    this.postGain.connect(hp);
    const shaper = ctx.createWaveShaper();
    shaper.curve = curve();
    shaper.oversample = '4x';
    this.nodes.push(shaper);
    shaper.connect(this.postGain);
    this.preDrive = g(2);
    this.preDrive.connect(shaper);
    const mix = g(1);
    mix.connect(this.preDrive);

    this.cycleOsc = ctx.createOscillator();
    this.cycleOsc.setPeriodicWave(engineWave(ctx, p));
    this.cycleOsc.frequency.value = spec.idleRpm / 120;
    const cycGain = g(0.9);
    this.cycleOsc.connect(cycGain).connect(mix);
    this.subOsc = ctx.createOscillator();
    this.subOsc.type = 'sine';
    this.subGain = g(p.sub);
    this.subOsc.connect(this.subGain).connect(mix);

    // combustion noise, amplitude modulated at the firing frequency
    const nz = noiseSource(core);
    this.noiseAM = g(0);
    const nbp = f('bandpass', p.noiseFreq, 0.8);
    if (nz) {
      nz.connect(nbp);
      this.sources.push(nz);
    }
    nbp.connect(this.noiseAM).connect(mix);
    this.fireOsc = ctx.createOscillator();
    this.fireOsc.type = 'sine';
    this.amDepth = g(0);
    this.fireOsc.connect(this.amDepth).connect(this.noiseAM.gain);

    // rev limiter gate: square LFO pushes gate gain between ~0.25 and 1
    const limOsc = ctx.createOscillator();
    limOsc.type = 'square';
    limOsc.frequency.value = 15;
    this.limDepth = g(0);
    limOsc.connect(this.limDepth).connect(this.gate.gain);
    this.sources.push(limOsc);

    // --- intake ---
    const nz2 = noiseSource(core);
    this.intakeBP = f('bandpass', 1500, 1.2);
    this.intakeGain = g(0);
    if (nz2) {
      nz2.connect(this.intakeBP);
      this.sources.push(nz2);
    }
    this.intakeBP.connect(this.intakeGain).connect(comp);

    // --- turbo whistle + hiss ---
    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc2 = ctx.createOscillator();
    this.turboOsc2.type = 'sine';
    this.turboToneGain = g(0);
    const t2 = g(0.35);
    this.turboOsc.connect(this.turboToneGain);
    this.turboOsc2.connect(t2).connect(this.turboToneGain);
    this.turboToneGain.connect(this.out);
    const nz3 = noiseSource(core);
    this.turboBP = f('bandpass', 3000, 10);
    this.turboNoiseGain = g(0);
    if (nz3) {
      nz3.connect(this.turboBP);
      this.sources.push(nz3);
    }
    this.turboBP.connect(this.turboNoiseGain).connect(this.out);

    // blow-off valve bus with optional compressor-surge flutter
    this.bovGain = g(1);
    this.bovGain.connect(this.out);
    const flutOsc = ctx.createOscillator();
    flutOsc.type = 'square';
    flutOsc.frequency.value = 22;
    this.flutterDepth = g(0);
    flutOsc.connect(this.flutterDepth).connect(this.bovGain.gain);
    this.sources.push(flutOsc);

    this.oneShots = g(1);
    this.oneShots.connect(this.out);
    this.popGain = g(0.9);
    const popLP = f('lowpass', 4200, 0.7);
    this.popGain.connect(popLP).connect(this.out);

    // --- tires ---
    this.squealGain = g(0);
    this.squealBP = f('peaking', 1600, 1.0, 4);
    this.squealGain.connect(this.squealBP).connect(this.out);
    const sq = core.buffers.get('tire_squeal');
    if (sq) {
      this.squealSrc = loopSource(ctx, sq, true);
      this.squealSrc.connect(this.squealGain);
      this.sources.push(this.squealSrc);
    }
    this.slideGain = g(0);
    this.slideGain.connect(this.out);
    const sl = core.buffers.get('tire_slide');
    if (sl) {
      const s = loopSource(ctx, sl, true);
      s.connect(this.slideGain);
      this.sources.push(s);
    }

    // --- road + curb rumble ---
    this.roadGain = g(0);
    this.roadLP = f('lowpass', 800, 0.7);
    this.roadLP.connect(this.roadGain).connect(this.out);
    const rd = core.buffers.get('road');
    if (rd) {
      this.roadSrc = loopSource(ctx, rd, true);
      this.roadSrc.connect(this.roadLP);
      this.sources.push(this.roadSrc);
    }
    const nz4 = noiseSource(core);
    this.curbGain = g(0);
    const curbLP = f('lowpass', 140, 1.4);
    if (nz4) {
      nz4.connect(curbLP);
      this.sources.push(nz4);
    }
    curbLP.connect(this.curbGain).connect(this.out);

    // --- nitro hiss ---
    const nz5 = noiseSource(core);
    this.hissGain = g(0);
    const hissHP = f('highpass', 3200, 0.7);
    if (nz5) {
      nz5.connect(hissHP);
      this.sources.push(nz5);
    }
    hissHP.connect(this.hissGain).connect(this.out);
    this.nitroLoopGain = g(0);
    this.nitroLoopGain.connect(this.out);

    for (const o of [this.cycleOsc, this.subOsc, this.fireOsc, this.turboOsc, this.turboOsc2]) {
      o.start();
      this.sources.push(o);
    }
    limOsc.start();
    flutOsc.start();
  }

  setActive(on: boolean) {
    setParam(this.out.gain, on ? 1 : 0, this.ctx, 0.05);
  }

  private oneShot(name: string, gain: number, rate = 1, dest: AudioNode = this.oneShots) {
    const buf = this.core.buffers.get(name);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gn = this.ctx.createGain();
    gn.gain.value = gain;
    src.connect(gn).connect(dest);
    src.start();
    src.onended = () => gn.disconnect();
  }

  private playBuffer(buf: AudioBuffer, gain: number, rate: number, dest: AudioNode) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gn = this.ctx.createGain();
    gn.gain.value = gain;
    src.connect(gn).connect(dest);
    src.start();
    src.onended = () => gn.disconnect();
  }

  private blowOff(b: number) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const level = 0.55 * b + 0.15;
    // sample layer
    this.oneShot(Math.random() < 0.5 ? 'bov_1' : 'bov_2', level * 0.9, 0.95 + Math.random() * 0.2, this.bovGain);
    // procedural sweep layer
    const nz = noiseSource(this.core);
    if (nz) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(3500, now);
      bp.frequency.exponentialRampToValueAtTime(800, now + 0.35);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(level * 0.8, now + 0.004);
      env.gain.setTargetAtTime(0, now + 0.004, 0.12);
      nz.connect(bp).connect(env).connect(this.bovGain);
      nz.stop(now + 0.8);
      nz.onended = () => env.disconnect();
    }
    if (this.p.flutter > 0.05) {
      const d = this.flutterDepth.gain;
      d.cancelScheduledValues(now);
      d.setValueAtTime(0.5 * this.p.flutter, now + 0.02);
      d.setTargetAtTime(0, now + 0.25, 0.05);
    }
  }

  update(s: VehicleSoundState, dt: number) {
    const ctx = this.ctx;
    const p = this.p;
    this.time += dt;
    const rpm = Math.max(300, s.rpm);
    const redline = Math.max(1000, s.redline);
    const r = clamp01(rpm / redline);
    const cyc = rpm / 120;
    const fire = cyc * p.pulses;

    setParam(this.cycleOsc.frequency, cyc, ctx, 0.02);
    setParam(this.fireOsc.frequency, fire, ctx, 0.02);
    setParam(this.subOsc.frequency, fire * 0.5, ctx, 0.02);

    // engine load (smoothed). Nitro pushes beyond 1 for extra grit.
    let target = clamp01(s.load);
    if (s.boosting && s.throttle > 0.1) target = Math.min(1.3, target + 0.3);
    const k = 1 - Math.exp(-dt / 0.05);
    this.L += (target - this.L) * k;
    const L = this.L;
    const Lc = Math.min(1, L);

    const drive = p.drive[0] + (p.drive[1] - p.drive[0]) * Lc + (L > 1 ? (L - 1) * 4 : 0);
    setParam(this.preDrive.gain, drive, ctx);
    setParam(this.postGain.gain, 0.85 / Math.sqrt(drive), ctx);
    const offLoad = s.load < 0 ? Math.min(1, -s.load) : 0;
    const cutoff = p.lpBase + p.lpLoad * Math.pow(Lc, 1.5) + p.lpRpm * rpm - offLoad * 250;
    setParam(this.lp.frequency, Math.max(350, Math.min(16000, cutoff)), ctx);
    setParam(this.lp.Q, 0.8 + 0.6 * Lc, ctx);
    const nGain = (p.noiseGain / 0.22) * (0.05 + 0.25 * Lc * r);
    setParam(this.noiseAM.gain, nGain * 0.6, ctx);
    setParam(this.amDepth.gain, nGain * 0.5, ctx);
    setParam(this.subGain.gain, p.sub * (0.5 + 0.5 * Lc) * (1 - 0.5 * r), ctx);
    setParam(this.intakeGain.gain, p.intakeGain * Lc * r * r * 1.6, ctx);
    setParam(this.intakeBP.frequency, 900 + 2400 * r, ctx);
    const eg = (0.35 + 0.65 * (0.4 + 0.6 * Lc) * (0.5 + 0.5 * r)) * p.trim * 0.55;
    setParam(this.engineGain.gain, eg, ctx, 0.04);

    // rotary idle brap / general low-rpm irregularity
    const lope = p.lope * clamp01(1 - (rpm - 900) / 2600);
    this.lopeT -= dt;
    if (this.lopeT <= 0) {
      this.lopeT = 0.03 + Math.random() * 0.05;
      setParam(this.lopeGain.gain, 1 - lope * Math.random() * 0.7, ctx, 0.012);
    }

    // rev limiter
    if (s.limiter) this.limTimer = 0.12;
    this.limTimer -= dt;
    const lim = this.limTimer > 0;
    setParam(this.gate.gain, lim ? 0.62 : 1, ctx, 0.01);
    setParam(this.limDepth.gain, lim ? 0.38 : 0, ctx, 0.01);

    // shifts
    if (this.lastShift < 0) this.lastShift = s.shiftEvent;
    if (s.shiftEvent !== this.lastShift) {
      this.lastShift = s.shiftEvent;
      const now = ctx.currentTime;
      const sc = this.shiftCut.gain;
      sc.cancelScheduledValues(now);
      sc.setTargetAtTime(0.22, now, 0.012);
      sc.setTargetAtTime(1, now + 0.09, 0.04);
      this.oneShot(Math.random() < 0.5 ? 'shift_1' : 'shift_2', 0.16, 0.9 + Math.random() * 0.2);
      if (this.spec.turbo && this.boost > 0.35 && s.gear > 1) {
        this.oneShot(Math.random() < 0.5 ? 'bov_1' : 'bov_2', 0.18 * this.boost, 1.35, this.bovGain);
      }
    }

    // turbo spool
    const boostTarget = this.spec.turbo ? Lc * clamp01((rpm - 2500) / 3500) : 0;
    const tc = boostTarget > this.boost ? 0.7 : 0.3;
    this.boost += (boostTarget - this.boost) * (1 - Math.exp(-dt / tc));
    const b = this.boost;
    const tf = p.turboBase + p.turboSpan * b;
    setParam(this.turboOsc.frequency, tf, ctx, 0.05);
    setParam(this.turboOsc2.frequency, tf * 1.48, ctx, 0.05);
    setParam(this.turboBP.frequency, tf, ctx, 0.05);
    setParam(this.turboToneGain.gain, p.turboGain * b * b * 0.9, ctx, 0.05);
    setParam(this.turboNoiseGain.gain, p.turboGain * 0.6 * b, ctx, 0.05);

    // throttle lift detection -> blow-off + pop window
    this.throttleHist.push({ t: this.time, v: s.throttle });
    while (this.throttleHist.length && this.throttleHist[0].t < this.time - 0.12) this.throttleHist.shift();
    let maxRecent = 0;
    for (const h of this.throttleHist) maxRecent = Math.max(maxRecent, h.v);
    const lifted = maxRecent - s.throttle > 0.5 && s.throttle < 0.2 && this.lastThrottle >= 0.2;
    if (lifted) {
      if (this.spec.turbo && b > 0.4) {
        this.blowOff(b);
        this.boost = 0;
      }
      if (rpm > 3500 && Math.random() < 0.35 + 0.65 * p.pops) {
        this.popWindowTotal = 0.3 + 0.9 * Math.random() * (0.4 + 0.6 * p.pops);
        this.popWindow = this.popWindowTotal;
      }
    }
    this.lastThrottle = s.throttle;

    if (this.popWindow > 0) {
      this.popWindow -= dt;
      if (s.throttle > 0.3 || rpm < 2500) this.popWindow = 0;
      const density = this.popWindow / this.popWindowTotal;
      this.popTimer -= dt;
      if (this.popTimer <= 0 && this.core.pops.length) {
        this.popTimer = (0.05 + Math.random() * 0.12) / Math.max(0.25, density);
        this.playBuffer(pick(this.core.pops), (0.3 + Math.random() * 0.7) * 0.55 * (0.5 + 0.5 * density), 0.85 + Math.random() * 0.35, this.popGain);
      }
      this.crackleTimer -= dt;
      if (this.crackleTimer <= 0 && this.core.crackles.length) {
        this.crackleTimer = 0.012 + Math.random() * 0.04;
        this.playBuffer(pick(this.core.crackles), 0.09 * density * (0.5 + Math.random()), 0.8 + Math.random() * 0.5, this.popGain);
      }
    }
    if (s.backfire && !this.wasBackfire && this.core.bangs.length && Math.random() < 0.75) {
      this.playBuffer(pick(this.core.bangs), 0.9, 0.9 + Math.random() * 0.2, this.popGain);
    }
    this.wasBackfire = s.backfire;

    // tires
    const spd = Math.abs(s.speed);
    const skidTarget = spd > 2 ? clamp01(s.skid) : 0;
    this.skidSm += (skidTarget - this.skidSm) * (1 - Math.exp(-dt / 0.06));
    const sk = this.skidSm;
    const onCurb = s.surface === 1;
    setParam(this.squealGain.gain, Math.pow(sk, 1.2) * 0.5 * (onCurb ? 0.5 : 1), ctx, 0.04);
    setParam(this.slideGain.gain, clamp01(sk * 1.3 - 0.25) * 0.45, ctx, 0.04);
    if (this.squealSrc) {
      const wob = Math.sin(this.time * 3.1) * 0.03 + Math.sin(this.time * 7.7) * 0.015;
      setParam(this.squealSrc.playbackRate, 0.88 + 0.22 * Math.min(1, spd / 40) + sk * 0.08 + wob, ctx, 0.05);
    }
    setParam(this.squealBP.frequency, 1300 + sk * 900, ctx, 0.05);

    // road + curb
    const sp = clamp01(spd / 60);
    setParam(this.roadGain.gain, Math.pow(sp, 0.8) * 0.32 * (onCurb ? 1.4 : 1), ctx, 0.08);
    setParam(this.roadLP.frequency, 350 + spd * 45, ctx, 0.08);
    if (this.roadSrc) setParam(this.roadSrc.playbackRate, Math.min(1.6, 0.75 + spd / 70), ctx, 0.1);
    setParam(this.curbGain.gain, onCurb ? Math.min(1, spd / 25) * 0.9 : 0, ctx, 0.03);

    // nitro
    if (s.boosting && !this.wasBoosting) {
      this.oneShot('nitro_start', 0.5);
      const nb = this.core.buffers.get('nitro_loop');
      if (nb && !this.nitroLoop) {
        this.nitroLoop = loopSource(ctx, nb);
        this.nitroLoop.connect(this.nitroLoopGain);
      }
      setParam(this.nitroLoopGain.gain, 0.35, ctx, 0.08);
    } else if (!s.boosting && this.wasBoosting) {
      this.oneShot('nitro_end', 0.45);
      setParam(this.nitroLoopGain.gain, 0, ctx, 0.08);
      const l = this.nitroLoop;
      this.nitroLoop = null;
      if (l) {
        try {
          l.stop(ctx.currentTime + 0.5);
        } catch {
          /* already stopped */
        }
      }
    }
    this.wasBoosting = s.boosting;
    setParam(this.hissGain.gain, s.boosting ? 0.08 + 0.06 * Lc : 0, ctx, 0.06);
  }

  dispose() {
    const now = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, now, 0.03);
    const all = [...this.sources];
    if (this.nitroLoop) all.push(this.nitroLoop);
    setTimeout(() => {
      for (const s of all) {
        try {
          s.stop();
        } catch {
          /* not started */
        }
        s.disconnect();
      }
      for (const n of this.nodes) n.disconnect();
      this.out.disconnect();
    }, 200);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Rivals / traffic: cheap spatialized engine
// ---------------------------------------------------------------------------------------------------------
class NpcVoice implements EngineVoice {
  private ctx: AudioContext;
  private core: AudioCore;
  private p: EngineProfile;
  private spec: CarSpec;
  private minimal: boolean;
  private sources: AudioScheduledSourceNode[] = [];
  private nodes: AudioNode[] = [];
  private out: GainNode;
  private panner: PannerNode;
  private osc1: OscillatorNode;
  private osc2: OscillatorNode | null = null;
  private lp: BiquadFilterNode;
  private engineGain: GainNode;
  private noiseGain: GainNode | null = null;
  private squealGain: GainNode | null = null;
  private squealSrc: AudioBufferSourceNode | null = null;
  private active = true;
  private culled = false;
  private L = 0;
  private lastShift = -1;
  private shiftCut: GainNode;
  private wasBackfire = false;
  private tmp = new THREE.Vector3();
  private vol: number;

  constructor(core: AudioCore, spec: CarSpec, p: EngineProfile, opts: VehicleSoundOptions) {
    const ctx = core.ctx!;
    this.ctx = ctx;
    this.core = core;
    this.p = p;
    this.spec = spec;
    this.minimal = !!opts.minimal;
    this.vol = opts.volume ?? 1;
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      this.nodes.push(n);
      return n;
    };
    this.panner = makePanner(ctx, !this.minimal);
    this.nodes.push(this.panner);
    this.out = g(0);
    this.out.connect(this.panner).connect(core.world!);

    this.engineGain = g(0);
    this.shiftCut = g(1);
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 1200;
    this.lp.Q.value = 1.0;
    this.nodes.push(this.lp);
    const shaper = ctx.createWaveShaper();
    shaper.curve = curve();
    this.nodes.push(shaper);
    const pre = g(this.minimal ? 1.2 : 2.2);
    pre.connect(shaper).connect(this.lp).connect(this.shiftCut).connect(this.engineGain).connect(this.out);

    this.osc1 = ctx.createOscillator();
    if (this.minimal) {
      this.osc1.type = 'triangle';
      this.osc1.connect(pre);
    } else {
      this.osc1.setPeriodicWave(engineWave(ctx, p));
      const g1 = g(0.8);
      this.osc1.connect(g1).connect(pre);
      this.osc2 = ctx.createOscillator();
      this.osc2.type = 'sawtooth';
      const g2 = g(0.18);
      this.osc2.connect(g2).connect(pre);
      const nz = noiseSource(core);
      if (nz) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = p.noiseFreq;
        bp.Q.value = 0.8;
        this.nodes.push(bp);
        this.noiseGain = g(0);
        nz.connect(bp).connect(this.noiseGain).connect(pre);
        this.sources.push(nz);
      }
      const sq = core.buffers.get('tire_squeal');
      if (sq) {
        this.squealGain = g(0);
        this.squealSrc = loopSource(ctx, sq, true);
        this.squealSrc.connect(this.squealGain).connect(this.out);
        this.sources.push(this.squealSrc);
      }
    }
    this.osc1.start();
    this.sources.push(this.osc1);
    if (this.osc2) {
      this.osc2.start();
      this.sources.push(this.osc2);
    }
  }

  setActive(on: boolean) {
    this.active = on;
    if (!on) setParam(this.out.gain, 0, this.ctx, 0.05);
  }

  update(s: VehicleSoundState, dt: number) {
    const ctx = this.ctx;
    const lp = this.core.listenerPos;
    const dist = this.tmp.copy(s.position).sub(lp).length();
    const audible = this.active && dist < (this.minimal ? 120 : 260);
    if (!audible) {
      if (!this.culled) setParam(this.out.gain, 0, ctx, 0.1);
      this.culled = true;
      return;
    }
    this.culled = false;
    setPannerPos(this.panner, s.position, ctx);

    // fake Doppler: f' = f * (c + v_l) / (c - v_s) along the line of sight
    let doppler = 1;
    if (dist > 0.5) {
      const dir = this.tmp.multiplyScalar(1 / dist); // source -> listener is -dir; dir = listener->source
      const vs = -s.velocity.dot(dir); // source speed toward listener
      const vl = this.core.listenerVel.dot(dir); // listener speed toward source
      doppler = (SPEED_OF_SOUND + vl) / (SPEED_OF_SOUND - vs);
      doppler = Math.max(0.88, Math.min(1.12, doppler));
    }

    const rpm = Math.max(300, s.rpm);
    const r = clamp01(rpm / Math.max(1000, s.redline));
    const fire = (rpm / 120) * this.p.pulses;
    const k = 1 - Math.exp(-dt / 0.06);
    this.L += (clamp01(s.load) - this.L) * k;
    const L = this.L;
    if (this.minimal) {
      setParam(this.osc1.frequency, fire * doppler, ctx, 0.03);
      setParam(this.lp.frequency, 300 + 900 * L + rpm * 0.08, ctx);
      setParam(this.engineGain.gain, 0.12 + 0.12 * L, ctx);
    } else {
      setParam(this.osc1.frequency, (rpm / 120) * doppler, ctx, 0.03);
      if (this.osc2) setParam(this.osc2.frequency, fire * doppler, ctx, 0.03);
      setParam(this.lp.frequency, this.p.lpBase * 0.8 + this.p.lpLoad * 0.6 * Math.pow(L, 1.5) + this.p.lpRpm * rpm, ctx);
      if (this.noiseGain) setParam(this.noiseGain.gain, 0.05 + 0.2 * L * r, ctx);
      setParam(this.engineGain.gain, (0.3 + 0.5 * (0.4 + 0.6 * L) * (0.5 + 0.5 * r)) * this.p.trim * 0.55, ctx);
      if (this.lastShift < 0) this.lastShift = s.shiftEvent;
      if (s.shiftEvent !== this.lastShift) {
        this.lastShift = s.shiftEvent;
        const now = ctx.currentTime;
        this.shiftCut.gain.cancelScheduledValues(now);
        this.shiftCut.gain.setTargetAtTime(0.25, now, 0.012);
        this.shiftCut.gain.setTargetAtTime(1, now + 0.09, 0.04);
      }
      if (s.backfire && !this.wasBackfire && this.core.pops.length && Math.random() < 0.5) {
        const src = ctx.createBufferSource();
        src.buffer = pick(this.core.pops);
        src.playbackRate.value = 0.9 + Math.random() * 0.3;
        const gn = ctx.createGain();
        gn.gain.value = 0.5;
        src.connect(gn).connect(this.out);
        src.start();
        src.onended = () => gn.disconnect();
      }
      this.wasBackfire = s.backfire;
      if (this.squealGain && this.squealSrc) {
        const sk = Math.abs(s.speed) > 2 ? clamp01(s.skid) : 0;
        setParam(this.squealGain.gain, Math.pow(sk, 1.2) * 0.45, ctx, 0.05);
        setParam(this.squealSrc.playbackRate, (0.9 + 0.2 * Math.min(1, Math.abs(s.speed) / 40)) * doppler, ctx, 0.05);
      }
    }
    setParam(this.out.gain, this.vol, ctx, 0.08);
  }

  dispose() {
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    setTimeout(() => {
      for (const s of this.sources) {
        try {
          s.stop();
        } catch {
          /* ignore */
        }
        s.disconnect();
      }
      for (const n of this.nodes) n.disconnect();
    }, 200);
  }
}
