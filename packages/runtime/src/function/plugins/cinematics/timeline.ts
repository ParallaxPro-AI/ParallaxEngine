/**
 * A cinematic document (content/cinematic/<id>.json) and how its tracks sample. The same
 * parser runs in the game and in `parallax check`, so a document that checks clean plays.
 *
 *     {
 *       "duration": 6,              // seconds; absent or null: the last key's time
 *       "skippable": true,          // the skip action may end it (code's skip() always can)
 *       "scenes": ["harbor"],       // plays by itself when one of these scenes loads
 *       "bind": ["hero"],           // names play(bind={...}) must give (a trigger gives "activator")
 *       "tracks": [
 *         {"type": "camera", "camera": "cam", "keys": [
 *           {"t": 0, "position": [0, 8, 14], "look_at": "hero", "fov": 55},
 *           {"t": 3, "position": [0, 2, 4], "relative_to": "hero", "look_at": "hero", "ease": "in_out_cubic"},
 *           {"t": 4, "position": [6, 3, 0], "rotation": [10, -90, 0], "cut": true}]},
 *         {"type": "transform", "target": "gate", "keys": [{"t": 2, "position": [0, 4, 0]}]},
 *         {"type": "visibility", "target": "ghost", "keys": [{"t": 1, "visible": false}]},
 *         {"type": "property", "target": "lamp", "field": "light.intensity", "restore": true,
 *          "keys": [{"t": 0, "value": 0}, {"t": 2, "value": 5}]},
 *         {"type": "event", "keys": [{"t": 2.5, "name": "gate_open"}]},
 *         {"type": "animation", "target": "hero", "keys": [{"t": 0, "clip": "wave", "loop": false}]},
 *         {"type": "audio", "keys": [{"t": 0, "music": "assets/music/boss.ogg"}, {"t": 2.5, "sound": "assets/sfx/gate.ogg", "at": "gate"}]},
 *         {"type": "letterbox", "keys": [{"t": 0, "amount": 0}, {"t": 0.5, "amount": 1}]},
 *         {"type": "grade", "post": {"preset": "noir"}, "keys": [{"t": 0, "weight": 0}, {"t": 1, "weight": 1}]},
 *         {"type": "time_scale", "keys": [{"t": 2.4, "value": 0.2}, {"t": 3, "value": 1}]},
 *         {"type": "shake", "keys": [{"t": 2.5, "intensity": 0.6, "seconds": 0.5}]},
 *         {"type": "focus", "keys": [{"t": 0, "distance": 14, "range": 4, "blur": 6}, {"t": 3, "distance": 4}]},
 *         {"type": "subtitle", "keys": [{"t": 0.5, "text": "The harbor, at dawn.", "seconds": 2}]},
 *         {"type": "spawn", "keys": [{"t": 1, "prefab": "gull", "position": [2, 6, 0], "name": "gull"}, {"t": 4, "despawn": "gull"}]},
 *         {"type": "vfx", "keys": [{"t": 2.5, "effect": "assets/vfx/dust.vfx.json", "at": "gate"}]},
 *         {"type": "dialogue", "keys": [{"t": 3, "speaker": "Hero", "text": "It's open."}]}]
 *     }
 *
 * Targets are names: a `bind` name, else the placed id of an entity in the running scene
 * (`camera` absent: the camera seat 0 is looking through — the cameras service — else the first camera in the world). Times are seconds, `t >= 0`, in
 * ascending order within a track, at most `duration`.
 *
 * Channels. Each animated value (a camera's position, orientation and fov; a transform's
 * position, rotation and scale; a property; visibility; letterbox amount, grade weight,
 * time scale, focus distance/range/blur) samples over the keys that give it, from an
 * implicit key at t = 0 holding the value the target had when the cinematic started (unless
 * a key sits at 0). Between two keys the later key's `ease` (default "in_out_quad") shapes
 * the blend; a key with `"cut": true` holds the earlier value until its time, then snaps (a
 * shot change). After the last key the value holds. Visibility, bool and text properties
 * always step.
 *
 * Triggers fire once, as playback reaches their key: event (markers), animation, audio,
 * shake, spawn, vfx. Several keys of these may share a time.
 *
 * Camera keys: `position` (world, or an offset from `relative_to`'s world position, read
 * every frame — following a moving entity); orientation from `look_at` (a point, or a
 * target whose world position is read every frame) or `rotation` (Euler degrees); `fov`.
 * Transform keys set the target's local `position`, `rotation` (Euler degrees) and `scale`
 * (a number or [x, y, z]). Property keys give `value` in the field's data form (a number,
 * true/false, "#rrggbb", [x, y, z]); `field` is "<component>.<field>".
 *
 * Presentation tracks (one of each per cinematic), always put back when it ends:
 *   letterbox   `amount` 0 (none) .. 1 (full cinematic bars); starts at 0.
 *   grade       `post` is a scene "post" block (a preset and/or fields), blended over the
 *               scene's look by `weight` 0..1; starts at 0.
 *   time_scale  `value` (>= 0) is the game's time scale (slow motion, freeze frames); while
 *               the track plays, the cinematic itself runs on real time. Starts at the
 *               game's scale.
 *   focus       depth of field on the directed camera (`camera`, else the camera track's,
 *               else seat 0's): `distance` (meters in sharp focus), `range` (meters from it
 *               where blur reaches the most), `blur` (that most, pixels at 1080p). Starts
 *               from the camera's DepthOfField, or {range 4, blur 6} at the first distance.
 *   subtitle    `text` shown from its key for `seconds` (default: until the next key, at
 *               most 3 s).
 *   dialogue    a spoken line (`text`, `speaker`, `portrait` image). It waits for the player
 *               to advance (the plugin's `advance` button, the panel's Continue, or
 *               `ctx.cinematics.advance()`) unless `"wait": false`; an auto line clears
 *               after `seconds` (default: at the next line).
 * Triggers:
 *   animation   `clip` on the target's Animator (`loop`, default true; `fade`, `speed`), or
 *               its Sprite's animation of that name.
 *   audio       `sound` (one-shot; `at` a point or name, `volume`, `pitch`, `duck`) or
 *               `music` (the scene music override, null: back to the scene's; `fade`).
 *   shake       `intensity` (default 0.3) for `seconds` (default 0.4) on the directed camera.
 *   spawn       `prefab` at `position` / `rotation` (Euler degrees), optionally `name`d so a
 *               later key can `despawn` it; or `despawn` a name (a target or a spawned name).
 *               What it spawns is removed when the cinematic ends unless the key `keep`s it.
 *   vfx         a one-shot `effect` (assets/vfx/*.vfx.json) `at` a point or name, with
 *               `color`, `scale`, `direction`.
 *
 * `restore` (transform, visibility, property): put the starting values back when the
 * cinematic ends. Otherwise its end state stays — it is ordinary component data, saved
 * with the game. The camera is always handed back.
 */

