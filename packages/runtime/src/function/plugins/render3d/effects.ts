/**
 * Effect definitions (`assets/vfx/<name>.vfx.json`) in a 3D game. One schema serves 2D and
 * 3D games (core VFX_KEYS): the same keys, every key optional. The keys both draw:
 *
 *   burst, rate, duration, lifetime, speed, direction, spread, radius, gravity, drag,
 *   size, size_end, color, color_end, spin, shape ("circle" | "square" | "glow" | "ring"),
 *   image, max, blend ("alpha" | "additive"), haze, extends
 *
 * In 3D, `direction` (degrees counter-clockwise from +x) names an axis in the x/y plane —
 * 90, the default, is straight up — so an effect authored for 2D points the same way.
 * `spread` is the full angle of the cone around that axis (360: every direction),
 * `radius` a ball particles start in, `gravity` acts along +y (negative: falls), or [x, y]
 * (a sideways pull along x too), and sizes are billboard diameters in meters.
 *
 * 3D adds how particles look and what else an effect does when it plays (a 2D game accepts
 * these keys and ignores them, core VFX_3D_ONLY_KEYS):
 *
 *   look      flipbook ("fire" | "smoke": a built-in animated sheet), frames ([cols, rows] of `image`),
 *             facing ("camera" | "velocity" | "up"), stretch (seconds of velocity a
 *             velocity-facing particle streaks over), soft (meters of fade into the scene),
 *             lit (shaded by the sun and ambient), intensity (color × this: above 1
 *             blooms), angle (start rotation, degrees), fade_in (fraction of life)
 *   motion    turbulence (m/s² of smooth swirl), delay (seconds before a one-shot starts)
 *   with it   light { color, intensity, range, seconds, flicker } (a flash fading over
 *             `seconds`; 0: steady while a continuous emitter emits), sound (a one-shot's
 *             sound, a continuous emitter's loop), shake { intensity, seconds, radius }
 *             (cameras within radius), haze { radius, strength, ring, seconds } (heat
 *             shimmer, or with `ring` a shockwave growing over `seconds`)
 *   composed  children [{ effect, delay, scale, offset }] (played with a one-shot),
 *             on_death { effect, chance } (played where a particle dies) — `effect` is a
 *             reference or an inline effect object
 *   reuse     extends: another effect ("effect/explosion", "vfx/base") whose keys this
 *             file overrides
 *
 * `effect/<name>` effects (Python `Effect.<name>`; BUILTIN_EFFECTS, effect_presets.ts) need
 * no file, as `synth/<name>` sounds need none. Problems are PP3808 with the file, in 2D
 * and 3D games alike.
 */

import { BUILTIN_EFFECT_PREFIX, BUILTIN_EFFECTS, COLOR_FORMS, fail, parseColor, VFX_BLENDS, VFX_KEYS, VFX_SHAPES } from '../../../core/index.js';
import type { Rgba } from '../../../core/index.js';
import type { AssetCatalog } from '../../../resource/index.js';
import { EFFECT_PRESETS } from './effect_presets.js';

export interface Range {
  readonly lo: number;
  readonly hi: number;
}

export interface EffectLight {
  readonly color: Rgba;
  readonly intensity: number;
  readonly range: number;
  /** Seconds a one-shot's flash fades over; 0: steady while emitting (continuous emitters). */
  readonly seconds: number;
  /** 0..1: how much it flickers. */
  readonly flicker: number;
}

export interface EffectShake {
  readonly intensity: number;
  readonly seconds: number;
  /** Cameras farther than this feel nothing; nearer ones more, the closer they are. */
  readonly radius: number;
}

export interface EffectHaze {
  readonly radius: number;
  readonly strength: number;
  /** 0: a steady shimmer; above 0: a shockwave ring this fraction of its radius wide, growing over `seconds`. */
  readonly ring: number;
  readonly seconds: number;
}

/** An effect played with another: a reference (resolved when played) or an inline definition. */
export interface EffectChild {
  readonly ref: string | null;
  readonly def: EffectDef | null;
  readonly delay: number;
  readonly scale: number;
  readonly offset: readonly [number, number, number];
}

