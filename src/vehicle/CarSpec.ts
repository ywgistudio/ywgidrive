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
  engineSound: 'v6tt' | 'rotary' | 'i6t' | 'flat6tt' | 'flat6t' | 'i4na';
  /** real car this is based on (for credits / tooltips, not shown as a brand) */
  basedOn?: string;
  /** display horsepower for the UI */
  hp?: number;
}

// Real-car based roster. Display names avoid trademarks; `basedOn` notes the inspiration.
// Geometry (wheelbase/track/wheel radius) follows the measured 3D models so wheels sit in their arches.
// Gear ratios: BMW G82 press kit (5.000/3.200/2.143/1.720/1.313/1.000/0.823/0.640, FD 3.154),
// Porsche 2021 911 Turbo S tech sheet (4.89/3.17/2.15/1.56/1.18/0.94/0.76/0.61, rear axle 3.02),
// Getrag 265 close ratio (3.72/2.40/1.77/1.26/1.00), 930 3.3 four-speed (2.25/1.30/0.89/0.625, FD 4.22).
export const CARS: CarSpec[] = [
  {
    id: 'm4csl',
    name: 'BAVARIA CSL',
    tagline: 'Carbon roof, no back seats, 550 hp straight-six to the rear wheels. The lightweight Ring-record coupe.',
    basedOn: 'BMW M4 CSL (G82)',
    hp: 550,
    model: 'bmw_m4_csl.glb',
    paint: 0x8a9096,
    stats: { power: 0.84, grip: 0.88, weight: 0.78, drift: 0.78 },
    mass: 1625,
    cgHeight: 0.49,
    wheelbase: 2.839,
    frontWeight: 0.51,
    trackFront: 1.612,
    trackRear: 1.612,
    inertia: [2850, 3100, 620],
    bodyHalf: [0.92, 0.32, 2.34],
    bodyOffsetY: 0.12,
    wheelRadius: 0.34,
    wheelWidth: 0.285,
    wheelInertia: 1.3,
    suspLength: 0.23,
    bumpStop: 0.155,
    freqFront: 2.25,
    freqRear: 2.35,
    dampBump: 0.32,
    dampRebound: 0.62,
    arbFront: 32000,
    arbRear: 21000,
    maxSteer: 0.62,
    steerRate: 2.7,
    tireLat: { mu: 1.22, peakSlip: 0.125, C: 1.36, E: -0.22 },
    tireLong: { mu: 1.52, peakSlip: 0.11, C: 1.5, E: 0.0 },
    loadSensitivity: 0.09,
    relaxLength: 0.34,
    rollingResistance: 0.014,
    idleRpm: 900,
    redline: 7100,
    limiter: 7300,
    launchRpm: 4300,
    torqueCurve: [[800, 330], [1500, 470], [2750, 650], [4000, 650], [5950, 650], [6500, 610], [7000, 555], [7400, 480]],
    engineInertia: 0.2,
    engineBrake: 90,
    gears: [5.0, 3.2, 2.143, 1.72, 1.313, 1.0, 0.823, 0.64],
    reverseGear: 3.478,
    finalDrive: 3.154,
    drivetrainEfficiency: 0.86,
    shiftTime: 0.1,
    drive: 'RWD',
    frontSplit: 0,
    lsdLock: 0.5,
    lsdPreload: 110,
    brakeTorque: 2150,
    brakeBias: 0.62,
    handbrakeTorque: 3500,
    cd: 0.345,
    frontalArea: 2.2,
    clFront: 0.16,
    clRear: 0.24,
    nitroTorque: 1.25,
    turbo: true,
    cylinders: 6,
    engineSound: 'i6t',
  },
  {
    id: 'turbos992',
    name: 'STUTTGART TURBO S',
    tagline: '650 hp twin-turbo flat-six hung out back, all-wheel drive, eight-speed twin-clutch. Brutally, effortlessly fast.',
    basedOn: 'Porsche 911 Turbo S (992)',
    hp: 650,
    model: 'porsche_992_turbo_s.glb',
    paint: 0xc9ccd1,
    stats: { power: 1.0, grip: 1.0, weight: 0.8, drift: 0.42 },
    mass: 1640,
    cgHeight: 0.46,
    wheelbase: 2.452,
    frontWeight: 0.39,
    trackFront: 1.557,
    trackRear: 1.57,
    inertia: [2600, 2850, 600],
    bodyHalf: [0.93, 0.3, 2.22],
    bodyOffsetY: 0.11,
    wheelRadius: 0.345,
    wheelWidth: 0.3,
    wheelInertia: 1.35,
    suspLength: 0.22,
    bumpStop: 0.15,
    freqFront: 2.25,
    freqRear: 2.45,
    dampBump: 0.33,
    dampRebound: 0.64,
    arbFront: 36000,
    arbRear: 20000,
    maxSteer: 0.6,
    steerRate: 2.7,
    tireLat: { mu: 1.24, peakSlip: 0.125, C: 1.36, E: -0.2 },
    tireLong: { mu: 1.44, peakSlip: 0.11, C: 1.5, E: 0.0 },
    loadSensitivity: 0.075,
    relaxLength: 0.34,
    rollingResistance: 0.014,
    idleRpm: 900,
    redline: 7200,
    limiter: 7400,
    launchRpm: 5000,
    torqueCurve: [[800, 350], [1800, 600], [2500, 800], [4000, 800], [5000, 765], [6000, 725], [6750, 690], [7300, 610]],
    engineInertia: 0.21,
    engineBrake: 95,
    gears: [4.89, 3.17, 2.15, 1.56, 1.18, 0.94, 0.76, 0.61],
    reverseGear: 3.99,
    finalDrive: 3.02,
    drivetrainEfficiency: 0.85,
    shiftTime: 0.08,
    drive: 'AWD',
    frontSplit: 0.22,
    lsdLock: 0.4,
    lsdPreload: 90,
    brakeTorque: 2100,
    brakeBias: 0.58,
    handbrakeTorque: 3600,
    cd: 0.32,
    frontalArea: 2.1,
    clFront: 0.15,
    clRear: 0.3,
    nitroTorque: 1.2,
    turbo: true,
    cylinders: 6,
    engineSound: 'flat6tt',
  },
  {
    id: 'e30m3',
    name: 'BAVARIA E30 EVO',
    tagline: 'Box flares, dogleg five-speed, individual throttle bodies screaming to 8,400. The touring-car legend, built to go sideways.',
    basedOn: 'BMW M3 Sport Evolution (E30)',
    hp: 295,
    model: 'bmw_e30_m3.glb',
    paint: 0xf2f2ee,
    stats: { power: 0.42, grip: 0.72, weight: 0.32, drift: 1.0 },
    mass: 1200,
    cgHeight: 0.48,
    wheelbase: 2.581,
    frontWeight: 0.52,
    trackFront: 1.389,
    trackRear: 1.413,
    inertia: [1750, 1900, 420],
    bodyHalf: [0.82, 0.3, 2.12],
    bodyOffsetY: 0.1,
    wheelRadius: 0.31,
    wheelWidth: 0.235,
    wheelInertia: 1.0,
    suspLength: 0.22,
    bumpStop: 0.15,
    freqFront: 2.15,
    freqRear: 2.05,
    dampBump: 0.3,
    dampRebound: 0.6,
    arbFront: 21000,
    arbRear: 19000,
    maxSteer: 0.68,
    steerRate: 3.0,
    tireLat: { mu: 1.12, peakSlip: 0.12, C: 1.3, E: -0.32 },
    tireLong: { mu: 1.2, peakSlip: 0.1, C: 1.48, E: 0.0 },
    loadSensitivity: 0.1,
    relaxLength: 0.31,
    rollingResistance: 0.013,
    idleRpm: 1000,
    redline: 8400,
    limiter: 8600,
    launchRpm: 5300,
    torqueCurve: [[800, 120], [2500, 195], [4000, 240], [5000, 262], [6000, 285], [7000, 282], [8000, 262], [8700, 228]],
    engineInertia: 0.13,
    engineBrake: 50,
    gears: [3.72, 2.4, 1.77, 1.26, 1.0],
    reverseGear: 4.23,
    finalDrive: 3.91,
    drivetrainEfficiency: 0.88,
    shiftTime: 0.17,
    drive: 'RWD',
    frontSplit: 0,
    lsdLock: 0.6,
    lsdPreload: 120,
    brakeTorque: 2400,
    brakeBias: 0.63,
    handbrakeTorque: 3100,
    cd: 0.33,
    frontalArea: 1.9,
    clFront: 0.06,
    clRear: 0.1,
    nitroTorque: 1.18,
    turbo: false,
    cylinders: 4,
    engineSound: 'i4na',
  },
  {
    id: 'turbo930',
    name: 'STUTTGART 930 WIDOWMAKER',
    tagline: 'Whale tail, four gears, one enormous turbo. Nothing... nothing... EVERYTHING. Respect the lift-off.',
    basedOn: 'Porsche 911 Turbo 3.3 (930)',
    hp: 480,
    model: 'porsche_930_turbo.glb',
    paint: 0x111114,
    stats: { power: 0.74, grip: 0.68, weight: 0.5, drift: 0.88 },
    mass: 1335,
    cgHeight: 0.49,
    wheelbase: 2.272,
    frontWeight: 0.4,
    trackFront: 1.517,
    trackRear: 1.552,
    inertia: [1900, 2050, 460],
    bodyHalf: [0.86, 0.3, 2.1],
    bodyOffsetY: 0.1,
    wheelRadius: 0.314,
    wheelWidth: 0.255,
    wheelInertia: 1.1,
    suspLength: 0.22,
    bumpStop: 0.15,
    freqFront: 1.95,
    freqRear: 2.15,
    dampBump: 0.3,
    dampRebound: 0.6,
    arbFront: 26500,
    arbRear: 17000,
    maxSteer: 0.62,
    steerRate: 2.8,
    tireLat: { mu: 1.12, peakSlip: 0.12, C: 1.32, E: -0.3 },
    tireLong: { mu: 1.22, peakSlip: 0.1, C: 1.48, E: 0.0 },
    loadSensitivity: 0.085,
    relaxLength: 0.32,
    rollingResistance: 0.014,
    idleRpm: 950,
    redline: 6800,
    limiter: 7000,
    launchRpm: 4500,
    torqueCurve: [[800, 160], [2000, 205], [3000, 255], [3600, 320], [4000, 520], [4500, 600], [5500, 590], [6500, 520], [7100, 440]],
    engineInertia: 0.22,
    engineBrake: 70,
    gears: [2.25, 1.3, 0.89, 0.625],
    reverseGear: 2.43,
    finalDrive: 4.22,
    drivetrainEfficiency: 0.87,
    shiftTime: 0.22,
    drive: 'RWD',
    frontSplit: 0,
    lsdLock: 0.45,
    lsdPreload: 100,
    brakeTorque: 2800,
    brakeBias: 0.56,
    handbrakeTorque: 3300,
    cd: 0.42,
    frontalArea: 2.0,
    clFront: 0.04,
    clRear: 0.16,
    nitroTorque: 1.25,
    turbo: true,
    cylinders: 6,
    engineSound: 'flat6t',
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
