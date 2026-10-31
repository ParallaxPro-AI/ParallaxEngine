/**
 * Effect definitions: `assets/vfx/<name>.vfx.json`, the files `EffectRef`s name
 * (`Assets.vfx.sparks`). One format serves one-shot effects (`ctx.vfx.play`) and
 * continuous emitters (the `particles` component). Every key is optional:
 *
 *   {
 *     "burst": 24,              particles emitted at once when the effect starts
 *     "rate": 0,                particles per second while emitting
 *     "duration": 0,            one-shot: seconds `rate` keeps emitting (continuous emitters
 *                               emit for as long as `emitting` is true)
 *     "lifetime": [0.3, 0.6],   seconds; a number, or [lo, hi] picked per particle
 *     "speed": [2, 5],          m/s; number or [lo, hi]
 *     "direction": 90,          degrees counter-clockwise from +x
 *     "spread": 360,            degrees of the cone around `direction`
 *     "radius": 0,              particles start anywhere within this many meters
 *     "gravity": 0,             m/s² along y (negative falls), or [x, y] (wind, a sideways pull)
 *     "drag": 0,                velocity lost per second, as a fraction (0..)
 *     "size": 0.15,             diameter in meters; number or [lo, hi]
 *     "size_end": null,         diameter at the end of life (null: unchanged)
 *     "color": "#ffffff",       start color
 *     "color_end": null,        color at the end of life (null: unchanged); "#ffffff00" fades out
 *     "spin": 0,                degrees per second; number or [lo, hi]
 *     "shape": "circle",        "circle" or "square" ("glow" and "ring", 3D looks, draw as circles)
 *     "image": null,            an image (images/<name>) drawn instead of the shape
 *     "blend": "alpha",         "additive": colors add up and glow where particles overlap
 *                               (fire, sparks, magic); "alpha" paints over
 *     "haze": null,             a shockwave ripple when the effect plays (one-shots):
 *                               {"radius": 2, "strength": 0.5, "ring": 0.3, "seconds": 0.5}
 *                               — the image bends in a ring growing to `radius` meters over
 *                               `seconds`, `ring` its width as a fraction of the radius
 *     "max": 512,               live particles kept per emitter (oldest are dropped first)
 *     "extends": null           another effect file ("vfx/base") whose keys this one overrides
 *   }
 *
 * It is the one `.vfx.json` schema of 2D and 3D games (core VFX_KEYS): a 3D game's keys
 * (`flipbook`, `light`, `sound`, `children`, … core VFX_3D_ONLY_KEYS) are accepted here and
 * ignored, so one file serves both. The built-in effects (`effect/<name>`) are 3D-only.
 * At least one of `burst` and `rate` must be positive. Problems are PP3808 with the file,
 * as in a 3D game.
 */

import { BUILTIN_EFFECT_PREFIX, COLOR_FORMS, fail, parseColor, VFX_3D_ONLY_KEYS, VFX_BLENDS, VFX_KEYS, VFX_SHAPES } from '../../../core/index.js';
import type { Rgba } from '../../../core/index.js';
import type { AssetCatalog } from './assets.js';

export interface Range {
  readonly lo: number;
  readonly hi: number;
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
  /** m/s² along x and y. */
  readonly gravity: readonly [x: number, y: number];
  readonly drag: number;
  readonly size: Range;
  readonly sizeEnd: number | null;
  readonly color: Rgba;
  readonly colorEnd: Rgba | null;
  readonly spin: Range;
  readonly shape: 'circle' | 'square';
  readonly image: string | null;
  readonly blend: (typeof VFX_BLENDS)[number];
  /** The shockwave ripple a one-shot plays with (null: none). */
  readonly haze: EffectHaze2d | null;
  readonly max: number;
}

export interface EffectHaze2d {
  /** Meters the ring grows to. */
  readonly radius: number;
  /** 0..1: how far the image bends. */
  readonly strength: number;
  /** The ring's width, as a fraction of `radius`. */
  readonly ring: number;
  readonly seconds: number;
}

/** Every `.vfx.json` key: the 3D-only ones are accepted and ignored. */
const KEYS = VFX_KEYS;
const IGNORED: readonly string[] = VFX_3D_ONLY_KEYS;
const HAZE_KEYS = ['radius', 'strength', 'ring', 'seconds'];

function bad(path: string, message: string, fix?: string): never {
  return fail('PP3808', `${path}: ${message}`, { path, ...(fix !== undefined && { fix }) });
}

class Reader {
  readonly #path: string;
  readonly #doc: Record<string, unknown>;

  constructor(path: string, doc: Record<string, unknown>) {
    this.#path = path;
    this.#doc = doc;
  }

