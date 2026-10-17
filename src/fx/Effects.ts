import * as THREE from 'three';
import type { QualityProfile } from '../core/Settings';
import { Smoke } from './Smoke';
import { Skids } from './Skids';
import { Sparks } from './Sparks';
import { Debris } from './Debris';
import { Exhaust } from './Exhaust';
import { StreakField } from './Ambient';
import { createSmokeTexture } from './textures';

export interface ExhaustSpec {
  /** exhaust tips in car local space (+Z forward, +X left, +Y up) */
  localPos: THREE.Vector3[];
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _glass = new THREE.Color(0.75, 0.85, 0.9);

/**
 * All dynamic world effects. Call the emitters any time during the frame, then update() once
 * (after the emitters, before rendering).
 */
export class Effects {
  readonly group = new THREE.Group();
  readonly smoke: Smoke;
  readonly skids: Skids;
  readonly sparksSys: Sparks;
  readonly debrisSys: Debris;
  readonly exhaustSys: Exhaust;
  readonly rain: StreakField;
  readonly speedLines: StreakField;
  private q: QualityProfile;
  private lastDt = 1 / 60;
  private time = 0;
  private camPrev = new THREE.Vector3();
  private camVel = new THREE.Vector3();
  private hasCam = false;
  private rainAmount = 0;
  private sparkBudget = 0;
  private emberAcc = 0;
  /** world velocity of the car currently passed to exhaust() (embers inherit it) */
  private carVelHint = new THREE.Vector3();

  constructor(scene: THREE.Scene, q: QualityProfile) {
    this.q = q;
    const pm = Math.max(0.2, q.particles);
    this.smoke = new Smoke(createSmokeTexture(256), Math.round(900 * pm));
    this.skids = new Skids(Math.round(4000 * Math.min(1.3, Math.max(0.5, pm))));
    this.sparksSys = new Sparks(Math.round(1200 * pm));
    this.debrisSys = new Debris(Math.round(160 * Math.min(1, pm + 0.2)));
    this.exhaustSys = new Exhaust(64);
    this.exhaustSys.onPop = (p, i) => {
      // tiny ember spit on backfire
      for (let k = 0; k < 3; k++) {
        this.sparksSys.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 3, Math.random() * 1.5, (Math.random() - 0.5) * 3, 0.15 + Math.random() * 0.2, 0.6 * i);
      }
    };
    this.exhaustSys.onBoost = (p, back, i) => {
      this.emberAcc += 40 * i * this.lastDt * Math.min(1.2, this.q.particles + 0.2);
      while (this.emberAcc >= 1) {
        this.emberAcc -= 1;
        const sp = 4 + Math.random() * 5;
        this.sparksSys.spawn(
          p.x + back.x * 0.5, p.y + back.y * 0.5, p.z + back.z * 0.5,
          this.carVelHint.x + back.x * sp + (Math.random() - 0.5) * 1.2,
          this.carVelHint.y + back.y * sp + Math.random() * 0.6,
          this.carVelHint.z + back.z * sp + (Math.random() - 0.5) * 1.2,
          0.12 + Math.random() * 0.18, 0.5, 1,
        );
      }
    };
    this.rain = new StreakField(Math.round(5000 * Math.min(1.2, pm)), {
      box: new THREE.Vector3(36, 22, 36),
      vel: new THREE.Vector3(0.8, -13, 0.4),
      exposure: 0.024,
      width: 0.013,
      maxLen: 3.5,
      color: new THREE.Color(0.7, 0.78, 0.95),
      opacity: 0.55,
      additive: true,
    });
    this.speedLines = new StreakField(Math.round(500 * Math.min(1, pm)), {
      box: new THREE.Vector3(26, 7, 26),
      vel: new THREE.Vector3(0, 0, 0),
      exposure: 0.05,
      width: 0.008,
      maxLen: 7,
      color: new THREE.Color(0.75, 0.82, 1.0),
      opacity: 0.22,
      additive: true,
    });
    this.group.add(this.skids.mesh, this.smoke.mesh, this.sparksSys.mesh, this.debrisSys.mesh, this.exhaustSys.group, this.rain.mesh, this.speedLines.mesh);
    scene.add(this.group);
  }

  /** Tint smoke by ambient light (e.g. sodium orange in the tunnel). */
  setSmokeLight(c: THREE.Color) {
    this.smoke.uniforms.uLight.value.copy(c);
  }

