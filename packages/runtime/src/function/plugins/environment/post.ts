/**
 * Post-processing settings: the scene's `"post"` block, the presets it may name, and runtime
 * changes (`ctx.environment.post(...)`), resolved into one `PostSettings` per frame.
 *
 *   "post": {"preset": "noir", "bloom": 0.4, "vignette": 0.3,
 *            "stylize": {"pixelate": 3, "posterize": 6, "toon": 3, "edges": 1.5}}
 *
 * Every field is optional; the stylization effects sit together in "stylize". Resolution,
 * later wins:
 *
 *   DEFAULT_POST  ←  the preset's bundle  ←  the scene's fields  ←  the runtime layer
 *
 * The runtime layer (`ctx.environment.post(preset, **fields)`) replaces the scene's preset
 * when it names one (and then the scene's own fields are dropped too: a new look, not a
 * blend of two); without a preset its fields override the scene's. `post()` with nothing
 * clears it. Numbers blend over the change's `seconds`; switches flip at once.
 */

import { closestMatch, Color, COLOR_FORMS, fail } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { POST_PRESET_NAMES } from '../../services/index.js';
import type { PostPresetName, PostSettings } from '../../services/index.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type PostField = Exclude<keyof PostSettings, 'preset'>;
export type PostValue = number | boolean | string | Color | null;

/** A nested block of related post settings: `"stylize": {"pixelate": 4, "posterize": 6}`. */
export type PostGroup = 'stylize';
export const POST_GROUPS: readonly PostGroup[] = ['stylize'];

export interface FieldSpec {
  /** The key in scene JSON and the Python keyword (inside its group, if it has one). */
  readonly key: string;
  readonly prop: PostField;
  readonly kind: 'number' | 'bool' | 'color';
  /** The nested block it is written in. */
  readonly group?: PostGroup;
  readonly min?: number;
  readonly max?: number;
  /** Numbers that only make sense whole (levels, bands). */
  readonly whole?: boolean;
  readonly doc: string;
}

/**
 * Every post field: scene key, settings property, type and range. The wireframe view
 * (PostSettings `mode`, `wireColor`, `wireBackground`) is a debug setting, not a look:
 * the environment's "debug" block sets it (spec.ts), over whatever the post resolves to.
 */
export const POST_FIELDS: readonly FieldSpec[] = [
  { key: 'exposure', prop: 'exposure', kind: 'number', min: 0, max: 64, doc: 'brightness multiplier on the tone-mapped image, before contrast (1.1: 10% brighter)' },
  { key: 'bloom', prop: 'bloom', kind: 'number', min: 0, max: 8, doc: 'glow strength around bright light (0: none)' },
  { key: 'bloom_threshold', prop: 'bloomThreshold', kind: 'number', min: 0, max: 64, doc: 'brightness where glow starts (3D: linear, the default 1 means 0.5; 2D: the drawn color 0..1, so 1 is no glow)' },
  { key: 'saturation', prop: 'saturation', kind: 'number', min: 0, max: 4, doc: '0 gray, 1 unchanged' },
  { key: 'contrast', prop: 'contrast', kind: 'number', min: 0, max: 4, doc: '1 unchanged' },
  { key: 'tint', prop: 'tint', kind: 'color', doc: 'multiplies the final colors' },
  { key: 'temperature', prop: 'temperature', kind: 'number', min: -1, max: 1, doc: 'warmth: + adds red and takes blue (0.1 per unit, on the graded image), - the reverse, 0 neutral' },
  { key: 'grain', prop: 'grain', kind: 'number', min: 0, max: 1, doc: 'animated film grain (0: none)' },
  { key: 'vignette', prop: 'vignette', kind: 'number', min: 0, max: 1, doc: 'darkening toward the corners' },
  { key: 'chromatic_aberration', prop: 'chromaticAberration', kind: 'number', min: 0, max: 0.05, doc: 'red/blue fringes at the corners (fraction of the image)' },
  { key: 'ambient_occlusion', prop: 'ambientOcclusion', kind: 'number', min: 0, max: 4, doc: 'contact shadows in creases (0: none)' },
  { key: 'reflections', prop: 'reflections', kind: 'bool', doc: 'screen-space reflections on smooth surfaces' },
  { key: 'god_rays', prop: 'godRays', kind: 'number', min: 0, max: 4, doc: 'light shafts from the sun (0: none)' },
  { key: 'antialias', prop: 'antialias', kind: 'bool', doc: 'smooth jagged edges' },
  { key: 'pixelate', prop: 'pixelate', kind: 'number', group: 'stylize', min: 1, max: 64, whole: true, doc: 'screen pixels per image pixel (1: none)' },
  { key: 'posterize', prop: 'posterize', kind: 'number', group: 'stylize', min: 0, max: 256, whole: true, doc: 'levels per color channel (0: none)' },
  { key: 'toon', prop: 'toon', kind: 'number', group: 'stylize', min: 0, max: 16, whole: true, doc: 'bands of cel-shaded light (0: smooth)' },
  { key: 'edges', prop: 'edges', kind: 'number', group: 'stylize', min: 0, max: 8, doc: 'ink line thickness in pixels (0: none)' },
  { key: 'edge_color', prop: 'edgeColor', kind: 'color', group: 'stylize', doc: 'ink line color' },
];

