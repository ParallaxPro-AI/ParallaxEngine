/**
 * The scene's `"terrain"` block, checked and normalized into a `TerrainSpec` (plain data:
 * it crosses to job workers). The format is documented in sdk/parallax/terrain.pyi; in
 * short, every key but `size` and `layers` optional:
 *
 *   size, resolution, base_height                    the grid
 *   max_height + seed  |  noise: [{kind, amplitude, wavelength, octaves, gain, lacunarity, seed}]
 *   hills: [{<shape>, height, feather}]              raised (or sunk) footprints, eased up over
 *                                                    `feather` meters inward from the edge
 *   flats: [{<shape>, height, feather, mode}]        ground eased to a height (set / carve / fill)
 *   holes: [<shape>]                                 ground cut away
 *   water_level
 *   layers: ["grass", {name, texture, normal, tile, tint, color, roughness, detail,
 *             pattern, variation, relief}]                                     at most 8
 *     (a layer named after a ground material in catalog.ts draws it unless "texture" says
 *     otherwise; "color" on a textured layer sets the texture's average tone)
 *   default_layer
 *   rules: [{layer, slope: [from°, full°], height: [low, high], feather, strength}]
 *   paint: [{layer, <shape>, feather, noise, strength}]                         in order
 *   paths: [{paint, points, width, feather, closed, strength, flatten}]        in order
 *   brush: [{id, <shape>, height, tags}]             tall grass that hides
 *
 * A <shape> is `"center": [x, z]` with `"radius"` (a circle) or `"size": [w, d]` and an
 * optional `"rotation"` in degrees (a rectangle), or `"points": [[x, z], …]` (a polygon).
 */

import { closestMatch, COLOR_FORMS, cosDegrees, fail, parseColor, rectFootprint } from '../../../core/index.js';
import type { Footprint, FractalKind, FractalNoise } from '../../../core/index.js';
import { handleFormProblem } from '../../../resource/index.js';
import type { Json, JsonObject, SceneDoc } from '../../../resource/index.js';
import { MAX_LAYERS, TERRAIN_PATTERNS } from '../../services/index.js';
import { GROUND_MATERIALS, groundByAlbedo, groundFor } from './catalog.js';
import type { Rgb3, TerrainGradePath, TerrainLayer, TerrainPattern } from '../../services/index.js';

export interface Hill {
  readonly shape: Footprint;
  readonly height: number;
  readonly feather: number;
}

export type FlatMode = 'set' | 'carve' | 'fill';

export interface Flat {
  readonly shape: Footprint;
  readonly height: number;
  readonly feather: number;
  readonly mode: FlatMode;
}

export interface SplatRule {
  readonly layer: number;
  /** Normal-y band: no cover above `from` (flatter), full cover at `full` and steeper; null: any slope. */
  readonly slope: { readonly from: number; readonly full: number } | null;
  /** Height band in meters, eased over `feather` outside it; null: any height. */
  readonly height: { readonly low: number; readonly high: number } | null;
  readonly feather: number;
  readonly strength: number;
}

export interface Paint {
  readonly layer: number;
  readonly shape: Footprint;
  readonly feather: number;
  /** 0..1: how far noise pushes the edge in and out, as a fraction of the feather. */
  readonly noise: number;
  readonly strength: number;
  readonly seed: number;
}

export interface Path {
  /** Layer painted along the path, or null (a grading-only path). */
  readonly layer: number | null;
  readonly points: readonly (readonly [number, number])[];
  readonly closed: boolean;
  readonly width: number;
  readonly feather: number;
  readonly strength: number;
  /** Grade the ground to the path: eased over `feather` meters beyond the edge, `offset` meters above the smoothed profile. */
  readonly flatten: { readonly feather: number; readonly offset: number } | null;
}

export interface Brush {
  readonly id: string;
  readonly shape: Footprint;
  readonly height: number;
  readonly tags: readonly string[];
}

export interface TerrainSpec {
  readonly width: number;
  readonly depth: number;
  /** Quads along the longer side of the gameplay grid. */
  readonly resolution: number;
  readonly baseHeight: number;
  readonly noise: readonly FractalNoise[];
  readonly hills: readonly Hill[];
  readonly flats: readonly Flat[];
  readonly holes: readonly Footprint[];
  readonly waterLevel: number | null;
  readonly layers: readonly TerrainLayer[];
  readonly defaultLayer: number;
  readonly rules: readonly SplatRule[];
  readonly paint: readonly Paint[];
  readonly paths: readonly Path[];
  readonly brush: readonly Brush[];
}

