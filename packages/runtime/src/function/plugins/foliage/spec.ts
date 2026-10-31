/**
 * The scene's `"foliage"` block: a list of layers, scattered (trees, bushes, plants, rocks,
 * models) or drawn around the camera (grass). Documented in sdk/parallax/foliage.pyi.
 *
 *   "foliage": {"layers": [ … ]}, each layer one of:
 *
 *   {"id": "pines", "kind": "tree", "species": "pine", "density": 0.02, "max": 4000,
 *    "on": "grass", "avoid": ["road"], "area": {"center": [0, 0], "size": [400, 300]},
 *    "exclude": [{"center": [10, 0], "radius": 30}], "spacing": 4, "scale": [0.8, 1.3],
 *    "slope": 30, "height": [0, 80], "seed": 3, "color": [0.3, 0.5, 0.2], "collide": true,
 *    "collider": [0.25, 9]}
 *
 *   {"id": "meadow", "kind": "grass", "density": 40, "on": "grass", "blade_height": [0.3, 0.6],
 *    "draw_radius": 50, "color": [0.35, 0.55, 0.2]}
 *
 *   ("draw_radius", meters 5-200, default 50: how far from the camera grass is drawn; grass only.)
 *
 * `area`/`exclude` are footprints (the terrain's schema, world [x, z]): {"center", "radius"},
 * {"center", "size": [w, d], "rotation"} or {"points": [[x, z], …]}. `on`/`avoid` filters
 * need the terrain plugin and a scene terrain; without them a layer needs an
 * `area` and sits on y = 0.
 */

import { closestMatch, COLOR_FORMS, cosDegrees, fail, parseColor, readFootprint } from '../../../core/index.js';
import type { Footprint } from '../../../core/index.js';
import type { Json, JsonObject, SceneDoc } from '../../../resource/index.js';
import { FOLIAGE_KINDS, FOLIAGE_SPECIES } from '../../services/index.js';
import type { FoliageKind, Rgb3 } from '../../services/index.js';

export interface FoliageLayerSpec {
  readonly id: string;
  readonly kind: FoliageKind;
  readonly species: string | null;
  readonly model: string | null;
  /** Instances per m² (grass: blades per m²). */
  readonly density: number;
  readonly max: number;
  /** Terrain layer names it grows on (any of them), and how much weight they need. */
  readonly layers: readonly string[];
  readonly minWeight: number;
  readonly avoid: readonly string[];
  readonly avoidWeight: number;
  readonly area: Footprint | null;
  readonly exclude: readonly Footprint[];
  readonly spacing: number;
  readonly scale: readonly [number, number];
  /** Steepest ground it grows on, as a minimum normal y; null: any. */
  readonly maxSlopeNormalY: number | null;
  readonly heightBand: readonly [number, number] | null;
  readonly seed: number;
  readonly color: Rgb3;
  readonly collide: boolean;
  readonly sway: number;
  readonly radius: number;
  readonly height: number;
  /** Grass only. */
  readonly bladeHeight: readonly [number, number];
  readonly drawRadius: number;
}

/** Collision radius and height at scale 1, and default color, per look. */
export const LOOKS: Readonly<Record<string, { radius: number; height: number; color: Rgb3; sway: number }>> = {
  'tree:broadleaf': { radius: 0.28, height: 7, color: [0.25, 0.42, 0.16], sway: 0.6 },
  'tree:pine': { radius: 0.24, height: 9, color: [0.16, 0.3, 0.17], sway: 0.45 },
  'tree:birch': { radius: 0.16, height: 8, color: [0.42, 0.55, 0.22], sway: 0.7 },
  'tree:willow': { radius: 0.3, height: 7, color: [0.4, 0.52, 0.22], sway: 0.8 },
  'tree:acacia': { radius: 0.26, height: 6, color: [0.36, 0.44, 0.18], sway: 0.45 },
  'tree:palm': { radius: 0.2, height: 8.5, color: [0.32, 0.5, 0.2], sway: 0.7 },
  'tree:dead': { radius: 0.26, height: 6.5, color: [0.4, 0.37, 0.33], sway: 0.3 },
  'bush:round': { radius: 0.7, height: 1.3, color: [0.25, 0.4, 0.15], sway: 0.5 },
  'bush:sprawl': { radius: 0.9, height: 0.9, color: [0.3, 0.42, 0.18], sway: 0.5 },
  'plant:fern': { radius: 0.35, height: 0.7, color: [0.28, 0.5, 0.2], sway: 0.8 },
  'plant:reed': { radius: 0.2, height: 1.5, color: [0.5, 0.55, 0.3], sway: 1 },
  'rock:boulder': { radius: 0.9, height: 1.0, color: [0.5, 0.49, 0.46], sway: 0 },
  'rock:slab': { radius: 1.1, height: 0.5, color: [0.46, 0.45, 0.43], sway: 0 },
  model: { radius: 0.5, height: 2, color: [1, 1, 1], sway: 0.3 },
  grass: { radius: 0, height: 0.5, color: [0.33, 0.52, 0.2], sway: 1 },
};