/** The keys a "post" block (and post()'s keywords) take: preset, the ungrouped fields, the groups. */
export const POST_KEYS: readonly string[] = ['preset', ...POST_FIELDS.filter((f) => f.group === undefined).map((f) => f.key), ...POST_GROUPS];

export const DEFAULT_POST: PostSettings = {
  // A little bloom by default: the sun and bright highlights glow.
  preset: null, exposure: 1, bloom: 0.1, bloomThreshold: 1, saturation: 1, contrast: 1, tint: Color.WHITE, temperature: 0, grain: 0, vignette: 0,
  chromaticAberration: 0, pixelate: 1, posterize: 0, toon: 0, edges: 0, edgeColor: Color.BLACK, ambientOcclusion: 1,
  reflections: true, godRays: 0, mode: 'standard', wireColor: null, wireBackground: null, antialias: true,
};

const rgb = (r: number, g: number, b: number): Color => new Color(r, g, b, 1);

/** The looks a preset name expands to (fields not listed keep their defaults). */
export const POST_PRESETS: Readonly<Record<PostPresetName, Partial<PostSettings>>> = {
  cyberpunk_neon: { contrast: 1.35, saturation: 1.5, tint: rgb(1.08, 0.92, 1.15), bloom: 0.18, chromaticAberration: 0.002, vignette: 0.4, grain: 0.28 },
  warm: { temperature: 0.3, tint: rgb(1.03, 1, 0.96), saturation: 1.05 },
  cool: { temperature: -0.3, tint: rgb(0.97, 1, 1.03), saturation: 0.95 },
  noir: { saturation: 0, contrast: 1.25, vignette: 0.45 },
  vintage: { tint: rgb(1.05, 0.97, 0.82), saturation: 0.7, contrast: 0.9, vignette: 0.35, chromaticAberration: 0.0015, grain: 0.35 },
  vivid: { saturation: 1.3, contrast: 1.1 },
  cinematic: { contrast: 1.1, tint: rgb(1.03, 1, 0.95), vignette: 0.3, bloom: 0.12 },
  horror: { saturation: 0.45, contrast: 1.2, tint: rgb(0.92, 0.95, 1), vignette: 0.6, chromaticAberration: 0.003, exposure: 0.85, grain: 0.25 },
  dreamy: { bloom: 0.15, bloomThreshold: 0.6, contrast: 0.92, saturation: 1.1, vignette: 0.2 },
  retro: { pixelate: 4, posterize: 6 },
  comic: { posterize: 5, edges: 1.5, saturation: 1.25, contrast: 1.1 },
  toon: { toon: 3, edges: 1.5, saturation: 1.15 },
  underwater: { tint: rgb(0.7, 0.95, 1.15), saturation: 0.85, vignette: 0.3, chromaticAberration: 0.002 },
  night_vision: { saturation: 0, tint: rgb(0.45, 1.2, 0.45), exposure: 1.4, vignette: 0.65, contrast: 1.2, grain: 0.5 },
};

