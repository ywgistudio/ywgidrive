import * as THREE from 'three';
import { QUALITY } from '../core/Settings';
import { createRenderer } from '../render/Renderer';
import { PostFX } from '../render/PostFX';
import { Effects } from './Effects';

// Dev harness for effects: ?mode=drift|nitro|crash&cam=chase|top|side&t=4&q=high&rain=0.6
const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'drift';
const camMode = params.get('cam') ?? 'chase';
const warm = parseFloat(params.get('t') ?? '0');
const qName = (params.get('q') ?? 'high') as keyof typeof QUALITY;
const rainAmt = parseFloat(params.get('rain') ?? '0');
const q = QUALITY[qName];

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = createRenderer(canvas, q);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02030a);
scene.fog = new THREE.FogExp2(0x05060f, 0.012);
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2000);
const post = new PostFX(renderer, scene, camera, q);
const fx = new Effects(scene, q);
fx.setRain(rainAmt);

// --- world
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x2a2a2f, roughness: 0.34, metalness: 0.0 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
scene.add(new THREE.HemisphereLight(0x2a3a66, 0x050505, 0.35));

const neon = [0xff2a8a, 0x22e5ff, 0xffaa22, 0x8a5cff];
for (let i = 0; i < 10; i++) {
  const a = (i / 10) * Math.PI * 2;
  const r = 34 + (i % 3) * 6;
  const col = new THREE.Color(neon[i % neon.length]);
  const box = new THREE.Mesh(new THREE.BoxGeometry(6, 1.2, 0.4), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: col, emissiveIntensity: 5 }));
  box.position.set(Math.cos(a) * r, 6 + (i % 2) * 3, Math.sin(a) * r);
  box.lookAt(0, box.position.y, 0);
  scene.add(box);
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.4, 12, 0.4), new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.6 }));
  pole.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
  pole.position.y = 6;
  scene.add(pole);
  if (i % 3 === 0) {
    const pl = new THREE.PointLight(col, 120, 40, 2);
    pl.position.copy(box.position);
    scene.add(pl);
  }
}
const wall = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.1, 120), new THREE.MeshStandardMaterial({ color: 0x55565c, roughness: 0.8 }));
wall.position.set(9.3, 0.55, 0);
scene.add(wall);

// dummy car
const car = new THREE.Group();
const body = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.62, 4.4), new THREE.MeshStandardMaterial({ color: 0xb01020, metalness: 0.6, roughness: 0.28 }));
body.position.y = 0.55;
const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.45, 2.0), new THREE.MeshStandardMaterial({ color: 0x0a0a10, metalness: 0.2, roughness: 0.1 }));
cabin.position.set(0, 1.08, -0.2);
const tl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.05), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff1010, emissiveIntensity: 6 }));
tl.position.set(0, 0.7, -2.21);
const hl = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.05), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xddeeff, emissiveIntensity: 8 }));
hl.position.set(0, 0.6, 2.21);
car.add(body, cabin, tl, hl);
const head = new THREE.SpotLight(0xdde8ff, 260, 70, 0.5, 0.6, 1.5);
head.position.set(0, 0.7, 2.0);
head.target.position.set(0, 0, 14);
car.add(head, head.target);
scene.add(car);

const exhaustSpec = { localPos: [new THREE.Vector3(0.45, 0.32, -2.28), new THREE.Vector3(-0.45, 0.32, -2.28)] };
const rearWheels = [new THREE.Vector3(0.8, 0.0, -1.3), new THREE.Vector3(-0.8, 0.0, -1.3)];
const frontWheels = [new THREE.Vector3(0.8, 0.0, 1.35), new THREE.Vector3(-0.8, 0.0, 1.35)];

