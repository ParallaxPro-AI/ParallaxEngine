/**
 * The scene's `"voxels"` block, checked against the block registry. Shape:
 *
 *   {
 *     "y_range": [min, max],          blocks exist for min <= y < max (required)
 *     "render_distance": 4,           chunks drawn and collided around each streaming source
 *     "generator": { ... }            optional; absent: the world starts as air
 *   }
 *
 * The one generator, `"type": "landscape"` (every key but `type`, `strata` optional):
 *
 *   "seed": 0                         integer
 *   "base_height": 0,                 y of the surface where the relief is 0
 *   "amplitude": 0, "frequency": 0.05, "octaves": 1
 *                                     surface y = floor(base_height + amplitude · fbm(x·frequency, z·frequency)),
 *                                     fbm: value noise in [-1, 1], octaves at doubling frequency, halving weight
 *   "noise": "value"                  the noise family: "value" (default) or "lattice", a second seeded
 *                                     value noise (a 2D lattice hash, octave seeds seed + 1013 · i) for
 *                                     worlds authored against it; the same seed gives different hills
 *                                     in each. Slope variation uses the same family
 *   "strata": [{"block": "grass", "depth": 1}, {"block": "dirt", "depth": 3}, {"block": "stone"}]
 *                                     top down from the surface; every layer but the last has a depth,
 *                                     the last fills down to the bottom
 *   "bottom": "bedrock"               the block at y = min
 *   "sea_level": 0, "water": "water"  air at or below sea_level is water
 *   "shore": "sand"                   in columns whose surface is at most sea_level + shore_height, the
 *   "shore_height": 1                 layers with a depth are this block instead
 *   "ores": [{"block": "iron_ore", "chance": 0.06, "min_depth": 3}]
 *                                     in the last stratum, at least min_depth below the surface, each
 *                                     cell becomes the first ore whose seeded roll is below its chance
 *   "trees": {"trunk", "leaves", "on", "spacing": 11, "density": 0.6, "min_height": 4,
 *             "max_height": 6, "radius": 2}
 *                                     at most one tree per spacing × spacing square (seeded position,
 *                                     present with probability density) on a column whose surface block
 *                                     is `on` and above sea_level; trunk min..max_height tall, leaves
 *                                     filling air: radius around the top two trunk blocks, radius - 1
 *                                     on the layer above (corners trimmed)
 *   "ruins": {"block": "relic", "walls": "bricks", "spacing": 48, "chance": 0.3, "size": 5, "height": 2}
 *                                     at most one per spacing square, on dry land: a size × size ring of
 *                                     wall columns `height` tall on each column's own surface (a quarter
 *                                     of the wall blocks missing, by seeded roll), and `block` on the
 *                                     surface at the center. Ruins fill air only, before trees.
 *
 *   "caves": {"frequency": 0.06, "threshold": 0.65, "min_depth": 3}
 *                                     air wherever two octaves of 3D value noise (0..1) reach
 *                                     threshold, at least min_depth below the surface
 *
 * World shaping (each optional; a meadow at spawn, uplands one way and a coast another):
 *
 *   "slopes": [{"direction": 180, "start": 34, "width": 55, "rise": 18, "variation": 0.5,
 *               "surface": "stone", "surface_above": 0.45,
 *               "spires": {"block": "stone", "spacing": [23, 19], "size": 2, "height": 3}}]
 *                                     each slope raises (rise > 0) or sinks (rise < 0) the surface toward
 *                                     a compass `direction` (0: +z, 90: +x, 180: -z): its weight ramps
 *                                     0 → 1 from `start` meters out from the origin over `width` meters,
 *                                     times 1 + variation · broad noise (wavelength 1/variation_frequency,
 *                                     default 0.008), and adds weight · rise to the surface. Where the
 *                                     weight exceeds surface_above (default 0.5), the top block is
 *                                     `surface`, and `spires` (size × size columns `height` tall, one per
 *                                     spacing [x, z] lattice cell) stand on it
 *   "tunnels": {"y": -8, "spacing": 64, "width": 3.9, "height": 3.2, "min_depth": 5,
 *               "cross_y": -10, "cross_radius": 3.5}
 *                                     long tunnels running along x, one every `spacing` meters in z,
 *                                     wandering ±10 m sideways and ±3 m in y about `y` (ellipse
 *                                     half-width × half-height), and cross tunnels running along z, one
 *                                     every spacing in x, round (cross_radius) about cross_y (omit
 *                                     cross_y for none); only at least min_depth below the surface and
 *                                     above the bottom 3 layers
 *   "galleries": [{"from": [12, -12], "to": [64, -12], "width": 2, "height": 4, "slope": 0.48,
 *                  "lowest": -12}]
 *                                     a straight passage dug from the surface at `from` toward `to`
 *                                     (x, z): within `width` of the line, `height` tall over a floor that
 *                                     starts at the surface and drops `slope` per meter, never below
 *                                     `lowest`. Open at the top where it starts, so it is found from
 *                                     the surface; it joins tunnels where it reaches them
 *
 * `"mode": "smooth"` (default "blocks") makes a density lattice meshed smooth and dug
 * anywhere (smooth.ts): the same generator, without trees, ruins, water, shore, slope
 * surfaces / spires, tunnels or galleries (they place or carve blocks; slopes still shape it), at most 255 block types, and no block with a prefab in the project.
 *
 * Generated blocks may not name a prefab (PP3627): a block entity exists only for a block
 * placed with `ctx.voxels.set`.
 */

