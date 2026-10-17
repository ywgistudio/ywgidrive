import * as THREE from 'three';
import type { Vehicle } from '../vehicle/Vehicle';
import type { Track, Projection } from '../track/Track';

export interface AIObstacle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  halfLength: number;
  halfWidth: number;
  s: number;
  lateral: number;
}

export interface AIContext {
  obstacles: AIObstacle[];
  playerS: number;
  selfS: number;
  raceStarted: boolean;
  /** -1..1, + = AI is behind the player and should push harder */
  rubberBand: number;
}

export interface RacerAIOptions {
  skill: number; // 0.85..1.05
  aggression: number; // 0..1
  laneBias?: number; // meters added to the racing line (spreads the pack)
}

const G = 9.81;
const SECTION = 25; // meters per adaptive speed section

/**
 * Per-car-model learned speed multipliers per track section. Shared by all AI using the same spec,
 * so the field quickly learns where its car under/over-performs the analytic racing speed profile.
 */
const learned = new Map<string, Float32Array>();
const _rear = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _d = new THREE.Vector3();
const _left = new THREE.Vector3();
const _frame = { pos: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };

/**
 * Racing-line follower: pure-pursuit steering, curvature speed profile with lookahead braking,
 * PI throttle/brake, overtaking/avoidance and stuck recovery. Writes vehicle.input only.
 */
export class RacerAI {
  readonly vehicle: Vehicle;
  readonly track: Track;
  readonly skill: number;
  readonly aggression: number;
  laneBias: number;

  /** Set when the car is flipped / out of bounds / hopelessly stuck. Caller resets the car then calls onReset(). */
  needsReset = false;
  /** Latest projection of the car onto the track. */
  readonly proj: Projection = { index: -1, s: 0, lateral: 0, height: 0 };
  /** Telemetry for debugging/tuning. */
  readonly debug = { vCmd: 0, latTarget: 0, avoid: 0, blocked: false };

  private gripMu: number;
  private avoid = 0; // lateral offset relative to the racing line (m)
  private avoidTarget = 0;
  private avoidHold = 0;
  private integ = 0;
  private stuckTimer = 0;
  private recovering = false;
  private recoverTimer = 0;
  private recoverSteer = 0;
  private flipTimer = 0;
  private outTimer = 0;
  private wrongWayTimer = 0;
  private progressS = 0;
  private progressTimer = 0;
  private progressAcc = 0;
  private lastS = -1;
  private mistakeTimer = 0;
  private mistakeSpeed = 1;
  private mistakeLat = 0;
  private wobblePhase = Math.random() * 10;
  private nitroCooldown = 0;
  private lastSteer = 0;
  private sectionMult: Float32Array;
  private curSection = -1;
  private secBad = 0;
  private secLimited = false;
  private secAvoided = false;

  constructor(vehicle: Vehicle, track: Track, opts: RacerAIOptions) {
    this.vehicle = vehicle;
    this.track = track;
    this.skill = opts.skill;
    this.aggression = THREE.MathUtils.clamp(opts.aggression, 0, 1);
    this.laneBias = opts.laneBias ?? 0;
    // Effective usable lateral grip relative to the mu=1 racing speed profile.
    const spec = vehicle.spec;
    const aeroBonus = (spec.clFront + spec.clRear) * 0.08;
    // steady-state skidpad grip measures ~0.85-0.92 x peak mu; transients need some margin on top
    this.gripMu = spec.tireLat.mu * 0.84 + aeroBonus;
    const n = Math.ceil(track.length / SECTION);
    let arr = learned.get(spec.id);
    if (!arr || arr.length !== n) {
      arr = new Float32Array(n).fill(1);
      learned.set(spec.id, arr);
    }
    this.sectionMult = arr;
    // AI drives with stability aids on but less countersteer meddling than the player default.
    vehicle.assists = { abs: true, tcs: true, esc: true, steerAssist: 0.55, autoGear: true };
  }

  /** Clear recovery state after the caller has reset the vehicle onto the track. */
  onReset() {
    this.needsReset = false;
    this.stuckTimer = 0;
    this.recovering = false;
    this.recoverTimer = 0;
    this.flipTimer = 0;
    this.outTimer = 0;
    this.wrongWayTimer = 0;
    this.progressTimer = 0;
    this.progressAcc = 0;
    this.lastS = -1;
    this.integ = 0;
    this.avoid = 0;
    this.avoidTarget = 0;
    this.proj.index = -1;
  }

  /** Speed target at arc length s for this car (m/s). */
  speedTarget(s: number, rubberBand: number): number {
    const k = Math.sqrt(this.gripMu) * this.skill * (1 + 0.06 * THREE.MathUtils.clamp(rubberBand, -1, 1)) * this.mistakeSpeed;
    const ss = this.track.wrapS(s) / SECTION;
    const n = this.sectionMult.length;
    const i0 = Math.floor(ss);
    const f = ss - i0;
    const m = this.sectionMult[i0 % n] * (1 - f) + this.sectionMult[(i0 + 1) % n] * f;
    return this.track.racingSpeedAt(s) * k * m;
  }

