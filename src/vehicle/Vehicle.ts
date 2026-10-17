import * as THREE from 'three';
import { RAPIER, CAR_GROUPS, WHEEL_RAY_GROUPS } from '../physics/Physics';
import { type CarSpec, torqueAt } from './CarSpec';

export interface VehicleInput {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1 (left) .. 1 (right)
  handbrake: number; // 0..1
  nitro: boolean;
}

export interface Assists {
  abs: boolean;
  tcs: boolean;
  esc: boolean;
  steerAssist: number; // 0..1 countersteer help
  autoGear: boolean;
}

export const DEFAULT_ASSISTS: Assists = { abs: true, tcs: true, esc: true, steerAssist: 0.7, autoGear: true };

/** Surface lookup: collider handle -> grip multiplier & roughness. */
export const surfaceGrip = new Map<number, { grip: number; bump: number; kind: number }>();

const G = 9.81;
const RAD2RPM = 60 / (2 * Math.PI);

function pacejka(x: number, B: number, C: number, E: number): number {
  const bx = B * x;
  return Math.sin(C * Math.atan(bx - E * (bx - Math.atan(bx))));
}

function bFromPeak(peak: number, C: number): number {
  return Math.tan(Math.PI / (2 * C)) / peak;
}

export class Wheel {
  readonly front: boolean;
  readonly left: boolean;
  readonly local = new THREE.Vector3();
  readonly radius: number;
  readonly k: number;
  readonly cBump: number;
  readonly cRebound: number;
  compression = 0;
  prevCompression = 0;
  contact = false;
  readonly point = new THREE.Vector3();
  readonly normal = new THREE.Vector3(0, 1, 0);
  omega = 0;
  spin = 0; // visual rotation angle
  steer = 0;
  alpha = 0; // relaxed slip angle
  slipRatio = 0;
  fx = 0;
  fy = 0;
  fz = 0;
  driveTorque = 0;
  brakeTorque = 0;
  absScale = 1;
  surfaceKind = 0;
  skid = 0; // 0..1 how hard this tire is sliding
  slideSpeed = 0; // m/s of contact patch sliding
  driven = false;
  inertiaEff = 1;
  hold = 0; // static-friction anchor displacement (m)

  constructor(front: boolean, left: boolean, spec: CarSpec) {
    this.front = front;
    this.left = left;
    this.radius = spec.wheelRadius;
    const axleLoad = spec.mass * G * (front ? spec.frontWeight : 1 - spec.frontWeight);
    const cornerMass = axleLoad / 2 / G;
    const f = front ? spec.freqFront : spec.freqRear;
    this.k = cornerMass * (2 * Math.PI * f) ** 2;
    const crit = 2 * Math.sqrt(this.k * cornerMass);
    this.cBump = crit * spec.dampBump;
    this.cRebound = crit * spec.dampRebound;
    const staticComp = (cornerMass * G) / this.k;
    const a = spec.wheelbase * (1 - spec.frontWeight); // COM to front axle
    const b = spec.wheelbase * spec.frontWeight; // COM to rear axle
    const z = front ? a : -b;
    const x = (left ? 1 : -1) * (front ? spec.trackFront : spec.trackRear) * 0.5;
    const y = spec.wheelRadius + spec.suspLength - staticComp - spec.cgHeight;
    this.local.set(x, y, z);
  }
}

const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _left = new THREE.Vector3();
const _lv = new THREE.Vector3();
const _av = new THREE.Vector3();
const _hp = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _s = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _F = new THREE.Vector3();
const _T = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _worldUp = new THREE.Vector3(0, 1, 0);

export class Vehicle {
  readonly spec: CarSpec;
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[] = [];
  readonly wheels: Wheel[];
  readonly world: RAPIER.World;
  private ray: RAPIER.Ray;

