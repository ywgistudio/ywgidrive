import * as THREE from 'three';

export type CameraMode = 'chase' | 'far' | 'hood' | 'bumper';
export const CAMERA_MODES: CameraMode[] = ['chase', 'far', 'hood', 'bumper'];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Spring-damped chase camera that follows the car's velocity direction (not its nose) so drifts
 * read clearly, widens FOV with speed, and adds speed/impact shake.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private look = new THREE.Vector3();
  private heading = new THREE.Vector3(0, 0, 1);
  private shake = 0;
  private time = 0;
  shakeEnabled = true;
  baseFov = 62;
  private initialized = false;
  private driftS = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.1, 3000);
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this.initialized = false;
  }

  impact(amount: number) {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  snap() {
    this.initialized = false;
  }

  update(
    dt: number,
    target: { position: THREE.Vector3; quaternion: THREE.Quaternion; velocity: THREE.Vector3 },
    speed: number,
    boosting: boolean,
    lookBack: boolean,
    airborne: boolean,
    drift = 0, // 0..1 how hard the car is drifting
  ) {
    this.time += dt;
    const cam = this.camera;
    const fwd = _v.set(0, 0, 1).applyQuaternion(target.quaternion);
    const flatFwd = _v2.set(fwd.x, 0, fwd.z).normalize();
    const vflat = new THREE.Vector3(target.velocity.x, 0, target.velocity.z);
    const sp = vflat.length();

    // heading blends from car nose to velocity direction when moving forward fast (drift-friendly)
    const desiredHeading = flatFwd.clone();
    if (sp > 6 && vflat.dot(flatFwd) > 0) {
      vflat.normalize();
      desiredHeading.lerp(vflat, 0.55 + 0.25 * drift).normalize();
    }
    if (!this.initialized) this.heading.copy(desiredHeading);
    const hRate = this.mode === 'chase' || this.mode === 'far' ? 5.5 : 30;
    this.heading.lerp(desiredHeading, 1 - Math.exp(-hRate * dt)).normalize();
    const h = lookBack ? this.heading.clone().negate() : this.heading;

    const kmh = speed * 3.6;
    const sNorm = THREE.MathUtils.clamp(kmh / 300, 0, 1);

    if (this.mode === 'chase' || this.mode === 'far') {
      const far = this.mode === 'far';
      const dist = (far ? 8.4 : 6.0) + sNorm * (far ? 1.6 : 1.2) - (boosting ? -0.6 : 0);
      const height = (far ? 2.9 : 2.0) + sNorm * 0.2;
      const desired = target.position.clone().addScaledVector(h, -dist);
      desired.y += height;
      if (!this.initialized) {
        this.pos.copy(desired);
        this.vel.set(0, 0, 0);
      }
      // critically damped spring
      const k = 60;
      const c = 2 * Math.sqrt(k) * 0.95;
      const acc = desired.clone().sub(this.pos).multiplyScalar(k).addScaledVector(this.vel, -c);
      this.vel.addScaledVector(acc, dt);
      this.pos.addScaledVector(this.vel, dt);
      // keep the camera from lagging too far behind at very high speed
      const off = this.pos.clone().sub(desired);
      const maxOff = 2.5;
      if (off.length() > maxOff) this.pos.copy(desired).addScaledVector(off.normalize(), maxOff);
      // don't let it dip below the car's roofline when landing
      if (this.pos.y < target.position.y + 0.8) this.pos.y = target.position.y + 0.8;
      cam.position.copy(this.pos);
      this.look.copy(target.position).addScaledVector(h, 4.5);
      this.look.y += 0.9;
      cam.lookAt(this.look);
    } else {
      const local = this.mode === 'hood' ? new THREE.Vector3(0, 0.95, 0.35) : new THREE.Vector3(0, 0.42, 2.25);
      const p = local.applyQuaternion(target.quaternion).add(target.position);
      cam.position.copy(p);
      _q.copy(target.quaternion);
      if (lookBack) _q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      // camera looks down -Z, car forward is +Z
      cam.quaternion.copy(_q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    }

    // FOV with speed + nitro
    this.driftS += (drift - this.driftS) * Math.min(1, dt * 4);
    const fovTarget = this.baseFov + sNorm * 16 + (boosting ? 8 : 0) + this.driftS * 4;
    cam.fov += (fovTarget - cam.fov) * Math.min(1, dt * 3);

    // shake: speed rumble + impacts
    if (this.shakeEnabled) {
      this.shake = Math.max(0, this.shake - dt * 2.5);
      const rumble = sNorm * sNorm * 0.012 + (boosting ? 0.01 : 0) + this.shake * 0.08 + (airborne ? 0 : 0);
      if (rumble > 0) {
        const t = this.time;
        cam.position.x += Math.sin(t * 37.1) * rumble + Math.sin(t * 13.7) * rumble * 0.5;
        cam.position.y += Math.sin(t * 41.3) * rumble * 0.7;
        cam.rotateZ(Math.sin(t * 23.3) * rumble * 0.25);
      }
    }
    cam.updateProjectionMatrix();
    this.initialized = true;
  }
}