import { closestMatch, fail } from '../../../core/index.js';
import type { Json, JsonObject, SceneDoc } from '../../../resource/index.js';
import type { BlockTable } from './blocks.js';

export interface Stratum {
  readonly block: number;
  /** Undefined for the last (unbounded) stratum. */
  readonly depth: number | undefined;
}

export interface Ore {
  readonly block: number;
  readonly chance: number;
  readonly minDepth: number;
}

export interface Trees {
  readonly trunk: number;
  readonly leaves: number;
  readonly on: number;
  readonly spacing: number;
  readonly density: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly radius: number;
}

export interface Ruins {
  readonly block: number;
  readonly walls: number;
  readonly spacing: number;
  readonly chance: number;
  readonly size: number;
  readonly height: number;
}

export interface Caves {
  readonly frequency: number;
  readonly threshold: number;
  readonly minDepth: number;
}

export interface Spires {
  readonly block: number;
  readonly spacingX: number;
  readonly spacingZ: number;
  readonly size: number;
  readonly height: number;
}

/** A directional rise or fall of the surface (uplands, a coast). */
export interface Slope {
  /** Unit (x, z) of the compass direction it rises toward. */
  readonly dirX: number;
  readonly dirZ: number;
  readonly start: number;
  readonly width: number;
  readonly rise: number;
  readonly variation: number;
  readonly variationFrequency: number;
  readonly surface: number | undefined;
  readonly surfaceAbove: number;
  readonly spires: Spires | undefined;
}

export interface Tunnels {
  readonly y: number;
  readonly spacing: number;
  readonly width: number;
  readonly height: number;
  readonly minDepth: number;
  /** Undefined: no cross tunnels. */
  readonly crossY: number | undefined;
  readonly crossRadius: number;
}

export interface Gallery {
  readonly fromX: number;
  readonly fromZ: number;
  readonly toX: number;
  readonly toZ: number;
  readonly width: number;
  readonly height: number;
  readonly slope: number;
  readonly lowest: number;
}

export type LandscapeNoise = 'value' | 'lattice';

export interface LandscapeSpec {
  readonly seed: number;
  readonly noise: LandscapeNoise;
  readonly baseHeight: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly octaves: number;
  readonly strata: readonly Stratum[];
  readonly bottom: number | undefined;
  readonly seaLevel: number;
  readonly water: number | undefined;
  readonly shore: number | undefined;
  /** Columns up to sea_level + this are shore. */
  readonly shoreHeight: number;
  readonly ores: readonly Ore[];
  readonly trees: Trees | undefined;
  readonly ruins: Ruins | undefined;
  readonly caves: Caves | undefined;
  readonly slopes: readonly Slope[];
  readonly tunnels: Tunnels | undefined;
  readonly galleries: readonly Gallery[];
}