  setWind(w: THREE.Vector3) {
    this.smoke.uniforms.uWind.value.copy(w);
  }

  tireSmoke(pos: THREE.Vector3, vel: THREE.Vector3, intensity: number): void {
    this.smoke.emit(pos, vel, Math.min(1, intensity) * Math.min(1.3, this.q.particles + 0.15), this.lastDt);
  }

  skid(wheelId: number, pos: THREE.Vector3, normal: THREE.Vector3, right: THREE.Vector3, width: number, intensity: number): void {
    this.skids.add(wheelId, pos, normal, right, width, intensity);
  }

  sparks(pos: THREE.Vector3, normal: THREE.Vector3, vel: THREE.Vector3, intensity: number): void {
    const i = Math.min(1, Math.max(0, intensity));
    // budgeted: continuous scrapes call this every frame
    this.sparkBudget += (4 + 46 * i) * this.q.particles;
    const n = Math.floor(this.sparkBudget);
    this.sparkBudget -= n;
    _n.copy(normal).normalize();
    const speed = vel.length();
    for (let k = 0; k < n; k++) {
      // spray: mostly along the car's motion, kicked off the surface normal, wide cone
      _v.copy(vel).multiplyScalar(0.35 + Math.random() * 0.5);
      _t1.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2 + 5 * i);
      _v.add(_t1).addScaledVector(_n, (1 + Math.random() * 4) * (0.5 + i));
      _v.y += Math.random() * 2.5;
      const life = 0.25 + Math.random() * 0.55 + i * 0.25;
      this.sparksSys.spawn(pos.x + (Math.random() - 0.5) * 0.2, pos.y + (Math.random() - 0.5) * 0.15, pos.z + (Math.random() - 0.5) * 0.2, _v.x, _v.y, _v.z, life, 0.6 + Math.random() * 0.6 + Math.min(0.6, speed * 0.01));
    }
  }

  debris(pos: THREE.Vector3, vel: THREE.Vector3, intensity: number, color?: THREE.Color): void {
    const n = Math.round(Math.min(1, intensity) * 26 * Math.min(1, this.q.particles + 0.2));
    for (let k = 0; k < n; k++) {
      const c = Math.random() < 0.45 ? _glass : color ?? _glass;
      this.debrisSys.spawn(pos, vel, c);
    }
  }

  exhaust(carId: number, carMatrix: THREE.Matrix4, spec: ExhaustSpec, boosting: boolean, backfire: boolean, throttle: number, carVelocity?: THREE.Vector3): void {
    if (carVelocity) this.carVelHint.copy(carVelocity);
    else this.carVelHint.set(0, 0, 0);
    this.exhaustSys.set(carId, carMatrix, spec.localPos, boosting, backfire, throttle);
  }

  setRain(amount: number): void {
    this.rainAmount = THREE.MathUtils.clamp(amount, 0, 1);
    this.rain.amount = this.rainAmount;
  }

  update(dt: number, camera: THREE.Camera, playerSpeed: number): void {
    this.lastDt = dt;
    this.time += dt;
    camera.getWorldPosition(_t2);
    if (this.hasCam && dt > 0) {
      _t1.subVectors(_t2, this.camPrev).divideScalar(dt);
      // ignore teleports (camera cuts / resets)
      if (_t1.lengthSq() < 150 * 150) this.camVel.lerp(_t1, 1 - Math.exp(-dt * 12));
      else this.camVel.set(0, 0, 0);
    }
    this.camPrev.copy(_t2);
    this.hasCam = true;

    this.smoke.update(dt);
    this.skids.update(dt);
    this.sparksSys.update(dt);
    this.debrisSys.update(dt);
    this.exhaustSys.update(dt);

    this.rain.update(this.time, _t2, this.camVel);
    const kmh = Math.abs(playerSpeed) * 3.6;
    const sl = THREE.MathUtils.smoothstep(kmh, 150, 290);
    this.speedLines.amount = sl * 0.9;
    this.speedLines.uniforms.uOpacity.value = 0.12 + sl * 0.18;
    this.speedLines.update(this.time, _t2, this.camVel);
  }

  /** Remove all transient marks (race restart). */
  clear() {
    this.skids.clear();
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    this.smoke.dispose();
    this.skids.dispose();
    this.sparksSys.dispose();
    this.debrisSys.dispose();
    this.exhaustSys.dispose();
    this.rain.dispose();
    this.speedLines.dispose();
  }
}
