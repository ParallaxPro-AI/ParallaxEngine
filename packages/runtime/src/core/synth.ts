/**
 * A sound described as data: a `SynthSpec` is an additive stack of oscillator and noise
 * layers with pitch sweeps, envelopes and filters, and `renderSynth` turns it into mono PCM.
 * A game names one where it would name a file — a built-in preset (`synth/hit_metal`) or its
 * own `assets/sfx/<name>.synth.json` — and needs no recording, no fetch and no decoder.
 *
 * Pure on purpose: no Web Audio, no `Math.random`. The same spec and sample rate give the
 * same samples on every machine, so the engine can check a spec, headless tests can measure
 * what it would sound like (`synthStats`: peak, RMS, how much is not silence), and the
 * browser output renders exactly that buffer.
 *
 * Filters are the RBJ cookbook biquads — the formulas Web Audio's BiquadFilterNode uses — so
 * a synthesized sweep sounds as the same numbers would through a live filter.
 */

export type SynthWave = 'sine' | 'square' | 'saw' | 'triangle' | 'noise';
export type SynthSweep = 'linear' | 'exponential';
export type SynthFilterType = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'lowshelf' | 'highshelf';

export const SYNTH_WAVES: readonly SynthWave[] = ['sine', 'square', 'saw', 'triangle', 'noise'];
export const SYNTH_FILTERS: readonly SynthFilterType[] = ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf'];

export interface SynthFilter {
  readonly type: SynthFilterType;
  /** Corner / centre frequency (Hz) at the layer's start. */
  readonly freq: number;
  /** Swept to this by the layer's end. */
  readonly freq_end?: number;
  /** Resonance (default 0.707: no peak). */
  readonly q?: number;
  /** Peaking and shelf filters' gain, dB. */
  readonly gain_db?: number;
  readonly sweep?: SynthSweep;
}

/** One voice of the stack. Layers are summed, then the whole sound is normalized. */
export interface SynthLayer {
  readonly wave: SynthWave;
  /** Start frequency, Hz (default 440; noise ignores it). */
  readonly freq?: number;
  /** Glide to this by the layer's end: down is an impact, up a charge. */
  readonly freq_end?: number;
  /** Pitch sweep shape (default exponential). */
  readonly sweep?: SynthSweep;
  /** Linear gain before normalization (default 1). */
  readonly gain?: number;
  /** Seconds before the layer starts (default 0). */
  readonly delay?: number;
  /** Seconds it lasts from `delay` (default: the rest of the sound). */
  readonly length?: number;
  /** ADSR: seconds, except `sustain` (a 0..1 level). */
  readonly attack?: number;
  readonly decay?: number;
  readonly sustain?: number;
  readonly release?: number;
  /** Exponential decay on top of the envelope (higher = snappier; 0 none). */
  readonly decay_curve?: number;
  /** A second oscillator this many cents away, summed (thickness). */
  readonly detune_cents?: number;
  /** Ring-modulate by this frequency (metal, bells). */
  readonly ring_hz?: number;
  /** Tremolo depth 0..1 at `lfo_hz`. */
  readonly lfo_depth?: number;
  readonly lfo_hz?: number;
  /** Soft-clip drive (1 none; more adds grit). */
  readonly drive?: number;
  readonly filter?: SynthFilter;
}

/** A whole sound. */
export interface SynthSpec {
  /** Seconds, MIN_SYNTH_SECONDS..MAX_SYNTH_SECONDS. */
  readonly duration: number;
  readonly layers: readonly SynthLayer[];
  /** Level after peak normalization (default 0.9). */
  readonly gain?: number;
  /** Noise seed: the same spec and seed are the same samples forever (default 1). */
  readonly seed?: number;
  /** Skip peak normalization (a sound meant to be quieter than full scale). */
  readonly normalize?: boolean;
}

export const MIN_SYNTH_SECONDS = 0.005;
export const MAX_SYNTH_SECONDS = 20;
export const MAX_SYNTH_LAYERS = 24;
export const SYNTH_SAMPLE_RATE = 48000;

const LAYER_KEYS = [
  'wave', 'freq', 'freq_end', 'sweep', 'gain', 'delay', 'length', 'attack', 'decay', 'sustain', 'release', 'decay_curve',
  'detune_cents', 'ring_hz', 'lfo_depth', 'lfo_hz', 'drive', 'filter',
] as const;
const FILTER_KEYS = ['type', 'freq', 'freq_end', 'q', 'gain_db', 'sweep'] as const;
export const SYNTH_KEYS = ['duration', 'layers', 'gain', 'seed', 'normalize'] as const;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every problem with a written spec (empty: it renders). Unknown keys are problems: a
 * typo would otherwise render a different sound without a word.
 */
