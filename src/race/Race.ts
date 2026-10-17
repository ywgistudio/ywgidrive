import * as THREE from 'three';
import type { Track, Projection } from '../track/Track';
import { START_S } from '../track/TrackDef';
import type { Vehicle } from '../vehicle/Vehicle';

export type RacePhase = 'grid' | 'countdown' | 'running' | 'finished';

export interface Racer {
  id: number;
  name: string;
  carName: string;
  color: string;
  vehicle: Vehicle;
  player: boolean;
  proj: Projection;
  progress: number; // meters since the start line (negative on the grid)
  lap: number; // completed laps
  lapStart: number;
  lastLap: number | null;
  bestLap: number | null;
  finished: boolean;
  finishTime: number | null;
  position: number;
  wrongWay: number; // seconds driving the wrong way
}

export interface RaceEvents {
  onCountdown?: (step: 3 | 2 | 1 | 0) => void;
  onLap?: (r: Racer, lapTime: number, isBest: boolean, finalLapNext: boolean) => void;
  onFinish?: (r: Racer) => void;
  onAllFinished?: () => void;
}

export class Race {
  readonly track: Track;
  laps: number;
  phase: RacePhase = 'grid';
  time = 0; // race clock (starts at GO)
  private countdownT = 0;
  private lastStep = 4;
  readonly racers: Racer[] = [];
  events: RaceEvents = {};
  private finishOrder = 0;

  constructor(track: Track, laps: number) {
    this.track = track;
    this.laps = laps;
  }

  add(vehicle: Vehicle, name: string, carName: string, color: string, player: boolean): Racer {
    const proj = this.track.project(vehicle.position);
    const r: Racer = {
      id: this.racers.length,
      name,
      carName,
      color,
      vehicle,
      player,
      proj,
      progress: this.track.deltaS(START_S, proj.s),
      lap: 0,
      lapStart: 0,
      lastLap: null,
      bestLap: null,
      finished: false,
      finishTime: null,
      position: this.racers.length + 1,
      wrongWay: 0,
    };
    this.racers.push(r);
    return r;
  }

  startCountdown() {
    this.phase = 'countdown';
    this.countdownT = 0;
    this.lastStep = 4;
  }

  get countdownRemaining(): number {
    return Math.max(0, 3 - this.countdownT);
  }

  get started(): boolean {
    return this.phase === 'running' || this.phase === 'finished';
  }

  update(dt: number) {
    if (this.phase === 'countdown') {
      this.countdownT += dt;
      const step = Math.max(0, 3 - Math.floor(this.countdownT)) as 3 | 2 | 1 | 0;
      if (step < this.lastStep) {
        this.lastStep = step;
        this.events.onCountdown?.(step);
        if (step === 0) {
          this.phase = 'running';
          this.time = 0;
          for (const r of this.racers) r.lapStart = 0;
        }
      }
    } else if (this.phase === 'running' || this.phase === 'finished') {
      this.time += dt;
    }

    const L = this.track.length;
    for (const r of this.racers) {
      const prevS = r.proj.s;
      this.track.project(r.vehicle.position, r.proj.index, r.proj);
      let d = this.track.deltaS(prevS, r.proj.s);
      if (Math.abs(d) > 60) d = 0; // teleport/reset guard
      if (!r.finished) r.progress += d;

      // wrong way: velocity against the track tangent
      const i = r.proj.index;
      const v = r.vehicle.velocity;
      const along = v.x * this.track.tx[i] + v.y * this.track.ty[i] + v.z * this.track.tz[i];
      if (along < -4) r.wrongWay += dt;
      else r.wrongWay = Math.max(0, r.wrongWay - dt * 3);

      if (!this.started || r.finished) continue;
      const lapsDone = Math.floor(r.progress / L);
      if (lapsDone > r.lap && r.progress > 0) {
        r.lap = lapsDone;
        const lapTime = this.time - r.lapStart;
        r.lapStart = this.time;
        r.lastLap = lapTime;
        const isBest = r.bestLap === null || lapTime < r.bestLap;
        if (isBest) r.bestLap = lapTime;
        if (r.lap >= this.laps) {
          r.finished = true;
          r.finishTime = this.time;
          this.finishOrder++;
          this.events.onFinish?.(r);
          if (r.player) this.phase = 'finished';
        } else {
          this.events.onLap?.(r, lapTime, isBest, r.lap === this.laps - 1);
        }
      }
    }

    // standings
    const sorted = [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return (a.finishTime ?? 0) - (b.finishTime ?? 0);
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    sorted.forEach((r, k) => (r.position = k + 1));
    if (this.racers.length && this.racers.every((r) => r.finished)) this.events.onAllFinished?.();
  }

  get standings(): Racer[] {
    return [...this.racers].sort((a, b) => a.position - b.position);
  }

  /** Seconds gap estimate between two racers using the slower car's speed. */
  gap(a: Racer, b: Racer): number {
    const d = Math.abs(a.progress - b.progress);
    const v = Math.max(8, Math.min(Math.abs(a.vehicle.speed), Math.abs(b.vehicle.speed)));
    return d / v;
  }

  currentLapTime(r: Racer): number {
    return this.started ? this.time - r.lapStart : 0;
  }

  /** World position on the start grid for slot i (2 columns, staggered). */
  static gridSlot(track: Track, i: number, out = new THREE.Vector3()): { s: number; lateral: number } {
    const row = Math.floor(i / 2);
    const col = i % 2;
    return { s: START_S - 10 - row * 9 - col * 3, lateral: col === 0 ? 1.9 : 5.5 };
  }
}
