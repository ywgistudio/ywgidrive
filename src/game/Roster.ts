import type { CarSpec } from '../vehicle/CarSpec';
import type { CarModelEntry } from '../vehicle/CarVisual';

export interface RivalDef {
  name: string;
  car: number; // index into CARS
  color: string; // minimap / UI color
  paint: number;
  skill: number;
  aggression: number;
  variant: number; // which model variant to prefer
}

export const RIVALS: RivalDef[] = [
  { name: 'NOX', car: 1, color: '#7cf8ff', paint: 0x0e0f12, skill: 1.0, aggression: 0.7, variant: 0 },
  { name: 'VIPER', car: 0, color: '#9dff6a', paint: 0x2f8f3a, skill: 0.98, aggression: 0.9, variant: 0 },
  { name: 'KAITO', car: 2, color: '#ff8a1f', paint: 0xff6a00, skill: 0.97, aggression: 0.5, variant: 0 },
  { name: 'JUNO', car: 3, color: '#ff4fd8', paint: 0xb3126f, skill: 0.95, aggression: 0.4, variant: 0 },
  { name: 'RAZE', car: 0, color: '#ffe14d', paint: 0xf2c400, skill: 0.94, aggression: 0.8, variant: 0 },
  { name: 'SABLE', car: 1, color: '#b18cff', paint: 0x4a2bb0, skill: 0.92, aggression: 0.3, variant: 0 },
  { name: 'GHOST', car: 3, color: '#e8e8e8', paint: 0xf4f4f4, skill: 0.9, aggression: 0.6, variant: 0 },
];

/**
 * Pick a visual model for a car spec. Specs may name a model id (spec.model without .glb);
 * otherwise fall back to role order so every spec still gets a real model.
 */
export function carModelFor(spec: CarSpec, sports: CarModelEntry[], variant: number): CarModelEntry | null {
  if (!sports.length) return null;
  const want = spec.model.replace(/\.glb$/, '');
  const byId = sports.find((e) => e.id === want || e.file === spec.model);
  if (byId && variant === 0) return byId;
  if (byId) {
    // rivals: same spec but allow a different body for visual variety
    const others = sports.filter((e) => e !== byId);
    return variant % 2 === 0 || !others.length ? byId : others[variant % others.length];
  }
  return sports[variant % sports.length];
}