import { COLOR_FORMS, diagnostic, parseColor, Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { Color } from '../../../core/index.js';
import type { Diagnostic } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { POST_PRESET_NAMES } from '../../services/index.js';
import { DEFAULT_EASE, ease, EASES, EASE_NAMES } from './easing.js';

export const CINEMATIC = 'cinematic';
export const TRACK_TYPES = [
  'camera', 'transform', 'visibility', 'property', 'event', 'animation', 'audio', 'letterbox', 'grade', 'time_scale', 'shake',
  'focus', 'subtitle', 'spawn', 'vfx', 'dialogue',
] as const;
export type TrackType = (typeof TRACK_TYPES)[number];

/** Tracks a cinematic has at most one of: each drives one thing for the whole cinematic. */
export const SINGLE_TRACKS: readonly TrackType[] = ['camera', 'letterbox', 'grade', 'time_scale', 'focus', 'subtitle', 'dialogue'];

/** Kinds whose keys blend (`ease`, `cut`). */
const EASED: ReadonlySet<TrackType> = new Set(['camera', 'transform', 'property', 'letterbox', 'grade', 'time_scale', 'focus']);
/** Trigger kinds whose keys may share a time. */
const SAME_TIME: ReadonlySet<TrackType> = new Set(['event', 'audio', 'shake', 'spawn', 'vfx']);

/** Floats summed frame by frame: a key "at 2 s" is reached by the frame landing on 1.9999…. */
export const DUE = 1e-9;

/** A subtitle (or auto dialogue line) without `seconds` shows until the next key, at most this long. */
export const SUBTITLE_SECONDS = 3;

export interface KeyTiming {
  readonly t: number;
  readonly ease: string;
  readonly cut: boolean;
}

/** A point, or a target name read every frame. */
export type Aim = { readonly point: Vec3 } | { readonly target: string };

export interface CameraKey extends KeyTiming {
  readonly position?: Vec3;
  readonly relativeTo?: string;
  readonly lookAt?: Aim;
  readonly rotation?: Vec3;
  readonly fov?: number;
}

export interface TransformKey extends KeyTiming {
  readonly position?: Vec3;
  readonly rotation?: Vec3;
  readonly scale?: Vec3;
}

export interface ValueKey extends KeyTiming {
  /** The field's data form; decoded against the field's type when the cinematic binds. */
  readonly value: Json;
}

/** letterbox `amount`, grade `weight`, time_scale `value`. */
export interface ScalarKey extends KeyTiming {
  readonly value: number;
}

export interface FocusKey extends KeyTiming {
  readonly distance?: number;
  readonly range?: number;
  readonly blur?: number;
}

export interface VisibleKey {
  readonly t: number;
  readonly visible: boolean;
}

export interface MarkerKey {
  readonly t: number;
  readonly name: string;
}

export interface AnimationKey {
  readonly t: number;
  readonly clip: string;
  readonly loop: boolean;
  readonly fade?: number;
  readonly speed: number;
}

export type AudioKey =
  | {
    readonly t: number; readonly kind: 'sound'; readonly sound: string; readonly at: Aim | null;
    readonly volume: number; readonly pitch: number; readonly duck: boolean;
  }
  | { readonly t: number; readonly kind: 'music'; readonly music: string | null; readonly fade: number };

export interface ShakeKey {
  readonly t: number;
  readonly intensity: number;
  readonly seconds: number;
}

export interface SubtitleKey {
  readonly t: number;
  readonly text: string;
  readonly seconds: number | null;
}

export type SpawnKey =
  | {
    readonly t: number; readonly kind: 'spawn'; readonly prefab: string; readonly name: string | null;
    readonly position: Vec3 | null; readonly rotation: Vec3 | null; readonly keep: boolean;
  }
  | { readonly t: number; readonly kind: 'despawn'; readonly despawn: string };

export interface VfxKey {
  readonly t: number;
  readonly effect: string;
  readonly at: Aim;
  readonly color: Color | null;
  readonly scale: number;
  readonly direction: Vec3 | null;
}

export interface DialogueKey {
  readonly t: number;
  readonly text: string;
  readonly speaker: string | null;
  readonly portrait: string | null;
  readonly wait: boolean;
  readonly seconds: number | null;
}

export type Track =
  | { readonly type: 'camera'; readonly camera: string | null; readonly keys: readonly CameraKey[] }
  | { readonly type: 'transform'; readonly target: string; readonly restore: boolean; readonly keys: readonly TransformKey[] }
  | { readonly type: 'visibility'; readonly target: string; readonly restore: boolean; readonly keys: readonly VisibleKey[] }
  | {
    readonly type: 'property'; readonly target: string; readonly restore: boolean;
    readonly component: string; readonly field: string; readonly keys: readonly ValueKey[];
  }
  | { readonly type: 'event'; readonly keys: readonly MarkerKey[] }
  | { readonly type: 'animation'; readonly target: string; readonly keys: readonly AnimationKey[] }
  | { readonly type: 'audio'; readonly keys: readonly AudioKey[] }
  | { readonly type: 'letterbox'; readonly keys: readonly ScalarKey[] }
  | { readonly type: 'grade'; readonly post: JsonObject; readonly keys: readonly ScalarKey[] }
  | { readonly type: 'time_scale'; readonly keys: readonly ScalarKey[] }
  | { readonly type: 'shake'; readonly camera: string | null; readonly keys: readonly ShakeKey[] }
  | { readonly type: 'focus'; readonly camera: string | null; readonly keys: readonly FocusKey[] }
  | { readonly type: 'subtitle'; readonly keys: readonly SubtitleKey[] }
  | { readonly type: 'spawn'; readonly keys: readonly SpawnKey[] }
  | { readonly type: 'vfx'; readonly keys: readonly VfxKey[] }
  | { readonly type: 'dialogue'; readonly keys: readonly DialogueKey[] };

export interface Cinematic {
  readonly id: string;
  readonly duration: number;
  readonly skippable: boolean;
  readonly scenes: readonly string[];
  readonly bind: readonly string[];
  readonly tracks: readonly Track[];
}

export interface ParseResult {
  readonly cinematic: Cinematic | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

const TOP_KEYS = ['duration', 'skippable', 'scenes', 'bind', 'tracks'];
const TRACK_KEYS: Readonly<Record<TrackType, readonly string[]>> = {
  camera: ['type', 'camera', 'keys'],
  transform: ['type', 'target', 'restore', 'keys'],
  visibility: ['type', 'target', 'restore', 'keys'],
  property: ['type', 'target', 'field', 'restore', 'keys'],
  event: ['type', 'keys'],
  animation: ['type', 'target', 'keys'],
  audio: ['type', 'keys'],
  letterbox: ['type', 'keys'],
  grade: ['type', 'post', 'keys'],
  time_scale: ['type', 'keys'],
  shake: ['type', 'camera', 'keys'],
  focus: ['type', 'camera', 'keys'],
  subtitle: ['type', 'keys'],
  spawn: ['type', 'keys'],
  vfx: ['type', 'keys'],
  dialogue: ['type', 'keys'],
};
const KEY_KEYS: Readonly<Record<TrackType, readonly string[]>> = {
  camera: ['t', 'ease', 'cut', 'position', 'relative_to', 'look_at', 'rotation', 'fov'],
  transform: ['t', 'ease', 'cut', 'position', 'rotation', 'scale'],
  visibility: ['t', 'visible'],
  property: ['t', 'ease', 'cut', 'value'],
  event: ['t', 'name'],
  animation: ['t', 'clip', 'loop', 'fade', 'speed'],
  audio: ['t', 'sound', 'at', 'volume', 'pitch', 'duck', 'music', 'fade'],
  letterbox: ['t', 'ease', 'cut', 'amount'],
  grade: ['t', 'ease', 'cut', 'weight'],
  time_scale: ['t', 'ease', 'cut', 'value'],
  shake: ['t', 'intensity', 'seconds'],
  focus: ['t', 'ease', 'cut', 'distance', 'range', 'blur'],
  subtitle: ['t', 'text', 'seconds'],
  spawn: ['t', 'prefab', 'name', 'position', 'rotation', 'keep', 'despawn'],
  vfx: ['t', 'effect', 'at', 'color', 'scale', 'direction'],
  dialogue: ['t', 'text', 'speaker', 'portrait', 'wait', 'seconds'],
};

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pointer(...parts: (string | number)[]): string {
  return parts.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

function vec3(v: unknown): Vec3 | undefined {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return new Vec3(v[0] as number, v[1] as number, v[2] as number);
}

/** Any authored colour form (parseColor). */
function color(v: unknown): Color | undefined {
  return parseColor(v) ?? undefined;
}

/** The time a track's last key holds through: its last key, or a subtitle's (auto line's) end. */
function trackEnd(track: Track): number {
  let end = 0;
  for (const k of track.keys) end = Math.max(end, k.t);
  if (track.type === 'subtitle') {
    const last = track.keys[track.keys.length - 1];
    if (last !== undefined) end = Math.max(end, last.t + (last.seconds ?? SUBTITLE_SECONDS));
  } else if (track.type === 'dialogue') {
    const last = track.keys[track.keys.length - 1];
    if (last !== undefined && !last.wait) end = Math.max(end, last.t + (last.seconds ?? SUBTITLE_SECONDS));
  }
  return end;
}

/** Parse one content entry's values. Every problem is reported (PP7200–PP7205), not just the first. */
export function parseCinematic(id: string, values: unknown, path?: string): ParseResult {
  const out: Diagnostic[] = [];
  const at = (code: `PP${number}`, message: string, ptr: string, fix?: string): void => {
    out.push(diagnostic(code, `Cinematic "${id}": ${message}`, { ...(path !== undefined && { path }), pointer: ptr, ...(fix !== undefined && { fix }) }));
  };
  if (!isObject(values)) {
    at('PP7200', 'must be an object', '', 'Write {"tracks": [...]}.');
    return { cinematic: undefined, diagnostics: out };
  }
  for (const key of Object.keys(values)) {
    if (!TOP_KEYS.includes(key)) at('PP7200', `unknown key "${key}"`, pointer(key), `Keys: ${TOP_KEYS.join(', ')}.`);
  }
  const duration = values['duration'];
  if (duration !== undefined && duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)) {
    at('PP7200', '"duration" must be a number of seconds (>= 0) or null', pointer('duration'));
  }
  const skippable = values['skippable'] ?? true;
  if (typeof skippable !== 'boolean') at('PP7200', '"skippable" must be true or false', pointer('skippable'));
  const names = (key: string): string[] => {
    const list = values[key] ?? [];
    if (!Array.isArray(list) || !list.every((s) => typeof s === 'string' && s.length > 0)) {
      at('PP7200', `"${key}" must be a list of names`, pointer(key));
      return [];
    }
    const seen = new Set<string>();
    for (const [i, s] of (list as string[]).entries()) {
      if (seen.has(s)) at('PP7200', `"${key}" lists "${s}" twice`, pointer(key, i));
      seen.add(s);
    }
    return list as string[];
  };
  const scenes = names('scenes');
  const bind = names('bind');
  const rawTracks = values['tracks'] ?? [];
  const tracks: Track[] = [];
  if (!Array.isArray(rawTracks)) {
    at('PP7201', '"tracks" must be a list', pointer('tracks'));
  } else {
    rawTracks.forEach((raw, i) => {
      const track = parseTrack(raw, (code, message, ptr, fix) => at(code, message, pointer('tracks', i) + ptr, fix));
      if (track !== undefined) tracks.push(track);
    });
  }
  for (const kind of SINGLE_TRACKS) {
    const count = tracks.filter((t) => t.type === kind).length;
    if (count <= 1) continue;
    at('PP7201', `has ${count} ${kind} tracks; a cinematic has at most one`, pointer('tracks'), kind === 'camera'
      ? 'Merge them into one track (cut between shots with "cut": true).'
      : `Merge the ${kind} keys into one track.`);
  }
  const last = Math.max(0, ...tracks.flatMap((t) => t.keys.map((k) => k.t)));
  if (typeof duration === 'number' && Number.isFinite(duration) && duration + DUE < last) {
    at('PP7202', `a key at ${last} s is after "duration" (${duration} s)`, pointer('duration'), `Raise "duration" to at least ${last}, or remove it.`);
  }
  if (out.length > 0) return { cinematic: undefined, diagnostics: out };
  return {
    cinematic: {
      id, duration: typeof duration === 'number' ? duration : Math.max(0, ...tracks.map(trackEnd)), skippable: skippable as boolean, scenes, bind, tracks,
    },
    diagnostics: out,
  };
}

type Report = (code: `PP${number}`, message: string, ptr: string, fix?: string) => void;

function parseTrack(raw: unknown, at: Report): Track | undefined {
  if (!isObject(raw)) {
    at('PP7201', 'a track must be an object', '');
    return undefined;
  }
  const type = raw['type'];
  if (typeof type !== 'string' || !(TRACK_TYPES as readonly string[]).includes(type)) {
    at('PP7201', `unknown track type ${JSON.stringify(type ?? null)}`, pointer('type'), `Types: ${TRACK_TYPES.join(', ')}.`);
    return undefined;
  }
  const kind = type as TrackType;
  for (const key of Object.keys(raw)) {
    if (!TRACK_KEYS[kind].includes(key)) at('PP7201', `a ${kind} track has no key "${key}"`, pointer(key), `Keys: ${TRACK_KEYS[kind].join(', ')}.`);
  }
  const name = (key: string, required: boolean): string | null => {
    const v = raw[key];
    if (v === undefined || v === null) {
      if (required) at('PP7201', `a ${kind} track needs "${key}" (a bind name or placed entity id)`, pointer(key));
      return null;
    }
    if (typeof v !== 'string' || v.length === 0) {
      at('PP7201', `"${key}" must be a name`, pointer(key));
      return null;
    }
    return v;
  };
  const restore = raw['restore'] ?? false;
  if (typeof restore !== 'boolean') at('PP7201', '"restore" must be true or false', pointer('restore'));
  const rawKeys = raw['keys'];
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    at('PP7201', `a ${kind} track needs a non-empty "keys" list`, pointer('keys'));
    return undefined;
  }
  let previous = -Infinity;
  const keys: Record<string, unknown>[] = [];
  rawKeys.forEach((k, i) => {
    const kp = pointer('keys', i);
    if (!isObject(k)) {
      at('PP7204', 'a key must be an object', kp);
      return;
    }
    for (const key of Object.keys(k)) {
      if (!KEY_KEYS[kind].includes(key)) at('PP7204', `a ${kind} key has no "${key}"`, kp + pointer(key), `Keys: ${KEY_KEYS[kind].join(', ')}.`);
    }
    const t = k['t'];
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
      at('PP7202', '"t" must be a time in seconds (>= 0)', kp + pointer('t'));
      return;
    }
    if (t < previous || (t === previous && !SAME_TIME.has(kind))) {
      at('PP7202', `keys must be in ascending time order (${t} s comes after ${previous} s)`, kp + pointer('t'), 'Sort the keys by "t"; give each time once.');
    }
    previous = Math.max(previous, t);
    const parsed = parseKey(kind, k, (code, message, ptr, fix) => at(code, message, kp + ptr, fix));
    if (parsed !== undefined) keys.push({ ...parsed, t });
  });
  const targeted = kind === 'transform' || kind === 'visibility' || kind === 'property' || kind === 'animation';
  const target = targeted ? name('target', true) : null;
  switch (kind) {
    case 'property': {
      const field = raw['field'];
      const dot = typeof field === 'string' ? field.indexOf('.') : -1;
      if (typeof field !== 'string' || dot <= 0 || dot === field.length - 1 || field.indexOf('.', dot + 1) >= 0) {
        at('PP7205', `"field" must be "<component>.<field>", got ${JSON.stringify(field ?? null)}`, pointer('field'), 'e.g. "light.intensity".');
        return undefined;
      }
      if (target === null) return undefined;
      return {
        type: 'property', target, restore: restore === true, component: field.slice(0, dot), field: field.slice(dot + 1),
        keys: keys as unknown as ValueKey[],
      };
    }
    case 'camera': return { type: 'camera', camera: name('camera', false), keys: keys as unknown as CameraKey[] };
    case 'transform': return target === null ? undefined : { type: 'transform', target, restore: restore === true, keys: keys as unknown as TransformKey[] };
    case 'visibility': return target === null ? undefined : { type: 'visibility', target, restore: restore === true, keys: keys as unknown as VisibleKey[] };
    case 'animation': return target === null ? undefined : { type: 'animation', target, keys: keys as unknown as AnimationKey[] };
    case 'grade': {
      const post = raw['post'];
      if (!isObject(post)) {
        at('PP7201', 'a grade track needs "post": a scene post block ({"preset": "noir"} and/or fields)', pointer('post'));
        return undefined;
      }
      const preset = post['preset'];
      if (preset !== undefined && preset !== null && !(POST_PRESET_NAMES as readonly string[]).includes(preset as string)) {
        at('PP7201', `unknown post preset ${JSON.stringify(preset)}`, pointer('post', 'preset'), `Presets: ${POST_PRESET_NAMES.join(', ')}.`);
        return undefined;
      }
      if (Object.keys(post).length === 0) {
        at('PP7201', '"post" is empty: name a preset or set fields', pointer('post'));
        return undefined;
      }
      return { type: 'grade', post, keys: keys as unknown as ScalarKey[] };
    }
    case 'shake': return { type: 'shake', camera: name('camera', false), keys: keys as unknown as ShakeKey[] };
    case 'focus': return { type: 'focus', camera: name('camera', false), keys: keys as unknown as FocusKey[] };
    default: return { type: kind, keys } as unknown as Track;
  }
}