/** One layer of post settings: a preset and the fields set over it. */
export interface PostLayer {
  readonly preset: PostPresetName | null;
  readonly fields: Readonly<Partial<Record<PostField, PostValue>>>;
}

export const EMPTY_POST: PostLayer = { preset: null, fields: {} };

/** A preset name checked (`problem` raises with a suggestion). */
export function postPreset(name: unknown, problem: (message: string, fix: string) => never): PostPresetName {
  if (typeof name === 'string' && (POST_PRESET_NAMES as readonly string[]).includes(name)) return name as PostPresetName;
  const guess = typeof name === 'string' ? closestMatch(name, POST_PRESET_NAMES) : undefined;
  return problem(`unknown post preset ${JSON.stringify(name)}`, guess === undefined ? `Use one of: ${POST_PRESET_NAMES.join(', ')}.` : `Did you mean "${guess}"?`);
}

const WIREFRAME_KEYS: readonly string[] = ['mode', 'wire_color', 'wire_background', 'wireframe'];

/**
 * The fields a "post" block (or post()'s keywords, or a cinematic grade) sets: each with its
 * spec, value and path ("bloom", "stylize/pixelate"); "preset" is left out and each group
 * opened. An unknown key, a grouped field written outside its group, or a group that isn't
 * an object is a problem (`problem(path, message, fix)` raises with a suggestion).
 */
export function postEntries(
  block: Readonly<Record<string, unknown>>, problem: (path: string, message: string, fix: string) => never,
): [FieldSpec, unknown, string][] {
  const out: [FieldSpec, unknown, string][] = [];
  for (const [key, value] of Object.entries(block)) {
    if (key === 'preset') continue;
    const group = POST_GROUPS.find((g) => g === key);
    if (group !== undefined) {
      const members = POST_FIELDS.filter((f) => f.group === group);
      const names = members.map((f) => f.key);
      const inner = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : problem(key, `${key} must be an object of settings`, `Write "${key}": {"${names[0]}": ...} with any of: ${names.join(', ')}.`);
      for (const [name, v] of Object.entries(inner)) {
        const guess = closestMatch(name, names);
        const spec = members.find((f) => f.key === name)
          ?? problem(`${key}/${name}`, `unknown ${key} setting "${name}"`, guess === undefined ? `Settings: ${names.join(', ')}.` : `Did you mean "${guess}"?`);
        out.push([spec, v, `${key}/${name}`]);
      }
      continue;
    }
    const spec = POST_FIELDS.find((f) => f.key === key);
    if (spec !== undefined && spec.group !== undefined) {
      return problem(key, `${key} belongs in the post's "${spec.group}" block`, `Write "${spec.group}": {"${key}": ...}.`);
    }
    if (spec === undefined && WIREFRAME_KEYS.includes(key)) {
      return problem(key, `"${key}" is not a post setting: the wireframe view is a debug setting`,
        'Set it in the environment\'s "debug" block: "debug": {"wireframe": true, "wire_color": "#00ff66"}.');
    }
    const guess = closestMatch(key, POST_KEYS);
    out.push([
      spec ?? problem(key, `unknown post setting "${key}"`, guess === undefined ? `Settings: ${POST_KEYS.join(', ')}.` : `Did you mean "${guess}"?`),
      value, key,
    ]);
  }
  return out;
}

/**
 * A field value checked against its spec. `color` turns a JSON colour (or a Color) into a
 * Color; `problem` raises.
 */
export function postValue(spec: FieldSpec, value: unknown, color: (value: unknown) => Color | null, problem: (message: string, fix: string) => never): PostValue {
  switch (spec.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return problem(`${spec.key} must be a number`, `Write ${spec.key} as a number (${spec.doc}).`);
      if (spec.min !== undefined && value < spec.min) return problem(`${spec.key} is ${value}; it can't be below ${spec.min}`, `Use ${spec.min} to ${spec.max}.`);
      if (spec.max !== undefined && value > spec.max) return problem(`${spec.key} is ${value}; it can't be above ${spec.max}`, `Use ${spec.min} to ${spec.max}.`);
      if (spec.whole === true && !Number.isInteger(value)) return problem(`${spec.key} must be a whole number, got ${value}`, `Round it (${spec.doc}).`);
      if (spec.key === 'posterize' && value === 1) return problem('posterize 1 would leave one level per channel', 'Use 0 for none, or 2 and up.');
      return value;
    }
    case 'bool':
      if (typeof value !== 'boolean') return problem(`${spec.key} must be true or false`, `Write ${spec.key} as a boolean.`);
      return value;
    case 'color': {
      const c = value === null ? null : color(value);
      if (c === null) return problem(`${spec.key} must be a colour`, `Use ${COLOR_FORMS}.`);
      return c;
    }
  }
}

