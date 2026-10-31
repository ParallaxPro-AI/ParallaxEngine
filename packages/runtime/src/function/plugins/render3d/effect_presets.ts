/**
 * The built-in effects (`effect/<name>`, Python `Effect.<name>`), written in the
 * `.vfx.json` format so a game's file can `"extends"` one and override any key. Tuned at
 * scale 1 for a human-sized world: an explosion about 3 m across, a campfire, a rifle's
 * muzzle. One-shots (play with `ctx.vfx.play`): explosion, sparks, muzzle_flash, impact,
 * sparkle. Continuous (a `Particles` component): fire, smoke, embers, magic, dust.
 *
 * Gravity acts along +y (negative falls); spin and angle are degrees; colors are straight-alpha sRGB.
 */

import type { BUILTIN_EFFECTS } from '../../../core/index.js';

type Doc = Readonly<Record<string, unknown>>;

const SPARKS: Doc = {
  burst: 40, max: 160, lifetime: [0.25, 0.8], speed: [4, 13], spread: 360, gravity: -9, drag: 0.9,
  size: [0.05, 0.1], size_end: 0.02, color: '#fff2b8', color_end: '#ff6a1a00',
  blend: 'additive', shape: 'glow', facing: 'velocity', stretch: 0.045, intensity: 4,
};

const SMOKE_PUFFS: Doc = {
  burst: 12, max: 48, lifetime: [1.6, 2.8], speed: [0.6, 2.2], spread: 360, radius: 0.7, gravity: 0.7, drag: 1.4,
  size: [1.2, 2], size_end: 4, color: '#3a3532c8', color_end: '#5c585400', flipbook: 'smoke', angle: [0, 360], spin: [-35, 35],
  fade_in: 0.12, turbulence: 0.6, delay: 0.08,
};