function parseKey(kind: TrackType, k: JsonObject, at: Report): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (EASED.has(kind)) {
    const e = k['ease'] ?? DEFAULT_EASE;
    if (typeof e !== 'string' || EASES[e] === undefined) {
      at('PP7203', `unknown ease ${JSON.stringify(e)}`, pointer('ease'), `Eases: ${EASE_NAMES.join(', ')}.`);
    }
    out['ease'] = e;
    const cut = k['cut'] ?? false;
    if (typeof cut !== 'boolean') at('PP7204', '"cut" must be true or false', pointer('cut'));
    out['cut'] = cut === true;
  }
  const v3 = (key: string, label: string): void => {
    if (k[key] === undefined) return;
    const v = vec3(k[key]);
    if (v === undefined) at('PP7204', `"${key}" must be ${label}`, pointer(key));
    else out[key] = v;
  };
  /** A number key: absent → `fallback` (undefined: required); checked against [min, max]. */
  const num = (key: string, fallback: number | undefined, min: number, max = Infinity, label = `a number from ${min}`): number | undefined => {
    const v = k[key];
    if (v === undefined || v === null) {
      if (fallback === undefined) at('PP7204', `a ${kind} key needs "${key}" (${label})`, pointer(key));
      return fallback;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      at('PP7204', `"${key}" must be ${label}`, pointer(key));
      return undefined;
    }
    return v;
  };
  const text = (key: string, required: boolean): string | null | undefined => {
    const v = k[key];
    if (v === undefined || v === null) {
      if (required) at('PP7204', `a ${kind} key needs "${key}"`, pointer(key));
      return required ? undefined : null;
    }
    if (typeof v !== 'string' || v.length === 0) {
      at('PP7204', `"${key}" must be text`, pointer(key));
      return undefined;
    }
    return v;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const v = k[key] ?? fallback;
    if (typeof v !== 'boolean') at('PP7204', `"${key}" must be true or false`, pointer(key));
    return v === true;
  };
  const aim = (key: string, required: boolean): Aim | null | undefined => {
    const v = k[key];
    if (v === undefined || v === null) {
      if (required) at('PP7204', `a ${kind} key needs "${key}" ([x, y, z] or a name)`, pointer(key));
      return required ? undefined : null;
    }
    if (typeof v === 'string' && v.length > 0) return { target: v };
    const p = vec3(v);
    if (p === undefined) {
      at('PP7204', `"${key}" must be [x, y, z] or a name`, pointer(key));
      return undefined;
    }
    return { point: p };
  };
  switch (kind) {
    case 'camera': {
      v3('position', '[x, y, z]');
      v3('rotation', 'Euler degrees [x, y, z]');
      const rel = k['relative_to'];
      if (rel !== undefined) {
        if (typeof rel !== 'string' || rel.length === 0) at('PP7204', '"relative_to" must be a name', pointer('relative_to'));
        else if (k['position'] === undefined) at('PP7204', '"relative_to" offsets "position", which this key lacks', pointer('relative_to'));
        else out['relativeTo'] = rel;
      }
      const look = k['look_at'];
      if (look !== undefined) {
        const a = aim('look_at', false);
        if (a !== undefined && a !== null) out['lookAt'] = a;
        if (k['rotation'] !== undefined) at('PP7204', 'a key gives "look_at" or "rotation", not both', pointer('rotation'));
      }
      const fov = k['fov'];
      if (fov !== undefined) {
        if (typeof fov !== 'number' || !(fov >= 1 && fov <= 179)) at('PP7204', '"fov" must be degrees between 1 and 179', pointer('fov'));
        else out['fov'] = fov;
      }
      if (k['position'] === undefined && look === undefined && k['rotation'] === undefined && fov === undefined) {
        at('PP7204', 'a camera key needs "position", "look_at", "rotation" or "fov"', '');
      }
      return out;
    }
    case 'transform': {
      v3('position', '[x, y, z]');
      v3('rotation', 'Euler degrees [x, y, z]');
      const s = k['scale'];
      if (s !== undefined) {
        if (typeof s === 'number' && Number.isFinite(s)) out['scale'] = new Vec3(s, s, s);
        else v3('scale', 'a number or [x, y, z]');
      }
      if (k['position'] === undefined && k['rotation'] === undefined && s === undefined) {
        at('PP7204', 'a transform key needs "position", "rotation" or "scale"', '');
      }
      return out;
    }
    case 'visibility':
      if (typeof k['visible'] !== 'boolean') {
        at('PP7204', 'a visibility key needs "visible": true or false', pointer('visible'));
        return undefined;
      }
      return { visible: k['visible'] };
    case 'property':
      if (k['value'] === undefined) {
        at('PP7204', 'a property key needs "value"', '');
        return undefined;
      }
      return { ...out, value: k['value'] };
    case 'event':
      if (typeof k['name'] !== 'string' || k['name'].length === 0) {
        at('PP7204', 'an event key needs "name"', pointer('name'));
        return undefined;
      }
      return { name: k['name'] };
    case 'animation': {
      const clip = text('clip', true);
      const fade = num('fade', -1, 0, Infinity, 'seconds (>= 0)');
      const speed = num('speed', 1, 0, Infinity, 'a playback rate (>= 0)');
      const loop = flag('loop', true);
      if (clip === undefined || clip === null || fade === undefined || speed === undefined) return undefined;
      return { clip, loop, speed, ...(fade >= 0 && { fade }) };
    }
    case 'audio': {
      const hasSound = k['sound'] !== undefined;
      const hasMusic = k['music'] !== undefined;
      if (hasSound === hasMusic) {
        at('PP7204', hasSound ? 'an audio key plays "sound" or sets "music", not both' : 'an audio key needs "sound" (a one-shot) or "music" (a track, or null)', '');
        return undefined;
      }
      if (hasMusic) {
        for (const key of ['at', 'volume', 'pitch', 'duck']) {
          if (k[key] !== undefined) at('PP7204', `"${key}" is for "sound" keys; music takes "fade"`, pointer(key));
        }
        const music = text('music', false);
        const fade = num('fade', 1, 0, Infinity, 'seconds (>= 0)');
        if (music === undefined || fade === undefined) return undefined;
        return { kind: 'music', music, fade };
      }
      if (k['fade'] !== undefined) at('PP7204', '"fade" is for "music" keys', pointer('fade'));
      const sound = text('sound', true);
      const where = aim('at', false);
      const volume = num('volume', 1, 0, Infinity, 'a level (>= 0)');
      const pitch = num('pitch', 1, 0.01, Infinity, 'a pitch (> 0)');
      const duck = flag('duck', false);
      if (sound === undefined || sound === null || where === undefined || volume === undefined || pitch === undefined) return undefined;
      return { kind: 'sound', sound, at: where, volume, pitch, duck };
    }
    case 'letterbox': {
      const amount = num('amount', undefined, 0, 1, 'from 0 (none) to 1 (full bars)');
      return amount === undefined ? undefined : { ...out, value: amount };
    }
    case 'grade': {
      const weight = num('weight', undefined, 0, 1, 'from 0 (the scene\'s look) to 1 (the grade)');
      return weight === undefined ? undefined : { ...out, value: weight };
    }
    case 'time_scale': {
      const value = num('value', undefined, 0, 64, 'a time scale from 0 (frozen) to 64');
      return value === undefined ? undefined : { ...out, value };
    }
    case 'shake': {
      const intensity = num('intensity', 0.3, 0, Infinity, 'a strength (>= 0)');
      const seconds = num('seconds', 0.4, 0, Infinity, 'seconds (>= 0)');
      return intensity === undefined || seconds === undefined ? undefined : { intensity, seconds };
    }
    case 'focus': {
      const fields: Record<string, number> = {};
      for (const [key, min, label] of [['distance', 0, 'meters (>= 0)'], ['range', 0.01, 'meters (> 0)'], ['blur', 0, 'pixels at 1080p (0 to 64)']] as const) {
        if (k[key] === undefined) continue;
        const v = num(key, undefined, min, key === 'blur' ? 64 : Infinity, label);
        if (v !== undefined) fields[key] = v;
      }
      if (k['distance'] === undefined && k['range'] === undefined && k['blur'] === undefined) {
        at('PP7204', 'a focus key needs "distance", "range" or "blur"', '');
      }
      return { ...out, ...fields };
    }
    case 'subtitle': {
      const value = text('text', true);
      const seconds = num('seconds', -1, 0.01, Infinity, 'seconds (> 0)');
      if (value === undefined || value === null || seconds === undefined) return undefined;
      return { text: value, seconds: seconds < 0 ? null : seconds };
    }
    case 'dialogue': {
      const value = text('text', true);
      const speaker = text('speaker', false);
      const portrait = text('portrait', false);
      const wait = flag('wait', true);
      const seconds = num('seconds', -1, 0.01, Infinity, 'seconds (> 0)');
      if (wait && k['seconds'] !== undefined) at('PP7204', '"seconds" is for auto lines; a waiting line stays until the player advances', pointer('seconds'), 'Add "wait": false, or remove "seconds".');
      if (value === undefined || value === null || speaker === undefined || portrait === undefined || seconds === undefined) return undefined;
      return { text: value, speaker, portrait, wait, seconds: seconds < 0 ? null : seconds };
    }
    case 'spawn': {
      if (k['despawn'] !== undefined) {
        for (const key of ['prefab', 'name', 'position', 'rotation', 'keep']) {
          if (k[key] !== undefined) at('PP7204', `a despawn key takes only "despawn", not "${key}"`, pointer(key));
        }
        const despawn = text('despawn', true);
        return despawn === undefined || despawn === null ? undefined : { kind: 'despawn', despawn };
      }
      const prefab = text('prefab', false);
      if (prefab === null) {
        at('PP7204', 'a spawn key needs "prefab" (or "despawn": a name)', '');
        return undefined;
      }
      const spawnName = text('name', false);
      v3('position', '[x, y, z]');
      v3('rotation', 'Euler degrees [x, y, z]');
      const keep = flag('keep', false);
      if (prefab === undefined || spawnName === undefined) return undefined;
      return { kind: 'spawn', prefab, name: spawnName, position: out['position'] ?? null, rotation: out['rotation'] ?? null, keep };
    }
    case 'vfx': {
      const effect = text('effect', true);
      const where = aim('at', true);
      const scale = num('scale', 1, 0, Infinity, 'a size multiplier (>= 0)');
      let tint: Color | null = null;
      if (k['color'] !== undefined && k['color'] !== null) {
        const c = color(k['color']);
        if (c === undefined) at('PP7204', `"color" must be ${COLOR_FORMS}`, pointer('color'));
        else tint = c;
      }
      v3('direction', '[x, y, z]');
      if (effect === undefined || effect === null || where === undefined || where === null || scale === undefined) return undefined;
      return { effect, at: where, color: tint, scale, direction: out['direction'] ?? null };
    }
  }
}