export interface VoxelSceneSpec {
  /** `blocks` (cubes) or `smooth` (a density lattice meshed smooth, dug anywhere). */
  readonly mode: 'blocks' | 'smooth';
  readonly yMin: number;
  readonly yMax: number;
  readonly renderDistance: number;
  readonly generator: LandscapeSpec | undefined;
}

const KEYS = ['mode', 'y_range', 'render_distance', 'generator'] as const;
const LANDSCAPE_KEYS = [
  'type', 'seed', 'noise', 'base_height', 'shore_height', 'amplitude', 'frequency', 'octaves', 'strata', 'bottom', 'sea_level', 'water', 'shore',
  'ores', 'trees', 'ruins', 'caves', 'slopes', 'tunnels', 'galleries',
] as const;
const SLOPE_KEYS = ['direction', 'start', 'width', 'rise', 'variation', 'variation_frequency', 'surface', 'surface_above', 'spires'] as const;
const SPIRE_KEYS = ['block', 'spacing', 'size', 'height'] as const;
const TUNNEL_KEYS = ['y', 'spacing', 'width', 'height', 'min_depth', 'cross_y', 'cross_radius'] as const;
const GALLERY_KEYS = ['from', 'to', 'width', 'height', 'slope', 'lowest'] as const;
const CAVE_KEYS = ['frequency', 'threshold', 'min_depth'] as const;
const STRATUM_KEYS = ['block', 'depth'] as const;
const ORE_KEYS = ['block', 'chance', 'min_depth'] as const;
const TREE_KEYS = ['trunk', 'leaves', 'on', 'spacing', 'density', 'min_height', 'max_height', 'radius'] as const;
const RUIN_KEYS = ['block', 'walls', 'spacing', 'chance', 'size', 'height'] as const;
const MAX_HEIGHT_SPAN = 4096;

class SpecReader {
  readonly #scene: SceneDoc;
  readonly #blocks: BlockTable;

  constructor(scene: SceneDoc, blocks: BlockTable) {
    this.#scene = scene;
    this.#blocks = blocks;
  }

  fail(pointer: string, message: string, fix: string): never {
    return fail('PP3620', `Scene "${this.#scene.id}" voxels: ${message}`, { fix, path: this.#scene.path, pointer: `/voxels${pointer}` });
  }

  keys(obj: JsonObject, pointer: string, allowed: readonly string[]): void {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      const guess = closestMatch(key, allowed);
      this.fail(`${pointer}/${key}`, `unknown key "${key}"`, guess === undefined ? `Keys here: ${allowed.join(', ')}.` : `Did you mean "${guess}"?`);
    }
  }

  object(value: Json | undefined, pointer: string, what: string): JsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return this.fail(pointer, `${what} must be an object`, `Write ${what} as {...}.`);
    return value as JsonObject;
  }

