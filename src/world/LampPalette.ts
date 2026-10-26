import * as THREE from 'three';
import type { Track, Lamp } from '../track/Track';

/**
 * Real-fixture colors for the circuit's streetlights (linear RGB, before intensity):
 *  - downtown: modern ~4000K LED, a few older warmer metal-halide heads mixed in
 *  - harbor, docks, the old boulevard (park), the hills and the tunnel: high-pressure sodium
 * Static world surfaces (analytic road lighting) and the lamp fixtures both use this, so the light
 * on the asphalt always matches the lamp head that emits it.
 */
export const LED = new THREE.Color(1.0, 0.86, 0.72);
export const LED_OLD = new THREE.Color(1.0, 0.74, 0.5);
export const SODIUM = new THREE.Color(1.0, 0.5, 0.17);
export const SODIUM_TUNNEL = new THREE.Color(1.0, 0.54, 0.2);

const cache = new WeakMap<Lamp, THREE.Color>();

export function lampColor(track: Track, lamp: Lamp): THREE.Color {
  const hit = cache.get(lamp);
  if (hit) return hit;
  let c: THREE.Color;
  if (lamp.tunnel) c = SODIUM_TUNNEL;
  else {
    const i = track.wrap(Math.round(lamp.s / track.step));
    const zone = track.zoneAt(i);
    if (zone === 'downtown') {
      // deterministic per lamp: ~1 in 7 heads is an older, warmer fixture
      const h = Math.abs(Math.sin(lamp.s * 12.9898) * 43758.5453) % 1;
      c = h < 0.14 ? LED_OLD : LED;
    } else c = SODIUM;
  }
  cache.set(lamp, c);
  return c;
}
