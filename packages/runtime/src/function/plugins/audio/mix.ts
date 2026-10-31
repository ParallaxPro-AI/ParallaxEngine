/**
 * The mix around the listener — data components the audio plugin defines, and the pure
 * math that turns them into `AudioMix` and per-voice parameters. All deterministic: the
 * engine decides, the output only renders.
 *
 *   audio_listener  on the camera (or any entity: then that entity is the listener):
 *                   panning (stereo | hrtf), Doppler scale, occlusion on/off, ducking
 *   reverb_zone     a sphere of reverb: the listener inside `radius` hears `preset` at
 *                   `mix`, faded in over the outer `blend` meters; overlapping zones: the
 *                   strongest wins (then the higher `priority`, then the older entity)
 *
 * Doppler. A voice's pitch is scaled by (c + v_listener) / (c − v_source), each speed
 * measured along the line between them (toward the other positive) from how far each moved
 * this frame, c = 343 m/s, clamped to 0.5..2 and blended by the listener's `doppler`.
 * Rounded to 1/200 so a steady speed sends no updates.
 *
 * Occlusion. With `occlusion` on and the physics3d service present (3D), a ray from the
 * listener to each positional voice: a solid hit before the sound means occluded (1),
 * otherwise 0. Hits within `OCCLUDER_SKIP` meters of the listener are stepped over once (a
 * third-person camera's own player is not a wall). Entity voices re-test every
 * `OCCLUSION_EVERY` frames, staggered by voice number.
 */

import { Vec3 } from '../../../core/index.js';
import type { AudioMix, AudioPosition, EntityId, ReverbPreset } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { ComponentDef, Fields, Schema } from '../../kernel/index.js';
import type { Physics3dService } from '../../services/index.js';

export const AUDIO_LISTENER = 'audio_listener';
export const REVERB_ZONE = 'reverb_zone';

export const REVERB_PRESETS: readonly ReverbPreset[] = ['room', 'hall', 'cave', 'arena', 'forest', 'underwater'];

export const AUDIO_LISTENER_SCHEMA: Schema = {
  panning: t.enum(['stereo', 'hrtf'], { default: 'stereo' }),
  /** 0 = no Doppler, 1 = physical. */
  doppler: t.number({ default: 1, min: 0, max: 2 }),
  occlusion: t.bool({ default: false }),
  /** The music's level while a `duck=True` sound plays. */
  duck_level: t.number({ default: 0.35, min: 0, max: 1 }),
  duck_release: t.number({ default: 0.6, min: 0 }),
};

export const REVERB_ZONE_SCHEMA: Schema = {
  preset: t.enum(REVERB_PRESETS, { default: 'room' }),
  /** Wet level at the zone's heart, 0..1. */
  mix: t.number({ default: 0.5, min: 0, max: 1 }),
  radius: t.number({ default: 10, min: 0 }),
  /** Meters inside the edge over which the reverb fades in. */
  blend: t.number({ default: 3, min: 0 }),
  priority: t.int({ default: 0 }),
};

export const MIX_COMPONENTS: readonly ComponentDef[] = [
  { id: AUDIO_LISTENER, schema: AUDIO_LISTENER_SCHEMA },
  { id: REVERB_ZONE, schema: REVERB_ZONE_SCHEMA },
];

/** The mix with no listener component and no zone: what every game had before (sent only when it changes). */
export const NEUTRAL_MIX: AudioMix = { kind: 'mix', reverb: null, panning: 'stereo', duckLevel: 0.35, duckRelease: 0.6 };

const SPEED_OF_SOUND = 343;
export const OCCLUSION_EVERY = 4;
export const OCCLUDER_SKIP = 2.5;

export interface ListenerSettings {
  readonly panning: 'stereo' | 'hrtf';
  readonly doppler: number;
  readonly occlusion: boolean;
  readonly duckLevel: number;
  readonly duckRelease: number;
}

