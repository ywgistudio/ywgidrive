// Dev-only page for the car visuals: lineup / turntable of every model in the manifests.
// Open /src/vehicle/carDev/dev.html?view=lineup|front|rear|side|close&id=<model id>&steer=0.3
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect } from 'postprocessing';
import { CarModels } from '../CarModels';
import { CarVisual, makeTrafficVisual } from '../CarVisual';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'lineup';
const onlyId = params.get('id');
const steerParam = Number(params.get('steer') ?? '0.32');
const info = document.getElementById('info')!;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, depth: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060b);
scene.fog = new THREE.FogExp2(0x070814, 0.012);
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 500);

const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new EffectPass(camera, new SMAAEffect(), new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.0, intensity: 1.2, radius: 0.75 }), new ToneMappingEffect({ mode: ToneMappingMode.AGX })));

// wet asphalt ground with puddle roughness variation
function noiseTex(size: number, seed: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const blobs = Array.from({ length: 40 }, () => [rnd() * size, rnd() * size, 10 + rnd() * 40]);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 0.55 + (rnd() - 0.5) * 0.25;
      for (const [bx, by, br] of blobs) {
        const d = Math.hypot(x - bx, y - by) / br;
        if (d < 1) v = Math.min(v, 0.05 + d * 0.45);
      }
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x15161b, roughness: 1, roughnessMap: noiseTex(256, 7), metalness: 0, envMapIntensity: 0.8 }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// streetlights
const lampPositions = [new THREE.Vector3(-6, 7.5, -3), new THREE.Vector3(7, 7.5, 2), new THREE.Vector3(0, 7.5, 12), new THREE.Vector3(-14, 7.5, 8)];
for (const p of lampPositions) {
  const l = new THREE.PointLight(0xffc98a, 380, 40, 1.8);
  l.position.copy(p);
  scene.add(l);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.2, 0.4), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 6, 3.5) }));
  head.position.copy(p);
  scene.add(head);
}
const neon = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.4, 5) }));
neon.position.set(0, 4, -12);
scene.add(neon);
const neon2 = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 4, 6) }));
neon2.position.set(-9, 3, -8);
neon2.rotation.y = 0.8;
scene.add(neon2);
scene.add(new THREE.HemisphereLight(0x334466, 0x080604, 0.25));

const SPECS = [
  { wheelbase: 2.78, trackFront: 1.6, trackRear: 1.6, wheelRadius: 0.35, cgHeight: 0.5, frontWeight: 0.54 },
  { wheelbase: 2.43, trackFront: 1.48, trackRear: 1.46, wheelRadius: 0.33, cgHeight: 0.45, frontWeight: 0.5 },
  { wheelbase: 2.55, trackFront: 1.52, trackRear: 1.53, wheelRadius: 0.34, cgHeight: 0.48, frontWeight: 0.53 },
];
const PAINTS = [0xd8dde3, 0xe0262b, 0x1d4fd8, 0x111111, 0xff7a00, 0x13a36b];

function physCenters(s: (typeof SPECS)[number]) {
  const a = s.wheelbase * (1 - s.frontWeight);
  const b = s.wheelbase * s.frontWeight;
  const y = s.wheelRadius - s.cgHeight;
  return [
    new THREE.Vector3(s.trackFront / 2, y, a),
    new THREE.Vector3(-s.trackFront / 2, y, a),
    new THREE.Vector3(s.trackRear / 2, y, -b),
    new THREE.Vector3(-s.trackRear / 2, y, -b),
  ];
}

async function main() {
  const hdr = await new HDRLoader().loadAsync('/assets/env/night_1k.hdr').catch(() => null);
  if (hdr) {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromEquirectangular(hdr).texture;
    scene.environmentIntensity = 0.45;
  }
  const models = new CarModels('/assets/cars/');
  await models.load((p) => (info.textContent = `loading ${(p * 100) | 0}%`));
  const sports = models.sports.filter((e) => !onlyId || e.id === onlyId);
  const traffic = models.traffic.filter((e) => !onlyId || e.id === onlyId);
  const lines: string[] = [];
  const cars: { v: CarVisual | null; o: THREE.Object3D }[] = [];

  sports.forEach((e, i) => {
    const spec = SPECS[i % SPECS.length];
    const v = new CarVisual(models, e, { paint: PAINTS[i % PAINTS.length], ...spec, player: i === 0, envMap: null });
    v.updateWheels(physCenters(spec), [steerParam, steerParam * 0.9, 0, 0], [0.3, 0.3, 0.3, 0.3]);
    v.setLights({ brake: i % 2, reverse: false, headlights: true, nitro: false });
    v.object.position.set((i - (sports.length - 1) / 2) * 3.2, spec.cgHeight, 0);
    v.object.rotation.y = view === 'lineup' ? 0.55 : 0;
    scene.add(v.object);
    cars.push({ v, o: v.object });
    const f = v.fit;
    lines.push(
      `${e.id}: tris=${models.get(e.id)!.tris} wb=${f.modelWheelbase.toFixed(3)} (spec ${spec.wheelbase}) trackF=${f.modelTrackFront.toFixed(3)} trackR=${f.modelTrackRear.toFixed(3)} R=${f.modelWheelRadius.toFixed(3)} wheelScale=${f.wheelScale.toFixed(3)} half=${v.halfExtents.toArray().map((x) => x.toFixed(2))}`,
    );
  });
  traffic.forEach((e, i) => {
    const o = makeTrafficVisual(models, e);
    const h = o.userData.halfExtents as THREE.Vector3;
    o.position.set((i - (traffic.length - 1) / 2) * 3.0, h.y, -7);
    o.rotation.y = view === 'lineup' ? 0.55 : 0;
    scene.add(o);
    cars.push({ v: null, o });
    lines.push(`traffic ${e.id}: tris=${models.get(e.id)!.tris} half=${h.toArray().map((x) => x.toFixed(2))}`);
  });

  const focus = cars[0]?.o.position ?? new THREE.Vector3();
  const n = Math.max(1, sports.length);
  switch (view) {
    case 'front':
      camera.position.set(focus.x + 3.6, 1.4, focus.z + 5.2);
      camera.lookAt(focus.x, 0.6, focus.z);
      break;
    case 'rear':
      camera.position.set(focus.x - 3.4, 1.5, focus.z - 5.0);
      camera.lookAt(focus.x, 0.6, focus.z);
      break;
    case 'side':
      camera.position.set(focus.x + 7, 0.9, focus.z);
      camera.lookAt(focus.x, 0.6, focus.z);
      break;
    case 'close':
      camera.position.set(focus.x + 2.2, 0.8, focus.z + 2.6);
      camera.lookAt(focus.x + 0.6, 0.45, focus.z + 1.2);
      break;
    case 'chase':
      camera.position.set(focus.x, 2.0, focus.z - 6.2);
      camera.lookAt(focus.x, 0.9, focus.z + 4.5);
      break;
    default:
      camera.position.set(0, 3.2 + n * 0.3, 7 + n * 1.6);
      camera.lookAt(0, 0.4, -1.5);
  }
  info.textContent = lines.join('\n');
  console.log(lines.join('\n'));

  let frames = 0;
  const loop = () => {
    requestAnimationFrame(loop);
    if (params.get('spin')) for (const c of cars) c.o.rotation.y += 0.01;
    composer.render();
    frames++;
    if (frames === 8) {
      (window as unknown as { __ready: boolean }).__ready = true;
      (window as unknown as { __info: unknown }).__info = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, lines };
    }
  };
  loop();
}
main().catch((e) => {
  info.textContent = String(e?.stack ?? e);
  console.error(e);
});
