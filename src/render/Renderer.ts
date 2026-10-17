import * as THREE from 'three';
import type { QualityProfile } from '../core/Settings';

/**
 * Single place for WebGLRenderer flags. The pmndrs EffectComposer owns its own HDR (half float)
 * render targets with depth, so the default framebuffer needs neither MSAA, depth nor stencil.
 * Tone mapping happens inside PostFX (ToneMappingEffect), so the renderer stays linear.
 */
export function createRenderer(canvas: HTMLCanvasElement, q: QualityProfile): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    stencil: false,
    depth: false,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x000000, 1);
  renderer.shadowMap.enabled = q.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;
  applyPixelRatio(renderer, q);
  return renderer;
}

export function applyPixelRatio(renderer: THREE.WebGLRenderer, q: QualityProfile) {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  renderer.setPixelRatio(Math.min(dpr, q.pixelRatio));
}