/** The default grid: one quad per meter, at most this many along the longer side. */
export const DEFAULT_MAX_QUADS = 512;
export const MAX_RESOLUTION = 1024;

const KEYS = [
  'size', 'resolution', 'base_height', 'max_height', 'seed', 'noise', 'hills', 'flats', 'holes', 'water_level',
  'layers', 'default_layer', 'rules', 'paint', 'paths', 'brush',
] as const;
const SHAPE_KEYS = ['center', 'radius', 'size', 'rotation', 'points'] as const;
const NOISE_KEYS = ['kind', 'amplitude', 'wavelength', 'octaves', 'gain', 'lacunarity', 'seed'] as const;
const LAYER_KEYS = ['name', 'texture', 'normal', 'tile', 'tint', 'color', 'roughness', 'detail', 'pattern', 'variation', 'relief'] as const;

const isMaterialName = (name: string): boolean => Object.prototype.hasOwnProperty.call(GROUND_MATERIALS, name);
const DETAIL_KEYS = ['texture', 'tile', 'strength'] as const;
const NOISE_KINDS: readonly FractalKind[] = ['fbm', 'ridged', 'billow'];
const FLAT_MODES: readonly FlatMode[] = ['set', 'carve', 'fill'];

class BlockReader {
  readonly #scene: SceneDoc;

  constructor(scene: SceneDoc) {
    this.#scene = scene;
  }

  fail(pointer: string, message: string, fix: string): never {
    return fail('PP3200', `Scene "${this.#scene.id}" terrain: ${message}`, { fix, path: this.#scene.path, pointer: `/terrain${pointer}` });
  }

  keys(obj: JsonObject, pointer: string, allowed: readonly string[]): void {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      const guess = closestMatch(key, allowed);
      this.fail(`${pointer}/${key}`, `unknown key "${key}"`, guess === undefined ? `Keys here: ${allowed.join(', ')}.` : `Did you mean "${guess}"?`);
    }
  }

  number(value: Json | undefined, pointer: string, fallback: number, check?: (n: number) => string | undefined): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) this.fail(pointer, `${name(pointer)} must be a number`, 'Write a number, e.g. 0.');
    const problem = check?.(value);
    if (problem !== undefined) this.fail(pointer, `${name(pointer)} ${problem}`, `Change ${name(pointer)}.`);
    return value;
  }

  required(obj: JsonObject, key: string, pointer: string, check?: (n: number) => string | undefined): number {
    if (obj[key] === undefined) this.fail(`${pointer}/${key}`, `needs "${key}"`, `Add "${key}".`);
    return this.number(obj[key], `${pointer}/${key}`, 0, check);
  }

  integer(value: Json | undefined, pointer: string, fallback: number, min: number, max: number): number {
    const n = this.number(value, pointer, fallback);
    if (!Number.isInteger(n) || n < min || n > max) this.fail(pointer, `${name(pointer)} must be a whole number from ${min} to ${max}`, `Write a whole number from ${min} to ${max}.`);
    return n;
  }

  pair(value: Json | undefined, pointer: string): readonly [number, number] {
    if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return this.fail(pointer, `${name(pointer)} must be a list of 2 numbers`, `Write ${name(pointer)} as [a, b].`);
    }
    return [value[0] as number, value[1] as number];
  }

  rgb(value: Json | undefined, pointer: string, fallback: Rgb3 | null): Rgb3 | null {
    if (value === undefined) return fallback;
    const c = parseColor(value);
    if (c === null || c.r < 0 || c.g < 0 || c.b < 0) {
      return this.fail(pointer, `${name(pointer)} must be a colour: ${COLOR_FORMS}`, 'Write e.g. "#ffffff" or [1, 1, 1].');
    }
    return [c.r, c.g, c.b];
  }

  object(value: Json | undefined, pointer: string, what: string): JsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return this.fail(pointer, `${what} must be an object`, `Write ${what} as {...}.`);
    return value as JsonObject;
  }

  list(value: Json | undefined, pointer: string, example: string): readonly Json[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) this.fail(pointer, `${name(pointer)} must be a list`, `Write ${example}.`);
    return value as readonly Json[];
  }

  string(value: Json | undefined, pointer: string): string {
    if (typeof value !== 'string' || value === '') return this.fail(pointer, `${name(pointer)} must be a non-empty string`, 'Write a name.');
    return value;
  }
}

