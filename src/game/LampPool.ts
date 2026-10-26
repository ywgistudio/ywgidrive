import * as THREE from 'three';
import type { Track } from '../track/Track';
import { lampColor } from '../world/LampPalette';

/**
 * A handful of real PointLights that hop to the streetlights nearest the camera so cars (and other
 * standard materials) get lit as they drive under lamps. Road surfaces are lit analytically instead.
 */
export class LampPool {
  readonly lights: THREE.PointLight[] = [];
  private track: Track;
  private order: { i: number; d: number }[] = [];
  /** per-lamp color matching the road's analytic lighting palette */
  private colors: THREE.Color[];

  constructor(scene: THREE.Scene, track: Track, count: number) {
    this.track = track;
    this.colors = track.lamps.map((l) => lampColor(track, l).clone());
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffd0a0, 0, 40, 2);
      l.castShadow = false;
      scene.add(l);
      this.lights.push(l);
    }
  }

  update(focus: THREE.Vector3) {
    const lamps = this.track.lamps;
    const o = this.order;
    o.length = 0;
    for (let i = 0; i < lamps.length; i++) {
      const p = lamps[i].pos;
      const dx = p.x - focus.x, dy = p.y - focus.y, dz = p.z - focus.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < 140 * 140) o.push({ i, d });
    }
    o.sort((a, b) => a.d - b.d);
    for (let k = 0; k < this.lights.length; k++) {
      const l = this.lights[k];
      const e = o[k];
      if (!e) {
        l.intensity = 0;
        l.visible = false;
        continue;
      }
      const lamp = lamps[e.i];
      l.visible = true;
      l.position.copy(lamp.pos);
      l.position.y -= 0.4;
      l.color.copy(this.colors[e.i]);
      l.distance = lamp.range * 1.15;
      // fade the farthest pooled light so lamps don't pop when the set changes
      const fade = k === this.lights.length - 1 ? 0.5 : 1;
      l.intensity = lamp.intensity * 2.2 * fade;
    }
  }
}