const up = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();
const vel = new THREE.Vector3();
const rightV = new THREE.Vector3();
const prevPos = new THREE.Vector3();
let time = 0;
let speed = 0;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  post.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function step(dt: number) {
  time += dt;
  prevPos.copy(car.position);
  let yaw = 0;
  let boosting = false;
  let backfire = false;
  let throttle = 1;
  if (mode === 'drift') {
    const R = 16;
    const w = 0.9;
    const a = time * w;
    car.position.set(Math.cos(a) * R - 14, 0, Math.sin(a) * R);
    const tangent = Math.atan2(Math.cos(a), -Math.sin(a));
    yaw = tangent + 0.55;
    backfire = Math.sin(time * 1.3) > 0.85;
  } else if (mode === 'nitro' || mode === 'crash') {
    const z = -60 + ((time * 32) % 120);
    car.position.set(mode === 'crash' ? 7.95 : 0, 0, z);
    yaw = 0;
    boosting = mode === 'nitro';
    backfire = mode === 'nitro' && Math.sin(time * 2) > 0.9;
  }
  car.rotation.set(0, yaw, 0);
  car.updateMatrixWorld();
  vel.subVectors(car.position, prevPos).divideScalar(Math.max(dt, 1e-4));
  if (vel.lengthSq() > 120 * 120) vel.set(0, 0, 0);
  speed = vel.length();
  rightV.set(-1, 0, 0).applyQuaternion(car.quaternion);

  // tires
  const slide = mode === 'drift' ? 1 : mode === 'crash' ? 0.25 : 0;
  rearWheels.forEach((w, i) => {
    tmp.copy(w).applyMatrix4(car.matrixWorld);
    fx.skid(i, tmp, up, rightV, 0.27, slide);
    if (slide > 0.5) fx.tireSmoke(tmp, vel, slide);
  });
  frontWheels.forEach((w, i) => {
    tmp.copy(w).applyMatrix4(car.matrixWorld);
    fx.skid(10 + i, tmp, up, rightV, 0.25, mode === 'drift' ? 0.35 : 0);
  });
  if (mode === 'crash') {
    tmp.set(0.95, 0.35, 0.6).applyMatrix4(car.matrixWorld);
    fx.sparks(tmp, new THREE.Vector3(-1, 0.2, 0), vel, 0.6 + 0.4 * Math.random());
    if (Math.floor(time * 2) !== Math.floor((time - dt) * 2)) fx.debris(tmp, vel, 0.8, new THREE.Color(0xb01020));
  }
  fx.exhaust(0, car.matrixWorld, exhaustSpec, boosting, backfire, throttle, vel);

  // camera
  if (camMode === 'chase') {
    const back = new THREE.Vector3(0, 2.3, -6.8).applyQuaternion(car.quaternion).add(car.position);
    if (mode === 'drift') back.set(0, 2.4, -7).applyAxisAngle(up, yaw - 0.45).add(car.position);
    camera.position.copy(back);
    camera.lookAt(tmp.copy(car.position).add(new THREE.Vector3(0, 0.9, 0)));
  } else if (camMode === 'top') {
    camera.position.set(-14, 34, 22);
    camera.lookAt(-14, 0, 0);
  } else {
    camera.position.set(car.position.x - 7, 1.6, car.position.z + 4.5);
    camera.lookAt(car.position.x, 0.8, car.position.z - 1);
  }
  camera.fov = 62 + Math.min(1, speed / 80) * 12 + (boosting ? 6 : 0);
  camera.updateProjectionMatrix();
  post.setSpeed(speed / 80);
  post.setNitro(boosting);
  if (mode === 'crash' && Math.floor(time * 0.7) !== Math.floor((time - dt) * 0.7)) post.impact(0.7);
  fx.update(dt, camera, speed);
}

const info = document.getElementById('info')!;
const dtFix = 1 / 60;
for (let t = 0; t < warm; t += dtFix) step(dtFix);
let last = performance.now();
let frames = 0;
let acc = 0;
(window as unknown as { __frames: number }).__frames = 0;
function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(params.has('t') ? dtFix : dt);
  post.render(dt);
  frames++;
  acc += dt;
  if (acc > 0.5) {
    info.textContent = `${mode} ${qName} ${(frames / acc).toFixed(0)} fps  calls ${renderer.info.render.calls}`;
    frames = 0;
    acc = 0;
  }
  (window as unknown as { __frames: number }).__frames++;
  requestAnimationFrame(loop);
}
loop();
