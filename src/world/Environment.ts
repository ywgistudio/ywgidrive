import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { Track } from '../track/Track';
import { START_S } from '../track/TrackDef';
import type { QualityProfile } from '../core/Settings';
import { TrackGrid } from './TrackGrid';
import { Terrain } from './Terrain';
import { LampLighting } from './LampLighting';
import { TrackMesh, type SurfaceKind } from './TrackMesh';
import { createTrackMaterials, worldUniforms, type TrackTextures } from './TrackMaterials';
import { City } from './City';
import { NeonAtlas, placeSigns, buildSignMesh } from './Neon';
import { StreetProps } from './StreetProps';
import { buildWater } from './Water';
import { Sky, FOG_COLOR } from './Sky';

/** env reflection strength for specific meshes (others use scene.environmentIntensity) */
const ENV_STRENGTH: Record<string, number> = {
  buildings: 0.1,
  roofProps: 0.1,
  terrain: 0.12,
  trees: 0.08,
  water: 0.9,
  containers: 0.15,
  cranes: 0.15,
};

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * All static visuals of "Midnight Circuit": road surfaces (matching physics), analytic streetlight
 * lighting, procedural night city, neon signage, props, harbor water and the sky.
 */
export class Environment {
  envMap: THREE.Texture | null = null;
  readonly root = new THREE.Group();
  lamps!: LampLighting;
  grid!: TrackGrid;
  terrain!: Terrain;
  city!: City;
  props!: StreetProps;
  sky!: Sky;
  hemi!: THREE.HemisphereLight;
  moon!: THREE.DirectionalLight;
  /** arc lengths of painted zebra crossings (traffic lights stand there) */
  zebras: number[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];

  constructor(
    readonly scene: THREE.Scene,
    readonly renderer: THREE.WebGLRenderer,
    readonly track: Track,
    readonly quality: QualityProfile,
  ) {
    this.root.name = 'environment';
  }