  number(value: Json | undefined, pointer: string, fallback: number, check?: (n: number) => string | undefined): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.fail(pointer, `${name(pointer)} must be a number`, 'Write a number.');
    const problem = check?.(value);
    if (problem !== undefined) this.fail(pointer, `${name(pointer)} ${problem}`, `Change ${name(pointer)}.`);
    return value;
  }

  integer(value: Json | undefined, pointer: string, fallback: number, check?: (n: number) => string | undefined): number {
    const n = this.number(value, pointer, fallback, check);
    if (!Number.isInteger(n)) this.fail(pointer, `${name(pointer)} must be a whole number`, `Write ${name(pointer)} without a fraction.`);
    return n;
  }

  /** A block id → its index; generated blocks can't have a prefab. */
  block(value: Json | undefined, pointer: string): number {
    if (typeof value !== 'string') return this.fail(pointer, `${name(pointer)} must name a block`, 'Write a block id from content/block/, e.g. "stone".');
    const index = this.#blocks.lookup(value);
    if (index === undefined) {
      const guess = closestMatch(value, this.#blocks.ids());
      return this.fail(pointer, `there is no block "${value}"`, guess === undefined ? 'Add content/block/<id>.json.' : `Did you mean "${guess}"?`);
    }
    const type = this.#blocks.type(index);
    if (type.prefab !== null) {
      fail('PP3627', `Scene "${this.#scene.id}" voxels: the generator places "${value}", which has a prefab`, {
        path: this.#scene.path, pointer: `/voxels${pointer}`,
        fix: 'Generate only blocks without a "prefab"; place block entities (chests, doors) with ctx.voxels.set.',
      });
    }
    return index;
  }

  optionalBlock(value: Json | undefined, pointer: string): number | undefined {
    return value === undefined ? undefined : this.block(value, pointer);
  }

  /** An [a, b] pair of numbers. */
  pair(value: Json | undefined, pointer: string): [number, number] {
    if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return this.fail(pointer, `${name(pointer)} must be [x, z]`, `Write ${name(pointer)} as two numbers, e.g. [12, -12].`);
    }
    return [value[0] as number, value[1] as number];
  }

  list(value: Json | undefined, pointer: string): readonly Json[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return this.fail(pointer, `${name(pointer)} must be a list`, `Write ${name(pointer)} as [...].`);
    return value;
  }
}

function name(pointer: string): string {
  return pointer.split('/').filter((p) => p !== '').join('.') || 'the block';
}

const positive = (n: number): string | undefined => (n > 0 ? undefined : 'must be greater than 0');
const nonNegative = (n: number): string | undefined => (n >= 0 ? undefined : "can't be negative");
const probability = (n: number): string | undefined => (n >= 0 && n <= 1 ? undefined : 'must be between 0 and 1');