export function synthProblems(spec: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(spec)) return ['a synth sound must be an object with "duration" and "layers"'];
  for (const key of Object.keys(spec)) {
    if (!(SYNTH_KEYS as readonly string[]).includes(key)) problems.push(`unknown key "${key}" (keys: ${SYNTH_KEYS.join(', ')})`);
  }
  const duration = spec['duration'];
  if (!isNumber(duration)) problems.push('"duration" (seconds) is required and must be a number');
  else if (duration < MIN_SYNTH_SECONDS || duration > MAX_SYNTH_SECONDS) {
    problems.push(`"duration" ${duration} is outside ${MIN_SYNTH_SECONDS}..${MAX_SYNTH_SECONDS} seconds`);
  }
  for (const key of ['gain', 'seed'] as const) {
    if (spec[key] !== undefined && !isNumber(spec[key])) problems.push(`"${key}" must be a number`);
  }
  if (isNumber(spec['gain']) && (spec['gain'] < 0 || spec['gain'] > 4)) problems.push(`"gain" ${spec['gain']} is outside 0..4`);
  if (spec['normalize'] !== undefined && typeof spec['normalize'] !== 'boolean') problems.push('"normalize" must be true or false');
  const layers = spec['layers'];
  if (!Array.isArray(layers) || layers.length === 0) {
    problems.push('"layers" must be a non-empty list (no layers is silence)');
    return problems;
  }
  if (layers.length > MAX_SYNTH_LAYERS) problems.push(`${layers.length} layers; at most ${MAX_SYNTH_LAYERS}`);
  layers.forEach((layer: unknown, i) => {
    const at = `layers[${i}]`;
    if (!isObject(layer)) { problems.push(`${at} must be an object`); return; }
    for (const key of Object.keys(layer)) {
      if (!(LAYER_KEYS as readonly string[]).includes(key)) problems.push(`${at}: unknown key "${key}"`);
    }
    if (!(SYNTH_WAVES as readonly unknown[]).includes(layer['wave'])) {
      problems.push(`${at}.wave ${JSON.stringify(layer['wave']) ?? 'missing'} is not one of ${SYNTH_WAVES.join(', ')}`);
    }
    for (const key of LAYER_KEYS) {
      if (key === 'wave' || key === 'sweep' || key === 'filter') continue;
      const value = layer[key];
      if (value !== undefined && !isNumber(value)) problems.push(`${at}.${key} must be a number`);
      else if (isNumber(value) && value < 0 && key !== 'detune_cents') problems.push(`${at}.${key} must be at least 0`);
    }
    if (isNumber(layer['sustain']) && layer['sustain'] > 1) problems.push(`${at}.sustain is a level, 0..1`);
    if (isNumber(layer['lfo_depth']) && layer['lfo_depth'] > 1) problems.push(`${at}.lfo_depth is 0..1`);
    if (layer['sweep'] !== undefined && layer['sweep'] !== 'linear' && layer['sweep'] !== 'exponential') {
      problems.push(`${at}.sweep must be "linear" or "exponential"`);
    }
    const filter = layer['filter'];
    if (filter === undefined) return;
    if (!isObject(filter)) { problems.push(`${at}.filter must be an object`); return; }
    for (const key of Object.keys(filter)) {
      if (!(FILTER_KEYS as readonly string[]).includes(key)) problems.push(`${at}.filter: unknown key "${key}"`);
    }
    if (!(SYNTH_FILTERS as readonly unknown[]).includes(filter['type'])) {
      problems.push(`${at}.filter.type ${JSON.stringify(filter['type']) ?? 'missing'} is not one of ${SYNTH_FILTERS.join(', ')}`);
    }
    if (!isNumber(filter['freq']) || filter['freq'] <= 0) problems.push(`${at}.filter.freq must be a frequency above 0 Hz`);
    for (const key of ['freq_end', 'q', 'gain_db'] as const) {
      if (filter[key] !== undefined && !isNumber(filter[key])) problems.push(`${at}.filter.${key} must be a number`);
    }
  });
  return problems;
}

/** Seconds the sound lasts (its duration, clamped as rendering clamps it). */
export function synthSeconds(spec: SynthSpec): number {
  return Math.max(MIN_SYNTH_SECONDS, Math.min(MAX_SYNTH_SECONDS, isNumber(spec.duration) ? spec.duration : 0.25));
}