export interface EffectDeath {
  readonly ref: string | null;
  readonly def: EffectDef | null;
  readonly chance: number;
}

export interface EffectDef {
  readonly path: string;
  readonly burst: number;
  readonly rate: number;
  readonly duration: number;
  readonly lifetime: Range;
  readonly speed: Range;
  readonly direction: number;
  readonly spread: number;
  readonly radius: number;
  /** m/s² along x and y (a number in the file is along y). */
  readonly gravity: readonly [x: number, y: number];
  readonly drag: number;
  readonly size: Range;
  readonly sizeEnd: number | null;
  readonly color: Rgba;
  readonly colorEnd: Rgba | null;
  readonly spin: Range;
  readonly shape: 'circle' | 'square' | 'glow' | 'ring';
  /** An image file (assets/images/…) drawn instead of the shape. */
  readonly image: string | null;
  readonly max: number;
  readonly blend: 'alpha' | 'additive';
  /** A built-in sheet drawn instead of the shape (8 × 8 frames). */
  readonly flipbook: 'fire' | 'smoke' | null;
  readonly frames: readonly [number, number];
  readonly facing: 'camera' | 'velocity' | 'up';
  readonly stretch: number;
  readonly soft: number;
  readonly lit: boolean;
  readonly intensity: number;
  /** Start rotation, degrees. */
  readonly angle: Range;
  readonly fadeIn: number;
  readonly turbulence: number;
  readonly delay: number;
  readonly light: EffectLight | null;
  /** As written (`sfx/boom`), for the audio service. */
  readonly sound: string | null;
  readonly shake: EffectShake | null;
  readonly haze: EffectHaze | null;
  readonly children: readonly EffectChild[];
  readonly onDeath: EffectDeath | null;
}

const KEYS = VFX_KEYS;

/** The prefix of a built-in effect's reference (`effect/explosion`). */
export const BUILTIN = BUILTIN_EFFECT_PREFIX;

/** The spelling built-in effects had before `effect/<name>`: an error that names the one form. */
const OLD_BUILTIN = 'builtin:';

type Doc = Record<string, unknown>;

function bad(path: string, message: string, fix?: string): never {
  return fail('PP3808', `${path}: ${message}`, { path, ...(fix !== undefined && { fix }) });
}

function number(path: string, doc: Doc, key: string, fallback: number, min = -Infinity, max = Infinity): number {
  const value = doc[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) bad(path, `"${key}" must be a number, got ${JSON.stringify(value)}`);
  if (value < min || value > max) bad(path, `"${key}" is ${value}; it must be ${max === Infinity ? `at least ${min}` : `between ${min} and ${max}`}`);
  return value;
}

function range(path: string, doc: Doc, key: string, fallback: number, min = -Infinity): Range {
  const value = doc[key];
  if (Array.isArray(value)) {
    if (value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      bad(path, `"${key}" must be a number or [lo, hi], got ${JSON.stringify(value)}`);
    }
    const [lo, hi] = value as [number, number];
    if (lo > hi) bad(path, `"${key}" is [${lo}, ${hi}]; lo must not exceed hi`, `Write [${hi}, ${lo}].`);
    if (lo < min) bad(path, `"${key}" starts at ${lo}; it must be at least ${min}`);
    return { lo, hi };
  }
  const n = number(path, doc, key, fallback, min);
  return { lo: n, hi: n };
}

/** A number along y, or an [x, y] pair (the same "gravity" a 2D game reads). */
function vector(path: string, doc: Doc, key: string, fallback: number): readonly [number, number] {
  const value = doc[key];
  if (Array.isArray(value)) {
    if (value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      bad(path, `"${key}" must be a number (along y) or [x, y], got ${JSON.stringify(value)}`);
    }
    return [value[0] as number, value[1] as number];
  }
  return [0, number(path, doc, key, fallback)];
}

