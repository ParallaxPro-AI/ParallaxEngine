/**
 * The scene's `"wind"` block, and the wind field as a function of position and game time.
 *
 *   "wind": {
 *     "direction": 45,          degrees the wind blows toward, clockwise from +z (90: +x); or [x, z]
 *     "speed": 4,               m/s (default 3)
 *     "gusts": 0.4,             0..1 (default 0.3)
 *     "scale": 40,              meters across one gust (default 40)
 *     "period": 6,              seconds between gusts at one spot (default 6)
 *     "streaks": true,          drifting air streaks near the camera (default false)
 *     "debris": 24              leaves blown past the camera (default 0)
 *   }
 *
 * The field: mean velocity d·s, times 1 + gusts·(0.65·g + 0.35·p) (clamped at 0), plus a
 * crosswind of 0.3·gusts·s·c — g a gust front moving downwind at the mean speed, p a pulse
 * in time, c a slow sideways wander, all value noise (core ground_math, deterministic).
 */

import { closestMatch, cosDegrees, fail, mixSeed, valueNoise2 } from '../../../core/index.js';
import type { Json, JsonObject, SceneDoc } from '../../../resource/index.js';
import type { WindSettings } from '../../services/index.js';

export const CALM: WindSettings = { dirX: 0, dirZ: 1, speed: 0, gusts: 0, scale: 40, period: 6, streaks: false, debris: 0 };

const KEYS = ['direction', 'speed', 'gusts', 'scale', 'period', 'streaks', 'debris'] as const;
const SEED = 0x51e7;

/** A compass bearing (clockwise from +z) as a unit [x, z]. */
export function bearing(degrees: number): [number, number] {
  return [cosDegrees(90 - degrees), cosDegrees(degrees)];
}

function bad(scene: SceneDoc, pointer: string, message: string, fix: string): never {
  return fail('PP3236', `Scene "${scene.id}" wind: ${message}`, { fix, path: scene.path, pointer: `/wind${pointer}` });
}

export function readWindSpec(scene: SceneDoc): WindSettings {
  const block = scene.plugins['wind'] as JsonObject | undefined;
  if (block === undefined) return CALM;
  for (const key of Object.keys(block)) {
    if ((KEYS as readonly string[]).includes(key)) continue;
    const guess = closestMatch(key, KEYS);
    bad(scene, `/${key}`, `unknown key "${key}"`, guess === undefined ? `Wind keys: ${KEYS.join(', ')}.` : `Did you mean "${guess}"?`);
  }
  const num = (key: string, fallback: number, ok: (n: number) => boolean, rule: string): number => {
    const v: Json | undefined = block[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) bad(scene, `/${key}`, `${key} must be a number that ${rule}`, `Change "${key}".`);
    return v;
  };
  let dir: [number, number] = [0, 1];
  const d = block['direction'];
  if (typeof d === 'number' && Number.isFinite(d)) dir = bearing(d);
  else if (Array.isArray(d) && d.length === 2 && d.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    const [x, z] = d as number[];
    const l = Math.sqrt(x! * x! + z! * z!);
    if (!(l > 0)) bad(scene, '/direction', 'direction is [0, 0]', 'Give a non-zero [x, z], or a bearing in degrees.');
    dir = [x! / l, z! / l];
  } else if (d !== undefined) bad(scene, '/direction', 'direction must be degrees or [x, z]', 'Write "direction": 90 (toward +x).');
  const streaks = block['streaks'] ?? false;
  if (typeof streaks !== 'boolean') bad(scene, '/streaks', 'streaks must be true or false', 'Write true or false.');
  const debris = num('debris', 0, (n) => Number.isInteger(n) && n >= 0 && n <= 256, 'is a whole number from 0 to 256');
  return {
    dirX: dir[0], dirZ: dir[1],
    speed: num('speed', 3, (n) => n >= 0, "isn't negative"),
    gusts: num('gusts', 0.3, (n) => n >= 0 && n <= 1, 'is from 0 to 1'),
    scale: num('scale', 40, (n) => n > 0, 'is above 0'),
    period: num('period', 6, (n) => n > 0, 'is above 0'),
    streaks: streaks as boolean,
    debris,
  };
}

/** Wind velocity at (x, z) at game time `t` under `s`, into `out` as [x, z]. */
export function windAt(s: WindSettings, x: number, z: number, t: number, out: Float64Array): Float64Array {
  if (s.speed === 0) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const along = x * s.dirX + z * s.dirZ;
  const across = -x * s.dirZ + z * s.dirX;
  const front = valueNoise2((along - s.speed * t) / s.scale, across / s.scale, SEED) * 2 - 1;
  const pulse = valueNoise2(t / s.period, (along + across) / (s.scale * 4), mixSeed(SEED, 1)) * 2 - 1;
  const wander = valueNoise2(t / (s.period * 3), across / (s.scale * 2), mixSeed(SEED, 2)) * 2 - 1;
  let factor = 1 + s.gusts * (0.65 * front + 0.35 * pulse);
  if (factor < 0) factor = 0;
  const side = 0.3 * s.gusts * wander;
  out[0] = s.speed * (s.dirX * factor - s.dirZ * side);
  out[1] = s.speed * (s.dirZ * factor + s.dirX * side);
  return out;
}

/** Settings eased from `a` to `b` by `k` in 0..1 (direction re-normalized). */
export function blendSettings(a: WindSettings, b: WindSettings, k: number): WindSettings {
  if (k >= 1) return b;
  const x = a.dirX + (b.dirX - a.dirX) * k;
  const z = a.dirZ + (b.dirZ - a.dirZ) * k;
  const l = Math.sqrt(x * x + z * z);
  return {
    ...b,
    dirX: l > 1e-9 ? x / l : b.dirX,
    dirZ: l > 1e-9 ? z / l : b.dirZ,
    speed: a.speed + (b.speed - a.speed) * k,
    gusts: a.gusts + (b.gusts - a.gusts) * k,
  };
}