function name(pointer: string): string {
  return pointer.split('/').filter((p) => p !== '' && !/^\d+$/.test(p)).pop() ?? 'terrain';
}

const positive = (n: number): string | undefined => (n > 0 ? undefined : 'must be greater than 0');
const nonNegative = (n: number): string | undefined => (n >= 0 ? undefined : "can't be negative");
const unit = (n: number): string | undefined => (n >= 0 && n <= 1 ? undefined : 'must be from 0 to 1');

/** A footprint from `center` + `radius` / `size` (+ `rotation`), or `points`. */
function readShape(r: BlockReader, obj: JsonObject, pointer: string): Footprint {
  if (obj['points'] !== undefined) {
    for (const key of ['center', 'radius', 'size', 'rotation']) {
      if (obj[key] !== undefined) r.fail(`${pointer}/${key}`, `a polygon ("points") takes no "${key}"`, 'Give either points, or a center with a radius or size.');
    }
    const list = r.list(obj['points'], `${pointer}/points`, '"points": [[x, z], [x, z], [x, z]]');
    if (list.length < 3) r.fail(`${pointer}/points`, 'a polygon needs at least 3 points', 'Add points, or use a center with a radius or size.');
    return { kind: 'polygon', points: list.map((p, i) => r.pair(p, `${pointer}/points/${i}`)) };
  }
  if (obj['center'] === undefined) r.fail(`${pointer}/center`, 'needs a "center" (or "points")', 'Add "center": [x, z] and a "radius" or "size".');
  const [x, z] = r.pair(obj['center'], `${pointer}/center`);
  const hasRadius = obj['radius'] !== undefined;
  const hasSize = obj['size'] !== undefined;
  if (hasRadius === hasSize) {
    r.fail(pointer, hasRadius ? 'has both "radius" and "size"' : 'needs a "radius" or a "size"', 'Give "radius" for a circle or "size": [w, d] for a rectangle.');
  }
  if (hasRadius) {
    if (obj['rotation'] !== undefined) r.fail(`${pointer}/rotation`, 'a circle has no rotation', 'Remove "rotation".');
    return { kind: 'circle', x, z, radius: r.number(obj['radius'], `${pointer}/radius`, 0, nonNegative) };
  }
  const [w, d] = r.pair(obj['size'], `${pointer}/size`);
  if (!(w >= 0 && d >= 0)) r.fail(`${pointer}/size`, "size can't be negative", 'Give a width and depth of 0 or more.');
  return rectFootprint(x, z, w, d, r.number(obj['rotation'], `${pointer}/rotation`, 0));
}