function color(path: string, doc: Doc, key: string, fallback: string | null): Rgba | null {
  const value = doc[key] ?? fallback;
  if (value === null) return null;
  const c = parseColor(value);
  if (c === null) return bad(path, `"${key}" must be a colour: ${COLOR_FORMS}, got ${JSON.stringify(value)}`);
  return [c.r, c.g, c.b, c.a];
}

function oneOf<T extends string>(path: string, doc: Doc, key: string, options: readonly T[], fallback: T): T {
  const value = doc[key] ?? fallback;
  if (!(options as readonly unknown[]).includes(value)) {
    bad(path, `"${key}" must be ${options.map((o) => `"${o}"`).join(', ')}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function object(path: string, doc: Doc, key: string, keys: readonly string[]): Doc | null {
  const value = doc[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) bad(path, `"${key}" must be an object, got ${JSON.stringify(value)}`);
  for (const k of Object.keys(value as Doc)) {
    if (!keys.includes(k)) bad(path, `"${key}" has an unknown key "${k}"`, `Keys: ${keys.join(', ')}.`);
  }
  return value as Doc;
}

/** The parsed JSON object of an effect file (PP3808 when it isn't one). */
function docOf(path: string, text: string): Doc {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    bad(path, `is not valid JSON (${(error as Error).message})`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) bad(path, 'must be a JSON object');
  return doc as Doc;
}

/** Whether a reference names a built-in effect (`effect/explosion`). */
export function isBuiltinEffect(ref: string): boolean {
  return ref.startsWith(BUILTIN) && (BUILTIN_EFFECTS as readonly string[]).includes(ref.slice(BUILTIN.length));
}

/**
 * Whether a reference is written as a built-in (`effect/<name>`), failing with `code` when
 * it names none — or spells one the old way (`builtin:<name>`).
 */
export function builtinEffectRef(ref: string, where: string, code: 'PP3808' | 'PP2063', path?: string): boolean {
  const at = path === undefined ? {} : { path };
  if (ref.startsWith(OLD_BUILTIN)) {
    const name = ref.slice(OLD_BUILTIN.length);
    fail(code, `${where} names "${ref}"; a built-in effect is written "${BUILTIN}<name>"`, { ...at, fix: `Write "${BUILTIN}${name}" (Python Effect.${name}).` });
  }
  if (!ref.startsWith(BUILTIN)) return false;
  if (!isBuiltinEffect(ref)) {
    fail(code, `${where} names "${ref}", which is not a built-in effect`, { ...at, fix: `Built-in effects: ${BUILTIN_EFFECTS.map((n) => BUILTIN + n).join(', ')}.` });
  }
  return true;
}

/** The effect's keys with every `extends` folded in (the base's keys, overridden by the file's). */
function flatten(path: string, doc: Doc, assets: AssetCatalog, seen: readonly string[]): Doc {
  const base = doc['extends'];
  if (base === undefined || base === null) return doc;
  if (typeof base !== 'string') bad(path, `"extends" must be an effect reference, got ${JSON.stringify(base)}`);
  let basePath: string;
  let baseDoc: Doc;
  if (builtinEffectRef(base, `${path}: "extends"`, 'PP3808', path)) {
    basePath = base;
    baseDoc = EFFECT_PRESETS[base.slice(BUILTIN.length) as (typeof BUILTIN_EFFECTS)[number]] as Doc;
  } else {
    basePath = assets.resolve(base, 'vfx', `${path} "extends"`);
    if (!assets.has(basePath)) return Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'extends'));
    baseDoc = docOf(basePath, assets.read(basePath));
  }
  if (seen.includes(basePath)) bad(path, `"extends" goes round in a circle (${[...seen, basePath].join(' → ')})`);
  const flat = flatten(basePath, baseDoc, assets, [...seen, basePath]);
  const out: Doc = { ...flat };
  for (const [k, v] of Object.entries(doc)) if (k !== 'extends') out[k] = v;
  return out;
}

function effectRef(path: string, where: string, value: unknown, assets: AssetCatalog, child: string): { ref: string | null; def: EffectDef | null } {
  if (typeof value === 'string') {
    if (builtinEffectRef(value, `${path}: ${where}`, 'PP3808', path)) return { ref: value, def: null };
    assets.resolve(value, 'vfx', `${path} ${where}`);
    return { ref: value, def: null };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { ref: null, def: parseDoc(child, value as Doc, assets, [child]) };
  }
  return bad(path, `${where} must be an effect reference ("vfx/<name>", "${BUILTIN}<name>") or an effect object, got ${JSON.stringify(value)}`);
}

export function parseEffect(path: string, text: string, assets: AssetCatalog): EffectDef {
  return parseDoc(path, docOf(path, text), assets, [path]);
}

/** A built-in effect, parsed once per catalog. */
export function builtinEffect(ref: string, assets: AssetCatalog): EffectDef {
  return parseDoc(ref, EFFECT_PRESETS[ref.slice(BUILTIN.length) as (typeof BUILTIN_EFFECTS)[number]] as Doc, assets, [ref]);
}

function parseDoc(path: string, raw: Doc, assets: AssetCatalog, seen: readonly string[]): EffectDef {
  for (const key of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(key)) bad(path, `has an unknown key "${key}"`, `Keys: ${KEYS.join(', ')}.`);
  }
  const d = flatten(path, raw, assets, seen);
  const burst = number(path, d, 'burst', 0, 0);
  if (!Number.isInteger(burst)) bad(path, `"burst" must be a whole number, got ${burst}`);
  const rate = number(path, d, 'rate', 0, 0);
  const children = d['children'] ?? [];
  if (!Array.isArray(children)) bad(path, `"children" must be a list, got ${JSON.stringify(children)}`);
  const lightDoc = object(path, d, 'light', ['color', 'intensity', 'range', 'seconds', 'flicker']);
  if (burst === 0 && rate === 0 && children.length === 0 && lightDoc === null) {
    bad(path, 'emits nothing: "burst" and "rate" are both 0', 'Set "burst" (particles at once) or "rate" (per second).');
  }
  const shape = oneOf(path, d, 'shape', VFX_SHAPES, 'circle');
  const image = d['image'] ?? null;
  if (image !== null && typeof image !== 'string') bad(path, `"image" must be a string, got ${JSON.stringify(image)}`);
  const flipbook = d['flipbook'] ?? null;
  if (flipbook !== null && flipbook !== 'fire' && flipbook !== 'smoke') bad(path, `"flipbook" must be "fire" or "smoke", got ${JSON.stringify(flipbook)}`);
  if (flipbook !== null && image !== null) bad(path, 'has both "image" and "flipbook"', 'Keep one: "flipbook" draws a built-in sheet, "image" your own.');
  const max = number(path, d, 'max', 512, 1);
  if (!Number.isInteger(max)) bad(path, `"max" must be a whole number, got ${max}`);
  const lifetime = range(path, d, 'lifetime', 0.5, 0);
  if (lifetime.lo <= 0) bad(path, '"lifetime" must be above 0');
  const size = range(path, d, 'size', 0.15, 0);
  const sizeEnd = d['size_end'] === undefined || d['size_end'] === null ? null : number(path, d, 'size_end', 0, 0);
  let frames: [number, number] = flipbook === null ? [1, 1] : [8, 8];
  if (d['frames'] !== undefined && d['frames'] !== null) {
    const f = d['frames'];
    if (!Array.isArray(f) || f.length !== 2 || !f.every((n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 64)) {
      bad(path, `"frames" must be [columns, rows] (whole numbers 1–64), got ${JSON.stringify(f)}`);
    }
    if (image === null) bad(path, '"frames" splits an "image" into a sheet, but there is no "image"', 'Add "image", or use "flipbook" for a built-in sheet.');
    frames = [f[0] as number, f[1] as number];
  }
  const blend = oneOf(path, d, 'blend', VFX_BLENDS, flipbook === 'fire' ? 'additive' : 'alpha');
  const facing = oneOf(path, d, 'facing', ['camera', 'velocity', 'up'] as const, 'camera');
  const lit = d['lit'] ?? flipbook === 'smoke';
  if (typeof lit !== 'boolean') bad(path, `"lit" must be true or false, got ${JSON.stringify(lit)}`);
  const sound = d['sound'] ?? null;
  if (sound !== null && typeof sound !== 'string') bad(path, `"sound" must be a sound reference ("sfx/<name>"), got ${JSON.stringify(sound)}`);
  // The audio plugin resolves it when it plays (sounds aren't in this catalog); check reports a missing file.
  if (sound !== null && !/^(?:sfx\/[^/.]+$|synth\/[^/.]+$|https:\/\/)/.test(sound)) {
    bad(path, `"sound" must name a sound in assets/sfx/ ("sfx/<name>") or a built-in ("synth/<name>"), got ${JSON.stringify(sound)}`,
      /^(?:assets\/)?sfx\/[^/]+$/.test(sound) ? `Write "${sound.replace(/^assets\//, '').replace(/\..*$/, '')}" (no "assets/", no extension).` : undefined);
  }

  const shakeDoc = object(path, d, 'shake', ['intensity', 'seconds', 'radius']);
  const hazeDoc = object(path, d, 'haze', ['radius', 'strength', 'ring', 'seconds']);
  const deathDoc = object(path, d, 'on_death', ['effect', 'chance']);
  if (deathDoc !== null && deathDoc['effect'] === undefined) bad(path, '"on_death" needs an "effect"');
  const where = `${path}#`;

  return {
    path,
    burst,
    rate,
    duration: number(path, d, 'duration', 0, 0),
    lifetime,
    speed: range(path, d, 'speed', 2),
    direction: number(path, d, 'direction', 90),
    spread: number(path, d, 'spread', 360, 0, 360),
    radius: number(path, d, 'radius', 0, 0),
    gravity: vector(path, d, 'gravity', 0),
    drag: number(path, d, 'drag', 0, 0),
    size,
    sizeEnd,
    color: color(path, d, 'color', '#ffffff')!,
    colorEnd: color(path, d, 'color_end', null),
    spin: range(path, d, 'spin', 0),
    shape,
    image: image === null ? null : assets.resolve(image, 'images', `${path} "image"`),
    max,
    blend,
    flipbook,
    frames,
    facing,
    stretch: number(path, d, 'stretch', facing === 'velocity' ? 0.05 : 0, 0),
    // Default: half the largest start size, at most half a meter — a soft edge where it meets the ground, without swallowing small sparks.
    soft: number(path, d, 'soft', Math.min(0.5, size.hi * 0.5), 0),
    lit,
    intensity: number(path, d, 'intensity', 1, 0),
    angle: range(path, d, 'angle', 0),
    fadeIn: number(path, d, 'fade_in', 0, 0, 1),
    turbulence: number(path, d, 'turbulence', 0, 0),
    delay: number(path, d, 'delay', 0, 0),
    light: lightDoc === null ? null : {
      color: color(path, lightDoc, 'color', null) ?? color(path, d, 'color', '#ffffff')!,
      intensity: number(path, lightDoc, 'intensity', 4, 0),
      range: number(path, lightDoc, 'range', 6, 0),
      seconds: number(path, lightDoc, 'seconds', rate > 0 && burst === 0 ? 0 : 0.25, 0),
      flicker: number(path, lightDoc, 'flicker', 0, 0, 1),
    },
    sound,
    shake: shakeDoc === null ? null : {
      intensity: number(path, shakeDoc, 'intensity', 0.3, 0),
      seconds: number(path, shakeDoc, 'seconds', 0.3, 0),
      radius: number(path, shakeDoc, 'radius', 20, 0),
    },
    haze: hazeDoc === null ? null : {
      radius: number(path, hazeDoc, 'radius', 2, 0),
      strength: number(path, hazeDoc, 'strength', 0.5, 0, 1),
      ring: number(path, hazeDoc, 'ring', 0, 0, 1),
      seconds: number(path, hazeDoc, 'seconds', 0.5, 0),
    },
    children: (children as unknown[]).map((c, i) => {
      if (typeof c === 'string') return { ...effectRef(path, `"children"[${i}]`, c, assets, `${where}children.${i}`), delay: 0, scale: 1, offset: [0, 0, 0] as const };
      const cd = object(path, { c }, 'c', ['effect', 'delay', 'scale', 'offset']);
      if (cd === null || cd['effect'] === undefined) return bad(path, `"children"[${i}] needs an "effect"`);
      const offset = cd['offset'] ?? [0, 0, 0];
      if (!Array.isArray(offset) || offset.length !== 3 || !offset.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        bad(path, `"children"[${i}].offset must be [x, y, z], got ${JSON.stringify(offset)}`);
      }
      return {
        ...effectRef(path, `"children"[${i}].effect`, cd['effect'], assets, `${where}children.${i}`),
        delay: number(path, cd, 'delay', 0, 0),
        scale: number(path, cd, 'scale', 1, 0),
        offset: offset as [number, number, number],
      };
    }),
    onDeath: deathDoc === null ? null : {
      ...effectRef(path, '"on_death".effect', deathDoc['effect'], assets, `${where}on_death`),
      chance: number(path, deathDoc, 'chance', 1, 0, 1),
    },
  };
}

/** An effect whose file isn't available (a data-only run): it emits nothing. */
function unavailableEffect(path: string): EffectDef {
  const zero = { lo: 0, hi: 0 };
  return {
    path, burst: 0, rate: 0, duration: 0, lifetime: { lo: 1, hi: 1 }, speed: zero, direction: 90, spread: 360, radius: 0,
    gravity: [0, 0], drag: 0, size: zero, sizeEnd: null, color: [1, 1, 1, 1], colorEnd: null, spin: zero, shape: 'circle',
    image: null, max: 1, blend: 'alpha', flipbook: null, frames: [1, 1], facing: 'camera', stretch: 0, soft: 0, lit: false,
    intensity: 1, angle: zero, fadeIn: 0, turbulence: 0, delay: 0, light: null, sound: null, shake: null, haze: null,
    children: [], onDeath: null,
  };
}

/** Effect files by reference, parsed once. Inline children are `<parent>#children.<i>` / `<parent>#on_death`. */
export class EffectLibrary {
  readonly #assets: AssetCatalog;
  readonly #byPath = new Map<string, EffectDef>();

  constructor(assets: AssetCatalog) {
    this.#assets = assets;
  }

  get(ref: string, where: string): EffectDef {
    const hash = ref.indexOf('#');
    if (hash !== -1) return this.#inline(ref, hash, where);
    const path = builtinEffectRef(ref, where, 'PP2063') ? ref : this.#assets.resolve(ref, 'vfx', where);
    return this.#load(path);
  }

  /** The effect at a resolved path (a file, or a built-in's reference), parsed once. */
  #load(path: string): EffectDef {
    let def = this.#byPath.get(path);
    if (def === undefined) {
      def = isBuiltinEffect(path) ? builtinEffect(path, this.#assets)
        : this.#assets.has(path) ? parseEffect(path, this.#assets.read(path), this.#assets) : unavailableEffect(path);
      this.#byPath.set(path, def);
    }
    return def;
  }

  /**
   * An inline child effect, found by walking from its file: `assets/vfx/boom.vfx.json#children.0#on_death`
   * (the parent is the resolved path its definition was parsed from, or a built-in's reference).
   */
  #inline(ref: string, hash: number, where: string): EffectDef {
    const parent = ref.slice(0, hash);
    let def = isBuiltinEffect(parent) || this.#assets.has(parent) ? this.#load(parent) : this.get(parent, where);
    for (const step of ref.slice(hash + 1).split('#')) {
      const next = step === 'on_death' ? def.onDeath?.def : step.startsWith('children.') ? def.children[Number(step.slice(9))]?.def : undefined;
      if (next === undefined || next === null) return fail('PP3808', `${where}: the effect "${ref}" no longer exists`, { fix: 'The effect file changed since this state was saved.' });
      def = next;
    }
    return def;
  }
}
