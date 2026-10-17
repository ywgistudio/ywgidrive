import { START_S } from '../track/TrackDef';

/**
 * Starting grid slots painted on the road behind the start/finish line.
 * `s` is the arc length of the slot's car center, `lateral` its offset (+ = right of center).
 * Slot 0 is pole position. Cars should face +tangent.
 */
export const GRID_SLOTS: { s: number; lateral: number }[] = Array.from({ length: 10 }, (_, i) => ({
  s: START_S - 7 - i * 7.5,
  lateral: (i % 2 === 0 ? -1 : 1) * 2.7,
}));