function readLayer(r: BlockReader, value: Json, pointer: string): TerrainLayer {
  const plain = { tint: [1, 1, 1] as Rgb3, color: null, roughness: 0.9, detail: null, pattern: null, variation: 0.5, relief: 1 };
  if (typeof value === 'string') {
    if (value === '') r.fail(pointer, 'a layer name is empty', 'Name the layer ("grass").');
    const ground = groundFor(value);
    return { name: value, texture: ground?.albedo ?? null, normal: ground?.normal ?? null, tile: ground?.tile ?? 8, ...plain };
  }
  const obj = r.object(value, pointer, 'a layer');
  r.keys(obj, pointer, LAYER_KEYS);
  const layerName = obj['name'];
  if (typeof layerName !== 'string' || layerName === '') return r.fail(`${pointer}/name`, 'a layer needs a "name"', 'Add "name": "grass".');
  // The texture: a project image's handle ("images/road") or hosted URL, a ground material's
  // name, null (none), or by default the ground material the layer's name stands for.
  const written = obj['texture'];
  if (written !== undefined && written !== null && (typeof written !== 'string' || written === '')) {
    r.fail(`${pointer}/texture`, 'texture must be an image, a ground material or null', 'Write an image handle ("images/<name>"), a hosted URL, a ground material ("rocky_terrain") or null.');
  }
  for (const key of ['texture', 'normal'] as const) {
    const ref = obj[key];
    const form = typeof ref === 'string' && !isMaterialName(ref) && ref.startsWith('assets/') ? handleFormProblem(ref, 'images') : undefined;
    if (form !== undefined) r.fail(`${pointer}/${key}`, form.message, `Write "${form.handle}".`);
  }
  const ground = written === undefined ? groundFor(layerName)
    : typeof written !== 'string' ? undefined
      : isMaterialName(written) ? GROUND_MATERIALS[written] : groundByAlbedo(written);
  if (typeof written === 'string' && ground === undefined && !written.includes('/') && !written.includes('.')) {
    const guess = closestMatch(written, Object.keys(GROUND_MATERIALS));
    r.fail(`${pointer}/texture`, `"${written}" is neither a file path nor a ground material`,
      guess === undefined ? `Use an image handle ("images/<name>"), a hosted URL or one of: ${Object.keys(GROUND_MATERIALS).join(', ')}.` : `Did you mean "${guess}"?`);
  }
  // A catalog image named by URL keeps the URL as written.
  const texture = typeof written === 'string' && !isMaterialName(written) ? written : ground?.albedo ?? null;
  const normalWritten = obj['normal'];
  if (normalWritten !== undefined && normalWritten !== null && (typeof normalWritten !== 'string' || normalWritten === '')) {
    r.fail(`${pointer}/normal`, 'normal must be a path or null', 'Write the normal map\'s image handle ("images/<name>") or hosted URL.');
  }
  if (typeof normalWritten === 'string' && texture === null) r.fail(`${pointer}/normal`, 'a normal map needs a texture', 'Give the layer a "texture" too, or remove "normal".');
  const normal = normalWritten === undefined ? ground?.normal ?? null : (normalWritten as string | null);
  let detail: TerrainLayer['detail'] = null;
  if (obj['detail'] !== undefined) {
    const d = r.object(obj['detail'], `${pointer}/detail`, 'detail');
    r.keys(d, `${pointer}/detail`, DETAIL_KEYS);
    const path = d['texture'];
    if (typeof path !== 'string' || path === '') r.fail(`${pointer}/detail/texture`, 'a detail needs a "texture"', 'Add "texture": "images/<name>".');
    detail = {
      texture: path as string,
      tile: r.number(d['tile'], `${pointer}/detail/tile`, 1.5, positive),
      strength: r.number(d['strength'], `${pointer}/detail/strength`, 0.5, unit),
    };
  }
  const pattern = obj['pattern'];
  if (pattern !== undefined && (typeof pattern !== 'string' || !(TERRAIN_PATTERNS as readonly string[]).includes(pattern))) {
    const guess = typeof pattern === 'string' ? closestMatch(pattern, TERRAIN_PATTERNS) : undefined;
    r.fail(`${pointer}/pattern`, `pattern ${JSON.stringify(pattern)} is not one of ${TERRAIN_PATTERNS.join(', ')}`,
      guess === undefined ? `Use one of: ${TERRAIN_PATTERNS.join(', ')}.` : `Did you mean "${guess}"?`);
  }
  return {
    name: layerName,
    texture,
    normal,
    tile: r.number(obj['tile'], `${pointer}/tile`, ground?.tile ?? 8, positive),
    tint: r.rgb(obj['tint'], `${pointer}/tint`, [1, 1, 1])!,
    color: r.rgb(obj['color'], `${pointer}/color`, null),
    roughness: r.number(obj['roughness'], `${pointer}/roughness`, 0.9, unit),
    detail,
    pattern: (pattern as TerrainPattern | undefined) ?? null,
    variation: r.number(obj['variation'], `${pointer}/variation`, 0.5, unit),
    relief: r.number(obj['relief'], `${pointer}/relief`, 1, (n) => (n >= 0 && n <= 2 ? undefined : 'must be from 0 to 2')),
  };
}

