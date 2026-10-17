import * as THREE from 'three';
import { Physics, PHYSICS_DT, RAPIER } from '../physics/Physics';
import { Track } from '../track/Track';
import { START_S } from '../track/TrackDef';
import { buildTrackColliders } from '../world/TrackColliders';
import { Environment } from '../world/Environment';
import { Vehicle, type Assists } from '../vehicle/Vehicle';
import { CARS, type CarSpec } from '../vehicle/CarSpec';
import { CarModels, CarVisual, makeTrafficVisual, modelHalfExtents, type CarModelEntry } from '../vehicle/CarVisual';
import { Input } from '../core/Input';
import { ChaseCamera } from '../core/ChaseCamera';
import { LampPool } from './LampPool';
import { makePlaceholderCar } from './Placeholder';
import { loadSettings, saveSettings, QUALITY, type Settings } from '../core/Settings';
import { createRenderer, applyPixelRatio } from '../render/Renderer';
import { PostFX } from '../render/PostFX';
import { Effects } from '../fx/Effects';
import { UI, type HudData, type ResultRow } from '../ui/UI';
import { Credits } from '../ui/Credits';
import { AudioSystem, type VehicleSound } from '../audio/AudioSystem';
import { RacerAI, type AIObstacle } from '../ai/RacerAI';
import { Traffic, type TrafficCarKind } from '../ai/Traffic';
import { NearMissDetector } from '../ai/NearMiss';
import { Race, type Racer } from '../race/Race';
import { Style } from '../race/Style';
import { carModelFor, RIVALS } from './Roster';

type Mode = 'boot' | 'title' | 'menu' | 'carselect' | 'race' | 'paused' | 'results';

interface CarEntity {
  id: number;
  spec: CarSpec;
  vehicle: Vehicle;
  visual: CarVisual | null;
  object: THREE.Object3D;
  renderPos: THREE.Vector3;
  renderQuat: THREE.Quaternion;
  ai: RacerAI | null;
  sound: VehicleSound | null;
  racer: Racer | null;
  colliderHandles: number[];
  lastCrash: number;
  scrape: number;
  wheelCenters: THREE.Vector3[];
  steer: number[];
  spin: number[];
  prevVel: THREE.Vector3;
  lean: THREE.Vector2;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _right = new THREE.Vector3();

export function assistsFor(s: Settings): Assists {
  const auto = s.transmission === 'auto';
  if (s.assists === 'pro') return { abs: true, tcs: false, esc: false, steerAssist: 0.25, autoGear: auto };
  if (s.assists === 'casual') return { abs: true, tcs: true, esc: true, steerAssist: 1.0, autoGear: auto };
  return { abs: true, tcs: true, esc: true, steerAssist: 0.7, autoGear: auto };
}

export class RaceGame {
  readonly canvas: HTMLCanvasElement;
  readonly uiRoot: HTMLElement;
  settings: Settings = loadSettings();
  renderer!: THREE.WebGLRenderer;
  post!: PostFX;
  scene = new THREE.Scene();
  physics = new Physics();
  track!: Track;
  env!: Environment;
  models = new CarModels();
  effects!: Effects;
  ui!: UI;
  credits!: Credits;
  audio = new AudioSystem();
  input = new Input();
  chase!: ChaseCamera;
  lampPool!: LampPool;
  mode: Mode = 'boot';
  race: Race | null = null;
  style = new Style();
  cars: CarEntity[] = [];
  player: CarEntity | null = null;
  traffic: Traffic | null = null;
  nearMiss = new NearMissDetector();
  selectedCar = 0;
  private colliderOwner = new Map<number, CarEntity>();
  private acc = 0;
  private last = 0;
  private time = 0;
  private menuCar: { object: THREE.Object3D; visual: CarVisual | null } | null = null;
  private menuAngle = 0;
  private resultsTimer = -1;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private flipTimer = 0;
  private lastWrongWayFlash = 0;
  private finalLapShown = false;
  private trafficKinds: TrafficCarKind[] = [];
  private trafficEntries: CarModelEntry[] = [];
  private startLightsStep = -2;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
  }

  get quality() {
    return QUALITY[this.settings.quality];
  }