const KEYS = [
  'id', 'kind', 'species', 'model', 'density', 'max', 'on', 'min_weight', 'avoid', 'avoid_weight', 'area', 'exclude',
  'spacing', 'scale', 'slope', 'height', 'seed', 'color', 'collide', 'sway', 'collider', 'blade_height', 'draw_radius',
] as const;
/** Old spellings, failed naming the new one (`layer` means a collision layer; `size` is full extents). */
const RENAMED: Readonly<Record<string, { to: string; why: string }>> = {
  layer: { to: 'on', why: '"layer" means a collision layer; the terrain layers an entry grows on are "on"' },
  size: { to: 'collider', why: '"size" means full extents; the collision cylinder [radius, height] is "collider"' },
};

/**
 * The species a layer grows when it names none: one per layer (a stand of one species
 * reads as a wood), picked from the kind's palette by the layer's `seed` and position —
 * the platform engine's rule (foliage_library.ts resolveLayerPalette: `hash1i(seed + n ·
 * 7919) % palette`, n the 1-based layer index, seed 1234 when absent, palette in its
 * order), so a ported scene grows the same species it did there.
 */
export const DEFAULT_PALETTES: Readonly<Record<'tree' | 'bush' | 'plant' | 'rock', readonly string[]>> = {
  tree: ['broadleaf', 'pine', 'birch', 'willow', 'acacia', 'dead'],
  bush: ['round', 'sprawl'],
  plant: ['fern', 'reed'],
  rock: ['boulder'],
};

function mix32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function defaultSpecies(kind: Exclude<FoliageKind, 'model' | 'grass'>, seed: Json | undefined, index: number): string {
  const palette = DEFAULT_PALETTES[kind];
  const s = typeof seed === 'number' && Number.isInteger(seed) ? seed : 1234;
  return palette[mix32(((s + (index + 1) * 7919) | 0) + 0x9e3779b9) % palette.length]!;
}

/** Most instances one scatter layer holds. */
export const MAX_INSTANCES = 200_000;

class Reader {
  readonly #scene: SceneDoc;

  constructor(scene: SceneDoc) {
    this.#scene = scene;
  }

  fail(pointer: string, message: string, fix: string): never {
    return fail('PP3230', `Scene "${this.#scene.id}" foliage: ${message}`, { fix, path: this.#scene.path, pointer: `/foliage${pointer}` });
  }

  number(v: Json | undefined, pointer: string, fallback: number, ok: (n: number) => boolean, rule: string): number {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) this.fail(pointer, `${pointer.split('/').pop()} must be a number that ${rule}`, `Change it to a number that ${rule}.`);
    return v;
  }

  pair(v: Json | undefined, pointer: string): [number, number] {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return this.fail(pointer, `${pointer.split('/').pop()} must be 2 numbers`, 'Write [a, b].');
    }
    return [v[0] as number, v[1] as number];
  }

  names(v: Json | undefined, pointer: string): string[] {
    if (v === undefined) return [];
    const list = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(list) || !list.every((s) => typeof s === 'string' && s !== '')) this.fail(pointer, 'must be a layer name or a list of them', 'Write "grass" or ["grass", "dirt"].');
    return list as string[];
  }

  /** A footprint: the terrain's schema, shared by every region (core/values/footprint_json.ts). */
  shape(v: Json | undefined, pointer: string): Footprint {
    return readFootprint(v, pointer, (at, message, fix) => this.fail(at, message, fix));
  }
}

