import * as THREE from 'three';
import { Physics, PHYSICS_DT } from '../physics/Physics';
import { Track } from '../track/Track';
import { START_S } from '../track/TrackDef';
import { buildTrackColliders } from '../world/TrackColliders';
import { Vehicle } from '../vehicle/Vehicle';
import { CARS, type CarSpec } from '../vehicle/CarSpec';
import { Input } from '../core/Input';
import { ChaseCamera } from '../core/ChaseCamera';
import { LampPool } from './LampPool';
import { buildPlaceholderWorld, makePlaceholderCar } from './Placeholder';
import { loadSettings, QUALITY, type Settings } from '../core/Settings';

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _w = new THREE.Vector3();

interface CarEntity {
  vehicle: Vehicle;
  object: THREE.Group;
  renderPos: THREE.Vector3;
  renderQuat: THREE.Quaternion;
  hint: number;
}

export class Game {
  readonly canvas: HTMLCanvasElement;
  renderer!: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  physics = new Physics();
  track!: Track;
  input = new Input();
  chase!: ChaseCamera;
  lampPool!: LampPool;
  settings: Settings = loadSettings();
  player!: CarEntity;
  cars: CarEntity[] = [];
  private acc = 0;
  private last = 0;
  private headL!: THREE.SpotLight;
  private headR!: THREE.SpotLight;
  hud?: HTMLElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init(onProgress?: (p: number, t: string) => void) {
    onProgress?.(0.05, 'Starting physics');
    await this.physics.init();
    onProgress?.(0.2, 'Building circuit');
    this.track = new Track();
    buildTrackColliders(this.physics.world, this.track);
    this.physics.step();

    const q = QUALITY[this.settings.quality];
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.background = new THREE.Color(0x06060c);
    this.scene.fog = new THREE.FogExp2(0x0a0814, 0.0028);
    this.scene.add(new THREE.HemisphereLight(0x3a4466, 0x0a0806, 0.35));
    const moon = new THREE.DirectionalLight(0x8899cc, 0.25);
    moon.position.set(-200, 300, -100);
    this.scene.add(moon);

    onProgress?.(0.4, 'Building city');
    buildPlaceholderWorld(this.scene, this.track);
    this.lampPool = new LampPool(this.scene, this.track, q.dynamicLamps);

    this.chase = new ChaseCamera(window.innerWidth / window.innerHeight);
    this.scene.add(this.chase.camera);

    onProgress?.(0.7, 'Spawning cars');
    this.player = this.spawnCar(CARS[0], 0);
    // player headlights
    this.headL = new THREE.SpotLight(0xfff4e0, 400, 90, 0.42, 0.5, 1.6);
    this.headR = this.headL.clone();
    for (const [h, x] of [[this.headL, 0.65], [this.headR, -0.65]] as [THREE.SpotLight, number][]) {
      h.position.set(x, 0.1, 2.1);
      h.target.position.set(x * 1.5, -0.6, 22);
      this.player.object.add(h, h.target);
    }

    window.addEventListener('resize', () => this.resize());
    this.resize();
    onProgress?.(1, 'Ready');
  }