/** The scene's terrain block, or undefined when it has none. */
export function readTerrainSpec(scene: SceneDoc, graded: readonly TerrainGradePath[] = []): TerrainSpec | undefined {
  const block = scene.plugins['terrain'];
  if (block === undefined) return undefined;
  const r: BlockReader = new BlockReader(scene);
  r.keys(block, '', KEYS);
  if (block['size'] === undefined) r.fail('/size', 'needs a "size"', 'Add "size": [width, depth] in meters.');
  const [width, depth] = r.pair(block['size'], '/size');
  if (!(width > 0 && depth > 0)) r.fail('/size', 'size must be positive', 'Give a width and depth greater than 0.');
  const longer = Math.max(width, depth);
  const resolution = r.integer(block['resolution'], '/resolution', Math.max(1, Math.min(DEFAULT_MAX_QUADS, Math.round(longer))), 1, MAX_RESOLUTION);

  // Layers first: everything else names them.
  const layersJson = r.list(block['layers'], '/layers', '"layers": ["grass", "rock"]');
  if (block['layers'] === undefined || layersJson.length === 0) r.fail('/layers', 'needs at least one layer', 'Add "layers": ["grass"].');
  if (layersJson.length > MAX_LAYERS) r.fail('/layers', `has ${layersJson.length} layers; at most ${MAX_LAYERS}`, `Merge layers down to ${MAX_LAYERS}.`);
  const layers = layersJson.map((layer, i) => readLayer(r, layer, `/layers/${i}`));
  const names = layers.map((l) => l.name);
  names.forEach((n, i) => {
    if (names.indexOf(n) !== i) r.fail(`/layers/${i}`, `layer "${n}" is listed twice`, 'Give every layer its own name.');
  });
  const layerIndex = (value: Json | undefined, pointer: string): number => {
    if (typeof value !== 'string' || !names.includes(value)) {
      const guess = typeof value === 'string' ? closestMatch(value, names) : undefined;
      r.fail(pointer, `${JSON.stringify(value ?? null)} is not one of the layers`, guess === undefined ? `Use one of: ${names.join(', ')}.` : `Did you mean "${guess}"?`);
    }
    return names.indexOf(value as string);
  };

  const seed = r.number(block['seed'], '/seed', 0);
  if (!Number.isInteger(seed)) r.fail('/seed', 'seed must be an integer', 'Write a whole number.');
  const maxHeight = r.number(block['max_height'], '/max_height', 0, nonNegative);
  let noise: FractalNoise[];
  if (block['noise'] !== undefined) {
    if (block['max_height'] !== undefined || block['seed'] !== undefined) {
      r.fail(block['max_height'] !== undefined ? '/max_height' : '/seed', '"max_height"/"seed" are the short form of "noise"; give one or the other',
        'Move the amplitude and seed into the "noise" layers.');
    }
    noise = r.list(block['noise'], '/noise', '"noise": [{"amplitude": 20, "wavelength": 200}]').map((value, i) => {
      const at = `/noise/${i}`;
      const obj = r.object(value, at, 'a noise layer');
      r.keys(obj, at, NOISE_KEYS);
      const kind = obj['kind'] ?? 'fbm';
      if (typeof kind !== 'string' || !(NOISE_KINDS as readonly string[]).includes(kind)) r.fail(`${at}/kind`, `kind ${JSON.stringify(kind)} is not a noise kind`, `Use one of: ${NOISE_KINDS.join(', ')}.`);
      const s = r.number(obj['seed'], `${at}/seed`, 0);
      if (!Number.isInteger(s)) r.fail(`${at}/seed`, 'seed must be an integer', 'Write a whole number.');
      return {
        kind: kind as FractalKind,
        amplitude: r.required(obj, 'amplitude', at),
        wavelength: r.required(obj, 'wavelength', at, positive),
        octaves: r.integer(obj['octaves'], `${at}/octaves`, 5, 1, 12),
        gain: r.number(obj['gain'], `${at}/gain`, 0.5, (n) => (n > 0 && n < 1 ? undefined : 'must be between 0 and 1')),
        lacunarity: r.number(obj['lacunarity'], `${at}/lacunarity`, 2, (n) => (n > 1 ? undefined : 'must be greater than 1')),
        seed: s,
      };
    });
  } else {
    noise = maxHeight > 0 ? [{ kind: 'fbm', amplitude: maxHeight, wavelength: longer / 3, octaves: 5, gain: 0.5, lacunarity: 2, seed }] : [];
  }

  const hills = r.list(block['hills'], '/hills', '"hills": [{"center": [x, z], "radius": r, "height": h}]').map((value, i): Hill => {
    const at = `/hills/${i}`;
    const obj = r.object(value, at, 'a hill');
    r.keys(obj, at, [...SHAPE_KEYS, 'height', 'feather']);
    const shape = readShape(r, obj, at);
    // The footprint is the hill's base; by default it eases all the way up (a smooth dome).
    const whole = shape.kind === 'circle' ? shape.radius : shape.kind === 'rect' ? Math.min(shape.hx, shape.hz) : 0;
    return { shape, height: r.required(obj, 'height', at), feather: r.number(obj['feather'], `${at}/feather`, whole, nonNegative) };
  });
  hills.forEach((hill, i) => {
    if (hill.shape.kind === 'circle' && hill.shape.radius === 0) r.fail(`/hills/${i}/radius`, 'a hill needs a radius above 0', 'Give the hill\'s base radius.');
  });

  const flats = r.list(block['flats'], '/flats', '"flats": [{"center": [x, z], "radius": r, "height": h}]').map((value, i): Flat => {
    const at = `/flats/${i}`;
    const obj = r.object(value, at, 'a flat');
    r.keys(obj, at, [...SHAPE_KEYS, 'height', 'feather', 'mode']);
    const mode = obj['mode'] ?? 'set';
    if (typeof mode !== 'string' || !(FLAT_MODES as readonly string[]).includes(mode)) r.fail(`${at}/mode`, `mode ${JSON.stringify(mode)} is not one of ${FLAT_MODES.join(', ')}`, '"set" levels, "carve" only lowers, "fill" only raises.');
    return { shape: readShape(r, obj, at), height: r.required(obj, 'height', at), feather: r.number(obj['feather'], `${at}/feather`, 4, nonNegative), mode: mode as FlatMode };
  });

  const holes = r.list(block['holes'], '/holes', '"holes": [{"center": [x, z], "radius": 3}]').map((value, i) => {
    const at = `/holes/${i}`;
    const obj = r.object(value, at, 'a hole');
    r.keys(obj, at, SHAPE_KEYS);
    return readShape(r, obj, at);
  });

  let defaultLayer = 0;
  if (block['default_layer'] !== undefined) defaultLayer = layerIndex(block['default_layer'], '/default_layer');

  const rules = r.list(block['rules'], '/rules', '"rules": [{"layer": "rock", "slope": [28, 38]}]').map((value, i): SplatRule => {
    const at = `/rules/${i}`;
    const obj = r.object(value, at, 'a rule');
    r.keys(obj, at, ['layer', 'slope', 'height', 'feather', 'strength']);
    const layer = layerIndex(obj['layer'], `${at}/layer`);
    let slope: SplatRule['slope'] = null;
    if (obj['slope'] !== undefined) {
      const [from, full] = r.pair(obj['slope'], `${at}/slope`);
      if (!(from >= 0 && full <= 90 && from < full)) r.fail(`${at}/slope`, `slope [${from}, ${full}] must rise from 0..90 degrees`, 'Write [where cover starts, where it is full], e.g. [28, 38].');
      slope = { from: cosDegrees(from), full: cosDegrees(full) };
    }
    let height: SplatRule['height'] = null;
    if (obj['height'] !== undefined) {
      const [low, high] = r.pair(obj['height'], `${at}/height`);
      if (!(low <= high)) r.fail(`${at}/height`, `height [${low}, ${high}] is backwards`, 'Write [low, high].');
      height = { low, high };
    }
    if (slope === null && height === null) r.fail(at, 'a rule needs a "slope" or a "height" band', 'Add "slope": [from, full] or "height": [low, high].');
    return { layer, slope, height, feather: r.number(obj['feather'], `${at}/feather`, 1, nonNegative), strength: r.number(obj['strength'], `${at}/strength`, 1, unit) };
  });

  const paint = r.list(block['paint'], '/paint', '"paint": [{"layer": "road", "center": [x, z], "size": [w, d]}]').map((value, i): Paint => {
    const at = `/paint/${i}`;
    const obj = r.object(value, at, 'a paint');
    r.keys(obj, at, [...SHAPE_KEYS, 'layer', 'feather', 'noise', 'strength']);
    return {
      layer: layerIndex(obj['layer'], `${at}/layer`),
      shape: readShape(r, obj, at),
      feather: r.number(obj['feather'], `${at}/feather`, 2, nonNegative),
      noise: r.number(obj['noise'], `${at}/noise`, 0, unit),
      strength: r.number(obj['strength'], `${at}/strength`, 1, unit),
      seed: i,
    };
  });

  const paths = r.list(block['paths'], '/paths', '"paths": [{"paint": "road", "points": [[x, z], [x, z]], "width": 8}]').map((value, i): Path => {
    const at = `/paths/${i}`;
    const obj = r.object(value, at, 'a path');
    if (obj['layer'] !== undefined) {
      r.fail(`${at}/layer`, 'a path names the terrain layer it paints with "paint", not "layer" ("layer" means a collision layer)', `Rename "layer" to "paint": "paint": ${JSON.stringify(obj['layer'])}.`);
    }
    r.keys(obj, at, ['paint', 'points', 'width', 'feather', 'closed', 'strength', 'flatten']);
    const points = r.list(obj['points'], `${at}/points`, '"points": [[x, z], [x, z]]').map((p, k) => r.pair(p, `${at}/points/${k}`));
    if (points.length < 2) r.fail(`${at}/points`, 'a path needs at least 2 points', 'Add "points": [[x, z], [x, z], …].');
    const closed = obj['closed'] ?? false;
    if (typeof closed !== 'boolean') r.fail(`${at}/closed`, 'closed must be true or false', 'Write true for a loop.');
    if (closed === true && points.length < 3) r.fail(`${at}/closed`, 'a closed path needs at least 3 points', 'Add points.');
    let flatten: Path['flatten'] = null;
    const f = obj['flatten'];
    if (f === true) flatten = { feather: 4, offset: 0 };
    else if (f !== undefined && f !== false) {
      const fo = r.object(f, `${at}/flatten`, 'flatten');
      r.keys(fo, `${at}/flatten`, ['feather', 'offset']);
      flatten = { feather: r.number(fo['feather'], `${at}/flatten/feather`, 4, nonNegative), offset: r.number(fo['offset'], `${at}/flatten/offset`, 0) };
    }
    const layer = obj['paint'] === undefined ? null : layerIndex(obj['paint'], `${at}/paint`);
    if (layer === null && flatten === null) r.fail(at, 'a path needs a "paint" layer or "flatten" to grade', 'Add "paint": "road", or "flatten": true.');
    return {
      layer, points, closed: closed as boolean,
      width: r.required(obj, 'width', at, positive),
      feather: r.number(obj['feather'], `${at}/feather`, 1.5, nonNegative),
      strength: r.number(obj['strength'], `${at}/strength`, 1, unit),
      flatten,
    };
  });

  // Paths other plugins grade (race tracks: TERRAIN_GRADING_SERVICE), after the block's own.
  for (const g of graded) paths.push({ ...g, layer: g.layer === null ? null : layerIndex(g.layer, '/paths') });

  const ids = new Set<string>();
  const brush = r.list(block['brush'], '/brush', '"brush": [{"id": "mid", "center": [x, z], "radius": 5}]').map((value, i): Brush => {
    const at = `/brush/${i}`;
    const obj = r.object(value, at, 'a brush volume');
    r.keys(obj, at, [...SHAPE_KEYS, 'id', 'height', 'tags']);
    const id = obj['id'] === undefined ? `brush_${i}` : r.string(obj['id'], `${at}/id`);
    if (ids.has(id)) r.fail(`${at}/id`, `brush "${id}" is listed twice`, 'Give every brush volume its own id.');
    ids.add(id);
    const tags = r.list(obj['tags'], `${at}/tags`, '"tags": ["lane"]').map((t, k) => r.string(t, `${at}/tags/${k}`));
    return { id, shape: readShape(r, obj, at), height: r.number(obj['height'], `${at}/height`, 1.6, positive), tags };
  });

  return {
    width, depth, resolution,
    baseHeight: r.number(block['base_height'], '/base_height', 0),
    noise, hills, flats, holes,
    waterLevel: block['water_level'] === undefined ? null : r.number(block['water_level'], '/water_level', 0),
    layers, defaultLayer, rules, paint, paths, brush,
  };
}
