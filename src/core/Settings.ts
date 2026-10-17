export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  quality: Quality;
  masterVolume: number; // 0..1
  musicVolume: number;
  sfxVolume: number;
  transmission: 'auto' | 'manual';
  assists: 'pro' | 'standard' | 'casual';
  cameraShake: boolean;
  units: 'kmh' | 'mph';
  showFps: boolean;
  traffic: 'off' | 'light' | 'heavy';
  laps: number;
  opponents: number; // 0..7
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  transmission: 'auto',
  assists: 'standard',
  cameraShake: true,
  units: 'kmh',
  showFps: false,
  traffic: 'light',
  laps: 3,
  opponents: 5,
};

const KEY = 'ywgidrive.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** Per-quality render knobs shared by renderer, post and world builders. */
export interface QualityProfile {
  pixelRatio: number; // cap
  bloom: boolean;
  smaa: boolean;
  shadows: boolean;
  envCubeSize: number; // 0 = no dynamic reflections
  envCubeEvery: number; // frames between cube updates
  buildingDensity: number; // 0..1
  particles: number; // max particles multiplier
  drawDistance: number;
  dynamicLamps: number; // real point lights following the camera
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { pixelRatio: 0.75, bloom: false, smaa: false, shadows: false, envCubeSize: 0, envCubeEvery: 0, buildingDensity: 0.45, particles: 0.4, drawDistance: 900, dynamicLamps: 2 },
  medium: { pixelRatio: 1, bloom: true, smaa: true, shadows: false, envCubeSize: 64, envCubeEvery: 6, buildingDensity: 0.7, particles: 0.7, drawDistance: 1300, dynamicLamps: 4 },
  high: { pixelRatio: 1.5, bloom: true, smaa: true, shadows: true, envCubeSize: 128, envCubeEvery: 3, buildingDensity: 1, particles: 1, drawDistance: 1800, dynamicLamps: 6 },
  ultra: { pixelRatio: 2, bloom: true, smaa: true, shadows: true, envCubeSize: 256, envCubeEvery: 2, buildingDensity: 1, particles: 1.4, drawDistance: 2400, dynamicLamps: 8 },
};
