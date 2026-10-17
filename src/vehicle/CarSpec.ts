export type DriveType = 'RWD' | 'AWD' | 'FWD';

export interface TireCurve {
  /** peak friction coefficient (D / Fz) */
  mu: number;
  /** slip (ratio or radians) at which the force peaks */
  peakSlip: number;
  /** Pacejka shape factor C */
  C: number;
  /** Pacejka curvature factor E */
  E: number;
}

export interface CarSpec {
  id: string;
  name: string;
  tagline: string;
  /** model file in /assets/cars and how to fit it */
  model: string;
  modelScale?: number;
  modelYaw?: number;
  modelOffsetY?: number;
  paint: number;
  stats: { power: number; grip: number; weight: number; drift: number }; // 0..1 for UI bars

  mass: number;
  cgHeight: number;
  wheelbase: number;
  frontWeight: number; // fraction of static load on front axle
  trackFront: number;
  trackRear: number;
  inertia: [number, number, number]; // pitch(x), yaw(y), roll(z) kg m^2
  bodyHalf: [number, number, number]; // collider half extents
  bodyOffsetY: number; // collider center above COM

  wheelRadius: number;
  wheelWidth: number;
  wheelInertia: number;

  suspLength: number; // droop length from hardpoint to wheel center
  bumpStop: number; // compression where bump stop starts
  freqFront: number; // suspension natural frequency Hz
  freqRear: number;
  dampBump: number; // damping ratio
  dampRebound: number;
  arbFront: number; // N/m of compression difference
  arbRear: number;

  maxSteer: number; // radians at standstill
  steerRate: number; // rad/s for keyboard

  tireLat: TireCurve;
  tireLong: TireCurve;
  loadSensitivity: number;
  relaxLength: number;
  rollingResistance: number;

  idleRpm: number;
  redline: number;
  limiter: number;
  /** engine speed the launch clutch holds while pulling away at full throttle */
  launchRpm: number;
  torqueCurve: [number, number][]; // rpm, Nm
  engineInertia: number;
  engineBrake: number; // Nm of drag at redline with closed throttle
  gears: number[];
  reverseGear: number;
  finalDrive: number;
  drivetrainEfficiency: number;
  shiftTime: number;
  drive: DriveType;
  frontSplit: number; // AWD torque to front
  lsdLock: number; // 0 open .. 1 locked (torque bias)
  lsdPreload: number; // Nm

  brakeTorque: number; // max per front wheel Nm
  brakeBias: number; // front fraction
  handbrakeTorque: number;

  cd: number;
  frontalArea: number;
  clFront: number; // downforce coefficient * area (front)
  clRear: number;

  nitroTorque: number; // multiplier on engine torque while boosting
  turbo: boolean;
  cylinders: number;
  engineSound: 'v6tt' | 'rotary' | 'i6t';
}