/** mulberry32: one integer of state, the same in node and every browser. */
function rng(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wave(kind: SynthWave, phase: number): number {
  switch (kind) {
    case 'sine': return Math.sin(phase * Math.PI * 2);
    case 'square': return phase < 0.5 ? 1 : -1;
    case 'saw': return 2 * phase - 1;
    case 'triangle': return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
    default: return 0;
  }
}

function sweep(from: number, to: number, t: number, shape: SynthSweep): number {
  return shape === 'exponential' && from > 0 && to > 0 ? from * (to / from) ** t : from + (to - from) * t;
}

function softClip(x: number, drive: number): number {
  return drive <= 1 ? Math.max(-1, Math.min(1, x)) : Math.tanh(x * drive) / Math.tanh(drive);
}

/** Normalized biquad coefficients (a0 = 1), RBJ cookbook. */
export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

export function biquad(type: SynthFilterType, frequency: number, q: number, gainDb: number, sampleRate: number, out?: Biquad): Biquad {
  const f0 = Math.max(1e-6, Math.min(frequency, sampleRate / 2 - 1e-6));
  const Q = q > 0 ? q : 0.707;
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cos + s); b1 = 2 * A * ((A - 1) - (A + 1) * cos); b2 = A * ((A + 1) - (A - 1) * cos - s);
      a0 = (A + 1) + (A - 1) * cos + s; a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cos + s); b1 = -2 * A * ((A - 1) + (A + 1) * cos); b2 = A * ((A + 1) + (A - 1) * cos - s);
      a0 = (A + 1) - (A - 1) * cos + s; a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - s;
      break;
    }
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cos; b2 = 1; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
  }
  const c = out ?? { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };
  c.b0 = b0 / a0; c.b1 = b1 / a0; c.b2 = b2 / a0; c.a1 = a1 / a0; c.a2 = a2 / a0;
  return c;
}

const num = (v: number | undefined, fallback: number): number => (isNumber(v) ? v : fallback);

/**
 * Render a spec to mono PCM in [-1, 1] at `sampleRate`. Deterministic: the same spec and
 * rate give the same samples everywhere. Assumes a checked spec (`synthProblems` empty);
 * out-of-range values are clamped, never thrown.
 */