function readLandscape(r: SpecReader, gen: JsonObject, smooth: boolean): LandscapeSpec {
  r.keys(gen, '/generator', LANDSCAPE_KEYS);
  if (gen['type'] !== 'landscape') {
    r.fail('/generator/type', `unknown generator type ${JSON.stringify(gen['type'] ?? null)}`, 'Use "type": "landscape".');
  }
  const strataJson = r.list(gen['strata'], '/generator/strata');
  const strata = strataJson.map((value, i): Stratum => {
    const at = `/generator/strata/${i}`;
    const obj = r.object(value, at, 'a stratum');
    r.keys(obj, at, STRATUM_KEYS);
    const last = i === strataJson.length - 1;
    if (!last && obj['depth'] === undefined) r.fail(`${at}/depth`, 'every stratum but the last needs a "depth"', 'Add "depth": <blocks>.');
    if (last && obj['depth'] !== undefined) r.fail(`${at}/depth`, 'the last stratum fills down to the bottom and takes no "depth"', 'Remove "depth".');
    return { block: r.block(obj['block'], `${at}/block`), depth: last ? undefined : r.integer(obj['depth'], `${at}/depth`, 1, positive) };
  });
  if (strata.length === 0) r.fail('/generator/strata', 'needs at least one stratum', 'Add "strata": [{"block": "stone"}].');

  const ores = r.list(gen['ores'], '/generator/ores').map((value, i): Ore => {
    const at = `/generator/ores/${i}`;
    const obj = r.object(value, at, 'an ore');
    r.keys(obj, at, ORE_KEYS);
    return {
      block: r.block(obj['block'], `${at}/block`),
      chance: r.number(obj['chance'], `${at}/chance`, 0, probability),
      minDepth: r.integer(obj['min_depth'], `${at}/min_depth`, 0, nonNegative),
    };
  });

  let trees: Trees | undefined;
  if (gen['trees'] !== undefined) {
    const obj = r.object(gen['trees'], '/generator/trees', 'trees');
    r.keys(obj, '/generator/trees', TREE_KEYS);
    for (const key of ['trunk', 'leaves', 'on']) {
      if (obj[key] === undefined) r.fail(`/generator/trees/${key}`, `trees need "${key}"`, `Add "${key}": "<block id>".`);
    }
    const radius = r.integer(obj['radius'], '/generator/trees/radius', 2, nonNegative);
    const spacing = r.integer(obj['spacing'], '/generator/trees/spacing', 11, positive);
    if (spacing < 2 * radius + 1) r.fail('/generator/trees/spacing', 'spacing must be at least 2 · radius + 1', 'Raise spacing or lower radius.');
    const minHeight = r.integer(obj['min_height'], '/generator/trees/min_height', 4, positive);
    const maxHeight = r.integer(obj['max_height'], '/generator/trees/max_height', minHeight, positive);
    if (maxHeight < minHeight) r.fail('/generator/trees/max_height', 'max_height is below min_height', 'Make max_height >= min_height.');
    trees = {
      trunk: r.block(obj['trunk'], '/generator/trees/trunk'),
      leaves: r.block(obj['leaves'], '/generator/trees/leaves'),
      on: r.block(obj['on'], '/generator/trees/on'),
      spacing,
      density: r.number(obj['density'], '/generator/trees/density', 1, probability),
      minHeight,
      maxHeight,
      radius,
    };
  }

  let ruins: Ruins | undefined;
  if (gen['ruins'] !== undefined) {
    const obj = r.object(gen['ruins'], '/generator/ruins', 'ruins');
    r.keys(obj, '/generator/ruins', RUIN_KEYS);
    for (const key of ['block', 'walls']) {
      if (obj[key] === undefined) r.fail(`/generator/ruins/${key}`, `ruins need "${key}"`, `Add "${key}": "<block id>".`);
    }
    const size = r.integer(obj['size'], '/generator/ruins/size', 5, (n) => (n >= 3 && n % 2 === 1 ? undefined : 'must be an odd number of at least 3'));
    const spacing = r.integer(obj['spacing'], '/generator/ruins/spacing', 48, positive);
    if (spacing < size) r.fail('/generator/ruins/spacing', 'spacing must be at least size', 'Raise spacing or lower size.');
    ruins = {
      block: r.block(obj['block'], '/generator/ruins/block'),
      walls: r.block(obj['walls'], '/generator/ruins/walls'),
      spacing,
      chance: r.number(obj['chance'], '/generator/ruins/chance', 0.3, probability),
      size,
      height: r.integer(obj['height'], '/generator/ruins/height', 2, positive),
    };
  }

  let caves: Caves | undefined;
  if (gen['caves'] !== undefined) {
    const obj = r.object(gen['caves'], '/generator/caves', 'caves');
    r.keys(obj, '/generator/caves', CAVE_KEYS);
    caves = {
      frequency: r.number(obj['frequency'], '/generator/caves/frequency', 0.06, positive),
      threshold: r.number(obj['threshold'], '/generator/caves/threshold', 0.65, probability),
      minDepth: r.number(obj['min_depth'], '/generator/caves/min_depth', 3, nonNegative),
    };
  }
  const slopes = r.list(gen['slopes'], '/generator/slopes').map((value, i) => readSlope(r, value, `/generator/slopes/${i}`, smooth));

  let tunnels: Tunnels | undefined;
  if (gen['tunnels'] !== undefined) {
    const at = '/generator/tunnels';
    const obj = r.object(gen['tunnels'], at, 'tunnels');
    r.keys(obj, at, TUNNEL_KEYS);
    tunnels = {
      y: r.number(obj['y'], `${at}/y`, 0),
      spacing: r.number(obj['spacing'], `${at}/spacing`, 64, positive),
      width: r.number(obj['width'], `${at}/width`, 3.9, positive),
      height: r.number(obj['height'], `${at}/height`, 3.2, positive),
      minDepth: r.number(obj['min_depth'], `${at}/min_depth`, 5, nonNegative),
      crossY: obj['cross_y'] === undefined ? undefined : r.number(obj['cross_y'], `${at}/cross_y`, 0),
      crossRadius: r.number(obj['cross_radius'], `${at}/cross_radius`, 3.5, positive),
    };
  }

  const galleries = r.list(gen['galleries'], '/generator/galleries').map((value, i): Gallery => {
    const at = `/generator/galleries/${i}`;
    const obj = r.object(value, at, 'a gallery');
    r.keys(obj, at, GALLERY_KEYS);
    const [fromX, fromZ] = r.pair(obj['from'], `${at}/from`);
    const [toX, toZ] = r.pair(obj['to'], `${at}/to`);
    if (fromX === toX && fromZ === toZ) r.fail(`${at}/to`, 'a gallery needs "to" apart from "from"', 'Move "to" away from "from".');
    return {
      fromX, fromZ, toX, toZ,
      width: r.number(obj['width'], `${at}/width`, 2, nonNegative),
      height: r.integer(obj['height'], `${at}/height`, 4, positive),
      slope: r.number(obj['slope'], `${at}/slope`, 0.5, nonNegative),
      lowest: r.integer(obj['lowest'], `${at}/lowest`, -1_000_000),
    };
  });

  if (smooth) {
    for (const key of ['tunnels', 'galleries'] as const) {
      if (gen[key] !== undefined) {
        r.fail(`/generator/${key}`, `"${key}" carves blocks, which a smooth world doesn't have`, `Remove "${key}" (caves carve smooth worlds), or use "mode": "blocks".`);
      }
    }
    for (const key of ['trees', 'ruins', 'water', 'shore'] as const) {
      if (gen[key] !== undefined) {
        r.fail(`/generator/${key}`, `"${key}" places blocks, which a smooth world doesn't have`, `Remove "${key}", or use "mode": "blocks".`);
      }
    }
  }

  return {
    caves,
    seed: r.integer(gen['seed'], '/generator/seed', 0),
    noise: readNoise(r, gen['noise']),
    baseHeight: r.integer(gen['base_height'], '/generator/base_height', 0),
    amplitude: r.number(gen['amplitude'], '/generator/amplitude', 0, nonNegative),
    frequency: r.number(gen['frequency'], '/generator/frequency', 0.05, positive),
    octaves: r.integer(gen['octaves'], '/generator/octaves', 1, (n) => (n >= 1 && n <= 8 ? undefined : 'must be 1 to 8')),
    strata,
    bottom: r.optionalBlock(gen['bottom'], '/generator/bottom'),
    seaLevel: r.integer(gen['sea_level'], '/generator/sea_level', 0),
    water: r.optionalBlock(gen['water'], '/generator/water'),
    shore: r.optionalBlock(gen['shore'], '/generator/shore'),
    shoreHeight: r.integer(gen['shore_height'], '/generator/shore_height', 1, nonNegative),
    ores,
    trees,
    ruins,
    slopes,
    tunnels,
    galleries,
  };
}

