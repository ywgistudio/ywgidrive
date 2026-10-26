import type { InputState } from '../core/Input';

interface Sample {
  t: number;
  steer: number;
  throttle: number;
  brake: number;
  handbrake: number;
}

export interface DrunkOutput {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: number;
}

/**
 * Drunk-mode impairment applied between the player's controls and the car: reactions arrive late,
 * the hands wander and over-correct, the car occasionally lurches, and the right foot hiccups.
 * `level` drifts slowly so the run has good and bad stretches.
 */
export class Drunk {
  level = 0;
  private t = 0;
  private buf: Sample[] = [];
  private lurch = 0;
  private lurchDir = 1;
  private lurchT = 0;
  private nextLurch = 6;
  private hiccupT = 0;
  private nextHiccup = 9;
  private out: DrunkOutput = { steer: 0, throttle: 0, brake: 0, handbrake: 0 };

  reset(level: number) {
    this.level = level;
    this.t = 0;
    this.buf.length = 0;
    this.lurchT = 0;
    this.hiccupT = 0;
    this.nextLurch = 5 + Math.random() * 4;
    this.nextHiccup = 8 + Math.random() * 6;
  }

  /** Blood-alcohol style readout for the HUD (fictional scale). */
  get bac(): number {
    return 0.08 + this.level * 0.12;
  }

  apply(dt: number, raw: InputState, base: number): DrunkOutput {
    this.t += dt;
    const t = this.t;
    // slow waves of better/worse
    this.level = Math.min(1, Math.max(0, base + 0.15 * Math.sin(t * 0.06) + 0.05 * Math.sin(t * 0.23)));
    const L = this.level;

    this.buf.push({ t, steer: raw.steer, throttle: raw.throttle, brake: raw.brake, handbrake: raw.handbrake });
    const delay = 0.12 + 0.16 * L + 0.05 * Math.sin(t * 0.5);
    let d = this.buf[0];
    while (this.buf.length > 1 && this.buf[1].t <= t - delay) {
      this.buf.shift();
      d = this.buf[0];
    }
    if (d.t > t - delay) d = this.buf[0];

    // wandering hands + over-correction
    const wander = (0.2 * Math.sin(t * 0.41) + 0.11 * Math.sin(t * 1.27 + 0.7) + 0.06 * Math.sin(t * 2.9 + 2.1)) * L;
    let steer = d.steer * (1 + 0.3 * L) + wander;

    // lurches: a sudden involuntary tug every several seconds
    this.nextLurch -= dt;
    if (this.nextLurch <= 0) {
      this.lurchT = 0.38;
      this.lurchDir = Math.random() < 0.5 ? -1 : 1;
      this.nextLurch = 5 + Math.random() * 7 - L * 2;
    }
    if (this.lurchT > 0) {
      this.lurchT -= dt;
      const k = Math.sin(Math.max(0, this.lurchT / 0.38) * Math.PI);
      steer += this.lurchDir * k * 0.55 * L;
    }

    // throttle hiccups: the foot slips off for a moment
    let throttle = d.throttle;
    this.nextHiccup -= dt;
    if (this.nextHiccup <= 0) {
      this.hiccupT = 0.28;
      this.nextHiccup = 7 + Math.random() * 8;
    }
    if (this.hiccupT > 0) {
      this.hiccupT -= dt;
      throttle *= 0.15;
    }

    const o = this.out;
    o.steer = Math.max(-1, Math.min(1, steer));
    o.throttle = throttle;
    o.brake = d.brake;
    o.handbrake = d.handbrake;
    return o;
  }
}
