/**
 * The built-in synthesized sounds: every game can play `synth/<name>` (SDK `Synth.<name>`)
 * with no file, and a `.synth.json` can start from one (`{"preset": "hit_metal", "gain": 0.6}`).
 *
 * Every spec here is original and describes a physical event — metal struck, air displaced,
 * a charge rising — built from oscillators, noise, envelopes and filters. Most are four moves:
 *   transient  a 1–10 ms noise or high burst: the sound happened at a moment
 *   body       an oscillator sweeping down (an impact) or up (a charge)
 *   tail       filtered noise or a low sine decaying slowly: the room, the debris
 *   colour     detune (thickness), ring modulation (metal, bells), drive (grit)
 *
 * The ambience beds (`rain`, `wind`, `river`, `surf`, `lake`) and `thunder` are what the
 * audio plugin plays for the weather, wind and water plugins (ambience.ts). Beds loop: their
 * envelopes are flat (no attack or release) so the loop seam doesn't dip.
 */

import type { SynthSpec } from '../../../core/index.js';

export const SYNTH_PRESETS: Readonly<Record<string, SynthSpec>> = {
  // ── UI ──────────────────────────────────────────────────────────────────────
  /** A short, dry, high tick: "you pressed something". */
  ui_click: {
    duration: 0.07, seed: 11, gain: 0.55,
    layers: [
      { wave: 'sine', freq: 2100, freq_end: 1400, attack: 0.001, decay: 0.05, sustain: 0, gain: 0.8 },
      { wave: 'noise', decay: 0.018, sustain: 0, gain: 0.5, filter: { type: 'highpass', freq: 2600 } },
    ],
  },
  /** Two rising notes: it worked. */
  ui_confirm: {
    duration: 0.34, seed: 12, gain: 0.6,
    layers: [
      { wave: 'triangle', freq: 660, attack: 0.004, decay: 0.14, sustain: 0, gain: 0.7, detune_cents: 6 },
      { wave: 'triangle', freq: 990, delay: 0.09, attack: 0.004, decay: 0.22, sustain: 0, gain: 0.8, detune_cents: 6 },
    ],
  },
  /** A flat, low, detuned buzz: refused. */
  ui_deny: {
    duration: 0.24, seed: 13, gain: 0.55,
    layers: [
      { wave: 'square', freq: 180, attack: 0.003, decay: 0.2, sustain: 0, gain: 0.5, detune_cents: 22, drive: 2, filter: { type: 'lowpass', freq: 1400 } },
    ],
  },
  /** A soft blip for hover and focus (quiet: it fires a lot). */
  ui_hover: {
    duration: 0.05, seed: 14, gain: 0.28,
    layers: [{ wave: 'sine', freq: 1500, freq_end: 1900, attack: 0.002, decay: 0.04, sustain: 0 }],
  },
  /** A panel sliding open: a filtered noise swell. */
  ui_open: {
    duration: 0.26, seed: 15, gain: 0.42,
    layers: [{ wave: 'noise', attack: 0.06, decay: 0.2, sustain: 0, filter: { type: 'bandpass', freq: 600, freq_end: 2400, q: 1.1 } }],
  },
  /** ...and closing: the same gesture reversed. */
  ui_close: {
    duration: 0.22, seed: 16, gain: 0.42,
    layers: [{ wave: 'noise', attack: 0.02, decay: 0.19, sustain: 0, filter: { type: 'bandpass', freq: 2200, freq_end: 500, q: 1.1 } }],
  },
  /** A coin chime: a purchase landed. */
  ui_purchase: {
    duration: 0.42, seed: 17, gain: 0.6,
    layers: [
      { wave: 'sine', freq: 1760, attack: 0.001, decay: 0.3, sustain: 0, gain: 0.7, ring_hz: 430 },
      { wave: 'sine', freq: 2640, delay: 0.035, attack: 0.001, decay: 0.34, sustain: 0, gain: 0.5, ring_hz: 610 },
      { wave: 'noise', decay: 0.02, sustain: 0, gain: 0.35, filter: { type: 'highpass', freq: 4000 } },
    ],
  },

  // ── Impacts ─────────────────────────────────────────────────────────────────
  /** Blade on plate: a bright transient, a short metallic ring, a noise tail. */
  hit_metal: {
    duration: 0.4, seed: 21, gain: 0.85,
    layers: [
      { wave: 'noise', decay: 0.012, sustain: 0, gain: 1, filter: { type: 'highpass', freq: 3000 } },
      { wave: 'square', freq: 1400, freq_end: 620, attack: 0.001, decay: 0.09, sustain: 0, gain: 0.5, ring_hz: 317, drive: 2.4 },
      { wave: 'sine', freq: 430, attack: 0.001, decay: 0.34, sustain: 0, gain: 0.35, ring_hz: 1290 },
    ],
  },
  /** A dull, wet thump with a short hiss: no ring at all. */
  hit_flesh: {
    duration: 0.26, seed: 22, gain: 0.8,
    layers: [
      { wave: 'sine', freq: 260, freq_end: 80, attack: 0.001, decay: 0.16, sustain: 0, gain: 1, drive: 1.8 },
      { wave: 'noise', decay: 0.07, sustain: 0, gain: 0.45, filter: { type: 'bandpass', freq: 900, freq_end: 320, q: 0.8 } },
    ],
  },
  /** Something heavy landing on stone: all body, no top. */
  hit_stone: {
    duration: 0.5, seed: 23, gain: 0.85,
    layers: [
      { wave: 'noise', decay: 0.03, sustain: 0, gain: 0.8, filter: { type: 'lowpass', freq: 2200, freq_end: 500 } },
      { wave: 'sine', freq: 150, freq_end: 48, attack: 0.001, decay: 0.4, sustain: 0, gain: 1 },
      { wave: 'noise', delay: 0.02, decay: 0.3, sustain: 0, gain: 0.25, filter: { type: 'lowpass', freq: 700 } },
    ],
  },
  /** Wood splintering. */
  hit_wood: {
    duration: 0.3, seed: 24, gain: 0.8,
    layers: [
      { wave: 'noise', decay: 0.025, sustain: 0, gain: 0.8, filter: { type: 'bandpass', freq: 1800, q: 0.9 } },
      { wave: 'triangle', freq: 340, freq_end: 150, attack: 0.001, decay: 0.2, sustain: 0, gain: 0.7, drive: 1.6 },
    ],
  },
  /** A big low explosion. */
  boom: {
    duration: 1.5, seed: 25, gain: 1,
    layers: [
      { wave: 'noise', decay: 0.05, sustain: 0, gain: 1, filter: { type: 'lowpass', freq: 5000, freq_end: 400 } },
      { wave: 'sine', freq: 110, freq_end: 26, attack: 0.002, decay: 1.1, sustain: 0, gain: 1, drive: 1.5 },
      { wave: 'noise', attack: 0.01, decay: 1.3, sustain: 0, gain: 0.35, filter: { type: 'lowpass', freq: 1200, freq_end: 180 } },
    ],
  },

  // ── Movement and air ────────────────────────────────────────────────────────
  /** Something big swung past. */
  whoosh: {
    duration: 0.4, seed: 31, gain: 0.55,
    layers: [{ wave: 'noise', attack: 0.11, decay: 0.28, sustain: 0, filter: { type: 'bandpass', freq: 420, freq_end: 2600, q: 1.4 } }],
  },
  /** A dash or blink: a fast pitched rush with a tail. */
  dash: {
    duration: 0.45, seed: 32, gain: 0.65,
    layers: [
      { wave: 'noise', attack: 0.015, decay: 0.2, sustain: 0, gain: 0.8, filter: { type: 'bandpass', freq: 2800, freq_end: 500, q: 1.2 } },
      { wave: 'saw', freq: 900, freq_end: 180, attack: 0.005, decay: 0.3, sustain: 0, gain: 0.35, filter: { type: 'lowpass', freq: 2400, freq_end: 500 } },
    ],
  },
  /** A soft footfall on soil. */
  footstep_soft: {
    duration: 0.16, seed: 33, gain: 0.4,
    layers: [
      { wave: 'noise', decay: 0.09, sustain: 0, gain: 1, filter: { type: 'lowpass', freq: 1100, freq_end: 300 } },
      { wave: 'sine', freq: 120, freq_end: 60, attack: 0.001, decay: 0.08, sustain: 0, gain: 0.4 },
    ],
  },
  /** ...and on stone: brighter, shorter, with a click. */
  footstep_hard: {
    duration: 0.14, seed: 34, gain: 0.42,
    layers: [
      { wave: 'noise', decay: 0.05, sustain: 0, gain: 1, filter: { type: 'bandpass', freq: 2400, q: 0.8 } },
      { wave: 'sine', freq: 190, freq_end: 90, attack: 0.001, decay: 0.06, sustain: 0, gain: 0.35 },
    ],
  },
  /** Something falling into water. */
  splash: {
    duration: 0.7, seed: 35, gain: 0.7,
    layers: [
      { wave: 'noise', attack: 0.004, decay: 0.12, sustain: 0, gain: 1, filter: { type: 'bandpass', freq: 1800, freq_end: 700, q: 0.7 } },
      { wave: 'sine', freq: 420, freq_end: 900, attack: 0.002, decay: 0.08, sustain: 0, gain: 0.3 },
      { wave: 'noise', delay: 0.05, attack: 0.05, decay: 0.55, sustain: 0, gain: 0.45, lfo_depth: 0.6, lfo_hz: 13, filter: { type: 'bandpass', freq: 2600, q: 0.9 } },
    ],
  },

  // ── Abilities ───────────────────────────────────────────────────────────────
  /** A wind-up: rising, thickening, ending on nothing (the release is its own sound, so it can be cancelled). */
  cast_charge: {
    duration: 0.55, seed: 41, gain: 0.6,
    layers: [
      { wave: 'saw', freq: 140, freq_end: 620, attack: 0.16, decay: 0.42, sustain: 0.8, release: 0.12, gain: 0.6, detune_cents: 9, filter: { type: 'lowpass', freq: 700, freq_end: 4200, q: 2.2 } },
      { wave: 'sine', freq: 280, freq_end: 1240, attack: 0.2, decay: 0.35, sustain: 0.7, release: 0.1, gain: 0.3 },
    ],
  },
  /** The release: a bright forward burst. */
  cast_release: {
    duration: 0.55, seed: 42, gain: 0.85,
    layers: [
      { wave: 'noise', decay: 0.05, sustain: 0, gain: 0.7, filter: { type: 'highpass', freq: 1800 } },
      { wave: 'saw', freq: 1200, freq_end: 240, attack: 0.002, decay: 0.3, sustain: 0, gain: 0.7, detune_cents: 14, drive: 1.8, filter: { type: 'lowpass', freq: 5200, freq_end: 900 } },
      { wave: 'sine', freq: 90, attack: 0.002, decay: 0.4, sustain: 0, gain: 0.5 },
    ],
  },
  /** An electrical zap. */
  zap: {
    duration: 0.28, seed: 43, gain: 0.75,
    layers: [
      { wave: 'saw', freq: 2400, freq_end: 600, attack: 0.001, decay: 0.16, sustain: 0, ring_hz: 137, drive: 3, filter: { type: 'highpass', freq: 700 } },
      { wave: 'noise', decay: 0.03, sustain: 0, gain: 0.4, filter: { type: 'highpass', freq: 4200 } },
    ],
  },
  /** A shield coming up: a swelling pad with a bell on top. */
  shield_up: {
    duration: 0.7, seed: 44, gain: 0.6,
    layers: [
      { wave: 'triangle', freq: 320, attack: 0.09, decay: 0.5, sustain: 0.3, release: 0.15, gain: 0.6, detune_cents: 11, filter: { type: 'lowpass', freq: 900, freq_end: 2600 } },
      { wave: 'sine', freq: 1280, attack: 0.02, decay: 0.55, sustain: 0, gain: 0.35, ring_hz: 640 },
    ],
  },
  /** ...and breaking: a glassy shatter. */
  shield_break: {
    duration: 0.6, seed: 45, gain: 0.8,
    layers: [
      { wave: 'noise', decay: 0.35, sustain: 0, gain: 0.9, filter: { type: 'highpass', freq: 2600, freq_end: 900 } },
      { wave: 'sine', freq: 2100, freq_end: 700, attack: 0.001, decay: 0.2, sustain: 0, gain: 0.45, ring_hz: 913 },
    ],
  },
  /** Healing: a warm rising swell. */
  heal: {
    duration: 0.8, seed: 46, gain: 0.5,
    layers: [
      { wave: 'sine', freq: 392, attack: 0.08, decay: 0.6, sustain: 0.2, release: 0.2, gain: 0.5, detune_cents: 5 },
      { wave: 'sine', freq: 588, delay: 0.06, attack: 0.1, decay: 0.6, sustain: 0.2, release: 0.2, gain: 0.4, detune_cents: 5 },
      { wave: 'sine', freq: 784, delay: 0.12, attack: 0.12, decay: 0.55, sustain: 0.1, release: 0.2, gain: 0.3 },
    ],
  },
  /** A pickup: a quick bright up-blip. */
  pickup: {
    duration: 0.18, seed: 47, gain: 0.55,
    layers: [
      { wave: 'square', freq: 880, freq_end: 1760, attack: 0.002, decay: 0.12, sustain: 0, gain: 0.5, filter: { type: 'lowpass', freq: 5000 } },
      { wave: 'sine', freq: 1760, delay: 0.05, attack: 0.002, decay: 0.12, sustain: 0, gain: 0.4 },
    ],
  },

  // ── Progression and stings ──────────────────────────────────────────────────
  /** A three-note rise with a bright tail. */
  level_up: {
    duration: 0.9, seed: 51, gain: 0.65,
    layers: [
      { wave: 'triangle', freq: 523, attack: 0.005, decay: 0.2, sustain: 0, gain: 0.6, detune_cents: 6 },
      { wave: 'triangle', freq: 659, delay: 0.1, attack: 0.005, decay: 0.2, sustain: 0, gain: 0.6, detune_cents: 6 },
      { wave: 'triangle', freq: 880, delay: 0.2, attack: 0.005, decay: 0.5, sustain: 0, gain: 0.7, detune_cents: 6 },
      { wave: 'sine', freq: 1760, delay: 0.2, attack: 0.01, decay: 0.6, sustain: 0, gain: 0.2 },
    ],
  },
  /** A low, ominous swell. */
  sting_low: {
    duration: 1.6, seed: 52, gain: 0.7,
    layers: [
      { wave: 'saw', freq: 55, attack: 0.25, decay: 1.2, sustain: 0.2, release: 0.4, gain: 0.8, detune_cents: 8, drive: 1.6, filter: { type: 'lowpass', freq: 260, freq_end: 900 } },
      { wave: 'sine', freq: 110, attack: 0.3, decay: 1.1, sustain: 0.2, release: 0.4, gain: 0.5 },
      { wave: 'noise', attack: 0.4, decay: 1.0, sustain: 0, gain: 0.15, filter: { type: 'bandpass', freq: 300, freq_end: 1400, q: 0.8 } },
    ],
  },
  /** A bright triumphant swell. */
  sting_high: {
    duration: 1.4, seed: 53, gain: 0.7,
    layers: [
      { wave: 'saw', freq: 330, attack: 0.06, decay: 1.0, sustain: 0.15, release: 0.3, gain: 0.55, detune_cents: 12, filter: { type: 'lowpass', freq: 1800, freq_end: 5200 } },
      { wave: 'saw', freq: 495, delay: 0.05, attack: 0.06, decay: 1.0, sustain: 0.15, release: 0.3, gain: 0.4, detune_cents: 12, filter: { type: 'lowpass', freq: 1800, freq_end: 5200 } },
      { wave: 'sine', freq: 1320, delay: 0.02, attack: 0.02, decay: 0.9, sustain: 0, gain: 0.25 },
    ],
  },
  /** A single struck bell: a countdown, an announcement. */
  bell: {
    duration: 1.8, seed: 54, gain: 0.6,
    layers: [
      { wave: 'sine', freq: 587, attack: 0.001, decay: 1.7, sustain: 0, gain: 1, ring_hz: 1401 },
      { wave: 'sine', freq: 1174, attack: 0.001, decay: 0.8, sustain: 0, gain: 0.4 },
      { wave: 'noise', decay: 0.01, sustain: 0, gain: 0.3, filter: { type: 'highpass', freq: 4000 } },
    ],
  },
  /** A soft two-pip alert that must not startle. */
  alert: {
    duration: 0.4, seed: 55, gain: 0.5,
    layers: [
      { wave: 'sine', freq: 880, attack: 0.006, decay: 0.12, sustain: 0, gain: 0.7 },
      { wave: 'sine', freq: 880, delay: 0.16, attack: 0.006, decay: 0.18, sustain: 0, gain: 0.6 },
    ],
  },
  /** A metronome tick (beat clocks, countdowns). */
  tick: {
    duration: 0.05, seed: 56, gain: 0.5,
    layers: [{ wave: 'sine', freq: 1600, attack: 0.0005, decay: 0.03, sustain: 0, gain: 1, decay_curve: 60 }],
  },

  // ── Motors (loop; the game moves the pitch) ─────────────────────────────────
  motor_car: {
    duration: 2, seed: 71, gain: 0.42,
    layers: [
      { wave: 'sine', freq: 45, attack: 0, decay: 0, sustain: 1, gain: 1, drive: 2.4 },
      { wave: 'triangle', freq: 90, attack: 0, decay: 0, sustain: 1, gain: 0.38, lfo_hz: 22.5, lfo_depth: 0.5 },
      { wave: 'sine', freq: 180, attack: 0, decay: 0, sustain: 1, gain: 0.12 },
    ],
  },
  motor_boat: {
    duration: 2, seed: 72, gain: 0.4,
    layers: [
      { wave: 'sine', freq: 32, attack: 0, decay: 0, sustain: 1, gain: 1, drive: 3, lfo_hz: 8, lfo_depth: 0.35 },
      { wave: 'triangle', freq: 64, attack: 0, decay: 0, sustain: 1, gain: 0.35 },
      { wave: 'sine', freq: 160, attack: 0, decay: 0, sustain: 1, gain: 0.1 },
    ],
  },
  motor_propeller: {
    duration: 2, seed: 73, gain: 0.35,
    layers: [
      { wave: 'triangle', freq: 70, attack: 0, decay: 0, sustain: 1, gain: 1, lfo_hz: 35, lfo_depth: 0.6 },
      { wave: 'sine', freq: 210, attack: 0, decay: 0, sustain: 1, gain: 0.25, drive: 1.8 },
    ],
  },
  motor_rotor: {
    duration: 2, seed: 74, gain: 0.42,
    layers: [
      { wave: 'sine', freq: 60, attack: 0, decay: 0, sustain: 1, gain: 1, lfo_hz: 12, lfo_depth: 0.95, drive: 3 },
      { wave: 'triangle', freq: 120, attack: 0, decay: 0, sustain: 1, gain: 0.18, lfo_hz: 12, lfo_depth: 0.9 },
    ],
  },

  // ── Ambience beds (loop) ────────────────────────────────────────────────────
  /** Outdoors at a distance: wide, slow, no pitch. */
  bed_air: {
    duration: 4, seed: 61, gain: 0.3,
    layers: [
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 1, lfo_depth: 0.35, lfo_hz: 0.25, filter: { type: 'lowpass', freq: 420 } },
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 0.4, lfo_depth: 0.5, lfo_hz: 0.5, filter: { type: 'bandpass', freq: 900, q: 0.5 } },
    ],
  },
  /** A low room or cave tone with a slow beat in it. */
  bed_deep: {
    duration: 4, seed: 62, gain: 0.28,
    layers: [
      { wave: 'sine', freq: 48, attack: 0, decay: 0, sustain: 1, gain: 1, detune_cents: 14, lfo_depth: 0.3, lfo_hz: 0.25 },
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 0.3, filter: { type: 'lowpass', freq: 220 } },
    ],
  },
  /** Foliage and insects: bright and busy. */
  bed_thicket: {
    duration: 4, seed: 63, gain: 0.24,
    layers: [
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 1, lfo_depth: 0.55, lfo_hz: 0.75, filter: { type: 'bandpass', freq: 3200, q: 0.7 } },
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 0.45, lfo_depth: 0.4, lfo_hz: 0.5, filter: { type: 'bandpass', freq: 1400, q: 0.9 } },
    ],
  },
  /** Rain on everything: a band-passed hiss with a fine patter. */
  rain: {
    duration: 2, seed: 81, gain: 0.5,
    layers: [
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 1, filter: { type: 'bandpass', freq: 2500, q: 0.5 } },
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 0.35, lfo_depth: 0.5, lfo_hz: 17, filter: { type: 'highpass', freq: 5000 } },
    ],
  },
  /** Wind: a low-passed rush swelling in slow gusts (the plugin raises its pitch with speed). */
  wind: {
    duration: 4, seed: 82, gain: 0.45,
    layers: [
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 1, lfo_depth: 0.45, lfo_hz: 0.25, filter: { type: 'lowpass', freq: 420, q: 0.8 } },
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 0.3, lfo_depth: 0.7, lfo_hz: 0.5, filter: { type: 'bandpass', freq: 900, q: 2.5 } },
    ],
  },
  /** A thunderclap: a bright crack settling into a long low rumble. */
  thunder: {
    duration: 3.2, seed: 83, gain: 0.95,
    layers: [
      { wave: 'noise', attack: 0.004, decay: 0.25, sustain: 0, gain: 0.8, filter: { type: 'lowpass', freq: 3200, freq_end: 600 } },
      { wave: 'noise', delay: 0.05, attack: 0.08, decay: 3, sustain: 0, gain: 1, lfo_depth: 0.4, lfo_hz: 2.5, filter: { type: 'lowpass', freq: 900, freq_end: 90 } },
      { wave: 'sine', freq: 52, freq_end: 30, delay: 0.05, attack: 0.1, decay: 2.6, sustain: 0, gain: 0.5 },
    ],
  },
  /** A river or stream: babbling band-passed noise. */
  river: {
    duration: 4, seed: 84, gain: 0.4,
    layers: [
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 1, lfo_depth: 0.3, lfo_hz: 1.25, filter: { type: 'bandpass', freq: 1400, q: 0.6 } },
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 0.5, filter: { type: 'lowpass', freq: 600 } },
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 0.2, lfo_depth: 0.8, lfo_hz: 7, filter: { type: 'bandpass', freq: 3000, q: 1.5 } },
    ],
  },
  /** The sea at the shore: a low wash swelling like sets of waves rolling in. */
  surf: {
    duration: 8, seed: 85, gain: 0.45,
    layers: [
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 1, lfo_depth: 0.85, lfo_hz: 0.125, filter: { type: 'lowpass', freq: 700, q: 0.4 } },
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 0.35, lfo_depth: 0.9, lfo_hz: 0.25, filter: { type: 'bandpass', freq: 2200, q: 0.6 } },
    ],
  },
  /** Still water lapping at an edge: quiet, slow. */
  lake: {
    duration: 4, seed: 86, gain: 0.3,
    layers: [
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 1, lfo_depth: 0.7, lfo_hz: 0.5, filter: { type: 'bandpass', freq: 800, q: 0.8 } },
      { wave: 'noise', attack: 0, decay: 0, sustain: 1, gain: 0.3, lfo_depth: 0.6, lfo_hz: 0.75, filter: { type: 'lowpass', freq: 400 } },
    ],
  },
};

export const SYNTH_PRESET_NAMES: readonly string[] = Object.keys(SYNTH_PRESETS);
