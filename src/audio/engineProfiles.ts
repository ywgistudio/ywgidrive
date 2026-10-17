// Engine voice characters. Pure data + math (no Web Audio) so it can be rendered offline for tuning.

export type EngineKind = 'v6tt' | 'rotary' | 'i6t';

export interface PeakFilter {
  freq: number;
  gain: number; // dB
  q: number;
}

export interface EngineProfile {
  kind: EngineKind;
  /** combustion pulses per 720 degree cycle (4-stroke cylinders; 2 x rotors for a Wankel) */
  pulses: number;
  /** pulse width as a fraction of the spacing between pulses */
  pulseWidth: number;
  /** decay of each pulse as a fraction of its width */
  pulseDecay: number;
  /** per-pulse amplitude multipliers (cycled) */
  amps: number[];
  /** per-pulse phase offsets in fractions of the cycle (cycled) */
  jitter: number[];
  /** fixed exhaust / intake resonances */
  peaks: PeakFilter[];
  /** wave-shaper drive range [closed throttle, full load] */
  drive: [number, number];
  /** lowpass cutoff = lpBase + lpLoad * L^1.5 + lpRpm * rpm */
  lpBase: number;
  lpLoad: number;
  lpRpm: number;
  /** combustion noise (bandpassed, amplitude-modulated by the firing rate) */
  noiseFreq: number;
  noiseGain: number;
  intakeGain: number;
  /** turbo whistle base/span (Hz) and level */
  turboBase: number;
  turboSpan: number;
  turboGain: number;
  /** blow-off flutter: 0 = clean psssh, 1 = heavy compressor surge flutter */
  flutter: number;
  /** lift-off pop tendency 0..1 */
  pops: number;
  /** idle irregularity (rotary brap) 0..1 */
  lope: number;
  /** sub-octave rumble level */
  sub: number;
  /** overall gain trim */
  trim: number;
}

export const ENGINE_PROFILES: Record<EngineKind, EngineProfile> = {
  // Twin-turbo V6 (VR38-ish): dense, smooth-but-angry, banks slightly unequal, lots of turbo hiss.
  v6tt: {
    kind: 'v6tt',
    pulses: 6,
    pulseWidth: 0.55,
    pulseDecay: 0.28,
    amps: [1.0, 0.86, 0.97, 0.84, 1.0, 0.88],
    jitter: [0, 0.006, -0.004, 0.007, 0.002, -0.006],
    peaks: [
      { freq: 115, gain: 6, q: 1.1 },
      { freq: 470, gain: 4.5, q: 1.8 },
      { freq: 1500, gain: 3.5, q: 2.4 },
      { freq: 3300, gain: -4, q: 1.0 },
    ],
    drive: [1.6, 6.5],
    lpBase: 650,
    lpLoad: 6200,
    lpRpm: 0.45,
    noiseFreq: 2400,
    noiseGain: 0.22,
    intakeGain: 0.16,
    turboBase: 2600,
    turboSpan: 6500,
    turboGain: 0.04,
    flutter: 0.25,
    pops: 0.55,
    lope: 0.05,
    sub: 0.22,
    trim: 1.0,
  },
  // Two-rotor Wankel (13B-ish): firing = rpm * rotors / 60. Long overlapping exhaust pulses -> buzzy,
  // brap-brap idle, screaming top end.
  rotary: {
    kind: 'rotary',
    pulses: 4,
    pulseWidth: 0.85,
    pulseDecay: 0.45,
    amps: [1.0, 0.8, 0.95, 0.78],
    jitter: [0, 0.018, -0.006, 0.022],
    peaks: [
      { freq: 190, gain: 6, q: 0.9 },
      { freq: 880, gain: 6, q: 1.4 },
      { freq: 2500, gain: 5, q: 2.0 },
      { freq: 5200, gain: -3, q: 1.0 },
    ],
    drive: [2.2, 9.0],
    lpBase: 900,
    lpLoad: 7600,
    lpRpm: 0.55,
    noiseFreq: 3000,
    noiseGain: 0.3,
    intakeGain: 0.12,
    turboBase: 3000,
    turboSpan: 6000,
    turboGain: 0.03,
    flutter: 0.4,
    pops: 0.9,
    lope: 0.85,
    sub: 0.12,
    trim: 0.85,
  },
  // Straight six with a big single turbo (2JZ-ish): perfectly even, silky high harmonics, big flutter.
  i6t: {
    kind: 'i6t',
    pulses: 6,
    pulseWidth: 0.42,
    pulseDecay: 0.22,
    amps: [1.0, 0.97, 1.0, 0.98, 1.0, 0.97],
    jitter: [0, 0.002, -0.002, 0.001, 0.002, -0.001],
    peaks: [
      { freq: 140, gain: 4.5, q: 1.0 },
      { freq: 720, gain: 5, q: 2.2 },
      { freq: 2100, gain: 4.5, q: 2.8 },
      { freq: 4200, gain: -3, q: 1.0 },
    ],
    drive: [1.5, 6.0],
    lpBase: 700,
    lpLoad: 7800,
    lpRpm: 0.6,
    noiseFreq: 2800,
    noiseGain: 0.18,
    intakeGain: 0.2,
    turboBase: 1900,
    turboSpan: 5200,
    turboGain: 0.05,
    flutter: 1.0,
    pops: 0.6,
    lope: 0.03,
    sub: 0.16,
    trim: 0.95,
  },
};

