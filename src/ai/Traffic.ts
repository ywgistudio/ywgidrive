import * as THREE from 'three';
import { RAPIER, TRAFFIC_GROUPS } from '../physics/Physics';
import type { Track, TrackFrame } from '../track/Track';

export interface TrafficCarKind {
  id: string;
  halfExtents: [number, number, number]; // half width (x), half height (y), half length (z)
  mass: number;
  maxSpeed: number; // m/s cruise speed
}

/** Reasonable civilian mix; index order is the `kind` passed to makeVisual. */
export const DEFAULT_TRAFFIC_KINDS: TrafficCarKind[] = [
  { id: 'sedan', halfExtents: [0.9, 0.72, 2.35], mass: 1450, maxSpeed: 19 },
  { id: 'hatch', halfExtents: [0.86, 0.75, 2.0], mass: 1150, maxSpeed: 18 },
  { id: 'suv', halfExtents: [0.98, 0.9, 2.4], mass: 2000, maxSpeed: 18 },
  { id: 'van', halfExtents: [1.0, 1.15, 2.6], mass: 2300, maxSpeed: 16 },
  { id: 'taxi', halfExtents: [0.9, 0.75, 2.4], mass: 1500, maxSpeed: 20.5 },
  { id: 'bus', halfExtents: [1.28, 1.6, 5.6], mass: 11000, maxSpeed: 14 },
];

export interface TrafficCar {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  position: THREE.Vector3; // body center (interpolated for rendering)
  velocity: THREE.Vector3;
  quaternion: THREE.Quaternion;
  s: number;
  lateral: number;
  index: number; // projection hint
  halfLength: number;
  halfWidth: number;
  halfHeight: number;
  crashed: boolean;
  crashTimer: number;
  object: THREE.Object3D;
  kind: number;
  oncoming: boolean;
  /** -1 left, 0 off, 1 right (from the driver's point of view) */
  blinker: -1 | 0 | 1;
  hazard: boolean;
  braking: boolean;
  /** Accumulated wheel rotation (radians) for visuals. */
  wheelSpin: number;
  /** true while simulated by Rapier (near the player); false = moved parametrically along its lane. */
  active: boolean;
  // ---- internals ----
  dir: 1 | -1;
  lane: number;
  laneFrom: number;
  laneTo: number;
  laneT: number;
  laneLat: number;
  blinkerTimer: number;
  laneCooldown: number;
  v0: number;
  vDes: number;
  idmAcc: number;
  speedAlong: number; // m/s along its own driving direction
  offTimer: number;
  waitTimer: number;
  readonly prevPosition: THREE.Vector3;
  readonly prevQuaternion: THREE.Quaternion;
  readonly curPosition: THREE.Vector3;
  readonly curQuaternion: THREE.Quaternion;
  readonly desiredVel: THREE.Vector3;
  readonly desiredFwd: THREE.Vector3;
  readonly upRef: THREE.Vector3;
  inertia: [number, number, number];
}

const G = 9.81;
const ACTIVE_RADIUS = 380;
const DEACTIVATE_RADIUS = 430;
const RESPAWN_MIN_DIST = 230;
const VISIBLE_RADIUS = 1200;
const CTRL_TAU = 0.3; // velocity tracker time constant (s)

// IDM parameters
const IDM_T = 1.4;
const IDM_A = 1.6;
const IDM_B = 2.5;
const IDM_S0 = 2.5;