export const EFFECT_PRESETS: Readonly<Record<(typeof BUILTIN_EFFECTS)[number], Doc>> = {
  /** A fireball, flying sparks, a rising smoke ball, a dust shock ring, a flash of light, a shockwave and a camera kick. */
  explosion: {
    burst: 22, max: 40, lifetime: [0.55, 1], speed: [1.5, 5.5], spread: 360, radius: 0.5, gravity: 1.2, drag: 2.6,
    size: [1.4, 2.4], size_end: 3.4, color: '#ffffff', color_end: '#8a4a2a00', flipbook: 'fire', angle: [0, 360],
    spin: [-70, 70], intensity: 2.4, turbulence: 1,
    light: { color: '#ffb066', intensity: 30, range: 12, seconds: 0.45, flicker: 0.3 },
    shake: { intensity: 0.35, seconds: 0.4, radius: 30 },
    haze: { radius: 7, strength: 0.6, ring: 0.25, seconds: 0.45 },
    children: [
      { effect: SPARKS, scale: 1.1 },
      { effect: SMOKE_PUFFS },
      {
        effect: {
          burst: 1, max: 1, lifetime: 0.22, speed: 0, size: 3.2, size_end: 6.5, color: '#fff1d0', color_end: '#ff9a4000',
          blend: 'additive', shape: 'glow', intensity: 6, soft: 1,
        },
      },
      {
        effect: {
          burst: 1, max: 1, lifetime: 0.6, speed: 0, size: 1.5, size_end: 9, color: '#8a7a68a0', color_end: '#8a7a6800',
          shape: 'ring', facing: 'up', soft: 0.3,
        },
        offset: [0, -0.4, 0],
      },
    ],
  },

  /** A steady flame: flipbook tongues, additive, rising, flickering light. Pair with `embers` and `smoke`. */
  fire: {
    rate: 26, max: 80, lifetime: [0.55, 1], speed: [0.6, 1.6], spread: 22, radius: 0.18, gravity: 2.4, drag: 1.2,
    size: [0.7, 1.1], size_end: 0.35, color: '#ffffff', color_end: '#ff9a6000', flipbook: 'fire', angle: [-25, 25],
    spin: [-45, 45], intensity: 2, turbulence: 1.4, soft: 0.4,
    light: { color: '#ff9a48', intensity: 6, range: 7, seconds: 0, flicker: 0.35 },
    haze: { radius: 1.4, strength: 0.35 },
  },

  /** A rising column of soft, lit smoke. */
  smoke: {
    rate: 9, max: 60, lifetime: [2.5, 4.5], speed: [0.5, 1.2], spread: 28, radius: 0.25, gravity: 0.5, drag: 0.6,
    size: [0.8, 1.3], size_end: 3.6, color: '#59544fb0', color_end: '#7a767200', flipbook: 'smoke', angle: [0, 360],
    spin: [-25, 25], fade_in: 0.15, turbulence: 0.5,
  },

  /** A burst of hot sparks that streak, fall and cool: grinding, hits on metal, short circuits. */
  sparks: SPARKS,

  /** Glowing motes drifting up off a fire. */
  embers: {
    rate: 10, max: 60, lifetime: [0.8, 2.2], speed: [0.8, 2.4], spread: 30, radius: 0.25, gravity: 0.6, drag: 0.4,
    size: [0.04, 0.08], size_end: 0.015, color: '#ffc070', color_end: '#ff400000', blend: 'additive', shape: 'glow',
    intensity: 3, turbulence: 2.5,
  },

  /** Swirling arcane motes and a soft glow: auras, portals, charging spells (tint with `color=`). */
  magic: {
    rate: 34, max: 140, lifetime: [0.7, 1.6], speed: [0.4, 1.4], spread: 360, radius: 0.35, gravity: 0.5, drag: 0.8,
    size: [0.12, 0.26], size_end: 0, color: '#9fc4ff', color_end: '#b25cff00', blend: 'additive', shape: 'glow',
    intensity: 3, turbulence: 3.5,
    light: { color: '#8aa8ff', intensity: 3, range: 4, seconds: 0, flicker: 0.15 },
  },

  /** A gun's flash: a bright star along `direction`, a few fast sparks, a flash of light and a wisp of smoke. */
  muzzle_flash: {
    burst: 3, max: 6, lifetime: [0.04, 0.07], speed: [6, 10], spread: 6, size: [0.25, 0.4], size_end: 0.5,
    color: '#fff0c0', color_end: '#ff902000', blend: 'additive', shape: 'glow', facing: 'velocity', stretch: 0.03,
    intensity: 6, direction: 0, soft: 0,
    light: { color: '#ffc77a', intensity: 12, range: 5, seconds: 0.06 },
    children: [
      {
        effect: {
          burst: 1, max: 1, lifetime: 0.05, speed: 0, size: 0.45, size_end: 0.6, color: '#fff6d8', color_end: '#ffb04000',
          blend: 'additive', shape: 'glow', intensity: 8, soft: 0,
        },
      },
      {
        effect: {
          burst: 4, max: 8, lifetime: [0.4, 0.8], speed: [0.4, 1.2], spread: 25, direction: 0, gravity: 0.4, drag: 2,
          size: [0.12, 0.2], size_end: 0.6, color: '#c8c4bf60', color_end: '#c8c4bf00', flipbook: 'smoke', angle: [0, 360], lit: true,
        },
        delay: 0.03,
      },
    ],
  },

  /** A bullet or blow hitting a surface: a puff of debris dust, a few sparks, along `direction` (the surface normal). */
  impact: {
    burst: 6, max: 12, lifetime: [0.4, 0.8], speed: [0.8, 2.6], spread: 70, gravity: -1.5, drag: 2.5,
    size: [0.15, 0.3], size_end: 0.7, color: '#8f8578c0', color_end: '#8f857800', flipbook: 'smoke', angle: [0, 360], lit: true,
    children: [
      {
        effect: {
          burst: 10, max: 20, lifetime: [0.12, 0.35], speed: [2.5, 7], spread: 80, gravity: -9, drag: 1,
          size: 0.04, size_end: 0.015, color: '#ffe6a8', color_end: '#ff702000', blend: 'additive', shape: 'glow',
          facing: 'velocity', stretch: 0.03, intensity: 4, soft: 0,
        },
      },
      {
        effect: {
          burst: 8, max: 16, lifetime: [0.4, 0.9], speed: [1.5, 4.5], spread: 75, gravity: -9.8, size: [0.03, 0.07],
          color: '#3b3632', shape: 'square', spin: [-700, 700], angle: [0, 360], soft: 0,
        },
      },
    ],
  },

  /** Ground dust kicked up and hanging low: footsteps, wheels, landings. */
  dust: {
    rate: 12, max: 60, lifetime: [0.8, 1.6], speed: [0.3, 1], spread: 120, radius: 0.3, gravity: 0.15, drag: 1.5,
    size: [0.3, 0.6], size_end: 1.2, color: '#a89272a0', color_end: '#a8927200', flipbook: 'smoke', angle: [0, 360], lit: true,
    fade_in: 0.2,
  },

  /** A pickup's twinkle: glints drifting up and winking out. */
  sparkle: {
    burst: 18, max: 40, lifetime: [0.4, 0.9], speed: [0.6, 2], spread: 360, gravity: 0.5, drag: 1.2,
    size: [0.1, 0.2], size_end: 0, color: '#fffbd0', color_end: '#ffd84000', blend: 'additive', shape: 'glow',
    intensity: 4, spin: [-170, 170],
    light: { color: '#fff0b0', intensity: 2, range: 3, seconds: 0.3 },
  },
};