function readNoise(r: SpecReader, value: Json | undefined): LandscapeNoise {
  if (value === undefined || value === 'value' || value === 'lattice') return value ?? 'value';
  return r.fail('/generator/noise', `unknown noise ${JSON.stringify(value)}`, 'Use "noise": "value" or "lattice".');
}

function readSlope(r: SpecReader, value: Json, at: string, smooth: boolean): Slope {
  const obj = r.object(value, at, 'a slope');
  r.keys(obj, at, SLOPE_KEYS);
  if (obj['rise'] === undefined) r.fail(`${at}/rise`, 'a slope needs "rise"', 'Add "rise": <meters> (negative sinks the land).');
  if (smooth) {
    for (const key of ['surface', 'spires'] as const) {
      if (obj[key] !== undefined) r.fail(`${at}/${key}`, `"${key}" places blocks, which a smooth world doesn't have`, `Remove "${key}", or use "mode": "blocks".`);
    }
  }
  const direction = r.number(obj['direction'], `${at}/direction`, 0) * Math.PI / 180;
  let spires: Spires | undefined;
  if (obj['spires'] !== undefined) {
    const sat = `${at}/spires`;
    const s = r.object(obj['spires'], sat, 'spires');
    r.keys(s, sat, SPIRE_KEYS);
    if (s['block'] === undefined) r.fail(`${sat}/block`, 'spires need "block"', 'Add "block": "<block id>".');
    const size = r.integer(s['size'], `${sat}/size`, 2, positive);
    const spacing = s['spacing'];
    const one = Array.isArray(spacing) ? 0 : r.integer(spacing, `${sat}/spacing`, 20, positive);
    const [spacingX, spacingZ] = Array.isArray(spacing) ? r.pair(spacing, `${sat}/spacing`) : [one, one];
    for (const n of [spacingX, spacingZ]) {
      if (!Number.isInteger(n) || n <= size) r.fail(`${sat}/spacing`, 'spires spacing must be whole numbers above size', 'Raise spacing or lower size.');
    }
    spires = { block: r.block(s['block'], `${sat}/block`), spacingX, spacingZ, size, height: r.integer(s['height'], `${sat}/height`, 3, positive) };
  }
  return {
    dirX: Math.sin(direction),
    dirZ: Math.cos(direction),
    start: r.number(obj['start'], `${at}/start`, 0),
    width: r.number(obj['width'], `${at}/width`, 32, positive),
    rise: r.number(obj['rise'], `${at}/rise`, 0),
    variation: r.number(obj['variation'], `${at}/variation`, 0, (n) => (n >= 0 && n <= 1 ? undefined : 'must be 0 to 1')),
    variationFrequency: r.number(obj['variation_frequency'], `${at}/variation_frequency`, 0.008, positive),
    surface: r.optionalBlock(obj['surface'], `${at}/surface`),
    surfaceAbove: r.number(obj['surface_above'], `${at}/surface_above`, 0.5, nonNegative),
    spires,
  };
}

