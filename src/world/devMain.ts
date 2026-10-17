// Standalone viewer for the environment (not part of the game build).
// URL params: ?s=186&lat=0&h=1.4&look=40&q=high  or  ?aerial=1&x=..&y=..&z=..&tx=..&tz=..
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect, VignetteEffect } from 'postprocessing';
import { Track } from '../track/Track';
import { QUALITY, type Quality } from '../core/Settings';
import { Environment } from './Environment';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? parseFloat(params.get(k)!) : d);
const q = (params.get('q') ?? 'high') as Quality;
const W = num('w', 1280), H = num('hh', 720);

const renderer = new THREE.WebGLRenderer({ antialias: false, stencil: false, depth: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 62), W / H, 0.1, 6000);
const track = new Track();
const env = new Environment(scene, renderer, track, QUALITY[q]);
const info = document.getElementById('info')!;

// stand-in headlights so the road reads like the game camera would see it
const head = new THREE.SpotLight(0xfff1dd, 900, 120, 0.42, 0.5, 2);
scene.add(head, head.target);

function placeCamera() {
  if (params.get('aerial')) {
    camera.position.set(num('x', 450), num('y', 900), num('z', 340));
    camera.lookAt(num('tx', 450), 0, num('tz', 340));
    return;
  }
  const s = num('s', 186);
  const f = track.frameAt(s);
  const p = f.pos.clone().addScaledVector(f.right, num('lat', 0)).addScaledVector(f.up, num('h', 1.5));
  camera.position.copy(p);
  const look = track.frameAt(s + num('look', 40));
  const tgt = look.pos.clone().addScaledVector(look.right, num('tlat', num('lat', 0))).addScaledVector(look.up, num('th', 1.0));
  camera.lookAt(tgt);
  head.position.copy(p).addScaledVector(f.up, -0.6).addScaledVector(f.tangent, 1.5);
  head.target.position.copy(tgt).addScaledVector(look.up, -1.0);
}

const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(scene, camera));
const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.9, luminanceSmoothing: 0.3, intensity: 1.15, radius: 0.72 });
composer.addPass(new EffectPass(camera, bloom, new VignetteEffect({ darkness: 0.5, offset: 0.3 }), new ToneMappingEffect({ mode: ToneMappingMode.AGX }), new SMAAEffect()));

const t0 = performance.now();
env
  .load((p) => (info.textContent = `loading ${(p * 100).toFixed(0)}%`))
  .then(() => {
    const loadMs = performance.now() - t0;
    placeCamera();
    env.setStartLights(num('lights', -2));
    const controls = new OrbitControls(camera, renderer.domElement);
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    controls.target.copy(camera.position).addScaledVector(fwd, 10);
    controls.update();
    // measure scene-only draw stats
    renderer.info.autoReset = false;
    renderer.info.reset();
    renderer.render(scene, camera);
    const calls = renderer.info.render.calls, tris = renderer.info.render.triangles;
    renderer.info.autoReset = true;
    (window as any).__view = (o: Record<string, number>) => {
      for (const k in o) params.set(k, String(o[k]));
      if (!('aerial' in o)) params.delete('aerial');
      placeCamera();
      controls.target.copy(camera.position).addScaledVector(camera.getWorldDirection(fwd), 10);
      env.setStartLights(num('lights', -2));
      renderer.info.reset();
    };
    let frames = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      const time = num('time', 0) + clock.getElapsedTime();
      env.update(0.016, camera, time);
      composer.render();
      frames++;
      if (frames === 6) {
        (window as any).__ready = true;
        (window as any).__stats = { calls, tris, loadMs };
      }
      info.textContent = params.get('hud') === '0' ? '' : `calls ${calls}  tris ${(tris / 1e6).toFixed(2)}M  load ${loadMs.toFixed(0)}ms  geoms ${renderer.info.memory.geometries}`;
      requestAnimationFrame(tick);
    };
    tick();
  })
  .catch((e) => {
    info.textContent = 'ERROR ' + e?.stack;
    (window as any).__error = String(e?.stack ?? e);
  });