  input: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: false };
  assists: Assists = { ...DEFAULT_ASSISTS };
  steerSmoothed = 0;
  steerAngle = 0;

  gear = 1;
  rpm = 900;
  shiftTimer = 0;
  private shiftTarget = 1;
  private reverseTimer = 0;
  clutch = 1;
  throttleOut = 0;
  tcsCut = 0;
  boosting = false;
  nitro = 1; // 0..1 tank
  nitroDuration = 4.5; // seconds for a full tank
  lastShiftUp = false;
  shiftEvent = 0; // increments on each shift (audio hook)
  backfire = 0; // >0 when a lift-off pop should play
  /** 1 at the start of a downshift (rev-matching throttle blip), decays to 0 — audio hook. */
  blip = 0;
  /** >0 for a moment after a clutch kick (handbrake released with the engine revved). */
  clutchKick = 0;
  /** true while the launch clutch is slipping (1st gear pull-away). */
  clutchSlipping = false;
  limiterCut = false;
  private prevHandbrake = 0;
  private shiftHold = 0; // seconds to wait before the auto box may downshift again
  private driftIntent = 0; // seconds: player deliberately initiated a slide (ESC backs off)

  // telemetry
  speed = 0; // forward speed m/s
  readonly velocity = new THREE.Vector3();
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly prevPosition = new THREE.Vector3();
  readonly prevQuaternion = new THREE.Quaternion();
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly upVec = new THREE.Vector3(0, 1, 0);
  bodySlip = 0; // radians between heading and velocity
  yawRate = 0;
  airTime = 0;
  groundedWheels = 4;
  load = 0; // engine load 0..1 for audio
  private fz0: number;
  private Blat: number;
  private Blong: number;
  private driven: Wheel[];
  private rearDriven: boolean;
  private tanPeakLat: number;
  private readonly _rv = { x: 0, y: 0, z: 0 };
  private readonly _rq = { x: 0, y: 0, z: 0, w: 1 };
  private readonly _imp = { x: 0, y: 0, z: 0 };
  readonly totalGearRatioCache: number[];

  constructor(world: RAPIER.World, spec: CarSpec, pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.world = world;
    this.spec = spec;
    this.fz0 = (spec.mass * G) / 4;
    this.Blat = bFromPeak(spec.tireLat.peakSlip, spec.tireLat.C);
    this.Blong = bFromPeak(spec.tireLong.peakSlip, spec.tireLong.C);

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setAngularDamping(0.05)
      .setLinearDamping(0.0);
    this.body = world.createRigidBody(desc);

    const [hx, hy, hz] = spec.bodyHalf;
    const main = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(0, spec.bodyOffsetY, 0)
      .setMassProperties(spec.mass, { x: 0, y: 0, z: 0 }, { x: spec.inertia[0], y: spec.inertia[1], z: spec.inertia[2] }, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.18)
      .setRestitution(0.08)
      .setCollisionGroups(CAR_GROUPS)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(8000);
    this.colliders.push(world.createCollider(main, this.body));
    const cabin = RAPIER.ColliderDesc.cuboid(hx * 0.82, hy * 0.75, hz * 0.48)
      .setTranslation(0, spec.bodyOffsetY + hy * 1.6, -hz * 0.08)
      .setDensity(0)
      .setFriction(0.18)
      .setRestitution(0.05)
      .setCollisionGroups(CAR_GROUPS)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(8000);
    this.colliders.push(world.createCollider(cabin, this.body));

    this.wheels = [new Wheel(true, true, spec), new Wheel(true, false, spec), new Wheel(false, true, spec), new Wheel(false, false, spec)];
    for (const w of this.wheels) {
      w.driven = spec.drive === 'AWD' || (spec.drive === 'RWD' ? !w.front : w.front);
    }
    this.driven = this.wheels.filter((w) => w.driven);
    this.rearDriven = spec.drive !== 'FWD';
    this.tanPeakLat = Math.tan(spec.tireLat.peakSlip);
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.totalGearRatioCache = spec.gears.map((g) => g * spec.finalDrive);
    this.syncState();
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
  }

  get speedKmh(): number {
    return Math.abs(this.speed) * 3.6;
  }

  gearRatio(gear = this.gear): number {
    if (gear === 0) return 0;
    if (gear < 0) return -this.spec.reverseGear * this.spec.finalDrive;
    return this.spec.gears[gear - 1] * this.spec.finalDrive;
  }

  reset(pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const w of this.wheels) {
      w.omega = 0;
      w.alpha = 0;
      w.compression = 0;
      w.prevCompression = 0;
    }
    this.gear = 1;
    this.shiftTimer = 0;
    this.rpm = this.spec.idleRpm;
    this.syncState();
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
  }

  /** Pull pose/velocity from the rigid body into cached three.js objects. */
  syncState() {
    const t = this.body.translation();
    const q = this.body.rotation();
    const v = this.body.linvel();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(q.x, q.y, q.z, q.w);
    this.velocity.set(v.x, v.y, v.z);
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.upVec.set(0, 1, 0).applyQuaternion(this.quaternion);
  }

  /** Per-frame logic: input smoothing, steering, gearbox, nitro. */
  update(dt: number) {
    const spec = this.spec;
    const inp = this.input;
    const v = this.velocity;
    _left.set(1, 0, 0).applyQuaternion(this.quaternion);
    const vLong = v.dot(this.forward);
    const vLat = v.dot(_left);
    this.speed = vLong;
    const speedAbs = Math.hypot(vLong, vLat);
    this.bodySlip = speedAbs > 3 ? Math.atan2(vLat, Math.abs(vLong)) : 0;

    // --- Steering: speed sensitive limit derived from the grip needed to hold the front tires at peak slip.
    const target = THREE.MathUtils.clamp(inp.steer, -1, 1);
    const rate = target === 0 || Math.sign(target) !== Math.sign(this.steerSmoothed) ? spec.steerRate * 1.8 : spec.steerRate;
    const ds = target - this.steerSmoothed;
    this.steerSmoothed += THREE.MathUtils.clamp(ds, -rate * dt, rate * dt);
    const vv = Math.max(Math.abs(vLong), 1);
    const gripSteer = Math.atan((spec.wheelbase * spec.tireLat.mu * G * 1.05) / (vv * vv)) + spec.tireLat.peakSlip * 0.85;
    const maxSteer = Math.min(spec.maxSteer, gripSteer);
    let angle = -this.steerSmoothed * maxSteer; // positive = left
    // Countersteer assist: align front wheels with the direction of travel while sliding.
    // Only kicks in past a few degrees of body slip so normal grip driving stays crisp.
    if (this.assists.steerAssist > 0 && speedAbs > 5 && vLong > 0) {
      const dead = 0.05;
      const b = this.bodySlip;
      const excess = Math.sign(b) * Math.max(0, Math.abs(b) - dead);
      angle += excess * this.assists.steerAssist * 1.15;
    }
    this.steerAngle = THREE.MathUtils.clamp(angle, -spec.maxSteer, spec.maxSteer);
    // Ackermann
    const L = spec.wheelbase;
    const tw = spec.trackFront;
    const d = this.steerAngle;
    if (Math.abs(d) > 1e-4) {
      const Rt = L / Math.tan(Math.abs(d));
      const inner = Math.atan(L / (Rt - tw / 2));
      const outer = Math.atan(L / (Rt + tw / 2));
      const sg = Math.sign(d);
      // turning left (d>0): left wheel is inner
      this.wheels[0].steer = sg * (d > 0 ? inner : outer);
      this.wheels[1].steer = sg * (d > 0 ? outer : inner);
    } else {
      this.wheels[0].steer = this.wheels[1].steer = 0;
    }

    // --- Gearbox
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) {
        this.gear = this.shiftTarget;
        this.shiftTimer = 0;
      }
    }
    if (this.shiftHold > 0) this.shiftHold -= dt;
    if (this.assists.autoGear && this.shiftTimer <= 0) {
      const n = spec.gears.length;
      if (this.gear >= 1) {
        if (vLong < 0.8 && inp.brake > 0.3 && inp.throttle < 0.05) {
          this.reverseTimer += dt;
          if (this.reverseTimer > 0.35) {
            this.gear = -1;
            this.reverseTimer = 0;
          }
        } else this.reverseTimer = 0;
        // decisions use road speed (not spinning wheels) so wheelspin can't make the box hunt
        const speedRpm = (Math.max(0, vLong) / spec.wheelRadius) * this.gearRatio() * RAD2RPM;
        // part throttle short-shifts, full throttle holds to the redline
        const upRpm = spec.redline * THREE.MathUtils.lerp(0.62, 0.985, THREE.MathUtils.smoothstep(inp.throttle, 0.35, 0.9));
        const engineRpm = Math.max(speedRpm, this.clutchSlipping ? 0 : this.rpm);
        if (engineRpm > upRpm && speedRpm > upRpm * 0.8 && this.gear < n && inp.throttle > 0.2 && this.groundedWheels > 1) {
          this.shift(this.gear + 1);
          this.shiftHold = 1.0;
        } else if (this.gear > 1 && (this.shiftHold <= 0 || inp.brake > 0.2)) {
          const step = this.gearRatio(this.gear) / this.gearRatio(this.gear - 1); // < 1
          const demand = Math.max(inp.throttle, inp.brake * 0.85);
          const downCap = upRpm * step * 0.86; // never below the rpm an upshift lands on => no hunting
          const downRpm = Math.min(downCap, spec.redline * THREE.MathUtils.lerp(0.3, 0.6, demand));
          const lowerRpm = speedRpm / step;
          if (speedRpm < downRpm && lowerRpm < spec.redline * 0.9) {
            this.shift(this.gear - 1);
            this.shiftHold = 0.35;
          }
        }
      } else if (this.gear === -1) {
        if (inp.throttle > 0.05 && vLong > -1.0) this.gear = 1;
      }
    }

    // clutch kick detection (handbrake drift pull released with revs up)
    if (this.prevHandbrake > 0.5 && inp.handbrake <= 0.5 && inp.throttle > 0.5 && this.gear >= 1) this.clutchKick = 1;
    this.prevHandbrake = inp.handbrake;
    if (this.clutchKick > 0) this.clutchKick = Math.max(0, this.clutchKick - dt / 0.35);
    if (this.blip > 0) this.blip = Math.max(0, this.blip - dt * 4);

    // drift intent: handbrake or a big flick of steering while already sliding
    if (inp.handbrake > 0.3 || (Math.abs(inp.steer) > 0.85 && Math.abs(this.bodySlip) > 0.12) || this.clutchKick > 0) this.driftIntent = 1.6;
    else if (this.driftIntent > 0 && Math.abs(this.bodySlip) > 0.14 && (inp.throttle > 0.25 || Math.abs(inp.steer) > 0.3)) this.driftIntent = Math.max(this.driftIntent, 0.5);
    else this.driftIntent = Math.max(0, this.driftIntent - dt);

    // --- Nitro
    const wantBoost = inp.nitro && this.nitro > 0.01 && this.gear >= 1;
    this.boosting = wantBoost;
    if (wantBoost) this.nitro = Math.max(0, this.nitro - dt / this.nitroDuration);

    if (this.backfire > 0) this.backfire = Math.max(0, this.backfire - dt);
  }

  shift(to: number) {
    if (to === this.gear || this.shiftTimer > 0) return;
    if (to > this.spec.gears.length || to < -1) return;
    this.lastShiftUp = to > this.gear;
    this.shiftTarget = to;
    this.shiftTimer = this.spec.shiftTime;
    this.shiftEvent++;
    if (this.lastShiftUp && this.throttleOut > 0.6) this.backfire = 0.25;
    if (!this.lastShiftUp && to >= 1) this.blip = 1;
  }

  private drivenOmega(): number {
    let s = 0;
    for (const w of this.driven) s += w.omega;
    return s / this.driven.length;
  }

  addNitro(amount: number) {
    this.nitro = Math.min(1, this.nitro + amount);
  }

  /** One physics substep: suspension, tires, drivetrain, aero. Applies impulses to the body. */
  substep(dt: number) {
    const spec = this.spec;
    const body = this.body;
    const t = body.translation(this._rv);
    _pos.set(t.x, t.y, t.z);
    const q = body.rotation(this._rq);
    _q.set(q.x, q.y, q.z, q.w);
    const lv = body.linvel(this._rv);
    _lv.set(lv.x, lv.y, lv.z);
    const av = body.angvel(this._rv);
    _av.set(av.x, av.y, av.z);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _left.set(1, 0, 0).applyQuaternion(_q);
    _F.set(0, 0, 0);
    _T.set(0, 0, 0);

    const inp = this.input;
    const reversing = this.gear === -1;
    let throttle = reversing ? inp.brake : inp.throttle;
    let brake = reversing ? inp.throttle : inp.brake;
    const vLongBody = _lv.dot(_fwd);
    // In auto mode when rolling backwards in a forward gear, throttle should not also brake.
    if (!this.assists.autoGear && reversing) {
      throttle = inp.throttle;
      brake = inp.brake;
    }

    // ---------------- Suspension ----------------
    const maxLen = spec.suspLength + spec.wheelRadius;
    let grounded = 0;
    for (const w of this.wheels) {
      _hp.copy(w.local).applyQuaternion(_q).add(_pos);
      this.ray.origin.x = _hp.x;
      this.ray.origin.y = _hp.y;
      this.ray.origin.z = _hp.z;
      this.ray.dir.x = -_up.x;
      this.ray.dir.y = -_up.y;
      this.ray.dir.z = -_up.z;
      const hit = this.world.castRayAndGetNormal(this.ray, maxLen, true, undefined, WHEEL_RAY_GROUPS, undefined, body);
      w.prevCompression = w.compression;
      if (hit) {
        const dist = hit.timeOfImpact;
        w.compression = maxLen - dist;
        w.contact = true;
        w.point.copy(_hp).addScaledVector(_up, -dist);
        w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        const surf = surfaceGrip.get(hit.collider.handle);
        w.surfaceKind = surf ? surf.kind : 0;
        grounded++;
      } else {
        w.compression = 0;
        w.contact = false;
        w.surfaceKind = -1;
      }
    }
    this.groundedWheels = grounded;

    // anti-roll bars
    const arbF = spec.arbFront * (this.wheels[0].compression - this.wheels[1].compression);
    const arbR = spec.arbRear * (this.wheels[2].compression - this.wheels[3].compression);

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.contact) {
        w.fz = 0;
        continue;
      }
      const compVel = THREE.MathUtils.clamp((w.compression - w.prevCompression) / dt, -10, 10);
      let spring = w.k * w.compression;
      let damp = compVel > 0 ? w.cBump * compVel : w.cRebound * compVel;
      if (w.compression > spec.bumpStop) {
        // progressive elastomer bump stop with hysteresis: it soaks up hard landings instead of
        // handing the energy back as a trampoline bounce
        const over = w.compression - spec.bumpStop;
        let bs = w.k * 6 * over + w.k * 120 * over * over;
        if (compVel < 0) bs *= 0.35;
        else damp += w.cBump * 3 * compVel;
        spring += bs;
      }
      const arb = i < 2 ? (i === 0 ? arbF : -arbF) : i === 2 ? arbR : -arbR;
      let fz = spring + damp + arb;
      if (fz < 0) fz = 0;
      w.fz = fz;
      _hp.copy(w.local).applyQuaternion(_q).add(_pos);
      _tmp.copy(_up).multiplyScalar(fz);
      _F.add(_tmp);
      _r.subVectors(_hp, _pos);
      _T.add(_tmp2.crossVectors(_r, _tmp));
    }

    // ---------------- Drivetrain ----------------
    const gr = this.gearRatio();
    const drivenOmega = this.drivenOmega();
    const shifting = this.shiftTimer > 0;
    // Pulling the handbrake hard dips the clutch (classic drift pull) so the engine free-revs.
    const clutchIn = inp.handbrake > 0.5 && this.rearDriven;
    const inGear = this.gear !== 0 && !shifting && !clutchIn;
    const wheelRpm = Math.abs(drivenOmega * gr * RAD2RPM);
    let coupled = 0; // how much engine inertia is rigidly tied to the driven wheels
    let slipping = false;
    if (!inGear) {
      // free revving (neutral, clutch in, or mid-shift). Mid-shift the revs fall (or blip up on a
      // downshift) to match the next gear's speed: rev matching.
      const free = spec.idleRpm + throttle * (spec.limiter - spec.idleRpm);
      let targetRpm = free;
      if (shifting) targetRpm = Math.abs(drivenOmega * this.gearRatio(this.shiftTarget) * RAD2RPM);
      const rate = shifting ? 1 / (spec.shiftTime * 0.6) : throttle > 0.05 ? 9 : 3.5;
      this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * rate);
    } else {
      // Clutch slips at launch (1st/reverse) so the engine can sit at its launch rpm while the
      // wheels catch up; in higher gears it only slips below idle.
      const launchable = this.gear === 1 || this.gear === -1;
      const launchTarget = launchable ? spec.idleRpm + throttle * throttle * (spec.launchRpm - spec.idleRpm) : spec.idleRpm;
      if (wheelRpm < launchTarget) {
        slipping = true;
        this.rpm += (launchTarget - this.rpm) * Math.min(1, dt * 14);
        // partial coupling as the clutch bites so the engine is pulled down a little (no bogging though)
        coupled = THREE.MathUtils.clamp(wheelRpm / launchTarget, 0, 1) * 0.3;
      } else {
        this.rpm = wheelRpm;
        coupled = 1;
      }
    }
    if (this.rpm < spec.idleRpm) this.rpm = spec.idleRpm; // can't stall
    if (this.rpm >= spec.limiter) this.limiterCut = true;
    else if (this.rpm < spec.limiter - 250) this.limiterCut = false;
    if (this.rpm > spec.limiter + 250) this.rpm = spec.limiter + 250;

    // traction control: watch driven wheel slip, cut throttle smoothly
    if (this.assists.tcs && throttle > 0 && inGear) {
      let maxSlip = 0;
      for (const w of this.driven) if (w.contact) maxSlip = Math.max(maxSlip, w.slipRatio * Math.sign(gr || 1));
      const thr = spec.tireLong.peakSlip * (this.driftIntent > 0 ? 4.5 : 1.5);
      const excess = maxSlip - thr;
      this.tcsCut = THREE.MathUtils.clamp(this.tcsCut + (excess > 0 ? dt * (6 + excess * 60) : -dt * 5), 0, 0.8);
    } else this.tcsCut = Math.max(0, this.tcsCut - dt * 5);

    let thrEff = this.limiterCut ? 0 : throttle * (1 - this.tcsCut);
    if (reversing) thrEff *= 1 - THREE.MathUtils.smoothstep(-vLongBody, 7, 10); // reverse tops out ~35 km/h
    if (shifting && this.lastShiftUp) thrEff = 0;
    this.throttleOut = thrEff;
    let engineTorque = torqueAt(spec, this.rpm) * thrEff;
    if (this.boosting && thrEff > 0.1) engineTorque *= spec.nitroTorque;
    // clutch kick: dumping a revved engine back in gives a short torque spike
    if (this.clutchKick > 0 && inGear && !slipping && thrEff > 0.5) engineTorque *= 1 + this.clutchKick * 0.8;
    // engine braking only once the clutch is closed
    if (coupled > 0.95 && this.rpm > spec.idleRpm + 150) {
      engineTorque -= spec.engineBrake * (this.rpm / spec.redline) * (1 - thrEff);
    }
    this.load = THREE.MathUtils.clamp(engineTorque / (torqueAt(spec, this.rpm) + 1), -1, 1.6);
    const axleTorque = inGear && (engineTorque > 0 || coupled > 0.95) ? engineTorque * gr * spec.drivetrainEfficiency : 0;
    const reflected = inGear ? (spec.engineInertia * gr * gr * coupled) / this.driven.length : 0;
    this.clutchSlipping = slipping;

    // distribute torque
    for (const w of this.wheels) {
      w.driveTorque = 0;
      w.inertiaEff = spec.wheelInertia + (w.driven ? reflected : 0);
    }
    if (spec.drive === 'AWD') {
      // center diff: viscous bias to the slower axle
      const fo = (this.wheels[0].omega + this.wheels[1].omega) * 0.5;
      const ro = (this.wheels[2].omega + this.wheels[3].omega) * 0.5;
      const centerLock = 0.25 * Math.abs(axleTorque) + 40;
      const cTransfer = THREE.MathUtils.clamp((fo - ro) * 30, -centerLock, centerLock);
      this.applyLsd(this.wheels[0], this.wheels[1], axleTorque * spec.frontSplit - cTransfer);
      this.applyLsd(this.wheels[2], this.wheels[3], axleTorque * (1 - spec.frontSplit) + cTransfer);
    } else if (spec.drive === 'RWD') {
      this.applyLsd(this.wheels[2], this.wheels[3], axleTorque);
    } else {
      this.applyLsd(this.wheels[0], this.wheels[1], axleTorque);
    }

    // brakes
    const hb = inp.handbrake;
    for (const w of this.wheels) {
      let tb = brake * spec.brakeTorque * (w.front ? 1 : (1 - spec.brakeBias) / spec.brakeBias);
      if (this.assists.abs && brake > 0) {
        if (w.slipRatio < -spec.tireLong.peakSlip * 1.25 && Math.abs(vLongBody) > 3) w.absScale = Math.max(0.25, w.absScale - dt * 30);
        else w.absScale = Math.min(1, w.absScale + dt * 10);
        tb *= w.absScale;
      }
      if (!w.front && hb > 0) tb += hb * spec.handbrakeTorque;
      w.brakeTorque = tb;
    }

    // ---------------- Tires ----------------
    const latC = spec.tireLat;
    const lonC = spec.tireLong;
    const cornerMass = spec.mass / 4;
    for (const w of this.wheels) {
      if (!w.contact || w.fz <= 0) {
        // free spinning wheel in the air
        const net = w.driveTorque;
        w.omega += (net / w.inertiaEff) * dt;
        const bd = (w.brakeTorque / w.inertiaEff) * dt;
        if (Math.abs(w.omega) <= bd) w.omega = 0;
        else w.omega -= Math.sign(w.omega) * bd;
        w.omega *= 1 - 0.2 * dt;
        w.fx = w.fy = 0;
        w.skid = 0;
        w.slideSpeed = 0;
        w.slipRatio = 0;
        continue;
      }
      const n = w.normal;
      const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
      _wf.copy(_fwd).multiplyScalar(cs).addScaledVector(_left, sn);
      _f.copy(_wf).addScaledVector(n, -_wf.dot(n)).normalize();
      _s.crossVectors(n, _f); // lateral (left)
      _r.subVectors(w.point, _pos);
      _v.crossVectors(_av, _r).add(_lv);
      const vx = _v.dot(_f);
      const vy = _v.dot(_s);
      const absVx = Math.abs(vx);
      const vden = Math.max(absVx, 3.0);

      const surf = w.surfaceKind === 1 ? 0.92 : 1;
      const muScale = THREE.MathUtils.clamp(1 - spec.loadSensitivity * (w.fz / this.fz0 - 1), 0.65, 1.25) * surf;
      const Dlong = lonC.mu * muScale * w.fz;
      const Dlat = latC.mu * muScale * w.fz;

      // relaxed slip angle
      const alphaSS = Math.atan2(vy, vden);
      w.alpha += (alphaSS - w.alpha) * Math.min(1, ((absVx + Math.abs(vy) + 1.5) * dt) / spec.relaxLength);

      const R = w.radius;
      // current longitudinal force for the implicit wheel update
      let kappa = (w.omega * R - vx) / vden;
      this.tireForces(kappa, w.alpha, Dlong, Dlat);
      const Kx = this.Blong * lonC.C * Dlong;
      const denom = w.inertiaEff + (dt * Kx * R * R) / vden;
      let omega = w.omega + (dt * (w.driveTorque - R * _fx)) / denom;
      const rr = spec.rollingResistance * (1 + (vx * vx) / 4500) * w.fz * R;
      const bd = (dt * (w.brakeTorque + rr)) / denom;
      if (Math.abs(omega) <= bd) omega = 0;
      else omega -= Math.sign(omega) * bd;
      w.omega = omega;
      kappa = (omega * R - vx) / vden;
      w.slipRatio = kappa;
      this.tireForces(kappa, w.alpha, Dlong, Dlat);
      let Fx = _fx;
      let Fy = _fy;

      // low speed: don't let the tire push past zero lateral velocity in one step
      const stopY = (Math.abs(vy) * cornerMass) / dt;
      if (Math.abs(Fy) > stopY) Fy = Math.sign(Fy) * stopY;
      // static friction when a braked wheel is (nearly) stopped: a stiff anchor + damper so the car
      // really holds on slopes instead of creeping
      if (absVx < 1.0 && w.brakeTorque > 300 && Math.abs(w.driveTorque) < 60) {
        w.hold = THREE.MathUtils.clamp(w.hold + vx * dt, -0.05, 0.05);
        Fx = THREE.MathUtils.clamp((-vx * cornerMass * 0.8) / dt - w.hold * 120000, -Dlong, Dlong);
        w.omega = 0;
      } else w.hold = 0;

      w.fx = Fx;
      w.fy = Fy;
      const slideLong = omega * R - vx;
      w.slideSpeed = Math.hypot(slideLong, vy * 1.0);
      const over = Math.max(0, _rho - 1.0);
      w.skid = THREE.MathUtils.clamp(over * 1.2 + Math.max(0, w.slideSpeed - 2.5) * 0.08, 0, 1) * Math.min(1, w.fz / this.fz0);

      _tmp.copy(_f).multiplyScalar(Fx).addScaledVector(_s, Fy);
      _F.add(_tmp);
      // Applied at the contact patch so load transfer through the springs is physically right
      // (a tiny lift keeps roll from getting tippy on curb strikes).
      _hp.copy(w.point).addScaledVector(_up, 0.04);
      _r.subVectors(_hp, _pos);
      _T.add(_tmp2.crossVectors(_r, _tmp));
    }

    // ---------------- Aero ----------------
    const speed2 = _lv.lengthSq();
    const spd = Math.sqrt(speed2);
    const rho = 1.225;
    _tmp.copy(_lv).multiplyScalar(-0.5 * rho * spec.cd * spec.frontalArea * spd);
    _F.add(_tmp);
    const downF = 0.5 * rho * spec.clFront * speed2;
    const downR = 0.5 * rho * spec.clRear * speed2;
    if (grounded > 0) {
      const a = spec.wheelbase * (1 - spec.frontWeight);
      const b = spec.wheelbase * spec.frontWeight;
      _tmp.copy(_up).multiplyScalar(-downF);
      _F.add(_tmp);
      _r.copy(_fwd).multiplyScalar(a);
      _T.add(_tmp2.crossVectors(_r, _tmp));
      _tmp.copy(_up).multiplyScalar(-downR);
      _F.add(_tmp);
      _r.copy(_fwd).multiplyScalar(-b);
      _T.add(_tmp2.crossVectors(_r, _tmp));
    }

    // nitro: a little extra push so it is felt even when traction limited
    if (this.boosting && throttle > 0.1 && grounded > 1) {
      _F.addScaledVector(_fwd, spec.mass * 0.45);
    }

    // ---------------- Assists ----------------
    const yawRate = _av.dot(_up);
    this.yawRate = yawRate;
    if (this.assists.esc && grounded >= 3 && spd > 8 && vLongBody > 0) {
      // Yaw-rate stability control. Only ever fights OVERSTEER (rotation beyond what the steering
      // asks for, capped by what the tires can physically deliver) - it never adds yaw.
      // Backs off during a deliberate drift unless the car is genuinely spinning out.
      const maxYaw = (spec.tireLat.mu * G * 1.05) / spd;
      const desired = THREE.MathUtils.clamp((vLongBody * Math.tan(this.steerAngle)) / spec.wheelbase, -maxYaw, maxYaw);
      const slip = Math.abs(this.bodySlip);
      const spinning = slip > 0.78; // ~45 degrees
      const deliberate = this.driftIntent > 0 && !spinning;
      let over = 0;
      if (Math.sign(yawRate) === Math.sign(desired) && Math.abs(desired) > 0.02) over = Math.abs(yawRate) - Math.abs(desired);
      else over = Math.abs(yawRate); // rotating against the steering request
      const lim = deliberate ? 99 : spinning ? 0.15 : 0.22;
      if (over > lim) {
        const k = Math.min(over - lim, 1.5) * spec.inertia[1] * (spinning ? 4.0 : 2.5);
        _T.addScaledVector(_up, -Math.sign(yawRate) * k);
      }
    }
    if (grounded === 0) {
      this.airTime += dt;
      // mild air stabilisation: damp roll/pitch spin and level out
      const levelAxis = _tmp.crossVectors(_up, _worldUp);
      _T.addScaledVector(levelAxis, spec.inertia[0] * 2.0);
      _tmp2.copy(_av).addScaledVector(_up, -yawRate);
      _T.addScaledVector(_tmp2, -spec.inertia[0] * 1.2);
    } else {
      this.airTime = 0;
    }

    const imp = this._imp;
    imp.x = _F.x * dt;
    imp.y = _F.y * dt;
    imp.z = _F.z * dt;
    body.applyImpulse(imp, true);
    imp.x = _T.x * dt;
    imp.y = _T.y * dt;
    imp.z = _T.z * dt;
    body.applyTorqueImpulse(imp, true);

    for (const w of this.wheels) w.spin += w.omega * dt;
  }

  /** Combined-slip Pacejka (normalised slip vector). Writes module scratch _fx/_fy/_rho. */
  private tireForces(k: number, a: number, Dlong: number, Dlat: number) {
    const lonC = this.spec.tireLong;
    const latC = this.spec.tireLat;
    const sx = k / lonC.peakSlip;
    const sy = Math.tan(a) / this.tanPeakLat;
    const rho = Math.hypot(sx, sy);
    if (rho < 1e-7) {
      _fx = 0;
      _fy = 0;
      _rho = 0;
      return;
    }
    const fxp = Dlong * pacejka(rho * lonC.peakSlip, this.Blong, lonC.C, lonC.E);
    const fyp = Dlat * pacejka(rho * latC.peakSlip, this.Blat, latC.C, latC.E);
    _fx = (fxp * sx) / rho;
    _fy = (-fyp * sy) / rho;
    _rho = rho;
  }

  private applyLsd(l: Wheel, r: Wheel, T: number) {
    const spec = this.spec;
    const dOmega = l.omega - r.omega;
    const lock = spec.lsdPreload + spec.lsdLock * Math.abs(T);
    const transfer = THREE.MathUtils.clamp(dOmega * 40, -lock, lock);
    l.driveTorque += T * 0.5 - transfer;
    r.driveTorque += T * 0.5 + transfer;
  }

  /** World-space wheel center for rendering, derived from suspension compression. */
  wheelWorldCenter(w: Wheel, alphaPos: THREE.Vector3, alphaQuat: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
    const ext = this.spec.suspLength - w.compression;
    out.copy(w.local);
    out.y -= Math.min(this.spec.suspLength, Math.max(0, ext));
    return out.applyQuaternion(alphaQuat).add(alphaPos);
  }

  /** Local-space wheel center (relative to COM). */
  wheelLocalCenter(w: Wheel, out: THREE.Vector3): THREE.Vector3 {
    const ext = this.spec.suspLength - w.compression;
    out.copy(w.local);
    out.y -= Math.min(this.spec.suspLength, Math.max(0, ext));
    return out;
  }

  static quatFromFrame(fwd: THREE.Vector3, up: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
    const left = _tmp.crossVectors(up, fwd).normalize();
    const u = _tmp2.crossVectors(fwd, left).normalize();
    _m.makeBasis(left, u, fwd);
    return out.setFromRotationMatrix(_m);
  }
}

let _fx = 0;
let _fy = 0;
let _rho = 0;