function apply(into: Mutable<PostSettings>, fields: Readonly<Partial<Record<PostField, PostValue>>>): void {
  for (const [prop, value] of Object.entries(fields) as [PostField, PostValue][]) (into as Record<string, unknown>)[prop] = value;
}

/** Defaults ← preset ← scene fields ← runtime layer (see the module doc). */
export function resolvePost(scene: PostLayer, runtime: PostLayer | null): PostSettings {
  const out: Mutable<PostSettings> = { ...DEFAULT_POST };
  const preset = runtime?.preset ?? scene.preset;
  if (preset !== null) apply(out, POST_PRESETS[preset] as Partial<Record<PostField, PostValue>>);
  out.preset = preset;
  if (runtime === null || runtime.preset === null) apply(out, scene.fields);
  if (runtime !== null) apply(out, runtime.fields);
  return out;
}

/** `from` → `to` at t (0..1): numbers and colours blend, everything else switches at t > 0. */
export function lerpPost(from: PostSettings, to: PostSettings, t: number): PostSettings {
  if (t >= 1) return to;
  const out: Mutable<PostSettings> = { ...to };
  for (const spec of POST_FIELDS) {
    const a = from[spec.prop];
    const b = to[spec.prop];
    if (spec.kind === 'number' && spec.whole !== true) {
      (out as Record<string, unknown>)[spec.prop] = (a as number) + ((b as number) - (a as number)) * t;
    } else if (spec.kind === 'color') {
      (out as Record<string, unknown>)[spec.prop] = (a as Color).lerp(b as Color, t);
    } else if (t <= 0) {
      (out as Record<string, unknown>)[spec.prop] = a;
    }
  }
  return out;
}

// ── JSON (saves and snapshots) ───────────────────────────────────────────────

function valueJson(v: PostValue): Json {
  return v instanceof Color ? [v.r, v.g, v.b, v.a] : v;
}

export function postLayerJson(layer: PostLayer): JsonObject {
  const fields: Record<string, Json> = {};
  for (const [prop, value] of Object.entries(layer.fields) as [PostField, PostValue][]) fields[prop] = valueJson(value);
  return { preset: layer.preset, fields };
}

export function postLayerFrom(value: Json, where: string): PostLayer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('PP9220', `${where}: not a saved post layer`);
  const o = value as JsonObject;
  const problem = (message: string): never => fail('PP9220', `${where}: ${message}`);
  const preset = o['preset'] === null ? null : postPreset(o['preset'], problem);
  const fields: Partial<Record<PostField, PostValue>> = {};
  for (const [prop, raw] of Object.entries((o['fields'] ?? {}) as JsonObject)) {
    const spec = POST_FIELDS.find((f) => f.prop === prop) ?? problem(`unknown post field ${prop}`);
    fields[spec.prop] = postValue(spec, raw, savedColor, problem);
  }
  return { preset, fields };
}

export function postSettingsJson(p: PostSettings): JsonObject {
  const out: Record<string, Json> = { preset: p.preset };
  for (const spec of POST_FIELDS) out[spec.prop] = valueJson(p[spec.prop]);
  return out;
}

export function postSettingsFrom(value: Json, where: string): PostSettings {
  const o = value as JsonObject;
  const layer = postLayerFrom({ preset: o['preset'] ?? null, fields: Object.fromEntries(POST_FIELDS.map((f) => [f.prop, o[f.prop]!])) }, where);
  return { ...DEFAULT_POST, ...layer.fields, preset: layer.preset } as PostSettings;
}

function savedColor(value: unknown): Color | null {
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number')) {
    const [r, g, b, a] = value as number[];
    return new Color(r!, g!, b!, a!);
  }
  return null;
}
