import * as THREE from 'three';
import type { CarSpec } from '../vehicle/CarSpec';
import {
  type AudioCore,
  loopRegion,
  loopSource,
  makePanner,
  pick,
  renderCrackle,
  renderNoise,
  renderPop,
  renderTunnelIR,
  setPannerPos,
  setParam,
} from './AudioCore';
import { VehicleSound, type VehicleSoundOptions } from './VehicleSound';

export { VehicleSound } from './VehicleSound';
export type { VehicleSoundState, VehicleSoundOptions } from './VehicleSound';

const BASE = 'assets/audio/';

const SFX = [
  'tire_squeal', 'tire_slide', 'wind', 'road', 'scrape',
  'crash_heavy_1', 'crash_heavy_2', 'crash_heavy_3', 'crash_med_1', 'crash_med_2', 'crash_med_3',
  'crash_light_1', 'crash_light_2', 'crash_light_3', 'glass_1', 'glass_2', 'crunch',
  'shift_1', 'shift_2', 'bov_1', 'bov_2', 'nitro_start', 'nitro_loop', 'nitro_end', 'nitro_burst', 'whoosh_1',
  'ui_hover', 'ui_click', 'ui_back', 'ui_start', 'lap',
];

const MUSIC: Record<'menu' | 'race' | 'final', string> = {
  menu: 'music_final',
  race: 'music_race',
  final: 'music_final',
};

type MusicKind = 'menu' | 'race' | 'final';

interface MusicVoice {
  kind: MusicKind;
  src: AudioBufferSourceNode;
  gain: GainNode;
}

/** Owns the AudioContext, mix buses, shared buffers and all non-vehicle sounds. */
export class AudioSystem {
  ctx: AudioContext | null = null;

  private core: AudioCore = {
    ctx: null,
    world: null,
    buffers: new Map(),
    noise: null,
    pops: [],
    bangs: [],
    crackles: [],
    listenerPos: new THREE.Vector3(),
    listenerVel: new THREE.Vector3(),
  };

  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicDuck: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private uiGain: GainNode | null = null;
  private worldFilter: BiquadFilterNode | null = null;
  private worldGain: GainNode | null = null;
  private tunnelSend: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windSrc: AudioBufferSourceNode | null = null;
  private scrapeGain: GainNode | null = null;
  private scrapeBP: BiquadFilterNode | null = null;
  private scrapePanner: PannerNode | null = null;
  private scrapeSrc: AudioBufferSourceNode | null = null;
  private scrapeLevel = 0;
  private scrapeAge = 1;