  number(key: string, fallback: number, min = -Infinity, max = Infinity): number {
    const value = this.#doc[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) bad(this.#path, `"${key}" must be a number, got ${JSON.stringify(value)}`);
    if (value < min || value > max) {
      bad(this.#path, `"${key}" is ${value}; it must be ${max === Infinity ? `at least ${min}` : `between ${min} and ${max}`}`);
    }
    return value;
  }

  optionalNumber(key: string, min: number): number | null {
    return this.#doc[key] === undefined || this.#doc[key] === null ? null : this.number(key, 0, min);
  }

  range(key: string, fallback: number, min = -Infinity): Range {
    const value = this.#doc[key];
    if (Array.isArray(value)) {
      if (value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        bad(this.#path, `"${key}" must be a number or [lo, hi], got ${JSON.stringify(value)}`);
      }
      const [lo, hi] = value as [number, number];
      if (lo > hi) bad(this.#path, `"${key}" is [${lo}, ${hi}]; lo must not exceed hi`, `Write [${hi}, ${lo}].`);
      if (lo < min) bad(this.#path, `"${key}" starts at ${lo}; it must be at least ${min}`);
      return { lo, hi };
    }
    const n = this.number(key, fallback, min);
    return { lo: n, hi: n };
  }

  color(key: string, fallback: string | null): Rgba | null {
    const value = this.#doc[key] ?? fallback;
    if (value === null) return null;
    const c = parseColor(value);
    if (c === null) return bad(this.#path, `"${key}" must be a colour: ${COLOR_FORMS}, got ${JSON.stringify(value)}`);
    return [c.r, c.g, c.b, c.a];
  }

  /** A number along y, or an [x, y] pair. */
  vector(key: string, fallback: number): readonly [number, number] {
    const value = this.#doc[key];
    if (Array.isArray(value)) {
      if (value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        bad(this.#path, `"${key}" must be a number (along y) or [x, y], got ${JSON.stringify(value)}`);
      }
      return [value[0] as number, value[1] as number];
    }
    return [0, this.number(key, fallback)];
  }

  string(key: string): string | null {
    const value = this.#doc[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') bad(this.#path, `"${key}" must be a string, got ${JSON.stringify(value)}`);
    return value;
  }
}

/** A resolved image, or null when a data-only run doesn't have its file (particles draw as shapes). */
function presentImage(assets: AssetCatalog, path: string): string | null {
  return assets.loadable(path) ? path : null;
}

/** The parsed JSON object of an effect file, its keys checked against the one schema. */
function docOf(path: string, text: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    bad(path, `is not valid JSON (${(error as Error).message})`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) bad(path, 'must be a JSON object');
  const record = doc as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(KEYS as readonly string[]).includes(key)) bad(path, `has an unknown key "${key}"`, `Keys: ${KEYS.join(', ')}.`);
  }
  return record;
}

/** The effect's keys with every `extends` folded in (the base file's keys, overridden by this one's). */
function flatten(path: string, doc: Record<string, unknown>, assets: AssetCatalog, seen: readonly string[]): Record<string, unknown> {
  const base = doc['extends'];
  if (base === undefined || base === null) return doc;
  if (typeof base !== 'string') bad(path, `"extends" must be an effect reference ("vfx/<name>"), got ${JSON.stringify(base)}`);
  if (base.startsWith(BUILTIN_EFFECT_PREFIX) || base.startsWith('builtin:')) {
    bad(path, `"extends" names "${base}", a built-in 3D effect; a 2D game has none`, 'Extend an effect file of this game ("vfx/<name>"), or write the keys out.');
  }
  const basePath = assets.resolve(base, 'vfx', `${path} "extends"`);
  const own = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'extends'));
  if (!assets.has(basePath)) return own;
  if (seen.includes(basePath)) bad(path, `"extends" goes round in a circle (${[...seen, basePath].join(' → ')})`);
  return { ...flatten(basePath, docOf(basePath, assets.read(basePath)), assets, [...seen, basePath]), ...own };
}

/** Parse and check one `.vfx.json` file. `assets` resolves its `image` and `extends`. */
export function parseEffect(path: string, text: string, assets: AssetCatalog): EffectDef {
  const record = flatten(path, docOf(path, text), assets, [path]);
  // 3D-only keys (flipbook, light, sound, children, …): accepted, not drawn in 2D.
  for (const key of IGNORED) delete record[key];
  const r = new Reader(path, record);
  const burst = r.number('burst', 0, 0);
  if (!Number.isInteger(burst)) bad(path, `"burst" must be a whole number, got ${burst}`);
  const rate = r.number('rate', 0, 0);
  if (burst === 0 && rate === 0) bad(path, 'emits nothing: "burst" and "rate" are both 0', 'Set "burst" (particles at once) or "rate" (per second).');
  const written = r.string('shape') ?? 'circle';
  if (!(VFX_SHAPES as readonly string[]).includes(written)) bad(path, `"shape" must be ${VFX_SHAPES.map((s) => `"${s}"`).join(', ')}, got "${written}"`);
  const shape = written === 'square' ? 'square' : 'circle';
  const image = r.string('image');
  const max = r.number('max', 512, 1);
  if (!Number.isInteger(max)) bad(path, `"max" must be a whole number, got ${max}`);
  const lifetime = r.range('lifetime', 0.5, 0);
  if (lifetime.lo <= 0) bad(path, '"lifetime" must be above 0');
  const blend = r.string('blend') ?? 'alpha';
  if (!(VFX_BLENDS as readonly string[]).includes(blend)) {
    bad(path, `"blend" must be "alpha" or "additive", got "${blend}"`, blend === 'normal' ? 'Write "alpha" (paints over).' : undefined);
  }
  const hazeDoc = record['haze'];
  let haze: EffectHaze2d | null = null;
  if (hazeDoc !== undefined && hazeDoc !== null) {
    if (typeof hazeDoc !== 'object' || Array.isArray(hazeDoc)) bad(path, `"haze" must be an object like {"radius": 2, "strength": 0.5}`);
    const h = hazeDoc as Record<string, unknown>;
    for (const key of Object.keys(h)) {
      if (!HAZE_KEYS.includes(key)) bad(path, `"haze" has an unknown key "${key}"`, `Keys: ${HAZE_KEYS.join(', ')}.`);
    }
    const hr = new Reader(`${path} "haze"`, h);
    haze = {
      radius: hr.number('radius', 2, 0), strength: hr.number('strength', 0.5, 0, 1), ring: hr.number('ring', 0.3, 0.01, 1),
      seconds: hr.number('seconds', 0.5, 0.01),
    };
  }
  return {
    path,
    burst,
    rate,
    duration: r.number('duration', 0, 0),
    lifetime,
    speed: r.range('speed', 2),
    direction: r.number('direction', 90),
    spread: r.number('spread', 360, 0, 360),
    radius: r.number('radius', 0, 0),
    gravity: r.vector('gravity', 0),
    drag: r.number('drag', 0, 0),
    size: r.range('size', 0.15, 0),
    sizeEnd: r.optionalNumber('size_end', 0),
    color: r.color('color', '#ffffff')!,
    colorEnd: r.color('color_end', null),
    spin: r.range('spin', 0),
    shape,
    image: image === null ? null : presentImage(assets, assets.resolve(image, 'images', `${path} "image"`)),
    blend: blend as (typeof VFX_BLENDS)[number],
    haze,
    max,
  };
}

/**
 * An effect whose file isn't available (asset files unchecked; see `AssetCatalog`): it
 * plays and attaches like any other, and emits no particles.
 */
export function unavailableEffect(path: string): EffectDef {
  const zero = { lo: 0, hi: 0 };
  return {
    path, burst: 0, rate: 0, duration: 0, lifetime: { lo: 1, hi: 1 }, speed: zero, direction: 90, spread: 360, radius: 0,
    gravity: [0, 0], drag: 0, size: zero, sizeEnd: null, color: [1, 1, 1, 1], colorEnd: null, spin: zero, shape: 'circle',
    image: null, blend: 'alpha', haze: null, max: 1,
  };
}

/** Effect files by reference, parsed once. */
export class EffectLibrary {
  readonly #assets: AssetCatalog;
  readonly #load: (image: string) => void;
  readonly #byPath = new Map<string, EffectDef>();

  /** `load` queues an effect's image for loading when its file is first read. */
  constructor(assets: AssetCatalog, load: (image: string) => void) {
    this.#assets = assets;
    this.#load = load;
  }

  get(ref: string, where: string): EffectDef {
    if (ref.startsWith(BUILTIN_EFFECT_PREFIX)) {
      fail('PP2063', `${where} names the built-in effect "${ref}", which only a 3D game has`, { fix: 'Play an effect file of this game, Assets.vfx.<name> ("vfx/<name>").' });
    }
    const path = this.#assets.resolve(ref, 'vfx', where);
    let def = this.#byPath.get(path);
    if (def === undefined) {
      def = this.#assets.has(path) ? parseEffect(path, this.#assets.read(path), this.#assets) : unavailableEffect(path);
      this.#byPath.set(path, def);
      if (def.image !== null) this.#load(def.image);
    }
    return def;
  }
}