/** Every target name a cinematic's tracks use (camera, targets, relative_to, look_at, at, despawn), with where. */
export function targetNames(c: Cinematic): Array<{ readonly name: string; readonly pointer: string }> {
  const out: Array<{ name: string; pointer: string }> = [];
  const aimed = (a: Aim | null | undefined, ptr: string): void => {
    if (a !== undefined && a !== null && 'target' in a) out.push({ name: a.target, pointer: ptr });
  };
  // Names a spawn key gives: a despawn of one of them needs no entity when the cinematic starts.
  const spawned = new Set<string>();
  c.tracks.forEach((track, i) => {
    switch (track.type) {
      case 'camera':
        if (track.camera !== null) out.push({ name: track.camera, pointer: pointer('tracks', i, 'camera') });
        track.keys.forEach((k, j) => {
          if (k.relativeTo !== undefined) out.push({ name: k.relativeTo, pointer: pointer('tracks', i, 'keys', j, 'relative_to') });
          aimed(k.lookAt, pointer('tracks', i, 'keys', j, 'look_at'));
        });
        break;
      case 'shake':
      case 'focus':
        if (track.camera !== null) out.push({ name: track.camera, pointer: pointer('tracks', i, 'camera') });
        break;
      case 'transform':
      case 'visibility':
      case 'property':
      case 'animation':
        out.push({ name: track.target, pointer: pointer('tracks', i, 'target') });
        break;
      case 'audio':
        track.keys.forEach((k, j) => { if (k.kind === 'sound') aimed(k.at, pointer('tracks', i, 'keys', j, 'at')); });
        break;
      case 'vfx':
        track.keys.forEach((k, j) => aimed(k.at, pointer('tracks', i, 'keys', j, 'at')));
        break;
      case 'spawn':
        track.keys.forEach((k, j) => {
          if (k.kind === 'spawn') { if (k.name !== null) spawned.add(k.name); }
          else if (!spawned.has(k.despawn)) out.push({ name: k.despawn, pointer: pointer('tracks', i, 'keys', j, 'despawn') });
        });
        break;
      default:
        break;
    }
  });
  return out;
}