  private maxSteerAt(v: number): number {
    const spec = this.vehicle.spec;
    const vv = Math.max(Math.abs(v), 1);
    const gripSteer = Math.atan((spec.wheelbase * spec.tireLat.mu * G * 1.05) / (vv * vv)) + spec.tireLat.peakSlip * 1.1;
    return Math.min(spec.maxSteer, gripSteer);
  }

  /**
   * Section-wise online adaptation of the speed profile. Penalises running wide (toward the outside
   * of the corner or onto the curb) in a section and the braking sections before it; slowly rewards
   * clean sections where the speed target was the limiting factor.
   */
  private learn(s: number, index: number, lat: number, vCmd: number, v: number, saturated: boolean, disturbed: boolean) {
    const track = this.track;
    const sec = Math.floor(track.wrapS(s) / SECTION);
    const here = track.racingLineAt(s) + this.laneBias + this.avoid;
    const ci = track.curvature[index];
    const outward = Math.abs(ci) > 0.002 ? (ci > 0 ? here - lat : lat - here) : 0;
    const edge = Math.abs(lat) + this.vehicle.spec.bodyHalf[0] - track.halfWidth;
    let bad = 0;
    if (v > 8) {
      if (outward > 2.2) bad = Math.max(bad, outward > 3.5 ? 2 : 1);
      if (edge > 0.15) bad = Math.max(bad, edge > 0.6 ? 2 : 1);
      if (saturated && outward > 1.0 && v > 15) bad = Math.max(bad, 1);
    }
    if (sec !== this.curSection) {
      if (this.curSection >= 0 && !this.secAvoided) {
        const arr = this.sectionMult;
        const n = arr.length;
        if (this.secBad > 0) {
          const dec = this.secBad > 1 ? 0.03 : 0.015;
          for (let k = 0; k < 3; k++) {
            const j = (this.curSection - k + n) % n;
            arr[j] = Math.max(0.85, arr[j] - dec * (k === 0 ? 1 : 0.6));
          }
        } else if (this.secLimited) {
          arr[this.curSection] = Math.min(1.12, arr[this.curSection] + 0.005);
        }
      }
      this.curSection = sec;
      this.secBad = 0;
      this.secLimited = false;
      this.secAvoided = false;
    }
    if (disturbed) this.secAvoided = true;
    this.secBad = Math.max(this.secBad, bad);
    if (v > 8 && vCmd < v + 1.0) this.secLimited = true;
  }