  async load(onProgress?: (p: number) => void): Promise<void> {
    const base = import.meta.env.BASE_URL;
    const progress = (p: number) => onProgress?.(Math.min(1, Math.max(0, p)));
    progress(0);

    // ---------------------------------------------------------------- assets
    const tl = new THREE.TextureLoader();
    const files = [
      'asphalt_color', 'asphalt_normal', 'asphalt_rough',
      'sidewalk_color', 'sidewalk_normal', 'sidewalk_rough',
      'concrete_color', 'concrete_normal', 'concrete_rough',
    ];
    let done = 0;
    const total = files.length + 1;
    const texMap: Record<string, THREE.Texture> = {};
    const texPromises = files.map(
      (f) =>
        new Promise<void>((res, rej) => {
          tl.load(
            `${base}assets/tex/${f}.jpg`,
            (t) => {
              texMap[f] = t;
              this.textures.push(t);
              done++;
              progress((done / total) * 0.45);
              res();
            },
            undefined,
            rej,
          );
        }),
    );
    const hdrPromise = new HDRLoader().loadAsync(`${base}assets/env/night_1k.hdr`).then((hdr) => {
      done++;
      progress((done / total) * 0.45);
      return hdr;
    });
    const [hdr] = await Promise.all([hdrPromise, ...texPromises]);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    this.envMap = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose();
    pmrem.dispose();
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.32;
    this.scene.environmentRotation.set(0, 1.1, 0);
    this.scene.background = null;
    this.scene.fog = new THREE.FogExp2(FOG_COLOR.getHex(), 1.0 / Math.max(600, this.quality.drawDistance * 0.62));
    await yieldFrame();

    const tex: TrackTextures = {
      asphalt: { map: texMap.asphalt_color, normal: texMap.asphalt_normal, rough: texMap.asphalt_rough },
      sidewalk: { map: texMap.sidewalk_color, normal: texMap.sidewalk_normal, rough: texMap.sidewalk_rough },
      concrete: { map: texMap.concrete_color, normal: texMap.concrete_normal, rough: texMap.concrete_rough },
    };

    // ---------------------------------------------------------------- analysis
    const t = this.track;
    this.grid = new TrackGrid(t);
    this.terrain = new Terrain(t, this.grid);
    this.city = new City(t, this.grid, this.terrain, this.quality.buildingDensity);
    this.lamps = new LampLighting(t, this.city.yardLamps());
    this.zebras = this.pickZebras();
    progress(0.5);
    await yieldFrame();

    // ---------------------------------------------------------------- track surfaces
    // every chunk is bound to the nearest reflection probe (baked from the finished city below)
    const tm = new TrackMesh(t, { terrainHeight: (x, z) => this.terrain.height(x, z) });
    this.probes = this.probeLayout();
    const probeMats = this.probes.map(() => createTrackMaterials(t, tex, this.lamps, this.zebras));
    for (const pm of probeMats) this.materials.push(...Object.values(pm));
    for (const chunk of tm.chunks) {
      const road = chunk.geometries.road!;
      const c = road.boundingSphere!.center;
      let tunnelCount = 0;
      const a = chunk.index * 100;
      for (let i = a; i < Math.min(t.count, a + 100); i++) tunnelCount += t.tunnel[i];
      let best = 0;
      let bestD = Infinity;
      this.probes.forEach((p, k) => {
        if (p.tunnel !== tunnelCount > 50) return;
        const d = p.pos.distanceToSquared(c);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      for (const k of Object.keys(chunk.geometries) as SurfaceKind[]) {
        const m = new THREE.Mesh(chunk.geometries[k]!, probeMats[best][k]);
        m.name = `track_${k}_${chunk.index}`;
        m.receiveShadow = k === 'road' || k === 'sidewalk';
        this.root.add(m);
      }
    }
    this.probeMats = probeMats;
    progress(0.6);
    await yieldFrame();

    // ---------------------------------------------------------------- ground + water
    for (const m of this.terrain.build(this.lamps, this.quality.buildingDensity < 0.6 ? 12 : 8)) this.root.add(m);
    this.root.add(buildWater(this.terrain, this.grid, this.lamps));
    progress(0.72);
    await yieldFrame();

    // ---------------------------------------------------------------- city
    for (const o of this.city.build(this.lamps)) this.root.add(o);
    progress(0.84);
    await yieldFrame();

    const atlas = new NeonAtlas();
    this.textures.push(atlas.texture);
    const signs = placeSigns(atlas, this.city.facades);
    this.root.add(buildSignMesh(atlas, signs));
    progress(0.9);
    await yieldFrame();

    this.props = new StreetProps(t, tm, this.lamps, this.city, this.terrain, this.grid, this.zebras, this.quality);
    this.root.add(this.props.group);
    this.props.setStartLights(-2);

    // ---------------------------------------------------------------- sky + global lights
    this.sky = new Sky();
    this.root.add(this.sky.mesh);
    this.hemi = new THREE.HemisphereLight(0x2a3560, 0x0c0808, 0.35);
    this.root.add(this.hemi);
    this.moon = new THREE.DirectionalLight(0x8fa4ff, 0.22);
    this.moon.position.set(-450, 420, -780);
    this.moon.target.position.set(0, 0, 0);
    this.root.add(this.moon, this.moon.target);

    // per-material environment strength (scene.environmentIntensity only applies to materials without envMap)
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (!mat || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
      const k = ENV_STRENGTH[mesh.name] ?? ENV_STRENGTH[mesh.name.replace(/_\d+$/, '')];
      if (k === undefined) return;
      mat.envMap = this.envMap;
      mat.envMapIntensity = k;
      mat.envMapRotation.copy(this.scene.environmentRotation);
    });

    this.scene.add(this.root);
    await yieldFrame();
    this.bakeProbes();
    progress(1);
  }

  probes: { name: string; pos: THREE.Vector3; tunnel: boolean; tex: THREE.Texture | null }[] = [];
  private probeMats: Record<SurfaceKind, THREE.MeshStandardMaterial>[] = [];

  private probeLayout() {
    const t = this.track;
    const at = (s: number, up: number, lat = 0) => {
      const f = t.frameAt(s);
      return f.pos.clone().addScaledVector(f.up, up).addScaledVector(f.right, lat);
    };
    return [
      { name: 'downtown', pos: at(START_S + 120, 3), tunnel: false, tex: null },
      { name: 'downtownWest', pos: at(3330, 3), tunnel: false, tex: null },
      { name: 'boulevard', pos: at(860, 3), tunnel: false, tex: null },
      { name: 'harbor', pos: at(1350, 1.2, -26), tunnel: false, tex: null },
      { name: 'docks', pos: at(1760, 3), tunnel: false, tex: null },
      { name: 'tunnel', pos: at(2250, 3), tunnel: true, tex: null },
      { name: 'hills', pos: at(2760, 4), tunnel: false, tex: null },
    ] as { name: string; pos: THREE.Vector3; tunnel: boolean; tex: THREE.Texture | null }[];
  }

  /** Render a cube capture of the finished city at every probe and use it for local reflections. */
  private bakeProbes() {
    const size = this.quality.envCubeSize >= 128 ? 256 : this.quality.envCubeSize > 0 ? 128 : 64;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
    const cam = new THREE.CubeCamera(0.5, 5000, rt);
    const water = this.root.getObjectByName('water');
    const intensity: Partial<Record<SurfaceKind, number>> = { road: 0.85, sidewalk: 0.6, concrete: 0.35, metal: 0.8, tunnelWall: 0.7, tunnelCeil: 0.15, retain: 0.3 };
    this.probes.forEach((p, k) => {
      cam.position.copy(p.pos);
      cam.updateMatrixWorld(true);
      cam.update(this.renderer, this.scene);
      p.tex = pmrem.fromCubemap(rt.texture).texture;
      const mats = this.probeMats[k];
      for (const kind of Object.keys(mats) as SurfaceKind[]) {
        const m = mats[kind];
        m.envMap = p.tex;
        m.envMapIntensity = intensity[kind] ?? 0.4;
      }
      this.textures.push(p.tex);
      if (p.name === 'harbor' && water) {
        const wm = (water as THREE.Mesh).material as THREE.MeshStandardMaterial;
        wm.envMap = p.tex;
        wm.envMapIntensity = 1.0;
        wm.envMapRotation.set(0, 0, 0);
      }
    });
    rt.dispose();
    pmrem.dispose();
  }

  private pickZebras(): number[] {
    const t = this.track;
    const out: number[] = [];
    for (let s = 0; s < t.length; s += 10) {
      const i = t.wrap(Math.round(s / t.step));
      if (t.zoneAt(i) !== 'downtown' || t.tunnel[i]) continue;
      if (Math.abs(t.deltaS(s, START_S)) < 160) continue;
      let straight = true;
      for (let k = -20; k <= 20; k += 4) if (Math.abs(t.curvature[t.wrap(i + k)]) > 0.004) straight = false;
      if (!straight) continue;
      if (out.some((z) => Math.abs(t.deltaS(z, s)) < 300)) continue;
      out.push(s);
      if (out.length >= 6) break;
    }
    return out;
  }

  /** Nearest baked reflection probe (PMREM texture) — a cheap, good-looking envMap for car paint. */
  probeAt(pos: THREE.Vector3): THREE.Texture | null {
    let best: THREE.Texture | null = null;
    let bestD = Infinity;
    for (const p of this.probes) {
      const d = p.pos.distanceToSquared(pos) * (p.tunnel ? 0.25 : 1);
      if (p.tex && d < bestD) {
        bestD = d;
        best = p.tex;
      }
    }
    return best ?? this.envMap;
  }

  /** 0..5 red columns lit, -1 green (GO), -2 all dark. */
  setStartLights(n: number) {
    this.props?.setStartLights(n);
  }

  update(dt: number, camera: THREE.Camera, time: number): void {
    void dt;
    void camera;
    worldUniforms.uTime.value = time;
    this.sky?.update(time);
    this.props?.update(time);
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.envMap?.dispose();
    if (this.scene.environment === this.envMap) this.scene.environment = null;
  }
}