// ── Sampling ─────────────────────────────────────────────────────────────────

export interface ChannelKey<T> {
  readonly t: number;
  readonly ease: string;
  readonly cut: boolean;
  readonly value: T;
}

/**
 * A channel's value at `time`: from `start` (an implicit key at 0, unless a key is at 0)
 * through `keys`, blended by `mix(a, b, u)`. `step` channels never blend.
 */
export function sample<T>(keys: readonly ChannelKey<T>[], start: T, time: number, mix: (a: T, b: T, u: number) => T, step = false): T {
  let prevT = 0;
  let prev = start;
  for (const key of keys) {
    if (time + DUE < key.t) {
      if (step || key.cut) return prev;
      const span = key.t - prevT;
      return span <= 0 ? key.value : mix(prev, key.value, ease(key.ease, (time - prevT) / span));
    }
    prevT = key.t;
    prev = key.value;
  }
  return prev;
}

/** The subtitle showing at `time` (null: none): a key shows for its `seconds`, else until the next key (at most 3 s). */
export function subtitleAt(keys: readonly SubtitleKey[], time: number): string | null {
  let shown: string | null = null;
  keys.forEach((k, i) => {
    const next = keys[i + 1]?.t;
    const end = k.seconds !== null ? k.t + k.seconds : Math.min(next ?? Infinity, k.t + SUBTITLE_SECONDS);
    if (k.t <= time + DUE && time + DUE < end) shown = k.text;
  });
  return shown;
}