  private volumes = { master: 0.8, music: 0.5, sfx: 0.9 };
  private initPromise: Promise<void> | null = null;
  private music: MusicVoice | null = null;
  private wantedMusic: MusicKind | null = null;
  private musicLoading = new Set<string>();
  private lastCrash = { heavy: 0, med: 0, light: 0 };
  private crashVoices = 0;
  private menuMode = false;
  private tunnel = 0;

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit() {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) {
      console.warn('[audio] Web Audio not supported');
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      console.warn('[audio] could not create AudioContext', e);
      return;
    }
    this.ctx = ctx;
    this.core.ctx = ctx;
    const resume = () => {
      if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
    };
    resume();
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, resume, { passive: true });

    // ---- buses ----
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(limiter);

    this.musicGain = ctx.createGain();
    this.musicDuck = ctx.createGain();
    this.musicGain.connect(this.musicDuck).connect(this.master);

    this.sfxGain = ctx.createGain();
    this.worldFilter = ctx.createBiquadFilter();
    this.worldFilter.type = 'lowpass';
    this.worldFilter.frequency.value = 20000;
    this.worldFilter.Q.value = 0.5;
    this.worldGain = ctx.createGain();
    this.sfxGain.connect(this.worldFilter).connect(this.worldGain).connect(this.master);
    this.core.world = this.sfxGain;

    this.uiGain = ctx.createGain();
    this.uiGain.connect(this.master);

    // tunnel reverb
    this.tunnelSend = ctx.createGain();
    this.tunnelSend.gain.value = 0;
    const conv = ctx.createConvolver();
    conv.buffer = renderTunnelIR(ctx);
    const ret = ctx.createGain();
    ret.gain.value = 0.9;
    this.worldFilter.connect(this.tunnelSend).connect(conv).connect(ret).connect(this.worldGain);

    this.applyVolumes();

    // ---- procedural buffers ----
    this.core.noise = renderNoise(ctx, 3);
    for (let i = 0; i < 6; i++) this.core.pops.push(renderPop(ctx, false));
    for (let i = 0; i < 3; i++) this.core.bangs.push(renderPop(ctx, true));
    for (let i = 0; i < 8; i++) this.core.crackles.push(renderCrackle(ctx));

    // ---- samples ----
    await Promise.all(SFX.map((n) => this.load(n)));

    // persistent loops
    const wind = this.core.buffers.get('wind');
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windGain.connect(this.sfxGain);
    if (wind) {
      this.windSrc = loopSource(ctx, wind, true);
      this.windSrc.connect(this.windGain);
    }
    this.scrapeGain = ctx.createGain();
    this.scrapeGain.gain.value = 0;
    this.scrapeBP = ctx.createBiquadFilter();
    this.scrapeBP.type = 'peaking';
    this.scrapeBP.frequency.value = 2000;
    this.scrapeBP.gain.value = 3;
    this.scrapePanner = makePanner(ctx, false);
    this.scrapePanner.refDistance = 8;
    this.scrapeGain.connect(this.scrapeBP).connect(this.scrapePanner).connect(this.sfxGain);
    const scrape = this.core.buffers.get('scrape');
    if (scrape) {
      this.scrapeSrc = loopSource(ctx, scrape, true);
      this.scrapeSrc.connect(this.scrapeGain);
    }

    // music streams in after everything else
    for (const m of new Set(Object.values(MUSIC))) void this.loadMusic(m);
  }

  private async load(name: string, file = `${name}.mp3`): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      const res = await fetch(BASE + file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      const buf = await ctx.decodeAudioData(data);
      this.core.buffers.set(name, buf);
      return buf;
    } catch (e) {
      console.warn(`[audio] failed to load ${file}`, e);
      return null;
    }
  }

  private async loadMusic(name: string) {
    if (this.core.buffers.has(name) || this.musicLoading.has(name)) return;
    this.musicLoading.add(name);
    await this.load(name);
    this.musicLoading.delete(name);
    if (this.wantedMusic && MUSIC[this.wantedMusic] === name && (!this.music || this.music.kind !== this.wantedMusic)) {
      this.startMusic(this.wantedMusic);
    }
  }

  private applyVolumes() {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    setParam(this.master.gain, this.volumes.master, ctx, 0.05);
    setParam(this.musicGain!.gain, this.volumes.music * 0.55, ctx, 0.05);
    setParam(this.sfxGain!.gain, this.volumes.sfx, ctx, 0.05);
    setParam(this.uiGain!.gain, this.volumes.sfx * 0.7, ctx, 0.05);
  }

  setVolumes(master: number, music: number, sfx: number): void {
    this.volumes = { master, music, sfx };
    this.applyVolumes();
  }

  setListener(pos: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3, vel: THREE.Vector3): void {
    this.core.listenerPos.copy(pos);
    this.core.listenerVel.copy(vel);
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.02);
      l.positionY.setTargetAtTime(pos.y, t, 0.02);
      l.positionZ.setTargetAtTime(pos.z, t, 0.02);
      l.forwardX.setTargetAtTime(forward.x, t, 0.02);
      l.forwardY.setTargetAtTime(forward.y, t, 0.02);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    } else {
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(pos.x, pos.y, pos.z);
      legacy.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  createVehicleSound(spec: CarSpec, player: boolean, opts?: VehicleSoundOptions): VehicleSound {
    return new VehicleSound(this.core, spec, player, opts);
  }

  // ------------------------------------------------------------------ one-shots

  private play(name: string, gain: number, rate = 1, dest: AudioNode | null = this.sfxGain, pan = 0): AudioBufferSourceNode | null {
    const ctx = this.ctx;
    const buf = this.core.buffers.get(name);
    if (!ctx || !buf || !dest) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(g).connect(p).connect(dest);
      src.onended = () => {
        g.disconnect();
        p.disconnect();
      };
    } else {
      src.connect(g).connect(dest);
      src.onended = () => g.disconnect();
    }
    src.start();
    return src;
  }

  private playAt(name: string, gain: number, rate: number, pos: THREE.Vector3) {
    const ctx = this.ctx;
    const buf = this.core.buffers.get(name);
    if (!ctx || !buf || !this.sfxGain) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = makePanner(ctx, false);
    p.refDistance = 10;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else setPannerPos(p, pos, ctx);
    src.connect(g).connect(p).connect(this.sfxGain);
    this.crashVoices++;
    src.onended = () => {
      g.disconnect();
      p.disconnect();
      this.crashVoices--;
    };
    src.start();
  }

  playCrash(intensity: number, pos: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx || intensity <= 0.02 || this.crashVoices > 10) return;
    const now = ctx.currentTime;
    const i = Math.min(1, intensity);
    const rate = () => 0.88 + Math.random() * 0.24;
    if (i > 0.6) {
      if (now - this.lastCrash.heavy < 0.12) return;
      this.lastCrash.heavy = now;
      this.playAt(pick(['crash_heavy_1', 'crash_heavy_2', 'crash_heavy_3']), 0.9 * i, rate(), pos);
      this.playAt('crunch', 0.6 * i, rate(), pos);
      if (i > 0.75 && Math.random() < 0.6) this.playAt(pick(['glass_1', 'glass_2']), 0.45 * i, rate(), pos);
      if (this.musicDuck) {
        const d = this.musicDuck.gain;
        d.cancelScheduledValues(now);
        d.setTargetAtTime(0.45, now, 0.02);
        d.setTargetAtTime(1, now + 0.5, 0.4);
      }
    } else if (i > 0.28) {
      if (now - this.lastCrash.med < 0.08) return;
      this.lastCrash.med = now;
      this.playAt(pick(['crash_med_1', 'crash_med_2', 'crash_med_3']), 0.5 + 0.6 * i, rate(), pos);
    } else {
      if (now - this.lastCrash.light < 0.06) return;
      this.lastCrash.light = now;
      this.playAt(pick(['crash_light_1', 'crash_light_2', 'crash_light_3']), 0.25 + 1.2 * i, rate(), pos);
    }
  }

  setScrape(amount: number, pos: THREE.Vector3): void {
    if (!this.ctx || !this.scrapePanner) return;
    this.scrapeLevel = Math.max(0, Math.min(1, amount));
    this.scrapeAge = 0;
    setPannerPos(this.scrapePanner, pos, this.ctx);
  }

  setWind(speed: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.windGain) return;
    const s = Math.max(0, speed);
    const x = Math.max(0, Math.min(1, (s - 6) / 70));
    setParam(this.windGain.gain, Math.pow(x, 1.5) * 0.55, ctx, 0.1);
    if (this.windSrc) setParam(this.windSrc.playbackRate, 0.7 + Math.min(0.8, s / 90), ctx, 0.15);
  }

  private beep(freq: number, dur: number, gain: number) {
    const ctx = this.ctx;
    if (!ctx || !this.uiGain) return;
    const now = ctx.currentTime;
    const o1 = ctx.createOscillator();
    o1.type = 'square';
    o1.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq * 2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = freq * 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.005);
    g.gain.setValueAtTime(gain, now + dur * 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.3;
    o1.connect(lp).connect(g);
    o2.connect(g2).connect(g);
    g.connect(this.uiGain);
    o1.start(now);
    o2.start(now);
    o1.stop(now + dur + 0.05);
    o2.stop(now + dur + 0.05);
    o1.onended = () => g.disconnect();
  }

  playCountdown(step: 3 | 2 | 1 | 0): void {
    if (step === 0) this.beep(1240, 0.7, 0.32);
    else this.beep(620, 0.2, 0.28);
  }

  playUi(kind: 'hover' | 'click' | 'back' | 'start'): void {
    const gains = { hover: 0.35, click: 0.6, back: 0.6, start: 0.8 };
    this.play(`ui_${kind}`, gains[kind], kind === 'hover' ? 0.95 + Math.random() * 0.1 : 1, this.uiGain);
  }

  playNearMiss(): void {
    this.play('whoosh_1', 0.75, 0.9 + Math.random() * 0.3, this.sfxGain, (Math.random() - 0.5) * 1.2);
  }

  playLap(final: boolean): void {
    this.play('lap', 0.7, 1, this.uiGain);
    if (final && this.ctx) {
      // rising arpeggio for the final lap
      [0, 0.11, 0.22].forEach((t, i) => setTimeout(() => this.beep([660, 880, 1320][i], i === 2 ? 0.45 : 0.14, 0.22), t * 1000 + 250));
    }
  }

  playNitroStart(): void {
    this.play('nitro_burst', 0.55, 1, this.sfxGain);
  }

  // ------------------------------------------------------------------ music

  playMusic(kind: MusicKind): void {
    this.wantedMusic = kind;
    if (!this.ctx) return;
    if (this.music && this.music.kind === kind) return;
    const name = MUSIC[kind];
    if (!this.core.buffers.has(name)) {
      void this.loadMusic(name);
      return;
    }
    this.startMusic(kind);
  }

  private startMusic(kind: MusicKind) {
    const ctx = this.ctx;
    const buf = this.core.buffers.get(MUSIC[kind]);
    if (!ctx || !buf || !this.musicGain) return;
    this.fadeOutMusic(1.2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const [a, b] = loopRegion(buf);
    src.loopStart = a;
    src.loopEnd = b;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(1, ctx.currentTime, 0.35);
    src.connect(g).connect(this.musicGain);
    src.start(ctx.currentTime, a);
    this.music = { kind, src, gain: g };
  }

  private fadeOutMusic(fade: number) {
    const ctx = this.ctx;
    const m = this.music;
    this.music = null;
    if (!ctx || !m) return;
    const now = ctx.currentTime;
    m.gain.gain.cancelScheduledValues(now);
    m.gain.gain.setTargetAtTime(0, now, Math.max(0.02, fade / 3));
    try {
      m.src.stop(now + fade + 0.2);
    } catch {
      /* ignore */
    }
    m.src.onended = () => m.gain.disconnect();
  }

  stopMusic(fade = 1): void {
    this.wantedMusic = null;
    this.fadeOutMusic(fade);
  }

  // ------------------------------------------------------------------ global state

  setMenuMode(on: boolean): void {
    this.menuMode = on;
    const ctx = this.ctx;
    if (!ctx || !this.worldFilter || !this.worldGain) return;
    setParam(this.worldFilter.frequency, on ? 650 : 20000, ctx, on ? 0.08 : 0.15);
    setParam(this.worldGain.gain, on ? 0.35 : 1, ctx, 0.12);
  }

  setTunnel(amount: number): void {
    this.tunnel = Math.max(0, Math.min(1, amount));
    const ctx = this.ctx;
    if (!ctx || !this.tunnelSend) return;
    setParam(this.tunnelSend.gain, this.tunnel * 0.55, ctx, 0.25);
  }

  update(dt: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.scrapeGain) return;
    this.scrapeAge += dt;
    if (this.scrapeAge > 0.15) this.scrapeLevel = Math.max(0, this.scrapeLevel - dt * 6);
    const lvl = this.scrapeLevel;
    setParam(this.scrapeGain.gain, Math.pow(lvl, 0.8) * 0.8, ctx, 0.04);
    if (this.scrapeSrc) setParam(this.scrapeSrc.playbackRate, 0.8 + lvl * 0.5, ctx, 0.08);
  }
}
