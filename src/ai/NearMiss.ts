import * as THREE from 'three';
import type { TrafficCar } from './Traffic';

export interface NearMissEvent {
  kind: 'near' | 'oncoming';
  /** closest body-to-body clearance during the pass (m) */
  distance: number;
  /** index into traffic.cars */
  car: number;
  relativeSpeed: number;
}

interface PassState {
  alongside: boolean;
  minClear: number;
  maxRel: number;
  contact: boolean;
  cooldown: number;
}

const _d = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _cf = new THREE.Vector3();
const _rv = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Detects close, contact-free passes of the player past traffic. Fires once per pass, when the pass
 * completes, if the minimum body-to-body clearance was under `clearance` at relative speed > `minRelSpeed`.
 */
export class NearMissDetector {
  private states = new Map<number, PassState>();

  constructor(
    public playerHalfWidth = 0.95,
    public playerHalfLength = 2.25,
    public clearance = 1.4,
    public minRelSpeed = 15,
  ) {}

  /** Call when a physics contact between the player and traffic car `index` happened (cancels the pass). */
  notifyContact(index: number) {
    const st = this.states.get(index);
    if (st) st.contact = true;
    else this.states.set(index, { alongside: true, minClear: 0, maxRel: 0, contact: true, cooldown: 0 });
  }

  reset() {
    this.states.clear();
  }

  update(
    player: { position: THREE.Vector3; velocity: THREE.Vector3; forward: THREE.Vector3 },
    traffic: TrafficCar[],
    dt: number,
  ): NearMissEvent | null {
    _fwd.copy(player.forward);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) return null;
    _fwd.normalize();
    _left.crossVectors(UP, _fwd);
    let best: NearMissEvent | null = null;
    for (let i = 0; i < traffic.length; i++) {
      const c = traffic[i];
      let st = this.states.get(i);
      if (c.crashed) {
        if (st) this.states.delete(i);
        continue;
      }
      _d.subVectors(c.position, player.position);
      const distSq = _d.lengthSq();
      if (distSq > 60 * 60) {
        if (st) this.states.delete(i);
        continue;
      }
      if (!st) {
        st = { alongside: false, minClear: Infinity, maxRel: 0, contact: false, cooldown: 0 };
        this.states.set(i, st);
      }
      if (st.cooldown > 0) {
        st.cooldown -= dt;
        continue;
      }
      const dz = _d.dot(_fwd);
      const dx = _d.dot(_left);
      _cf.set(0, 0, 1).applyQuaternion(c.quaternion);
      _cf.y = 0;
      _cf.normalize();
      const cosA = Math.abs(_cf.dot(_fwd));
      const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
      const extLong = c.halfLength * cosA + c.halfWidth * sinA;
      const extLat = c.halfLength * sinA + c.halfWidth * cosA;
      const overlapLong = Math.abs(dz) < this.playerHalfLength + extLong;
      const clear = Math.abs(dx) - this.playerHalfWidth - extLat;
      if (overlapLong && Math.abs(dx) < 7) {
        st.alongside = true;
        if (clear < st.minClear) st.minClear = clear;
        if (clear <= 0.03) st.contact = true;
        _rv.subVectors(player.velocity, c.velocity);
        const rel = _rv.length();
        if (rel > st.maxRel) st.maxRel = rel;
      } else if (st.alongside) {
        if (!st.contact && st.minClear < this.clearance && st.maxRel > this.minRelSpeed) {
          const ev: NearMissEvent = { kind: c.oncoming ? 'oncoming' : 'near', distance: Math.max(0, st.minClear), car: i, relativeSpeed: st.maxRel };
          if (!best || ev.distance < best.distance) best = ev;
        }
        st.alongside = false;
        st.minClear = Infinity;
        st.maxRel = 0;
        st.contact = false;
        st.cooldown = 1.0;
      }
    }
    return best;
  }
}