  async init() {
    this.ui = new UI(this.uiRoot, this.settings);
    this.ui.onUiSound = (k) => this.audio.playUi(k);
    const prog = (p: number, t: string) => this.ui.setLoading(p, t);
    prog(0.02, 'Igniting physics');
    await this.physics.init();
    prog(0.08, 'Laying asphalt');
    this.track = new Track();
    buildTrackColliders(this.physics.world, this.track);
    this.physics.step();

    const q = this.quality;
    this.renderer = createRenderer(this.canvas, q);
    this.chase = new ChaseCamera(window.innerWidth / window.innerHeight);
    this.chase.shakeEnabled = this.settings.cameraShake;
    this.scene.add(this.chase.camera);

    prog(0.12, 'Building the city');
    this.env = new Environment(this.scene, this.renderer, this.track, q);
    await this.env.load((p) => prog(0.12 + p * 0.5, 'Building the city'));
    prog(0.64, 'Rolling out the cars');
    const used = new Set(CARS.map((c) => c.model));
    this.models.sportsFilter = (e) => used.has(e.file);
    await this.models.load((p) => prog(0.64 + p * 0.26, 'Rolling out the cars'));
    this.trafficEntries = this.models.traffic;
    this.trafficKinds = this.trafficEntries.map((e) => ({
      id: e.id,
      halfExtents: modelHalfExtents(this.models, e).toArray() as [number, number, number],
      mass: (e as unknown as { massKg?: number }).massKg ?? 1450,
      maxSpeed: (e as unknown as { maxSpeed?: number }).maxSpeed ?? 17,
    }));

    this.credits = new Credits(this.uiRoot);
    this.credits.setLines([
      ...this.models.credits(),
      'Music: "Hot Roadway" by MintoDog (CC0). Sound effects: Kenney, BigSoundBank, OpenGameArt contributors (CC0; CC-BY 3.0 items credited in audio CREDITS).',
      'Environment: Poly Haven and ambientCG (CC0) textures and HDRIs.',
    ]);
    this.credits.showButton(false);
    prog(0.92, 'Tuning the lights');
    this.lampPool = new LampPool(this.scene, this.track, q.dynamicLamps);
    this.effects = new Effects(this.scene, q);
    this.post = new PostFX(this.renderer, this.scene, this.chase.camera, q);
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < this.track.count; i += 4) pts.push({ x: this.track.px[i], z: this.track.pz[i] });
    this.ui.setMinimapTrack(pts, Math.floor(START_S / this.track.step / 4));