export const CARS: CarSpec[] = [
  {
    id: 'kaze',
    name: 'KAZE GT-R',
    tagline: 'Twin-turbo AWD missile. Grips like a lizard, launches like a jet.',
    model: 'hero.glb',
    paint: 0xd8dde3,
    stats: { power: 0.92, grip: 0.95, weight: 0.85, drift: 0.45 },
    mass: 1720,
    cgHeight: 0.5,
    wheelbase: 2.78,
    frontWeight: 0.54,
    trackFront: 1.6,
    trackRear: 1.6,
    inertia: [2900, 3200, 650],
    bodyHalf: [0.93, 0.33, 2.3],
    bodyOffsetY: 0.12,
    wheelRadius: 0.35,
    wheelWidth: 0.28,
    wheelInertia: 1.4,
    suspLength: 0.24,
    bumpStop: 0.16,
    freqFront: 2.0,
    freqRear: 2.15,
    dampBump: 0.32,
    dampRebound: 0.62,
    arbFront: 34000,
    arbRear: 26000,
    maxSteer: 0.62,
    steerRate: 2.6,
    tireLat: { mu: 1.22, peakSlip: 0.13, C: 1.38, E: -0.2 },
    tireLong: { mu: 1.28, peakSlip: 0.11, C: 1.5, E: 0.0 },
    loadSensitivity: 0.09,
    relaxLength: 0.35,
    rollingResistance: 0.014,
    idleRpm: 950,
    redline: 7100,
    limiter: 7300,
    launchRpm: 4800,
    torqueCurve: [[800, 320], [2000, 490], [3000, 680], [4000, 745], [5000, 745], [6000, 710], [6800, 640], [7400, 550]],
    engineInertia: 0.22,
    engineBrake: 95,
    gears: [3.9, 2.38, 1.65, 1.27, 1.02, 0.82],
    reverseGear: 3.4,
    finalDrive: 3.7,
    drivetrainEfficiency: 0.85,
    shiftTime: 0.13,
    drive: 'AWD',
    frontSplit: 0.38,
    lsdLock: 0.35,
    lsdPreload: 80,
    brakeTorque: 3600,
    brakeBias: 0.64,
    handbrakeTorque: 3800,
    cd: 0.28,
    frontalArea: 2.1,
    clFront: 0.18,
    clRear: 0.26,
    nitroTorque: 1.22,
    turbo: true,
    cylinders: 6,
    engineSound: 'v6tt',
  },
  {
    id: 'raiden',
    name: 'RAIDEN RX',
    tagline: 'Featherweight rotary RWD. Screams to 9k and loves to slide.',
    model: 'rival1.glb',
    paint: 0xe0262b,
    stats: { power: 0.7, grip: 0.78, weight: 0.45, drift: 0.95 },
    mass: 1290,
    cgHeight: 0.45,
    wheelbase: 2.43,
    frontWeight: 0.5,
    trackFront: 1.48,
    trackRear: 1.46,
    inertia: [1900, 2050, 430],
    bodyHalf: [0.88, 0.3, 2.15],
    bodyOffsetY: 0.1,
    wheelRadius: 0.33,
    wheelWidth: 0.25,
    wheelInertia: 1.1,
    suspLength: 0.22,
    bumpStop: 0.15,
    freqFront: 2.2,
    freqRear: 2.1,
    dampBump: 0.3,
    dampRebound: 0.6,
    arbFront: 20000,
    arbRear: 22000,
    maxSteer: 0.66,
    steerRate: 2.9,
    tireLat: { mu: 1.14, peakSlip: 0.12, C: 1.32, E: -0.3 },
    tireLong: { mu: 1.2, peakSlip: 0.1, C: 1.48, E: 0.0 },
    loadSensitivity: 0.1,
    relaxLength: 0.32,
    rollingResistance: 0.013,
    idleRpm: 1000,
    redline: 8800,
    limiter: 9000,
    launchRpm: 5600,
    torqueCurve: [[800, 150], [2500, 245], [4000, 310], [5500, 345], [6500, 350], [7500, 335], [8500, 300], [9200, 260]],
    engineInertia: 0.15,
    engineBrake: 60,
    gears: [3.48, 2.02, 1.39, 1.0, 0.79],
    reverseGear: 3.3,
    finalDrive: 4.3,
    drivetrainEfficiency: 0.88,
    shiftTime: 0.11,
    drive: 'RWD',
    frontSplit: 0,
    lsdLock: 0.55,
    lsdPreload: 120,
    brakeTorque: 2700,
    brakeBias: 0.62,
    handbrakeTorque: 3200,
    cd: 0.33,
    frontalArea: 1.95,
    clFront: 0.1,
    clRear: 0.14,
    nitroTorque: 1.15,
    turbo: true,
    cylinders: 2,
    engineSound: 'rotary',
  },
  {
    id: 'akuma',
    name: 'AKUMA JZ',
    tagline: 'Big-single-turbo straight six. 700 horsepower of bad decisions.',
    model: 'rival2.glb',
    paint: 0x1d4fd8,
    stats: { power: 1.0, grip: 0.8, weight: 0.7, drift: 0.8 },
    mass: 1510,
    cgHeight: 0.48,
    wheelbase: 2.55,
    frontWeight: 0.5,
    trackFront: 1.52,
    trackRear: 1.53,
    inertia: [2400, 2600, 520],
    bodyHalf: [0.9, 0.32, 2.25],
    bodyOffsetY: 0.11,
    wheelRadius: 0.34,
    wheelWidth: 0.28,
    wheelInertia: 1.3,
    suspLength: 0.23,
    bumpStop: 0.16,
    freqFront: 2.0,
    freqRear: 1.95,
    dampBump: 0.3,
    dampRebound: 0.6,
    arbFront: 30000,
    arbRear: 18000,
    maxSteer: 0.63,
    steerRate: 2.7,
    tireLat: { mu: 1.17, peakSlip: 0.125, C: 1.34, E: -0.25 },
    tireLong: { mu: 1.34, peakSlip: 0.105, C: 1.5, E: 0.0 },
    loadSensitivity: 0.1,
    relaxLength: 0.34,
    rollingResistance: 0.014,
    idleRpm: 900,
    redline: 7400,
    limiter: 7600,
    launchRpm: 4500,
    torqueCurve: [[800, 260], [2500, 380], [3500, 620], [4500, 790], [5500, 800], [6500, 740], [7200, 650], [7800, 540]],
    engineInertia: 0.24,
    engineBrake: 90,
    gears: [3.83, 2.36, 1.69, 1.31, 1.0, 0.79],
    reverseGear: 3.28,
    finalDrive: 3.27,
    drivetrainEfficiency: 0.86,
    shiftTime: 0.14,
    drive: 'RWD',
    frontSplit: 0,
    lsdLock: 0.5,
    lsdPreload: 110,
    brakeTorque: 3300,
    brakeBias: 0.63,
    handbrakeTorque: 3500,
    cd: 0.35,
    frontalArea: 2.0,
    clFront: 0.12,
    clRear: 0.18,
    nitroTorque: 1.3,
    turbo: true,
    cylinders: 6,
    engineSound: 'i6t',
  },
];

export function torqueAt(spec: CarSpec, rpm: number): number {
  const c = spec.torqueCurve;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) {
      const f = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
      return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f;
    }
  }
  return c[c.length - 1][1];
}