export function renderSynth(spec: SynthSpec, sampleRate = SYNTH_SAMPLE_RATE): Float32Array {
  const sr = sampleRate > 0 && Number.isFinite(sampleRate) ? sampleRate : SYNTH_SAMPLE_RATE;
  const duration = synthSeconds(spec);
  const n = Math.max(1, Math.floor(duration * sr));
  const out = new Float32Array(n);
  const layers = spec.layers.slice(0, MAX_SYNTH_LAYERS);
  // One noise stream per layer index: appending a layer never changes the earlier ones.
  const baseSeed = Math.floor(num(spec.seed, 1)) >>> 0;
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li]!;
    const noise = rng((baseSeed + li * 0x9e3779b9) >>> 0);
    const delay = Math.max(0, num(layer.delay, 0));
    const startSample = Math.floor(delay * sr);
    if (startSample >= n) continue;
    const len = Math.max(1 / sr, Math.min(num(layer.length, duration - delay), duration - delay));
    const lenSamples = Math.max(1, Math.floor(len * sr));
    const endSample = Math.min(n, startSample + lenSamples);
    const gain = num(layer.gain, 1);
    const f0 = Math.max(0.0001, num(layer.freq, 440));
    const f1 = isNumber(layer.freq_end) ? Math.max(0.0001, layer.freq_end) : f0;
    const shape: SynthSweep = layer.sweep === 'linear' ? 'linear' : 'exponential';
    const detune = num(layer.detune_cents, 0);
    const detuneRatio = detune !== 0 ? 2 ** (detune / 1200) : 0;
    const ringHz = Math.max(0, num(layer.ring_hz, 0));
    const lfoDepth = Math.max(0, Math.min(1, num(layer.lfo_depth, 0)));
    const lfoHz = Math.max(0, num(layer.lfo_hz, 0));
    const drive = Math.max(1, num(layer.drive, 1));
    const attack = Math.max(0, num(layer.attack, 0.005));
    const decay = Math.max(0, num(layer.decay, Math.max(0, len - attack)));
    const sustain = Math.max(0, Math.min(1, num(layer.sustain, 0)));
    const release = Math.max(0, num(layer.release, 0));
    const releaseStart = Math.max(0, len - release);
    const curve = Math.max(0, num(layer.decay_curve, 0));

    // Phase is integrated: recomputing it from t × freq would buzz at the sweep rate.
    let phase = 0;
    let phaseDetune = 0;
    let ringPhase = 0;
    let filterAt: ((t: number) => Biquad) | null = null;
    const state = { x1: 0, x2: 0, y1: 0, y2: 0 };
    const filter = layer.filter;
    if (filter !== undefined && isNumber(filter.freq)) {
      const ff0 = Math.max(1, filter.freq);
      const ff1 = isNumber(filter.freq_end) ? Math.max(1, filter.freq_end) : ff0;
      const fShape: SynthSweep = filter.sweep === 'linear' ? 'linear' : 'exponential';
      const q = num(filter.q, 0.707);
      const db = num(filter.gain_db, 0);
      const fixed = biquad(filter.type, Math.min(sr / 2 - 1, ff0), q, db, sr);
      filterAt = ff0 === ff1 ? () => fixed : (t) => biquad(filter.type, Math.min(sr / 2 - 1, sweep(ff0, ff1, t, fShape)), q, db, sr, fixed);
    }

    for (let i = startSample; i < endSample; i++) {
      const local = (i - startSample) / sr;
      const t = lenSamples > 1 ? (i - startSample) / (lenSamples - 1) : 0;
      let s: number;
      if (layer.wave === 'noise') {
        s = noise() * 2 - 1;
      } else {
        const freq = sweep(f0, f1, t, shape);
        phase += freq / sr;
        if (phase >= 1) phase -= Math.floor(phase);
        s = wave(layer.wave, phase);
        if (detuneRatio > 0) {
          phaseDetune += (freq * detuneRatio) / sr;
          if (phaseDetune >= 1) phaseDetune -= Math.floor(phaseDetune);
          s = (s + wave(layer.wave, phaseDetune)) * 0.5;
        }
      }
      if (ringHz > 0) {
        ringPhase += ringHz / sr;
        if (ringPhase >= 1) ringPhase -= Math.floor(ringPhase);
        s *= Math.sin(ringPhase * Math.PI * 2);
      }
      if (filterAt !== null) {
        const c = filterAt(t);
        const y = c.b0 * s + c.b1 * state.x1 + c.b2 * state.x2 - c.a1 * state.y1 - c.a2 * state.y2;
        state.x2 = state.x1; state.x1 = s;
        state.y2 = state.y1; state.y1 = Number.isFinite(y) ? y : 0;
        s = state.y1;
      }
      let env: number;
      if (local < attack) env = attack > 0 ? local / attack : 1;
      else if (local < attack + decay) env = 1 + (sustain - 1) * (decay > 0 ? (local - attack) / decay : 1);
      else env = sustain;
      if (release > 0 && local >= releaseStart) env *= 1 - Math.min(1, (local - releaseStart) / release);
      if (curve > 0) env *= Math.exp(-curve * local);
      env = Math.max(0, env);
      if (lfoDepth > 0 && lfoHz > 0) env *= 1 - lfoDepth * 0.5 * (1 - Math.cos(local * lfoHz * Math.PI * 2));
      let v = s * env * gain;
      if (drive > 1) v = softClip(v, drive);
      out[i] = out[i]! + v;
    }
  }
  // Normalize to the peak, then apply the level: authors needn't balance layer gains by ear.
  const master = Math.max(0, Math.min(4, num(spec.gain, 0.9)));
  let k = master;
  if (spec.normalize !== false) {
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
    k = peak > 1e-9 ? master / peak : 0;
  }
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, out[i]! * k));
  return out;
}

export interface SynthStats {
  /** Largest absolute sample (0: silence). */
  readonly peak: number;
  /** Root-mean-square level: how loud it is (a one-sample click has peak 1 and is inaudible). */
  readonly rms: number;
  readonly seconds: number;
  /** Fraction of samples above -60 dBFS. */
  readonly audible: number;
}

/** Measure rendered PCM: what tests assert instead of claiming to hear it. */
export function synthStats(pcm: Float32Array, sampleRate = SYNTH_SAMPLE_RATE): SynthStats {
  let peak = 0;
  let sum = 0;
  let loud = 0;
  for (const v of pcm) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    if (a > 0.001) loud++;
  }
  const n = pcm.length;
  return { peak, rms: n > 0 ? Math.sqrt(sum / n) : 0, seconds: n / sampleRate, audible: n > 0 ? loud / n : 0 };
}