  gridSlot(i: number): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const s = START_S - 12 - row * 9;
    const lateral = col === 0 ? 2.0 : 5.6;
    const f = this.track.frameAt(s);
    const pos = f.pos.clone().addScaledVector(f.right, lateral).addScaledVector(f.up, 0.6);
    return { pos, quat: Vehicle.quatFromFrame(f.tangent, f.up) };
  }

  spawnCar(spec: CarSpec, slot: number): CarEntity {
    const { pos, quat } = this.gridSlot(slot);
    pos.y += spec.cgHeight;
    const vehicle = new Vehicle(this.physics.world, spec, pos, quat);
    const object = makePlaceholderCar(spec);
    this.scene.add(object);
    const e: CarEntity = { vehicle, object, renderPos: pos.clone(), renderQuat: quat.clone(), hint: -1 };
    this.cars.push(e);
    return e;
  }

  resetToTrack(e: CarEntity) {
    const p = this.track.project(e.vehicle.position, e.hint);
    const s = p.s;
    const lat = THREE.MathUtils.clamp(p.lateral, -this.track.halfWidth + 2, this.track.halfWidth - 2);
    const f = this.track.frameAt(s);
    const pos = f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, 0.6 + e.vehicle.spec.cgHeight);
    e.vehicle.reset(pos, Vehicle.quatFromFrame(f.tangent, f.up));
    this.chase.snap();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.chase.camera.aspect = w / h;
    this.chase.camera.updateProjectionMatrix();
  }

  start() {
    this.last = performance.now();
    const loop = (t: number) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  private frame(dt: number) {
    const input = this.input;
    input.update(dt);
    const pv = this.player.vehicle;
    if (input.consume('camera')) this.chase.cycle();
    if (input.consume('reset')) this.resetToTrack(this.player);
    if (input.consume('shiftUp')) pv.shift(pv.gear + 1);
    if (input.consume('shiftDown')) pv.shift(pv.gear - 1);
    const s = input.state;
    pv.input.throttle = s.throttle;
    pv.input.brake = s.brake;
    pv.input.steer = s.steer;
    pv.input.handbrake = s.handbrake;
    pv.input.nitro = s.nitro;
    if (pv.nitro < 1) pv.addNitro(dt * 0.02);

    for (const c of this.cars) c.vehicle.update(dt);

    this.acc += dt;
    let steps = 0;
    while (this.acc >= PHYSICS_DT && steps < 12) {
      for (const c of this.cars) {
        c.vehicle.prevPosition.copy(c.vehicle.position);
        c.vehicle.prevQuaternion.copy(c.vehicle.quaternion);
        c.vehicle.substep(PHYSICS_DT);
      }
      this.physics.step();
      for (const c of this.cars) c.vehicle.syncState();
      this.acc -= PHYSICS_DT;
      steps++;
    }
    if (steps === 12) this.acc = 0;
    const alpha = this.acc / PHYSICS_DT;

    for (const c of this.cars) {
      const v = c.vehicle;
      c.renderPos.lerpVectors(v.prevPosition, v.position, alpha);
      c.renderQuat.slerpQuaternions(v.prevQuaternion, v.quaternion, alpha);
      c.object.position.copy(c.renderPos);
      c.object.quaternion.copy(c.renderQuat);
      const wheels = c.object.userData.wheels as THREE.Object3D[];
      v.wheels.forEach((w, i) => {
        v.wheelLocalCenter(w, _w);
        wheels[i].position.copy(_w);
        wheels[i].rotation.set(0, w.steer, 0);
        wheels[i].children[0].rotation.x = w.spin;
      });
      const tail = c.object.userData.tailMat as THREE.MeshBasicMaterial;
      const braking = v.input.brake > 0.05;
      tail.color.setRGB(braking ? 10 : 2.5, 0.08, 0.08);
      const pr = this.track.project(v.position, c.hint);
      c.hint = pr.index;
    }

    const P = this.player;
    this.chase.update(dt, { position: P.renderPos, quaternion: P.renderQuat, velocity: P.vehicle.velocity }, Math.abs(P.vehicle.speed), P.vehicle.boosting, s.lookBack, P.vehicle.groundedWheels === 0);
    this.lampPool.update(P.renderPos);

    if (this.hud) {
      const v = P.vehicle;
      const gear = v.gear === -1 ? 'R' : v.gear === 0 ? 'N' : String(v.gear);
      this.hud.textContent = `${v.speedKmh.toFixed(0)} km/h   ${gear}   ${v.rpm.toFixed(0)} rpm   NOS ${(v.nitro * 100).toFixed(0)}%`;
    }

    this.renderer.render(this.scene, this.chase.camera);
  }
}