  update(dt: number, ctx: AIContext) {
    const veh = this.vehicle;
    const track = this.track;
    const spec = veh.spec;
    const inp = veh.input;
    const p = track.project(veh.position, this.proj.index, this.proj);
    const s = p.s;
    const v = veh.speed;
    const hw = track.halfWidth;
    const lim = hw - 1.5;

    if (!ctx.raceStarted) {
      inp.throttle = 0;
      inp.brake = 1;
      inp.steer = 0;
      inp.handbrake = 0;
      inp.nitro = false;
      this.lastS = s;
      return;
    }

    // ---------- watchdogs ----------
    const up = veh.upVec;
    this.flipTimer = up.y < 0.35 ? this.flipTimer + dt : 0;
    const outside = Math.abs(p.lateral) > hw + track.sidewalk[p.index] + 2.5 || Math.abs(p.height) > 6;
    this.outTimer = outside ? this.outTimer + dt : 0;
    const tdot = veh.forward.x * track.tx[p.index] + veh.forward.y * track.ty[p.index] + veh.forward.z * track.tz[p.index];
    this.wrongWayTimer = tdot < -0.3 ? this.wrongWayTimer + dt : 0;
    if (this.lastS >= 0) this.progressAcc += track.deltaS(this.lastS, s);
    this.lastS = s;
    this.progressTimer += dt;
    if (this.progressTimer > 8) {
      if (this.progressAcc < 15) this.needsReset = true;
      this.progressTimer = 0;
      this.progressAcc = 0;
    }
    if (this.flipTimer > 2.5 || this.outTimer > 1.0 || this.wrongWayTimer > 5) this.needsReset = true;

    // ---------- mistakes (low skill only) ----------
    this.mistakeTimer -= dt;
    if (this.mistakeTimer <= 0) {
      this.mistakeSpeed = 1;
      this.mistakeLat = 0;
      // checked every 0.25 s; rate ~ (1.02 - skill) * 0.25 mistakes per second
      const pMistake = Math.max(0, 1.02 - this.skill) * 0.25;
      if (Math.random() < pMistake * 0.25) {
        if (Math.random() < 0.5) {
          this.mistakeSpeed = 1.04 + Math.random() * 0.04; // late braking
        } else {
          this.mistakeLat = (Math.random() - 0.5) * 3; // sloppy line
        }
        this.mistakeTimer = 1.5 + Math.random() * 1.5;
      } else this.mistakeTimer = 0.25;
    }

    // ---------- avoidance ----------
    const myHalfW = spec.bodyHalf[0];
    const myHalfL = spec.bodyHalf[2];
    const margin = 0.55 + (1 - this.aggression) * 0.6;
    let blockSpeed = Infinity;
    let urgent: AIObstacle | null = null;
    let urgentTtc = Infinity;
    const curLat = p.lateral;
    for (const o of ctx.obstacles) {
      const ds = track.deltaS(s, o.s);
      if (ds < -(myHalfL + o.halfLength)) continue;
      const oi = track.wrap(Math.floor(track.wrapS(o.s) / track.step));
      const oAlong = o.velocity.x * track.tx[oi] + o.velocity.y * track.ty[oi] + o.velocity.z * track.tz[oi];
      const closing = v - oAlong;
      const range = THREE.MathUtils.clamp(closing * 3.2, 45, 220);
      if (ds > range) continue;
      const gap = ds - myHalfL - o.halfLength;
      if (closing <= 0.5 && gap > 6) continue;
      const ttc = gap > 0 ? gap / Math.max(closing, 0.1) : 0;
      if (ttc > 3.2) continue;
      // where will we be laterally when we reach it
      const blend = THREE.MathUtils.clamp(ds / 40, 0, 1);
      const planned = THREE.MathUtils.clamp(track.racingLineAt(o.s) + this.laneBias + this.avoid, -lim, lim);
      const myLat = curLat + (planned - curLat) * blend;
      const need = myHalfW + o.halfWidth + margin;
      if (Math.abs(myLat - o.lateral) < need) {
        if (ttc < urgentTtc) {
          urgentTtc = ttc;
          urgent = o;
        }
      }
    }
    if (urgent) {
      const o = urgent;
      const need = myHalfW + o.halfWidth + margin + 0.35;
      const cands = [o.lateral - need, o.lateral + need];
      const rl = track.racingLineAt(o.s) + this.laneBias;
      let best = NaN;
      let bestCost = Infinity;
      for (const c of cands) {
        if (c < -lim - 0.6 || c > lim + 0.6) continue;
        const cc = THREE.MathUtils.clamp(c, -lim, lim);
        // other obstacles near the same spot block this side
        let blocked = false;
        for (const o2 of ctx.obstacles) {
          if (o2 === o) continue;
          const d2 = track.deltaS(o.s, o2.s);
          if (Math.abs(d2) > 18) continue;
          if (Math.abs(o2.lateral - cc) < myHalfW + o2.halfWidth + 0.4) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        const cost = Math.abs(cc - rl) + Math.abs(cc - curLat) * 0.6;
        if (cost < bestCost) {
          bestCost = cost;
          best = cc;
        }
      }
      const oi = track.wrap(Math.floor(track.wrapS(o.s) / track.step));
      const oAlong = o.velocity.x * track.tx[oi] + o.velocity.y * track.ty[oi] + o.velocity.z * track.tz[oi];
      if (!Number.isNaN(best)) {
        this.avoidTarget = best - rl;
        this.avoidHold = 0.6;
        // If the lateral move cannot finish in time, scrub some speed too.
        const move = Math.abs(best - curLat);
        if (move > 1.2 && urgentTtc < move / 3.5) blockSpeed = Math.max(oAlong + 2, 0);
      } else if (urgentTtc < 1.8) {
        blockSpeed = Math.max(oAlong - 1.5, 0);
      }
    }
    if (this.avoidHold > 0) this.avoidHold -= dt;
    else this.avoidTarget *= Math.max(0, 1 - dt * 0.8);
    const rate = urgent ? 3.0 : 1.2;
    this.avoid += THREE.MathUtils.clamp(this.avoidTarget - this.avoid, -rate * dt * 4, rate * dt * 4) * Math.min(1, dt * rate * 2);

    // ---------- steering: pure pursuit from the rear axle ----------
    const b = spec.wheelbase * spec.frontWeight; // COM to rear axle
    _rear.copy(veh.position).addScaledVector(veh.forward, -b);
    const vAbs = Math.abs(v);
    const ld = THREE.MathUtils.clamp(7 + vAbs * 0.42, 9, 38);
    const sT = s + ld;
    this.wobblePhase += dt;
    const wob = this.mistakeLat * Math.sin(this.wobblePhase * 1.7);
    const latT = THREE.MathUtils.clamp(track.racingLineAt(sT) + this.laneBias + this.avoid + wob, -lim, lim);
    track.pointAt(sT, latT, _tgt);
    _d.subVectors(_tgt, _rear);
    _left.set(1, 0, 0).applyQuaternion(veh.quaternion);
    const x = _d.dot(_left);
    const z = _d.dot(veh.forward);
    const dist = Math.max(Math.hypot(x, z), 1);
    const alpha = Math.atan2(x, z);
    let delta = Math.atan2(2 * spec.wheelbase * Math.sin(alpha), dist);
    // yaw-rate damping against oscillation at speed
    const desiredYaw = (vAbs * Math.tan(delta)) / spec.wheelbase;
    delta += (desiredYaw - veh.yawRate) * 0.02 * Math.min(1, vAbs / 30);
    let steer = -delta / this.maxSteerAt(v);
    // Stay just under full lock at speed: the vehicle reads a full-lock flick while sliding as drift intent.
    const steerLim = vAbs > 12 ? 0.84 : 1;
    steer = THREE.MathUtils.clamp(steer, -steerLim, steerLim);

    // ---------- speed control ----------
    const lead = Math.max(0, v) * 0.32 + 3;
    let vCmd = Math.min(this.speedTarget(s + lead, ctx.rubberBand), this.speedTarget(s + lead * 0.5, ctx.rubberBand));
    // extra check further ahead with braking distance (covers avoidance-induced line changes)
    const aBrake = 0.82 * G * this.gripMu;
    for (let d = 10; d <= 120; d += 10) {
      const vt = this.speedTarget(s + lead + d, ctx.rubberBand);
      const allow = Math.sqrt(vt * vt + 2 * aBrake * d);
      if (allow < vCmd) vCmd = allow;
    }
    vCmd = Math.min(vCmd, blockSpeed);
    // tight steering at speed = understeer risk: ease off
    if (Math.abs(steer) > 0.82 && vAbs > 15) vCmd = Math.min(vCmd, vAbs - 1.5);

    const err = vCmd - v;
    this.debug.vCmd = vCmd;
    this.debug.latTarget = latT;
    this.debug.avoid = this.avoid;
    this.debug.blocked = urgent !== null;
    this.learn(s, p.index, p.lateral, vCmd, v, Math.abs(steer) > 0.82, urgent !== null || Math.abs(this.avoid) > 0.5 || this.mistakeLat !== 0);
    this.integ = THREE.MathUtils.clamp(this.integ + err * dt * 0.5, -0.4, 0.4);
    let u = err * 0.32 + this.integ;
    if (err > 2.5) u = 1;
    let throttle = THREE.MathUtils.clamp(u, 0, 1);
    let brake = THREE.MathUtils.clamp(-u * 0.9, 0, 1);
    if (err > -0.6) brake = 0;
    if (brake > 0) throttle = 0;
    // sliding: feather the throttle
    const slip = Math.abs(veh.bodySlip);
    if (slip > 0.16) throttle *= THREE.MathUtils.clamp(1 - (slip - 0.16) * 3, 0.25, 1);

    // ---------- nitro on straights ----------
    this.nitroCooldown -= dt;
    let nitro = false;
    if (veh.nitro > 0.3 && Math.abs(steer) < 0.2 && throttle > 0.95 && vAbs > 20 && this.nitroCooldown <= 0) {
      let straight = true;
      for (let d = 40; d <= 180; d += 35) {
        if (this.speedTarget(s + d, ctx.rubberBand) < vAbs + 12) {
          straight = false;
          break;
        }
      }
      nitro = straight;
    }
    if (veh.boosting && !nitro) this.nitroCooldown = 1.5;

    // ---------- stuck recovery ----------
    if (vAbs < 2 && !this.recovering) this.stuckTimer += dt;
    else if (!this.recovering) this.stuckTimer = 0;
    if (this.stuckTimer > 2) {
      this.recovering = true;
      this.recoverTimer = 0;
      this.stuckTimer = 0;
      this.recoverSteer = steer >= 0 ? -1 : 1;
    }
    if (this.recovering) {
      this.recoverTimer += dt;
      inp.throttle = 0;
      inp.brake = 1; // auto gearbox engages reverse at standstill; brake acts as throttle in reverse
      inp.steer = this.recoverSteer;
      inp.handbrake = 0;
      inp.nitro = false;
      if (this.recoverTimer > 1.9) {
        this.recovering = false;
        this.integ = 0;
      }
      return;
    }

    // smooth steering a little to avoid twitch (vehicle also rate-limits)
    const sm = Math.min(1, dt * 14);
    this.lastSteer += (steer - this.lastSteer) * sm;
    inp.steer = this.lastSteer;
    inp.throttle = throttle;
    inp.brake = brake;
    inp.handbrake = 0;
    inp.nitro = nitro;
  }
}