    // Gamepad -> UI navigation
    this.input.onPadNav = (dir) => {
      if (!this.ui.menuOpen) {
        if (dir === 'pause' && this.mode === 'race') this.pause();
        return;
      }
      if (dir === 'confirm') this.ui.confirm();
      else if (dir === 'back') this.ui.back();
      else if (dir !== 'pause') this.ui.navigate(dir);
    };

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'race') this.pause();
    });
    this.resize();
    this.placeMenuCar(this.selectedCar);
    prog(1, 'Ready');
    this.ui.hideLoading();
    this.mode = 'title';
    this.post.setMenuMode(true);
    this.ui.showTitle(async () => {
      await this.audio.init();
      this.applyAudioSettings();
      this.audio.setMenuMode(true);
      this.audio.playMusic('menu');
      this.goMenu();
    });
  }

  // ---------------------------------------------------------------- menus
  private goMenu() {
    this.mode = 'menu';
    this.credits.showButton(true);
    this.clearRace();
    this.placeMenuCar(this.selectedCar);
    this.post.setMenuMode(true);
    this.audio.setMenuMode(true);
    this.ui.showHud(false);
    this.ui.showMainMenu({
      onRace: () => this.goCarSelect(),
      onSettings: () => this.ui.showSettings(this.settings, (s) => this.applySettings(s), () => this.goMenu()),
      onControls: () => this.ui.showControls(() => this.goMenu()),
    });
  }

  private goCarSelect() {
    this.mode = 'carselect';
    this.ui.showCarSelect(
      CARS,
      {
        onSelect: (i) => {
          this.selectedCar = i;
          this.startRace();
        },
        onHover: (i) => {
          this.selectedCar = i;
          this.placeMenuCar(i);
        },
        onBack: () => this.goMenu(),
      },
      this.selectedCar,
    );
  }

  private applySettings(s: Settings) {
    const qualityChanged = s.quality !== this.settings.quality;
    this.settings = s;
    saveSettings(s);
    this.applyAudioSettings();
    this.chase.shakeEnabled = s.cameraShake;
    if (qualityChanged) {
      applyPixelRatio(this.renderer, this.quality);
      this.post.setQuality(this.quality);
      this.resize();
    }
    for (const c of this.cars) if (!c.ai) c.vehicle.assists = assistsFor(s);
    this.ui.setFps(s.showFps ? 0 : null);
  }

  private applyAudioSettings() {
    this.audio.setVolumes(this.settings.masterVolume, this.settings.musicVolume, this.settings.sfxVolume);
  }

  private placeMenuCar(i: number) {
    if (this.menuCar) {
      this.scene.remove(this.menuCar.object);
      this.menuCar.visual?.dispose();
      this.menuCar = null;
    }
    const spec = CARS[i];
    const entry = carModelFor(spec, this.models.sports, 0);
    let visual: CarVisual | null = null;
    let object: THREE.Object3D;
    if (entry) {
      visual = new CarVisual(this.models, entry, this.visualOpts(spec, true));
      object = visual.object;
      hideBadges(object, entry);
    } else object = makePlaceholderCar(spec);
    const f = this.track.frameAt(START_S + 40);
    object.position.copy(f.pos).addScaledVector(f.up, spec.wheelRadius + 0.02 + (spec.cgHeight - spec.wheelRadius));
    this.scene.add(object);
    if (visual) {
      const centers: THREE.Vector3[] = [];
      const tmpV = new Vehicle(this.physics.world, spec, new THREE.Vector3(0, -500 - i * 10, 0), new THREE.Quaternion());
      for (const w of tmpV.wheels) {
        w.compression = (spec.mass * 9.81 * (w.front ? spec.frontWeight : 1 - spec.frontWeight)) / 2 / w.k;
        centers.push(tmpV.wheelLocalCenter(w, new THREE.Vector3()));
      }
      this.physics.world.removeRigidBody(tmpV.body);
      visual.updateWheels(centers, [0.25, 0.22, 0, 0], [0, 0, 0, 0]);
      visual.setLights({ brake: 0.2, reverse: false, headlights: true, nitro: false });
    }
    this.menuCar = { object, visual };
  }

  private visualOpts(spec: CarSpec, player: boolean, paint?: number) {
    return {
      paint: paint ?? spec.paint,
      wheelbase: spec.wheelbase,
      trackFront: spec.trackFront,
      trackRear: spec.trackRear,
      wheelRadius: spec.wheelRadius,
      cgHeight: spec.cgHeight,
      player,
      envMap: this.env.envMap,
    };
  }

  // ---------------------------------------------------------------- race lifecycle
  private clearRace() {
    for (const c of this.cars) {
      this.scene.remove(c.object);
      c.visual?.dispose();
      c.sound?.dispose();
      for (const col of c.vehicle.colliders) this.colliderOwner.delete(col.handle);
      this.physics.world.removeRigidBody(c.vehicle.body);
    }
    this.cars = [];
    this.player = null;
    this.traffic?.clear();
    this.traffic = null;
    this.race = null;
    this.effects?.clear();
    this.resultsTimer = -1;
    this.finalLapShown = false;
  }

  startRace() {
    this.credits.showButton(false);
    this.clearRace();
    if (this.menuCar) {
      this.scene.remove(this.menuCar.object);
      this.menuCar.visual?.dispose();
      this.menuCar = null;
    }
    const s = this.settings;
    const race = new Race(this.track, s.laps);
    this.race = race;
    this.style.reset();
    const nOpp = Math.max(0, Math.min(7, s.opponents));
    const playerSlot = nOpp; // start at the back: earn it
    const rivals = RIVALS.slice(0, nOpp);
    const all: { spec: CarSpec; name: string; color: string; paint: number; player: boolean; skill: number; aggression: number; variant: number }[] = [];
    rivals.forEach((r, k) => {
      const spec = CARS[r.car % CARS.length];
      all.push({ spec, name: r.name, color: r.color, paint: r.paint, player: false, skill: r.skill, aggression: r.aggression, variant: r.variant });
    });
    const pSpec = CARS[this.selectedCar];
    all.splice(playerSlot, 0, { spec: pSpec, name: 'YOU', color: '#ffffff', paint: pSpec.paint, player: true, skill: 1, aggression: 0, variant: 0 });

    all.forEach((d, slot) => {
      const e = this.spawnCar(d.spec, slot, d.player, d.paint, d.variant);
      if (!d.player) {
        e.ai = new RacerAI(e.vehicle, this.track, { skill: d.skill, aggression: d.aggression, laneBias: slot % 2 === 0 ? -1 : 1 });
      } else this.player = e;
      e.racer = race.add(e.vehicle, d.name, d.spec.name, d.color, d.player);
      e.vehicle.gear = 0; // neutral on the grid; revs free until GO
    });

    // traffic
    const density = s.traffic === 'off' ? 0 : s.traffic === 'light' ? 22 : 40;
    if (density > 0 && this.trafficKinds.length) {
      this.traffic = new Traffic(this.physics.world, this.track, this.trafficKinds, (k) => this.makeTrafficObject(k), this.scene);
      this.traffic.spawn(density, [START_S]);
    }

    race.events = {
      onCountdown: (step) => {
        this.ui.countdown(step);
        this.audio.playCountdown(step);
        this.env.setStartLights(step === 0 ? -1 : 4 - step);
        if (step === 0) {
          for (const c of this.cars) c.vehicle.gear = 1;
          this.audio.playMusic('race');
        }
      },
      onLap: (r, lapTime, isBest, finalNext) => {
        if (!r.player) return;
        this.audio.playLap(finalNext);
        if (finalNext) {
          this.ui.flash('FINAL LAP', 1800, '#ff2bd6');
          this.audio.playMusic('final');
        } else this.ui.flash(isBest ? 'NEW BEST LAP' : `LAP ${r.lap + 1}`, 1400, isBest ? '#7cf8ff' : '#f2f4ff');
      },
      onFinish: (r) => {
        if (r.player) {
          this.ui.flash(r.position === 1 ? 'YOU WIN!' : `FINISHED P${r.position}`, 3000, r.position === 1 ? '#ffe14d' : '#f2f4ff');
          this.resultsTimer = 3.5;
          if (this.player) this.player.ai = new RacerAI(this.player.vehicle, this.track, { skill: 0.82, aggression: 0 });
        }
      },
    };
    this.env.setStartLights(0);
    this.mode = 'race';
    this.ui.hideMenus();
    this.ui.showHud(true);
    this.ui.setFps(s.showFps ? 0 : null);
    this.post.setMenuMode(false);
    this.audio.setMenuMode(false);
    this.audio.stopMusic(1.5);
    this.chase.snap();
    this.chase.mode = 'chase';
    // short grid intro then lights
    window.setTimeout(() => this.race === race && race.startCountdown(), 1200);
  }

  private spawnCar(spec: CarSpec, slot: number, player: boolean, paint: number, variant: number): CarEntity {
    const g = Race.gridSlot(this.track, slot);
    const f = this.track.frameAt(g.s);
    const pos = f.pos.clone().addScaledVector(f.right, g.lateral).addScaledVector(f.up, spec.cgHeight + 0.15);
    const quat = Vehicle.quatFromFrame(f.tangent, f.up);
    const vehicle = new Vehicle(this.physics.world, spec, pos, quat);
    vehicle.assists = player ? assistsFor(this.settings) : { abs: true, tcs: true, esc: true, steerAssist: 0.6, autoGear: true };
    vehicle.nitro = player ? 0.5 : 0.5;
    const entry = carModelFor(spec, this.models.sports, variant);
    let visual: CarVisual | null = null;
    let object: THREE.Object3D;
    if (entry) {
      visual = new CarVisual(this.models, entry, this.visualOpts(spec, player, paint));
      object = visual.object;
      hideBadges(object, entry);
    } else object = makePlaceholderCar(spec);
    this.scene.add(object);
    const e: CarEntity = {
      id: this.cars.length,
      spec,
      vehicle,
      visual,
      object,
      renderPos: pos.clone(),
      renderQuat: quat.clone(),
      ai: null,
      sound: this.audio.createVehicleSound(spec, player),
      racer: null,
      colliderHandles: vehicle.colliders.map((c) => c.handle),
      lastCrash: -10,
      scrape: 0,
      wheelCenters: [0, 1, 2, 3].map(() => new THREE.Vector3()),
      steer: [0, 0, 0, 0],
      spin: [0, 0, 0, 0],
      prevVel: new THREE.Vector3(),
      lean: new THREE.Vector2(),
    };
    for (const h of e.colliderHandles) this.colliderOwner.set(h, e);
    this.cars.push(e);
    return e;
  }

  private makeTrafficObject(kind: number): THREE.Object3D {
    const entry = this.trafficEntries[kind];
    const paints = [0xd8d8d8, 0x202020, 0x8a1b1b, 0x1b3a8a, 0xe8c547, 0x5a5f66, 0xf2f2f2, 0x2c5e3a];
    const kindStr = (entry as unknown as { kind?: string }).kind;
    const paint = kindStr === 'taxi' ? 0xf2c400 : paints[(Math.random() * paints.length) | 0];
    const inner = makeTrafficVisual(this.models, entry, kindStr === 'taxi' || kindStr === 'bus' ? undefined : paint);
    const half = inner.userData.halfExtents as THREE.Vector3;
    inner.position.y = half.y;
    const wrap = new THREE.Group();
    wrap.add(inner);
    wrap.userData.setBrake = inner.userData.setBrake;
    wrap.userData.dispose = inner.userData.dispose;
    return wrap;
  }

  pause() {
    if (this.mode !== 'race') return;
    this.mode = 'paused';
    this.post.setMenuMode(true);
    this.audio.setMenuMode(true);
    this.ui.showPause({
      onResume: () => this.resume(),
      onRestart: () => this.startRace(),
      onSettings: () => this.ui.showSettings(this.settings, (s) => this.applySettings(s), () => this.pauseMenuAgain()),
      onQuit: () => {
        this.audio.playMusic('menu');
        this.goMenu();
      },
    });
  }

  private pauseMenuAgain() {
    this.mode = 'race';
    this.pause();
  }

  resume() {
    this.mode = 'race';
    this.ui.hideMenus();
    this.post.setMenuMode(false);
    this.audio.setMenuMode(false);
    this.last = performance.now();
  }

  private showResults() {
    const race = this.race!;
    this.mode = 'results';
    // estimate finish times for unfinished racers
    const L = this.track.length * race.laps;
    const rows: ResultRow[] = race.standings.map((r) => {
      let time = r.finishTime;
      if (time === null) {
        const remaining = Math.max(0, L - r.progress);
        const avg = Math.max(20, r.progress / Math.max(1, race.time));
        time = race.time + remaining / avg;
      }
      return { position: r.position, name: r.name, car: r.carName, time, bestLap: r.bestLap, player: r.player };
    });
    rows.sort((a, b) => (a.time ?? 0) - (b.time ?? 0)).forEach((r, i) => (r.position = i + 1));
    this.ui.showHud(false);
    this.post.setMenuMode(true);
    this.audio.setMenuMode(true);
    this.ui.showResults(
      rows,
      { style: Math.round(this.style.total), topSpeed: this.style.topSpeed, drift: this.style.bestDrift, nearMisses: this.style.nearMisses },
      { onRestart: () => this.startRace(), onMenu: () => { this.audio.playMusic('menu'); this.goMenu(); } },
    );
  }

  resetCar(e: CarEntity) {
    const p = this.track.project(e.vehicle.position, e.racer?.proj.index ?? -1);
    const lat = THREE.MathUtils.clamp(p.lateral, -this.track.halfWidth + 2.2, this.track.halfWidth - 2.2);
    const f = this.track.frameAt(p.s);
    const pos = f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, e.spec.cgHeight + 0.4);
    e.vehicle.reset(pos, Vehicle.quatFromFrame(f.tangent, f.up));
    if (this.race?.started) e.vehicle.gear = 1;
    e.ai?.onReset();
    if (e === this.player) this.chase.snap();
  }

  // ---------------------------------------------------------------- loop
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    if (this.post) this.post.setSize(w, h);
    else this.renderer.setSize(w, h, false);
    this.chase.camera.aspect = w / h;
    this.chase.camera.updateProjectionMatrix();
  }

  start() {
    this.last = performance.now();
    const loop = (t: number) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, Math.max(0, (t - this.last) / 1000));
      this.last = t;
      this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  private frame(dt: number) {
    this.time += dt;
    this.input.update(dt);
    if (this.mode === 'race') this.raceFrame(dt);
    else if (this.mode === 'paused') {
      this.input.clearPressed();
    } else this.menuFrame(dt);

    if (this.mode === 'results' || this.mode === 'paused') {
      // keep the world alive slowly in the background on results
      if (this.mode === 'results') this.simulate(dt, false);
    }

    this.lampPool.update(this.chase.camera.position);
    this.env.update(dt, this.chase.camera, this.time);
    this.effects.update(dt, this.chase.camera, this.player ? Math.abs(this.player.vehicle.speed) : 0);
    this.audio.setListener(this.chase.camera.position, this.chase.camera.getWorldDirection(_v), this.chase.camera.up, this.player?.vehicle.velocity ?? _v2.set(0, 0, 0));
    this.audio.update(dt);
    this.post.render(dt);

    // fps
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      if (this.settings.showFps) this.ui.setFps(Math.round(this.fpsFrames / this.fpsAcc));
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  }

  private menuFrame(dt: number) {
    this.input.clearPressed();
    // slow cinematic orbit around the showroom car on the start straight
    this.menuAngle += dt * 0.18;
    const f = this.track.frameAt(START_S + 40);
    const center = f.pos.clone().addScaledVector(f.up, 0.7);
    const r = this.mode === 'carselect' ? 6.2 : 8.5;
    const a = this.menuAngle;
    const cam = this.chase.camera;
    cam.position.copy(center).addScaledVector(f.tangent, Math.cos(a) * r).addScaledVector(f.right, Math.sin(a) * r);
    cam.position.y += this.mode === 'carselect' ? 1.4 : 2.4;
    cam.lookAt(center);
    cam.fov = 50;
    cam.updateProjectionMatrix();
    if (this.menuCar) {
      this.menuCar.object.quaternion.copy(Vehicle.quatFromFrame(f.tangent, f.up));
    }
  }

  private raceFrame(dt: number) {
    const race = this.race!;
    const P = this.player!;
    const inp = this.input;
    if (inp.consume('pause')) {
      this.pause();
      return;
    }
    if (inp.consume('camera')) this.chase.cycle();
    if (inp.consume('mute')) {
      const m = this.settings.masterVolume > 0 ? 0 : 0.8;
      this.applySettings({ ...this.settings, masterVolume: m });
      this.ui.flash(m ? 'SOUND ON' : 'MUTED', 900);
    }
    if (inp.consume('reset') && race.started && !P.racer?.finished) this.resetCar(P);
    const pv = P.vehicle;
    if (!pv.assists.autoGear) {
      if (inp.consume('shiftUp')) pv.shift(pv.gear + 1);
      if (inp.consume('shiftDown')) pv.shift(pv.gear - 1);
    } else {
      inp.consume('shiftUp');
      inp.consume('shiftDown');
    }

    if (!P.ai) {
      const s = inp.state;
      pv.input.throttle = s.throttle;
      pv.input.brake = s.brake;
      pv.input.steer = s.steer;
      pv.input.handbrake = s.handbrake;
      pv.input.nitro = s.nitro && race.started;
      if (!race.started) {
        pv.input.brake = 1;
        pv.input.handbrake = 1;
      }
    }

    this.simulate(dt, true);

    // auto-reset if flipped / stuck for the player
    const up = pv.upVec.y;
    if (race.started && (up < 0.2 || (P.racer && Math.abs(P.racer.proj.lateral) > this.track.halfWidth + 6))) this.flipTimer += dt;
    else this.flipTimer = 0;
    if (this.flipTimer > 2.5) {
      this.resetCar(P);
      this.flipTimer = 0;
    }

    // results transition
    if (this.resultsTimer > 0) {
      this.resultsTimer -= dt;
      if (this.resultsTimer <= 0) this.showResults();
    }

    // camera
    this.chase.update(dt, { position: P.renderPos, quaternion: P.renderQuat, velocity: pv.velocity }, Math.abs(pv.speed), pv.boosting, inp.state.lookBack, pv.groundedWheels === 0);
    const sNorm = THREE.MathUtils.clamp(pv.speedKmh / 320, 0, 1);
    this.post.setSpeed(sNorm);
    this.post.setNitro(pv.boosting);

    // HUD
    this.updateHud();
  }

  /** Physics + AI + traffic + effects + audio for one frame. `racing` = full race logic. */
  private simulate(dt: number, racing: boolean) {
    const race = this.race;
    if (!race) return;
    // AI
    const obstacles: AIObstacle[] = [];
    for (const c of this.cars) {
      const r = c.racer!;
      obstacles.push({ position: c.vehicle.position, velocity: c.vehicle.velocity, halfLength: c.spec.bodyHalf[2], halfWidth: c.spec.bodyHalf[0], s: r.proj.s, lateral: r.proj.lateral });
    }
    if (this.traffic) {
      for (const t of this.traffic.cars) obstacles.push({ position: t.position, velocity: t.velocity, halfLength: t.halfLength, halfWidth: t.halfWidth, s: t.s, lateral: t.lateral });
    }
    const pProg = this.player?.racer?.progress ?? 0;
    for (const c of this.cars) {
      if (!c.ai) continue;
      const r = c.racer!;
      const behind = (pProg - r.progress) / 150;
      c.ai.update(dt, {
        obstacles: obstacles.filter((o) => o.position !== c.vehicle.position),
        playerS: this.player?.racer?.proj.s ?? 0,
        selfS: r.proj.s,
        raceStarted: race.started,
        rubberBand: THREE.MathUtils.clamp(behind, -1, 1),
      });
      if (!race.started) {
        c.vehicle.input.brake = 1;
        c.vehicle.input.handbrake = 1;
        c.vehicle.input.throttle = 0.35 + 0.3 * Math.sin(this.time * 3 + c.id); // rev on the grid
      }
      if (c.ai.needsReset) {
        const spot = c.ai.findResetSpot(obstacles.filter((o) => o.position !== c.vehicle.position));
        const f = this.track.frameAt(spot.s);
        const pos = f.pos.clone().addScaledVector(f.right, spot.lateral).addScaledVector(f.up, c.spec.cgHeight + 0.4);
        this.traffic?.clearAround(pos, 10);
        c.vehicle.reset(pos, Vehicle.quatFromFrame(f.tangent, f.up));
        if (race.started) c.vehicle.gear = 1;
        c.ai.onReset();
      }
    }

    for (const c of this.cars) c.vehicle.update(dt);

    // fixed-step physics
    this.acc += dt;
    let steps = 0;
    let crashedThisFrame = false;
    for (const c of this.cars) c.scrape = 0;
    while (this.acc >= PHYSICS_DT && steps < 12) {
      for (const c of this.cars) {
        c.vehicle.prevPosition.copy(c.vehicle.position);
        c.vehicle.prevQuaternion.copy(c.vehicle.quaternion);
        c.vehicle.substep(PHYSICS_DT);
      }
      this.traffic?.substep(PHYSICS_DT);
      this.physics.step();
      for (const c of this.cars) c.vehicle.syncState();
      crashedThisFrame = this.handleContacts() || crashedThisFrame;
      this.acc -= PHYSICS_DT;
      steps++;
    }
    if (steps >= 12) this.acc = 0;
    const alpha = this.acc / PHYSICS_DT;
    if (this.traffic) {
      this.traffic.update(dt, this.player?.vehicle.position ?? this.chase.camera.position, this.cars.map((c) => c.vehicle), alpha);
      for (const t of this.traffic.cars) (t.object.userData.setBrake as ((b: number) => void) | undefined)?.((t as unknown as { braking?: boolean }).braking ? 1 : 0);
    }

    race.update(dt);

    const P = this.player;
    // style + near misses
    if (racing && P && race.started && !P.racer!.finished) {
      let drafting = false;
      for (const c of this.cars) {
        if (c === P) continue;
        const d = c.racer!.progress - P.racer!.progress;
        if (d > 2 && d < 18 && Math.abs(c.racer!.proj.lateral - P.racer!.proj.lateral) < 1.8) drafting = true;
      }
      this.style.update(dt, P.vehicle, crashedThisFrame && this.time - P.lastCrash < 0.05, drafting);
      if (this.traffic) {
        const nm = this.nearMiss.update(P.vehicle, this.traffic.cars, dt);
        if (nm) {
          this.style.nearMiss(nm.kind === 'oncoming', P.vehicle.speedKmh);
          this.audio.playNearMiss();
        }
      }
      for (const ev of this.style.drain()) {
        this.ui.popup(ev.title, ev.sub, ev.color);
        if (ev.nitro > 0) P.vehicle.addNitro(ev.nitro);
      }
      if (P.vehicle.boosting && !this._wasBoost) this.audio.playNitroStart();
      this._wasBoost = P.vehicle.boosting;
    }
    // AI nitro trickle so they can use it on straights
    for (const c of this.cars) if (c.ai && race.started) c.vehicle.addNitro(dt * 0.012);

    // visuals
    for (const c of this.cars) this.syncVisual(c, alpha);
    this.syncAudio();
  }
  private _wasBoost = false;

  private handleContacts(): boolean {
    let playerCrash = false;
    const world = this.physics.world;
    this.physics.events.drainContactForceEvents((ev) => {
      const h1 = ev.collider1(), h2 = ev.collider2();
      const a = this.colliderOwner.get(h1);
      const b = this.colliderOwner.get(h2);
      const impulse = ev.totalForceMagnitude() * PHYSICS_DT; // N*s
      const owner = a ?? b;
      if (this.traffic) {
        if (this.traffic.colliderToCar(h1) >= 0) this.traffic.notifyImpact(h1, impulse);
        if (this.traffic.colliderToCar(h2) >= 0) this.traffic.notifyImpact(h2, impulse);
      }
      if (!owner) return;
      const other = a ? h2 : h1;
      const tIdx = this.traffic ? this.traffic.colliderToCar(other) : -1;
      if (tIdx >= 0 && owner === this.player) this.nearMiss.notifyContact(tIdx);
      const isStatic = !this.colliderOwner.has(other) && (this.traffic?.colliderToCar(other) ?? -1) < 0;
      const mass = owner.spec.mass;
      const dv = impulse / mass; // m/s velocity change
      // contact point for sparks
      const c1 = world.getCollider(h1), c2 = world.getCollider(h2);
      let point: THREE.Vector3 | null = null;
      let normal: THREE.Vector3 | null = null;
      if (c1 && c2) {
        world.contactPair(c1, c2, (manifold, flipped) => {
          if (point || manifold.numSolverContacts() === 0) return;
          const p = manifold.solverContactPoint(0);
          const n = manifold.normal();
          if (p) point = new THREE.Vector3(p.x, p.y, p.z);
          normal = new THREE.Vector3(n.x, n.y, n.z).multiplyScalar(flipped ? -1 : 1);
        });
      }
      const pt = point ?? owner.vehicle.position;
      const nrm = normal ?? _v.set(0, 1, 0);
      if (isStatic) owner.scrape = Math.max(owner.scrape, Math.min(1, dv * 0.6));
      if (dv > 2.2 && this.time - owner.lastCrash > 0.25) {
        owner.lastCrash = this.time;
        const intensity = THREE.MathUtils.clamp(dv / 14, 0.1, 1);
        this.audio.playCrash(intensity, pt);
        this.effects.sparks(pt, nrm, owner.vehicle.velocity, intensity);
        if (dv > 7) this.effects.debris(pt, owner.vehicle.velocity, intensity);
        if (owner === this.player) {
          playerCrash = true;
          this.chase.impact(intensity);
          this.post.impact(intensity);
        }
      } else if (isStatic && dv > 0.15) {
        // scraping along a wall
        if (Math.random() < 0.5) this.effects.sparks(pt, nrm, owner.vehicle.velocity, 0.15 + Math.min(0.4, dv * 0.2));
      }
    });
    return playerCrash;
  }

  private syncVisual(c: CarEntity, alpha: number) {
    const v = c.vehicle;
    c.renderPos.lerpVectors(v.prevPosition, v.position, alpha);
    c.renderQuat.slerpQuaternions(v.prevQuaternion, v.quaternion, alpha);
    c.object.position.copy(c.renderPos);
    c.object.quaternion.copy(c.renderQuat);
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      v.wheelLocalCenter(w, c.wheelCenters[i]);
      c.steer[i] = w.steer;
      c.spin[i] = w.spin;
    }
    const braking = Math.max(v.input.brake * (v.gear === -1 ? 0 : 1), v.gear === -1 ? v.input.throttle : 0);
    if (c.visual) {
      // exaggerate body roll/pitch from local accelerations (physics roll is realistic but subtle)
      const dtv = 1 / 60;
      _v.subVectors(v.velocity, c.prevVel).divideScalar(dtv);
      c.prevVel.copy(v.velocity);
      _v2.set(1, 0, 0).applyQuaternion(c.renderQuat);
      const latA = THREE.MathUtils.clamp(_v.dot(_v2), -20, 20);
      const lonA = THREE.MathUtils.clamp(_v.dot(v.forward), -20, 20);
      const grounded = v.groundedWheels >= 2;
      c.lean.x += ((grounded ? latA * 0.0055 : 0) - c.lean.x) * 0.12;
      c.lean.y += ((grounded ? -lonA * 0.0045 : 0) - c.lean.y) * 0.12;
      c.visual.setBodyLean(c.lean.x, c.lean.y);
      c.visual.updateLod(this.chase.camera.position);
      c.visual.updateWheels(c.wheelCenters, c.steer, c.spin);
      c.visual.setLights({ brake: braking, reverse: v.gear === -1, headlights: true, nitro: v.boosting });
    } else {
      const wheels = c.object.userData.wheels as THREE.Object3D[];
      wheels.forEach((wo, i) => {
        wo.position.copy(c.wheelCenters[i]);
        wo.rotation.set(0, c.steer[i], 0);
        wo.children[0].rotation.x = c.spin[i];
      });
    }

    // effects: skids + smoke + exhaust (skip far cars)
    const cam = this.chase.camera.position;
    const dist2 = c.renderPos.distanceToSquared(cam);
    if (dist2 < 220 * 220) {
      _right.set(-1, 0, 0).applyQuaternion(c.renderQuat);
      for (let i = 0; i < 4; i++) {
        const w = v.wheels[i];
        const id = c.id * 4 + i;
        const inten = w.contact ? w.skid : 0;
        this.effects.skid(id, w.point, w.normal, _right, c.spec.wheelWidth, inten > 0.28 ? inten : 0);
        if (w.contact && inten > 0.35 && w.slideSpeed > 4) {
          this.effects.tireSmoke(w.point, v.velocity, Math.min(1, inten * (w.slideSpeed / 12)));
        }
      }
      if (c.visual) {
        _m.compose(c.renderPos, c.renderQuat, _v.set(1, 1, 1));
        this.effects.exhaust(c.id, _m, { localPos: c.visual.exhausts }, v.boosting, v.backfire > 0, v.throttleOut, v.velocity);
      }
    }
  }

  private syncAudio() {
    const tunnel = this.player ? this.track.tunnelBlend[this.player.racer!.proj.index] : 0;
    this.audio.setTunnel(tunnel);
    for (const c of this.cars) {
      if (!c.sound) continue;
      const v = c.vehicle;
      let skid = 0;
      let surface = 0;
      for (const w of v.wheels) {
        if (w.contact) skid = Math.max(skid, w.skid);
        if (w.contact && w.surfaceKind === 1) surface = 1;
      }
      c.sound.update(
        {
          rpm: v.rpm,
          redline: c.spec.redline,
          limiter: v.rpm >= c.spec.limiter - 50,
          load: v.load,
          throttle: v.throttleOut,
          boosting: v.boosting,
          gear: v.gear,
          shiftEvent: v.shiftEvent,
          backfire: v.backfire > 0,
          speed: Math.abs(v.speed),
          skid,
          surface,
          position: c.renderPos,
          velocity: v.velocity,
        },
        1 / 60,
      );
    }
    if (this.player) {
      this.audio.setWind(Math.abs(this.player.vehicle.speed));
      this.audio.setScrape(this.player.scrape, this.player.renderPos);
    }
  }

  private updateHud() {
    const race = this.race!;
    const P = this.player!;
    const v = P.vehicle;
    const r = P.racer!;
    const st = race.standings;
    const idx = st.indexOf(r);
    const ahead = idx > 0 ? st[idx - 1] : null;
    const behind = idx < st.length - 1 ? st[idx + 1] : null;
    if (r.wrongWay > 1.2 && this.time - this.lastWrongWayFlash > 2.5) {
      this.lastWrongWayFlash = this.time;
      this.ui.flash('WRONG WAY', 1500, '#ff3355');
    }
    const hud: HudData = {
      speed: Math.abs(v.speed),
      rpm: v.rpm,
      redline: P.spec.redline,
      limiter: P.spec.limiter,
      gear: v.shiftTimer > 0 ? 0 : v.gear,
      nitro: v.nitro,
      boosting: v.boosting,
      position: r.position,
      total: race.racers.length,
      lap: Math.min(race.laps, r.lap + 1),
      laps: race.laps,
      raceTime: race.started ? race.time : 0,
      lapTime: race.currentLapTime(r),
      bestLap: r.bestLap,
      lastLap: r.lastLap,
      cars: this.cars.map((c) => ({ x: c.renderPos.x, z: c.renderPos.z, color: c.racer!.color, player: c === P })),
      heading: Math.atan2(v.forward.x, v.forward.z),
      style: Math.round(this.style.total),
      drift: { active: this.style.driftActive, points: Math.round(this.style.driftPoints), mult: this.style.driftMult },
      wrongWay: r.wrongWay > 1.2,
      gapAhead: ahead ? race.gap(r, ahead) : null,
      gapBehind: behind ? race.gap(r, behind) : null,
    };
    this.ui.updateHud(hud);
  }
}

/** Strip manufacturer badges/logos from a car model (trademarks). */
function hideBadges(root: THREE.Object3D, entry: CarModelEntry) {
  const re = /logo|badge|emblem|brand|wordmark|sticker|wunderbaum/i;
  const listed = new Set(((entry as unknown as { logos?: { materials?: string[] } }).logos?.materials ?? []).filter((n) => !/plate/i.test(n)));
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (re.test(m.name) || mats.some((x) => x && (re.test(x.name) || listed.has(x.name)))) m.visible = false;
  });
}

function trafficHalfExtents(e: CarModelEntry): [number, number, number] {
  const b = (e as unknown as { bounds?: { min: number[]; max: number[] } }).bounds;
  const L = (e as unknown as { lengthMeters?: number }).lengthMeters ?? 4.5;
  if (b) {
    const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
    const fwdIsX = (e as unknown as { forwardAxis?: string }).forwardAxis?.includes('x');
    const len = fwdIsX ? sx : sz;
    const wid = fwdIsX ? sz : sx;
    const k = L / Math.max(1e-3, len);
    return [(wid * k) / 2, (sy * k) / 2, L / 2];
  }
  return [0.9, 0.75, L / 2];
}

export { RAPIER };