/** No listener component: plain stereo, no Doppler, no occlusion. */
export const DEFAULT_LISTENER: ListenerSettings = { panning: 'stereo', doppler: 0, occlusion: false, duckLevel: 0.35, duckRelease: 0.6 };

export function listenerSettings(fields: Fields | undefined): ListenerSettings {
  if (fields === undefined) return DEFAULT_LISTENER;
  return {
    panning: fields['panning'] === 'hrtf' ? 'hrtf' : 'stereo',
    doppler: fields['doppler'] as number,
    occlusion: fields['occlusion'] === true,
    duckLevel: fields['duck_level'] as number,
    duckRelease: fields['duck_release'] as number,
  };
}

export interface Zone {
  readonly id: EntityId;
  readonly at: Vec3;
  readonly fields: Fields;
}

/** The reverb the listener hears at `at`, or null outside every zone. */
export function reverbAt(at: Vec3, zones: readonly Zone[]): AudioMix['reverb'] {
  let best: { wet: number; priority: number; id: EntityId; preset: ReverbPreset } | null = null;
  for (const zone of zones) {
    const radius = zone.fields['radius'] as number;
    const blend = zone.fields['blend'] as number;
    const distance = at.distance_to(zone.at);
    if (distance >= radius) continue;
    const depth = radius - distance;
    const weight = blend <= 0 ? 1 : Math.min(1, depth / blend);
    const wet = round(weight * (zone.fields['mix'] as number), 1e3);
    const priority = zone.fields['priority'] as number;
    const better = best === null || wet > best.wet || (wet === best.wet && (priority > best.priority || (priority === best.priority && zone.id < best.id)));
    if (better) best = { wet, priority, id: zone.id, preset: zone.fields['preset'] as ReverbPreset };
  }
  return best === null || best.wet <= 0 ? null : { preset: best.preset, wet: best.wet };
}

/** Doppler pitch factor for a source and listener that moved from `*Before` to now over `dt` seconds. */
export function dopplerFactor(
  source: Vec3, sourceBefore: Vec3, listener: Vec3, listenerBefore: Vec3, dt: number, scale: number,
): number {
  if (scale <= 0 || dt <= 0) return 1;
  const line = listener.__sub__(source);
  const distance = line.length();
  if (distance < 1e-6) return 1;
  const toListener = line.__truediv__(distance);
  // Speeds along the line: the source toward the listener, the listener toward the source.
  const vSource = source.__sub__(sourceBefore).dot(toListener) / dt;
  const vListener = -listener.__sub__(listenerBefore).dot(toListener) / dt;
  const physical = (SPEED_OF_SOUND + clamp(vListener, -SPEED_OF_SOUND / 2, SPEED_OF_SOUND / 2))
    / (SPEED_OF_SOUND - clamp(vSource, -SPEED_OF_SOUND / 2, SPEED_OF_SOUND / 2));
  return round(clamp(1 + (physical - 1) * scale, 0.5, 2), 200);
}

/** 1 when solid geometry stands between the listener and the sound, else 0. */
export function occlusionBetween(
  physics: Physics3dService, listener: Vec3, sound: Vec3, ignore: readonly EntityId[],
): number {
  const line = sound.__sub__(listener);
  const distance = line.length();
  if (distance < 0.5) return 0;
  const direction = line.__truediv__(distance);
  let from = listener;
  let reach = distance;
  for (let attempt = 0; attempt < 2; attempt++) {
    const hit = physics.raycast(from, direction, Math.max(0, reach - 0.25), { ignore });
    if (hit === undefined) return 0;
    const travelled = distance - reach + hit.distance;
    if (attempt === 0 && travelled < OCCLUDER_SKIP) {
      from = hit.point.__add__(direction.__mul__(0.05));
      reach = distance - travelled - 0.05;
      continue;
    }
    return 1;
  }
  return 0;
}

export function tuple(v: Vec3): AudioPosition {
  return [v.x, v.y, v.z];
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function round(x: number, steps: number): number {
  const r = Math.round(x * steps) / steps;
  return Object.is(r, -0) ? 0 : r;
}
