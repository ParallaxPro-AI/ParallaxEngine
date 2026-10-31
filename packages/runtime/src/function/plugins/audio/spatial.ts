/**
 * Positional sound: how loud and how far left/right a sound at a world point is for the
 * listener (the active camera). Computed by the engine, so it is deterministic and the
 * same in a playtest recording as in the browser.
 *
 *   attenuation  1 within `near`; then near / distance (inverse distance, like real
 *                sound), faded linearly to 0 over the last quarter before `far`; 0 beyond.
 *   pan          the sound's offset along the listener's right vector over its distance
 *                (the sine of the angle off straight ahead), scaled by PAN_WIDTH; within
 *                `near` it eases in, so a sound on top of the listener is centered.
 *
 * 2D games measure in the x/y plane (the camera's z is its distance from the board, not
 * a distance the sound travels); 3D games in full 3D.
 */

import { Vec3 } from '../../../core/index.js';
import type { Quat } from '../../../core/index.js';
import type { AudioListener, AudioPosition } from '../../../core/index.js';

/** Pan never goes fully to one ear: a hard-panned sound is unpleasant on headphones. */
const PAN_WIDTH = 0.8;

export interface SpatialOptions {
  /** Meters within which a positional sound plays at full volume. */
  readonly near: number;
  /** Meters beyond which it is silent. */
  readonly far: number;
}

/** A 2D screen shows ~20 m: everything on it is audible; sounds pan across its width. */
export const SPATIAL_2D: SpatialOptions = { near: 10, far: 40 };
/** 3D: full volume within arm's reach of the camera rig, silent past a city block. */
export const SPATIAL_3D: SpatialOptions = { near: 3, far: 80 };

export interface Spatialized {
  readonly attenuation: number;
  readonly pan: number;
}

export const CENTERED: Spatialized = { attenuation: 1, pan: 0 };

export function position(v: Vec3): AudioPosition {
  return [v.x, v.y, v.z];
}

export function spatialize(
  at: Vec3, listener: AudioListener | null, mode: '2d' | '3d', options: SpatialOptions,
): Spatialized {
  if (listener === null) return CENTERED;
  const [lx, ly, lz] = listener.position;
  const dx = at.x - lx;
  const dy = at.y - ly;
  const dz = mode === '2d' ? 0 : at.z - lz;
  const distance = Math.hypot(dx, dy, dz);
  const { near, far } = options;
  let attenuation = distance <= near ? 1 : near / distance;
  const fadeFrom = far * 0.75;
  if (distance >= far) attenuation = 0;
  else if (distance > fadeFrom) attenuation *= (far - distance) / (far - fadeFrom);

  const [rx, ry, rz] = listener.right;
  const lateral = dx * rx + dy * ry + (mode === '2d' ? 0 : dz * rz);
  const pan = Math.max(-1, Math.min(1, lateral / Math.max(distance, near))) * PAN_WIDTH;
  return { attenuation: round(attenuation), pan: round(pan) };
}

/** Six decimals: stable across platforms' last-bit float differences in recordings. */
function round(x: number): number {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** A listener at a transform: its world position and its right, forward (+z) and up axes. */
export function listenerAt(worldPosition: Vec3, rotation: Quat): AudioListener {
  const axis = (v: Vec3): AudioPosition => position(rotation.rotate(v).normalized());
  return { position: position(worldPosition), right: axis(Vec3.RIGHT), forward: axis(Vec3.FORWARD), up: axis(Vec3.UP) };
}