export function readFoliageSpec(scene: SceneDoc): FoliageLayerSpec[] {
  const block = scene.plugins['foliage'] as Json | undefined;
  if (block === undefined) return [];
  const r: Reader = new Reader(scene);
  const list = (block as JsonObject)['layers'];
  if (!Array.isArray(list)) r.fail('/layers', '"foliage" must be {"layers": [...]}', 'Write "foliage": {"layers": [{"kind": "tree", …}]}.');
  const ids = new Set<string>();
  return (list as Json[]).map((value, i): FoliageLayerSpec => {
    const at = `/layers/${i}`;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return r.fail(at, 'a layer must be an object', 'Write {"kind": "tree", …}.');
    const o = value as JsonObject;
    for (const key of Object.keys(o)) {
      if ((KEYS as readonly string[]).includes(key)) continue;
      const renamed = RENAMED[key];
      if (renamed !== undefined) r.fail(`${at}/${key}`, `"${key}" was renamed "${renamed.to}": ${renamed.why}`, `Rename "${key}" to "${renamed.to}".`);
      const guess = closestMatch(key, KEYS);
      r.fail(`${at}/${key}`, `unknown key "${key}"`, guess === undefined ? `Foliage keys: ${KEYS.join(', ')}.` : `Did you mean "${guess}"?`);
    }
    const kind = o['kind'];
    if (typeof kind !== 'string' || !(FOLIAGE_KINDS as readonly string[]).includes(kind)) {
      r.fail(`${at}/kind`, `kind ${JSON.stringify(kind ?? null)} is not a foliage kind`, `Use one of: ${FOLIAGE_KINDS.join(', ')}.`);
    }
    const k = kind as FoliageKind;
    const id = o['id'] === undefined ? `${k}_${i}` : o['id'];
    if (typeof id !== 'string' || id === '') r.fail(`${at}/id`, 'id must be a name', 'Write "id": "pines".');
    if (ids.has(id)) r.fail(`${at}/id`, `layer "${id}" is listed twice`, 'Give every foliage layer its own id.');
    ids.add(id);

    let species: string | null = null;
    let model: string | null = null;
    if (k === 'model') {
      if (typeof o['model'] !== 'string' || o['model'] === '') r.fail(`${at}/model`, 'a "model" layer needs a "model"', 'Add "model": "models/tree" (assets/models/tree.glb, by its handle).');
      model = o['model'];
      if (o['species'] !== undefined) r.fail(`${at}/species`, 'a "model" layer has no species', 'Remove "species".');
    } else if (k !== 'grass') {
      const options = FOLIAGE_SPECIES[k];
      const s = o['species'] ?? defaultSpecies(k, o['seed'], i);
      if (typeof s !== 'string' || !options.includes(s)) {
        const guess = typeof s === 'string' ? closestMatch(s, options) : undefined;
        r.fail(`${at}/species`, `species ${JSON.stringify(s)} is not a ${k}`, guess === undefined ? `Use one of: ${options.join(', ')}.` : `Did you mean "${guess}"?`);
      }
      species = s;
      if (o['model'] !== undefined) r.fail(`${at}/model`, `a "${k}" layer is built in; "model" is for kind "model"`, 'Remove "model", or use "kind": "model".');
    } else {
      for (const key of ['species', 'model', 'max', 'spacing', 'scale', 'collide', 'collider']) {
        if (o[key] !== undefined) r.fail(`${at}/${key}`, `grass has no "${key}"`, `Remove "${key}".`);
      }
    }
    if (k !== 'grass') for (const key of ['blade_height', 'draw_radius']) if (o[key] !== undefined) r.fail(`${at}/${key}`, `only grass has "${key}"`, `Remove "${key}".`);
    const look = LOOKS[k === 'model' || k === 'grass' ? k : `${k}:${species}`]!;

    const scale = o['scale'] === undefined ? [0.8, 1.2] as [number, number] : r.pair(o['scale'], `${at}/scale`);
    if (!(scale[0] > 0 && scale[0] <= scale[1])) r.fail(`${at}/scale`, 'scale must be [low, high] above 0', 'Write e.g. [0.8, 1.2].');
    // Default: the platform engine's grass clump heights (grass_config heightMin/heightMax).
    const blade = o['blade_height'] === undefined ? [0.35, 0.85] as [number, number] : r.pair(o['blade_height'], `${at}/blade_height`);
    if (!(blade[0] > 0 && blade[0] <= blade[1])) r.fail(`${at}/blade_height`, 'blade_height must be [low, high] above 0', 'Write e.g. [0.3, 0.6].');
    const band = o['height'] === undefined ? null : r.pair(o['height'], `${at}/height`);
    if (band !== null && band[0] > band[1]) r.fail(`${at}/height`, 'height band is backwards', 'Write [low, high].');
    const slope = o['slope'] === undefined ? null : r.number(o['slope'], `${at}/slope`, 0, (n) => n > 0 && n <= 90, 'is from 0 to 90 degrees');
    const parsed = o['color'] === undefined ? null : parseColor(o['color']);
    if (o['color'] !== undefined && (parsed === null || ![parsed.r, parsed.g, parsed.b].every((c) => c >= 0 && c <= 1))) {
      r.fail(`${at}/color`, `color must be ${COLOR_FORMS}`, 'Write e.g. "#4d8033" or [0.3, 0.5, 0.2].');
    }
    const color: Rgb3 | undefined = parsed === null ? undefined : [parsed.r, parsed.g, parsed.b];
    const collide = o['collide'] ?? false;
    if (typeof collide !== 'boolean') r.fail(`${at}/collide`, 'collide must be true or false', 'Write true or false.');
    const seed = r.number(o['seed'], `${at}/seed`, i, Number.isInteger, 'is a whole number');
    const size = o['collider'] === undefined ? null : r.pair(o['collider'], `${at}/collider`);
    if (size !== null && !(size[0] > 0 && size[1] > 0)) r.fail(`${at}/collider`, 'collider must be [radius, height] above 0', 'Write e.g. [0.3, 6].');
    return {
      id: id as string, kind: k, species, model,
      density: r.number(o['density'], `${at}/density`, k === 'grass' ? 30 : 0.01, (n) => n > 0, 'is above 0'),
      max: r.number(o['max'], `${at}/max`, 5000, (n) => Number.isInteger(n) && n > 0 && n <= MAX_INSTANCES, `is a whole number from 1 to ${MAX_INSTANCES}`),
      layers: r.names(o['on'], `${at}/on`),
      minWeight: r.number(o['min_weight'], `${at}/min_weight`, 0.5, (n) => n >= 0 && n <= 1, 'is from 0 to 1'),
      avoid: r.names(o['avoid'], `${at}/avoid`),
      avoidWeight: r.number(o['avoid_weight'], `${at}/avoid_weight`, 0.35, (n) => n >= 0 && n <= 1, 'is from 0 to 1'),
      area: o['area'] === undefined ? null : r.shape(o['area'], `${at}/area`),
      exclude: o['exclude'] === undefined ? [] : Array.isArray(o['exclude'])
        ? (o['exclude'] as Json[]).map((e, j) => r.shape(e, `${at}/exclude/${j}`))
        : r.fail(`${at}/exclude`, 'exclude must be a list of footprints', 'Write "exclude": [{"center": [x, z], "radius": r}].'),
      spacing: r.number(o['spacing'], `${at}/spacing`, 0, (n) => n >= 0, "isn't negative"),
      scale,
      maxSlopeNormalY: slope === null ? null : cosDegrees(slope),
      heightBand: band,
      seed,
      color: color ?? look.color,
      collide: collide as boolean,
      sway: r.number(o['sway'], `${at}/sway`, look.sway, (n) => n >= 0 && n <= 2, 'is from 0 to 2'),
      radius: size?.[0] ?? look.radius,
      height: size?.[1] ?? look.height,
      bladeHeight: blade,
      drawRadius: r.number(o['draw_radius'], `${at}/draw_radius`, 50, (n) => n >= 5 && n <= 200, 'is from 5 to 200 meters'),
    };
  });
}