/** Fundamental of the full 720-degree engine cycle. Firing frequency is this times `pulses`. */
export function cycleFreq(rpm: number): number {
  return rpm / 120;
}

/** Render one engine cycle into `size` samples (range roughly -1..1). */
export function renderCycle(p: EngineProfile, size = 2048): Float32Array {
  const w = new Float32Array(size);
  const spacing = 1 / p.pulses;
  const width = spacing * p.pulseWidth;
  for (let i = 0; i < p.pulses; i++) {
    const a = p.amps[i % p.amps.length];
    const start = i * spacing + p.jitter[i % p.jitter.length];
    for (let n = 0; n < size; n++) {
      let t = n / size - start;
      t -= Math.floor(t);
      if (t >= width * 1.6) continue;
      // pressure pulse: fast rise, exponential decay, with a negative rarefaction tail
      const x = t / width;
      const env = Math.exp(-x / p.pulseDecay);
      const v = Math.sin(Math.PI * 2 * x) * env + 0.6 * Math.sin(Math.PI * x) * Math.exp(-x * 3);
      w[n] += a * v;
    }
  }
  // remove DC and normalise
  let mean = 0;
  for (let n = 0; n < size; n++) mean += w[n];
  mean /= size;
  let peak = 1e-6;
  for (let n = 0; n < size; n++) {
    w[n] -= mean;
    peak = Math.max(peak, Math.abs(w[n]));
  }
  for (let n = 0; n < size; n++) w[n] /= peak;
  return w;
}

/** DFT of the cycle into PeriodicWave coefficient arrays (index 0 = DC, ignored). */
export function cycleCoefficients(p: EngineProfile, harmonics = 160): { real: Float32Array; imag: Float32Array } {
  const size = 2048;
  const w = renderCycle(p, size);
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    let re = 0;
    let im = 0;
    const f = (2 * Math.PI * k) / size;
    for (let n = 0; n < size; n++) {
      re += w[n] * Math.cos(f * n);
      im += w[n] * Math.sin(f * n);
    }
    real[k] = (2 * re) / size;
    imag[k] = (2 * im) / size;
  }
  return { real, imag };
}

/** tanh soft-clip transfer curve for WaveShaperNode. */
export function tanhCurve(samples = 2048, k = 1): Float32Array {
  const c = new Float32Array(samples);
  const norm = Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}
