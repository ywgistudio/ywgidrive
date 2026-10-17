import * as THREE from 'three';

interface Bit {
  alive: boolean;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  ax: number; ay: number; az: number; spin: number;
  angle: number;
  life: number;
  age: number;
  scale: number;
  ground: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/** Small CPU-simulated chunks (glass, plastic, carbon) for heavy crashes. */
export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private bits: Bit[] = [];
  private head = 0;
  private aliveCount = 0;

  constructor(max: number) {
    const geo = new THREE.TetrahedronGeometry(0.06, 0);
    geo.scale(1.6, 0.4, 1.0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.4, color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < max; i++) {
      this.bits.push({ alive: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 1, az: 0, spin: 0, angle: 0, life: 0, age: 0, scale: 1, ground: 0 });
      this.mesh.setMatrixAt(i, _zero);
      this.mesh.setColorAt(i, white);
    }
    this.mesh.count = max;
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color) {
    const i = this.head;
    this.head = (this.head + 1) % this.bits.length;
    const b = this.bits[i];
    const r = Math.random;
    if (!b.alive) this.aliveCount++;
    b.alive = true;
    b.px = pos.x + (r() - 0.5) * 0.6;
    b.py = pos.y + r() * 0.4;
    b.pz = pos.z + (r() - 0.5) * 0.6;
    b.vx = vel.x * 0.7 + (r() - 0.5) * 6;
    b.vy = Math.abs(vel.y) * 0.3 + 1.5 + r() * 4;
    b.vz = vel.z * 0.7 + (r() - 0.5) * 6;
    _axis.set(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    b.ax = _axis.x; b.ay = _axis.y; b.az = _axis.z;
    b.spin = 8 + r() * 20;
    b.angle = r() * 6.28;
    b.life = 3 + r() * 3;
    b.age = 0;
    b.scale = 0.6 + r() * 1.4;
    b.ground = pos.y - 0.45;
    this.mesh.setColorAt(i, color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    if (this.aliveCount === 0) return;
    const bits = this.bits;
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      if (!b.alive) continue;
      b.age += dt;
      if (b.age > b.life) {
        b.alive = false;
        this.aliveCount--;
        this.mesh.setMatrixAt(i, _zero);
        continue;
      }
      b.vy -= 9.81 * dt;
      b.px += b.vx * dt; b.py += b.vy * dt; b.pz += b.vz * dt;
      if (b.py < b.ground) {
        b.py = b.ground;
        if (b.vy < 0) b.vy = -b.vy * 0.3;
        b.vx *= 0.6; b.vz *= 0.6;
        b.spin *= 0.5;
      }
      b.angle += b.spin * dt;
      _axis.set(b.ax, b.ay, b.az);
      _q.setFromAxisAngle(_axis, b.angle);
      const fade = 1 - Math.max(0, (b.age - (b.life - 0.6)) / 0.6);
      const sc = b.scale * fade;
      _p.set(b.px, b.py, b.pz);
      _s.set(sc, sc, sc);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
