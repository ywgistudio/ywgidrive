import * as THREE from 'three';
import {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  EdgeDetectionMode,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  BlendFunction,
} from 'postprocessing';
import type { QualityProfile } from '../core/Settings';
import { GradeEffect, GrainEffect, RadialBlurEffect } from './effects';

const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/**
 * Post chain (HalfFloat HDR buffers):
 *   RenderPass
 *   EffectPass A: RadialBlur [conv] + Bloom + Grade  (all HDR)
 *   EffectPass B: ChromaticAberration [conv] + ToneMapping(AgX) + Vignette
 *   EffectPass C: SMAA [conv] + Grain                 (LDR)
 * Low quality collapses to RenderPass + (Grade, ToneMapping, Vignette).
 */
export class PostFX {
  readonly composer: EffectComposer;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private q: QualityProfile;

  private renderPass: RenderPass;
  private radial!: RadialBlurEffect;
  private grade!: GradeEffect;
  private grain!: GrainEffect;
  private bloom: BloomEffect | null = null;
  private ca!: ChromaticAberrationEffect;
  private tone!: ToneMappingEffect;
  private vignette!: VignetteEffect;
  private smaa: SMAAEffect | null = null;
  private passes: EffectPass[] = [];
  private exposure = 1;

  // targets (set by gameplay)
  private speedTarget = 0;
  private nitroTarget = 0;
  private menuTarget = 0;
  // smoothed state
  private speed = 0;
  private nitro = 0;
  private menu = 0;
  private impactAmt = 0;
  private time = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, q: QualityProfile) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.q = q;
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      multisampling: 0,
    });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.build();
  }

  /** (Re)creates effect instances; pmndrs passes dispose their effects, so nothing is shared across builds. */
  private build() {
    for (const p of this.passes) {
      this.composer.removePass(p);
      p.dispose();
    }
    this.passes = [];
    const q = this.q;
    const cam = this.camera;
    this.radial = new RadialBlurEffect();
    this.grade = new GradeEffect();
    this.grade.u<number>('exposure').value = this.exposure;
    this.grain = new GrainEffect(0.016);
    this.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.3 });
    this.tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0.55 });
    this.bloom = q.bloom
      ? new BloomEffect({
          blendFunction: BlendFunction.ADD,
          mipmapBlur: true,
          luminanceThreshold: 0.85,
          luminanceSmoothing: 0.35,
          intensity: 1.15,
          radius: 0.72,
          levels: 7,
        })
      : null;
    this.smaa = q.smaa ? new SMAAEffect({ preset: SMAAPreset.HIGH, edgeDetectionMode: EdgeDetectionMode.LUMA }) : null;

    if (!q.bloom && !q.smaa) {
      // low: a single pass, radial blur is the only convolution
      this.passes.push(new EffectPass(cam, this.radial, this.grade, this.tone, this.vignette, this.grain));
    } else {
      this.passes.push(this.bloom ? new EffectPass(cam, this.radial, this.bloom, this.grade) : new EffectPass(cam, this.radial, this.grade));
      if (this.smaa) {
        this.passes.push(new EffectPass(cam, this.ca, this.tone, this.vignette));
        this.passes.push(new EffectPass(cam, this.smaa, this.grain));
      } else {
        this.passes.push(new EffectPass(cam, this.ca, this.tone, this.vignette, this.grain));
      }
    }
    for (const p of this.passes) this.composer.addPass(p);
  }

  setQuality(q: QualityProfile) {
    const rebuild = q.bloom !== this.q.bloom || q.smaa !== this.q.smaa;
    this.q = q;
    if (rebuild) this.build();
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
  }

  setSpeed(t: number) {
    this.speedTarget = THREE.MathUtils.clamp(t, 0, 1);
  }

  setNitro(on: boolean) {
    this.nitroTarget = on ? 1 : 0;
  }

  impact(intensity: number) {
    this.impactAmt = Math.min(1.5, Math.max(this.impactAmt, THREE.MathUtils.clamp(intensity, 0, 1)));
  }

  setMenuMode(on: boolean) {
    this.menuTarget = on ? 1 : 0;
  }

  /** Optional: raise/lower overall exposure (e.g. tunnel adaptation). */
  setExposure(e: number) {
    this.exposure = e;
    this.grade.u<number>('exposure').value = e;
  }

  render(dt: number) {
    this.time += dt;
    this.speed = damp(this.speed, this.speedTarget, 3, dt);
    this.nitro = damp(this.nitro, this.nitroTarget, this.nitroTarget > this.nitro ? 8 : 3, dt);
    this.menu = damp(this.menu, this.menuTarget, 5, dt);
    this.impactAmt = Math.max(0, this.impactAmt - dt * 3.2);

    const sp = this.speed;
    const sp2 = Math.max(0, sp - 0.35) / 0.65; // only kicks in at higher speeds
    const imp = this.impactAmt;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 18);

    // radial blur
    this.radial.strength = sp2 * sp2 * 0.045 + this.nitro * (0.06 + 0.012 * pulse) + imp * 0.05 + this.menu * 0.0;
    this.radial.uniforms.get('innerRadius')!.value = THREE.MathUtils.lerp(0.22, 0.12, this.nitro);

    // chromatic aberration (edges only)
    const caAmt = sp2 * 0.0011 + this.nitro * 0.0024 + imp * 0.006;
    this.ca.offset.set(caAmt, caAmt * 0.6);

    // grade: nitro blue push, impact flash, menu dim/desat
    const tint = this.grade.u<THREE.Vector3>('tint').value;
    tint.set(1 - this.nitro * 0.08, 1 - this.nitro * 0.02, 1 + this.nitro * (0.12 + 0.05 * pulse));
    this.grade.u<number>('flash').value = imp * imp * 0.5;
    this.grade.u<number>('dim').value = this.menu * 0.35;
    this.grade.u<number>('saturation').value = 1.08 - this.menu * 0.35 + this.nitro * 0.06;

    // vignette
    this.vignette.darkness = 0.5 + sp2 * 0.15 + this.nitro * 0.12 + this.menu * 0.3 + imp * 0.2;
    this.vignette.offset = 0.32 - this.menu * 0.08;

    if (this.bloom) this.bloom.intensity = 1.15 + this.nitro * 0.25 + imp * 0.4;

    this.composer.render(dt);
  }

  dispose() {
    this.composer.dispose();
  }
}