/** The scene's voxels block, or undefined when it has none. */
export function readVoxelSpec(scene: SceneDoc, blocks: BlockTable): VoxelSceneSpec | undefined {
  const block = scene.plugins['voxels'];
  if (block === undefined) return undefined;
  const r = new SpecReader(scene, blocks);
  r.keys(block, '', KEYS);
  const range = block['y_range'];
  if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => Number.isInteger(n))) {
    return r.fail('/y_range', 'needs "y_range": [min, max] (whole numbers)', 'Add "y_range": [-32, 64]: blocks exist for min <= y < max.');
  }
  const [yMin, yMax] = range as [number, number];
  if (!(yMax > yMin) || yMax - yMin > MAX_HEIGHT_SPAN) {
    r.fail('/y_range', `y_range must have min < max and span at most ${MAX_HEIGHT_SPAN}`, 'Write "y_range": [min, max] with min < max.');
  }
  const renderDistance = r.integer(block['render_distance'], '/render_distance', 4, (n) => (n >= 1 && n <= 32 ? undefined : 'must be 1 to 32'));
  const mode = block['mode'] ?? 'blocks';
  if (mode !== 'blocks' && mode !== 'smooth') r.fail('/mode', `mode must be "blocks" or "smooth", got ${JSON.stringify(mode)}`, 'Use "mode": "smooth" for dig-anywhere terrain.');
  const smooth = mode === 'smooth';
  if (smooth) {
    const tooMany = blocks.count > 255;
    if (tooMany) r.fail('/mode', `a smooth world takes at most 255 block types, the project has ${blocks.count}`, 'Use fewer block types, or "mode": "blocks".');
    for (const id of blocks.ids()) {
      if (blocks.type(blocks.lookup(id)!).prefab !== null) {
        fail('PP3627', `Scene "${scene.id}" voxels: smooth worlds have no block entities, and block "${id}" has a prefab`, {
          path: scene.path, pointer: '/voxels/mode', fix: 'Spawn such objects as ordinary entities in a smooth world, or use "mode": "blocks".',
        });
      }
    }
  }
  const generator = block['generator'] === undefined ? undefined : readLandscape(r, r.object(block['generator'], '/generator', 'generator'), smooth);
  return { mode: smooth ? 'smooth' : 'blocks', yMin, yMax, renderDistance, generator };
}
