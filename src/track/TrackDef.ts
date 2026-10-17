// Control points for the single level: "Midnight Circuit".
// Units are meters. x/z are the ground plane, y is elevation, bank is degrees (positive banks toward the inside of a right-hander).
// zone tags drive scenery: downtown neon, harbor, tunnel, hills.

export type Zone = 'downtown' | 'harbor' | 'docks' | 'tunnel' | 'hills' | 'park';

export interface ControlPoint {
  x: number;
  z: number;
  y: number;
  bank?: number;
  zone: Zone;
}

export const TRACK_SCALE = 0.86;

export const CONTROL_POINTS: ControlPoint[] = [
  { x: -200, z: 0, y: 0, zone: 'downtown' },
  { x: 0, z: 0, y: 0, zone: 'downtown' },
  { x: 300, z: 0, y: 0, zone: 'downtown' },
  { x: 500, z: 8, y: 0, zone: 'downtown' },
  { x: 575, z: 55, y: 0, bank: 3, zone: 'downtown' },
  { x: 592, z: 190, y: 1, zone: 'downtown' },
  { x: 565, z: 320, y: 2, zone: 'park' },
  { x: 605, z: 440, y: 1, zone: 'park' },
  { x: 720, z: 515, y: 0, bank: -4, zone: 'harbor' },
  { x: 900, z: 525, y: 0, zone: 'harbor' },
  { x: 1150, z: 485, y: 0, bank: 2, zone: 'harbor' },
  { x: 1290, z: 510, y: 0, zone: 'docks' },
  { x: 1345, z: 585, y: 0, bank: 5, zone: 'docks' },
  { x: 1295, z: 655, y: 0, bank: 5, zone: 'docks' },
  { x: 1160, z: 650, y: -1, zone: 'docks' },
  { x: 1010, z: 720, y: -5, zone: 'tunnel' },
  { x: 820, z: 790, y: -7, zone: 'tunnel' },
  { x: 620, z: 800, y: -6, zone: 'tunnel' },
  { x: 430, z: 765, y: 0, zone: 'hills' },
  { x: 300, z: 715, y: 7, zone: 'hills' },
  { x: 235, z: 690, y: 9.5, zone: 'hills' },
  { x: 160, z: 660, y: 6, zone: 'hills' },
  { x: 0, z: 580, y: 0, zone: 'park' },
  { x: -160, z: 470, y: 0, zone: 'downtown' },
  { x: -170, z: 370, y: 0, bank: -3, zone: 'downtown' },
  { x: -255, z: 270, y: 0, zone: 'downtown' },
  { x: -315, z: 135, y: 0, bank: 3, zone: 'downtown' },
  { x: -295, z: 35, y: 0, zone: 'downtown' },
];

export const ROAD_HALF_WIDTH = 8.2; // 4 lanes of ~3.6m + shoulders
export const LANE_WIDTH = 3.6;
export const SIDEWALK_WIDTH = 4.0;
export const CURB_HEIGHT = 0.16;
export const WALL_HEIGHT = 1.1; // visible barrier height
export const WALL_COLLIDER_HEIGHT = 4.0;
export const LAMP_SPACING = 34; // meters between streetlights (alternating sides)
export const TUNNEL_LAMP_SPACING = 12;
export const LAPS = 3;
export const TUNNEL_SIDEWALK_WIDTH = 1.3;
export const TUNNEL_HEIGHT = 7.0; // ceiling height above road center
export const START_S = 186; // arc length of the start/finish line (on the main avenue straight)