/**
 * The dialogue line at `time` (null: none): the last line reached. A waiting line stays
 * (playback is held on it until the player advances); an auto line clears after `seconds`
 * when it gives them, else at the next line.
 */
export function dialogueAt(keys: readonly DialogueKey[], time: number): DialogueKey | null {
  let line: DialogueKey | null = null;
  for (const k of keys) {
    if (k.t > time + DUE) break;
    line = !k.wait && k.seconds !== null && time + DUE >= k.t + k.seconds ? null : k;
  }
  return line;
}

/** The times playback holds for the player to advance (each waiting dialogue line), ascending. */
export function holdTimes(c: Cinematic): number[] {
  const out = new Set<number>();
  for (const track of c.tracks) if (track.type === 'dialogue') for (const k of track.keys) if (k.wait) out.add(k.t);
  return [...out].sort((a, b) => a - b);
}

export const lerpNumber = (a: number, b: number, u: number): number => a + (b - a) * u;
export const lerpVec3 = (a: Vec3, b: Vec3, u: number): Vec3 => a.lerp(b, u);
export const lerpVec2 = (a: Vec2, b: Vec2, u: number): Vec2 => a.lerp(b, u);
export const lerpColor = (a: Color, b: Color, u: number): Color => a.lerp(b, u);

/** Shortest-arc spherical interpolation of unit quaternions. */
export function slerp(a: Quat, b: Quat, u: number): Quat {
  let { x, y, z, w } = b;
  let dot = a.x * x + a.y * y + a.z * z + a.w * w;
  if (dot < 0) { x = -x; y = -y; z = -z; w = -w; dot = -dot; }
  let s0: number;
  let s1: number;
  if (dot > 0.9995) {
    s0 = 1 - u;
    s1 = u;
  } else {
    const theta = Math.acos(dot);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - u) * theta) / sin;
    s1 = Math.sin(u * theta) / sin;
  }
  const qx = s0 * a.x + s1 * x;
  const qy = s0 * a.y + s1 * y;
  const qz = s0 * a.z + s1 * z;
  const qw = s0 * a.w + s1 * w;
  const n = Math.hypot(qx, qy, qz, qw);
  return new Quat(qx / n, qy / n, qz / n, qw / n);
}