const _f: TrackFrame = { pos: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
const _f2: TrackFrame = { pos: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
const _v = new THREE.Vector3();
const _e = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _worldPos = new THREE.Vector3();
const _off = new THREE.Vector3();
const _proj = { index: -1, s: 0, lateral: 0, height: 0 };

interface Agent {
  s: number;
  lat: number;
  halfLength: number;
  halfWidth: number;
  along: number; // velocity along +s
  traffic: number; // traffic index or -1
}

function smoothstep01(x: number) {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Civilian traffic on the circuit (right-hand traffic: +s direction uses the two right lanes,
 * oncoming −s traffic the two left lanes). Near the player each car is a dynamic Rapier box steered by a
 * force-limited velocity tracker following IDM car-following speeds; far away they move parametrically.
 */
export class Traffic {
  readonly cars: TrafficCar[] = [];
  private readonly world: RAPIER.World;
  private readonly track: Track;
  private readonly kinds: TrafficCarKind[];
  private readonly makeVisual: (kindIndex: number) => THREE.Object3D;
  private readonly scene: THREE.Scene;
  private readonly handleMap = new Map<number, number>();
  private agents: Agent[] = [];
  private racerHints: number[] = [];
  private focusIndex = -1;
  private focusS = 0;
  private time = 0;
  private rng: () => number;

  constructor(world: RAPIER.World, track: Track, kinds: TrafficCarKind[], makeVisual: (kindIndex: number) => THREE.Object3D, scene: THREE.Scene) {
    this.world = world;
    this.track = track;
    this.kinds = kinds.length ? kinds : DEFAULT_TRAFFIC_KINDS;
    this.makeVisual = makeVisual;
    this.scene = scene;
    let seed = 1337;
    this.rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  colliderToCar(handle: number): number {
    return this.handleMap.get(handle) ?? -1;
  }

  /** Feed contact impulses (N·s) from the event queue so hard hits knock cars out of "driving" mode. */
  notifyImpact(colliderHandle: number, impulse: number) {
    const i = this.colliderToCar(colliderHandle);
    if (i < 0) return;
    const c = this.cars[i];
    if (!c.crashed && impulse > c.body.mass() * 2.5) this.crash(c);
  }

  private pickKind(): number {
    // weights: lots of sedans/hatches/taxis, a few vans/SUVs, rare buses
    const w = [0.3, 0.22, 0.16, 0.1, 0.16, 0.06];
    let r = this.rng() * w.slice(0, this.kinds.length).reduce((a, b) => a + b, 0);
    for (let i = 0; i < this.kinds.length; i++) {
      r -= w[i] ?? 0.1;
      if (r <= 0) return i;
    }
    return 0;
  }

  spawn(count: number, avoidS: number[]) {
    this.clear();
    const L = this.track.length;
    const spacing = L / Math.max(1, count);
    let placed = 0;
    for (let k = 0; k < count * 3 && placed < count; k++) {
      const s = this.track.wrapS(placed * spacing + (this.rng() - 0.5) * spacing * 0.6 + k * 7.3);
      if (avoidS.some((a) => Math.abs(this.track.deltaS(a, s)) < 110)) continue;
      const lane = Math.floor(this.rng() * 4);
      if (!this.laneClear(s, lane, 22, -1)) continue;
      this.createCar(this.pickKind(), s, lane);
      placed++;
    }
    // initialise poses/activity relative to the start area
    this.focusS = avoidS[0] ?? 0;
  }

  private createCar(kind: number, s: number, lane: number) {
    const spec = this.kinds[kind];
    const [hx, hy, hz] = spec.halfExtents;
    const dir: 1 | -1 = lane >= 2 ? 1 : -1;
    const desc = RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setLinearDamping(0.02).setAngularDamping(0.4);
    const body = this.world.createRigidBody(desc);
    const m = spec.mass;
    const inertia: [number, number, number] = [(m / 3) * (hy * hy + hz * hz), (m / 3) * (hx * hx + hz * hz), (m / 3) * (hx * hx + hy * hy)];
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setMassProperties(m, { x: 0, y: -hy * 0.3, z: 0 }, { x: inertia[0], y: inertia[1], z: inertia[2] }, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0.12)
        .setCollisionGroups(TRAFFIC_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(m * 240 * 1.5),
      body,
    );
    const object = this.makeVisual(kind);
    this.scene.add(object);
    const v0 = spec.maxSpeed * (0.88 + this.rng() * 0.22) * (lane === 0 || lane === 3 ? 0.92 : 1.05);
    const car: TrafficCar = {
      body,
      collider: col,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      s,
      lateral: this.track.lanes[lane],
      index: -1,
      halfLength: hz,
      halfWidth: hx,
      halfHeight: hy,
      crashed: false,
      crashTimer: 0,
      object,
      kind,
      oncoming: dir < 0,
      blinker: 0,
      hazard: false,
      braking: false,
      wheelSpin: 0,
      active: true,
      dir,
      lane,
      laneFrom: lane,
      laneTo: lane,
      laneT: 1,
      laneLat: this.track.lanes[lane],
      blinkerTimer: 0,
      laneCooldown: 4 + this.rng() * 10,
      v0,
      vDes: v0,
      idmAcc: 0,
      speedAlong: v0,
      offTimer: 0,
      waitTimer: 0,
      prevPosition: new THREE.Vector3(),
      prevQuaternion: new THREE.Quaternion(),
      curPosition: new THREE.Vector3(),
      curQuaternion: new THREE.Quaternion(),
      desiredVel: new THREE.Vector3(),
      desiredFwd: new THREE.Vector3(0, 0, 1),
      upRef: new THREE.Vector3(0, 1, 0),
      inertia,
    };
    const idx = this.cars.length;
    this.cars.push(car);
    this.handleMap.set(col.handle, idx);
    this.placeOnLane(car, s, lane, v0);
  }

  /** Teleport a car onto its lane at arc length s, driving at speed v. */
  private placeOnLane(c: TrafficCar, s: number, lane: number, v: number) {
    const tr = this.track;
    c.lane = c.laneFrom = c.laneTo = lane;
    c.laneT = 1;
    c.laneLat = tr.lanes[lane];
    c.dir = lane >= 2 ? 1 : -1;
    c.oncoming = c.dir < 0;
    c.s = tr.wrapS(s);
    c.lateral = c.laneLat;
    c.index = -1;
    c.vDes = v;
    c.speedAlong = v;
    c.blinker = 0;
    c.hazard = false;
    c.braking = false;
    c.crashed = false;
    c.crashTimer = 0;
    c.offTimer = 0;
    c.waitTimer = 0;
    this.parametricPose(c);
    c.prevPosition.copy(c.curPosition);
    c.prevQuaternion.copy(c.curQuaternion);
    // controller targets valid even if substep() runs before the first update()
    c.desiredVel.copy(c.velocity);
    c.desiredFwd.set(0, 0, 1).applyQuaternion(c.curQuaternion);
    c.collider.setFriction(0);
    c.collider.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    c.body.setAngularDamping(0.4);
    if (c.active) this.syncBodyToParametric(c);
  }

  /** Compute pose from (s, laneLat) into curPosition/curQuaternion. */
  private parametricPose(c: TrafficCar) {
    const tr = this.track;
    tr.frameAt(c.s, _f);
    c.curPosition.copy(_f.pos).addScaledVector(_f.right, c.laneLat).addScaledVector(_f.up, c.halfHeight + 0.04);
    _fwd.copy(_f.tangent).multiplyScalar(c.dir);
    // slight yaw toward the lane while changing lanes
    if (c.laneT < 1) {
      const dl = tr.lanes[c.laneTo] - tr.lanes[c.laneFrom];
      _fwd.addScaledVector(_f.right, (dl * 0.55) / Math.max(4, c.speedAlong)).normalize();
    }
    const left = _a.crossVectors(_f.up, _fwd).normalize();
    const up = _b.crossVectors(_fwd, left).normalize();
    _m.makeBasis(left, up, _fwd);
    c.curQuaternion.setFromRotationMatrix(_m);
    c.upRef.copy(_f.up);
    c.velocity.copy(_f.tangent).multiplyScalar(c.dir * c.speedAlong);
  }

  private syncBodyToParametric(c: TrafficCar) {
    const p = c.curPosition;
    const q = c.curQuaternion;
    c.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    c.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    c.body.setLinvel({ x: c.velocity.x, y: c.velocity.y, z: c.velocity.z }, true);
    c.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  private setActive(c: TrafficCar, on: boolean) {
    if (c.active === on) return;
    c.active = on;
    if (on) {
      this.parametricPose(c);
      c.body.setEnabled(true);
      this.syncBodyToParametric(c);
      c.prevPosition.copy(c.curPosition);
      c.prevQuaternion.copy(c.curQuaternion);
    } else {
      c.body.setEnabled(false);
    }
  }

  private crash(c: TrafficCar) {
    c.crashed = true;
    c.crashTimer = 0;
    c.hazard = true;
    c.blinker = 0;
    c.braking = true;
    c.collider.setFriction(0.75);
    c.collider.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average);
    c.body.setAngularDamping(0.25);
  }

  /** Is the given lane clear of traffic around arc length s (± gap meters)? */
  private laneClear(s: number, lane: number, gap: number, self: number): boolean {
    const lat = this.track.lanes[lane];
    for (let j = 0; j < this.cars.length; j++) {
      if (j === self) continue;
      const o = this.cars[j];
      if (Math.abs(o.laneLat - lat) > 2 && Math.abs(o.lateral - lat) > 2) continue;
      if (Math.abs(this.track.deltaS(s, o.s)) < gap + o.halfLength) return false;
    }
    return true;
  }

  /** Per physics substep: velocity-tracking controller impulses for active, driving cars. */
  substep(dt: number) {
    for (const c of this.cars) {
      if (!c.active) continue;
      const body = c.body;
      const t = body.translation();
      const q = body.rotation();
      c.prevPosition.set(t.x, t.y, t.z);
      c.prevQuaternion.set(q.x, q.y, q.z, q.w);
      if (c.crashed) continue;
      const lv = body.linvel();
      const av = body.angvel();
      const m = this.kinds[c.kind].mass;
      const U = c.upRef;
      _v.set(lv.x, lv.y, lv.z);
      _e.copy(c.desiredVel).sub(_v);
      _e.addScaledVector(U, -_e.dot(U));
      _e.multiplyScalar(m / CTRL_TAU);
      const maxF = 0.85 * m * G;
      const fl = _e.length();
      if (fl > maxF) _e.multiplyScalar(maxF / fl);
      body.applyImpulse({ x: _e.x * dt, y: _e.y * dt, z: _e.z * dt }, true);

      // yaw alignment + roll/pitch damping
      _q.set(q.x, q.y, q.z, q.w);
      _fwd.set(0, 0, 1).applyQuaternion(_q);
      _fwd.addScaledVector(U, -_fwd.dot(U)).normalize();
      const df = c.desiredFwd;
      _a.crossVectors(_fwd, df);
      const err = Math.atan2(_a.dot(U), _fwd.dot(df));
      _b.set(av.x, av.y, av.z);
      const yawRate = _b.dot(U);
      const Iy = c.inertia[1];
      let tq = Iy * (7 * err - 4 * yawRate);
      const tqMax = Iy * 9;
      if (tq > tqMax) tq = tqMax;
      else if (tq < -tqMax) tq = -tqMax;
      _a.copy(U).multiplyScalar(tq);
      // damp roll/pitch rates and keep the box level with the road
      const wPerp = _b.addScaledVector(U, -yawRate);
      _a.addScaledVector(wPerp, -c.inertia[0] * 3);
      _up.set(0, 1, 0).applyQuaternion(_q);
      _off.crossVectors(_up, U);
      _a.addScaledVector(_off, c.inertia[0] * 12);
      body.applyTorqueImpulse({ x: _a.x * dt, y: _a.y * dt, z: _a.z * dt }, true);
    }
  }

  /**
   * Per frame: read physics state, IDM speeds, lane changes, crash/respawn logic, activation by distance,
   * and visual sync. `alpha` is the render interpolation factor between the last two physics states.
   */
  update(dt: number, focus: THREE.Vector3, racers: { position: THREE.Vector3; velocity: THREE.Vector3 }[], alpha = 1) {
    const tr = this.track;
    this.time += dt;
    const fp = tr.project(focus, this.focusIndex, _proj);
    this.focusIndex = fp.index;
    this.focusS = fp.s;

    // ---- read state ----
    for (const c of this.cars) {
      if (c.active) {
        const t = c.body.translation();
        const q = c.body.rotation();
        const v = c.body.linvel();
        c.curPosition.set(t.x, t.y, t.z);
        c.curQuaternion.set(q.x, q.y, q.z, q.w);
        c.velocity.set(v.x, v.y, v.z);
        const p = tr.project(c.curPosition, c.index, _proj);
        c.index = p.index;
        c.s = p.s;
        c.lateral = p.lateral;
        c.speedAlong = (c.velocity.x * tr.tx[p.index] + c.velocity.y * tr.ty[p.index] + c.velocity.z * tr.tz[p.index]) * c.dir;
      }
    }

    // ---- agents (traffic + racers) for car-following ----
    const agents = this.agents;
    agents.length = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      agents.push({ s: c.s, lat: c.lateral, halfLength: c.halfLength, halfWidth: c.halfWidth, along: c.crashed ? 0 : c.speedAlong * c.dir, traffic: i });
    }
    while (this.racerHints.length < racers.length) this.racerHints.push(-1);
    for (let r = 0; r < racers.length; r++) {
      const p = tr.project(racers[r].position, this.racerHints[r], _proj);
      this.racerHints[r] = p.index;
      const v = racers[r].velocity;
      agents.push({ s: p.s, lat: p.lateral, halfLength: 2.3, halfWidth: 0.95, along: v.x * tr.tx[p.index] + v.y * tr.ty[p.index] + v.z * tr.tz[p.index], traffic: -1 });
    }

    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.crashed) continue;
      // ---- leader search ----
      let gap = Infinity;
      let leadV = 0;
      for (const a of agents) {
        if (a.traffic === i) continue;
        const ds = tr.deltaS(c.s, a.s) * c.dir;
        if (ds <= 0 || ds > 140) continue;
        const need = c.halfWidth + a.halfWidth + 0.3;
        if (Math.abs(a.lat - c.laneLat) > need && Math.abs(a.lat - c.lateral) > need) continue;
        const along = a.along * c.dir;
        const g = ds - c.halfLength - a.halfLength;
        // head-on movers in our lane: far away they'll dodge (ignore), close by treat as a stopped obstacle
        if (along < -2 && g > 45) continue;
        if (g < gap) {
          gap = g;
          leadV = Math.max(0, along);
        }
      }
      // curvature-aware desired speed (look ahead along own direction)
      let v0 = c.v0;
      for (let d = 0; d <= 50; d += 10) {
        const k = Math.abs(tr.curvature[tr.wrap(Math.floor(tr.wrapS(c.s + c.dir * d) / tr.step))]);
        if (k > 1e-4) v0 = Math.min(v0, Math.sqrt((0.3 * G) / k));
      }
      // crests: slow down so the car stays planted (v^2 / R < 0.6 g)
      for (let d = 0; d <= 40; d += 10) {
        const i0 = tr.wrap(Math.floor(tr.wrapS(c.s + c.dir * d) / tr.step));
        const kv = (tr.py[tr.wrap(i0 + 5)] - 2 * tr.py[i0] + tr.py[tr.wrap(i0 - 5)]) / 100;
        if (kv < -1e-3) v0 = Math.min(v0, Math.sqrt((0.6 * G) / -kv));
      }
      v0 = Math.max(v0, 6);
      const v = Math.max(0, c.speedAlong);
      let acc = IDM_A * (1 - Math.pow(v / v0, 4));
      if (gap < Infinity) {
        const dv = v - leadV;
        const sStar = IDM_S0 + Math.max(0, v * IDM_T + (v * dv) / (2 * Math.sqrt(IDM_A * IDM_B)));
        acc -= IDM_A * Math.pow(sStar / Math.max(gap, 0.3), 2);
      }
      acc = THREE.MathUtils.clamp(acc, -8.5, IDM_A);
      c.idmAcc = acc;
      // desired speed = actual + acc * controller time constant, so the tracker produces ~IDM acceleration
      c.vDes = THREE.MathUtils.clamp(v + acc * CTRL_TAU, 0, Math.max(v, v0 * 1.05));
      c.braking = acc < -1.2 || (c.vDes < 0.5 && v < 1);

      // ---- lane changes ----
      c.laneCooldown -= dt;
      c.waitTimer = v < 0.5 && gap < 25 ? c.waitTimer + dt : 0;
      if (c.waitTimer > 5 && c.laneT >= 1 && c.blinkerTimer <= 0) {
        // been sitting behind a wreck / a racer in our lane: pull around it in the other lane
        const target = c.lane === 0 ? 1 : c.lane === 1 ? 0 : c.lane === 2 ? 3 : 2;
        if (this.laneClear(c.s, target, 8, i)) {
          c.laneTo = target;
          c.laneFrom = c.lane;
          c.laneT = 0;
          c.blinker = (Math.sign(tr.lanes[target] - tr.lanes[c.lane]) * c.dir) as -1 | 1;
          c.waitTimer = 0;
        }
      }
      if (c.laneT >= 1 && c.blinkerTimer <= 0 && c.laneCooldown <= 0) {
        const slowLeader = gap < 35 && leadV < c.v0 - 3;
        const want = slowLeader ? 0.6 : 0.035;
        if (this.rng() < want * dt) {
          const target = c.lane === 0 ? 1 : c.lane === 1 ? 0 : c.lane === 2 ? 3 : 2;
          if (this.targetLaneSafe(i, target)) {
            c.laneTo = target;
            c.blinker = (Math.sign(tr.lanes[target] - tr.lanes[c.lane]) * c.dir) as -1 | 1;
            c.blinkerTimer = 1.3;
          } else c.laneCooldown = 2;
        }
      }
      if (c.blinkerTimer > 0) {
        c.blinkerTimer -= dt;
        if (c.blinkerTimer <= 0) {
          if (this.targetLaneSafe(i, c.laneTo)) {
            c.laneFrom = c.lane;
            c.laneT = 0;
          } else {
            c.laneTo = c.lane;
            c.blinker = 0;
            c.laneCooldown = 3;
          }
        }
      }
      if (c.laneT < 1) {
        c.laneT = Math.min(1, c.laneT + dt / 2.6);
        c.laneLat = THREE.MathUtils.lerp(tr.lanes[c.laneFrom], tr.lanes[c.laneTo], smoothstep01(c.laneT));
        if (c.laneT >= 1) {
          c.lane = c.laneTo;
          c.blinker = 0;
          c.laneCooldown = 7 + this.rng() * 12;
        }
      }

      if (!c.active) {
        // parametric motion
        c.speedAlong = THREE.MathUtils.clamp(c.speedAlong + acc * dt, 0, v0 * 1.05);
        c.s = tr.wrapS(c.s + c.dir * c.speedAlong * dt);
        c.lateral = c.laneLat;
        continue;
      }

      // ---- controller targets ----
      tr.frameAt(c.s, _f);
      c.upRef.copy(_f.up);
      const latErr = c.laneLat - c.lateral;
      // lateral velocity of the lane itself while changing lanes (feedforward)
      const laneVel = c.laneT < 1 ? ((tr.lanes[c.laneTo] - tr.lanes[c.laneFrom]) * 6 * c.laneT * (1 - c.laneT)) / 2.6 : 0;
      const latVel = THREE.MathUtils.clamp(laneVel + latErr * 1.8, -3, 3);
      // direction: blend toward the tangent slightly ahead so curves are anticipated
      tr.frameAt(c.s + c.dir * Math.max(2, c.speedAlong * 0.35), _f2);
      _a.copy(_f.tangent).add(_f2.tangent).normalize();
      c.desiredVel.copy(_a).multiplyScalar(c.dir * c.vDes).addScaledVector(_f.right, latVel);
      c.desiredFwd.copy(_a).multiplyScalar(c.dir * Math.max(c.vDes, 4)).addScaledVector(_f.right, latVel * 0.5);
      c.desiredFwd.addScaledVector(_f.up, -c.desiredFwd.dot(_f.up)).normalize();

      // ---- crash detection from state ----
      _fwd.set(0, 0, 1).applyQuaternion(c.curQuaternion);
      _up.set(0, 1, 0).applyQuaternion(c.curQuaternion);
      const headingDot = _fwd.dot(c.desiredFwd);
      const tilt = _up.dot(_f.up);
      const off = headingDot < 0.82 || tilt < 0.8 || Math.abs(latErr) > 2.8;
      c.offTimer = off ? c.offTimer + dt : 0;
      if (c.offTimer > 0.2 || c.speedAlong > c.vDes + 9 || c.speedAlong < -3) {
        this.crash(c);
      }
    }

    // ---- crash timers, respawn, activation ----
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const dist = c.curPosition.distanceTo(focus);
      if (c.crashed) {
        c.crashTimer += dt;
        const fell = c.curPosition.y < tr.py[tr.wrap(c.index < 0 ? 0 : c.index)] - 15;
        // tow wrecks: out of range quickly; ones the player already left behind after a while; anything
        // not right next to the player after 20 s (stops permanent blockades)
        const behind = this.track.deltaS(this.focusS, c.s) < -25;
        const towed = (c.crashTimer > 9 && behind && dist > 50) || (c.crashTimer > 15 && dist > 30);
        if ((c.crashTimer > 4 && dist > RESPAWN_MIN_DIST) || fell || towed) {
          this.respawn(i);
          continue;
        }
      }
      if (!c.crashed) {
        if (c.active && dist > DEACTIVATE_RADIUS) this.setActive(c, false);
        else if (!c.active && dist < ACTIVE_RADIUS) this.setActive(c, true);
      }
    }

    // ---- visuals ----
    for (const c of this.cars) {
      if (!c.active) this.parametricPose(c);
      if (c.active) {
        c.position.lerpVectors(c.prevPosition, c.curPosition, alpha);
        c.quaternion.slerpQuaternions(c.prevQuaternion, c.curQuaternion, alpha);
      } else {
        c.position.copy(c.curPosition);
        c.quaternion.copy(c.curQuaternion);
      }
      const o = c.object;
      const dist = c.position.distanceTo(focus);
      o.visible = dist < VISIBLE_RADIUS;
      // visual origin = bottom center of the car (ground level), +Z forward
      _up.set(0, 1, 0).applyQuaternion(c.quaternion);
      o.position.copy(c.position).addScaledVector(_up, -c.halfHeight);
      o.quaternion.copy(c.quaternion);
      c.wheelSpin += (c.active ? c.velocity.length() * Math.sign(c.speedAlong || 1) : c.speedAlong) * dt / 0.32;
    }
  }

  private targetLaneSafe(self: number, lane: number): boolean {
    const c = this.cars[self];
    const lat = this.track.lanes[lane];
    for (const a of this.agents) {
      if (a.traffic === self) continue;
      if (Math.abs(a.lat - lat) > c.halfWidth + a.halfWidth + 0.6) continue;
      const ds = this.track.deltaS(c.s, a.s) * c.dir;
      const along = a.along * c.dir;
      if (ds > -c.halfLength - a.halfLength - 6 && ds < c.halfLength + a.halfLength + 14) return false; // alongside
      if (ds < 0 && ds > -60 && along > c.speedAlong + 2) return false; // faster car coming from behind
      if (ds > 0 && ds < 30 && along < c.speedAlong - 3) return false; // slow car just ahead in the target lane
    }
    return true;
  }

  /**
   * Respawn every traffic car (crashed or not) within `radius` of `position` - call before putting a
   * racer/player back on track so the reset spot isn't sitting on a wreck.
   */
  clearAround(position: THREE.Vector3, radius: number) {
    const r2 = radius * radius;
    for (let i = 0; i < this.cars.length; i++) {
      if (this.cars[i].curPosition.distanceToSquared(position) < r2) this.respawn(i);
    }
  }

  /** Move a car to a fresh, out-of-sight lane position. */
  private respawn(i: number) {
    const c = this.cars[i];
    const tr = this.track;
    let s = tr.wrapS(this.focusS - 600);
    let lane = Math.floor(this.rng() * 4);
    for (let tries = 0; tries < 16; tries++) {
      const behind = this.rng() < 0.5;
      const d = behind ? -(260 + this.rng() * 700) : 650 + this.rng() * 600;
      const cand = tr.wrapS(this.focusS + d);
      const ln = Math.floor(this.rng() * 4);
      tr.pointAt(cand, tr.lanes[ln], _worldPos);
      if (_worldPos.distanceTo(tr.pointAt(this.focusS, 0, _off)) < RESPAWN_MIN_DIST) continue;
      if (!this.laneClear(cand, ln, 25, i)) continue;
      s = cand;
      lane = ln;
      break;
    }
    // re-enable as parametric; activation logic will bring it into physics when near
    const wasActive = c.active;
    c.active = false;
    if (wasActive) c.body.setEnabled(false);
    this.placeOnLane(c, s, lane, c.v0 * 0.9);
  }

  clear() {
    for (const c of this.cars) {
      this.world.removeRigidBody(c.body);
      this.scene.remove(c.object);
    }
    this.cars.length = 0;
    this.handleMap.clear();
    this.agents.length = 0;
    this.racerHints.length = 0;
  }
}
