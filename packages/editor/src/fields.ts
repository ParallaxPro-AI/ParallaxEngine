/**
 * Inspector field values: which widget a declared field type gets, a live value as the JSON
 * the files hold, and widget input back to that JSON. Pure, so it is tested without a page.
 */

import { parseColor } from '@parallax/runtime/core';
import { encode } from '@parallax/runtime/kernel';
import type { FieldSpec, FieldType } from '@parallax/runtime/kernel';
import type { Json } from '@parallax/runtime/resource';
import { t } from './i18n.js';

export type WidgetKind = 'number' | 'int' | 'bool' | 'string' | 'enum' | 'vec2' | 'vec3' | 'color' | 'json';

export function widgetKind(type: FieldType): WidgetKind {
  switch (type.kind) {
    case 'number': case 'int': case 'bool': case 'string': case 'enum': case 'vec2': case 'vec3': case 'color':
      return type.kind;
    case 'tag': case 'ref': case 'entity':
      return 'string';
    default:
      return 'json';
  }
}

/** The live value as JSON, or undefined when it can't be written as data (an entity object, NaN). */
export function valueJson(spec: FieldSpec, value: unknown, where: string): Json | undefined {
  try {
    return encode(spec.type, value, where);
  } catch {
    return undefined;
  }
}

/** `#rrggbb` for a color input, from [r, g, b, a] in 0..1 (alpha kept separately). */
export function colorHex(json: Json | undefined): string {
  if (!Array.isArray(json)) return '#ffffff';
  const byte = (n: Json | undefined): string => Math.round(Math.min(1, Math.max(0, typeof n === 'number' ? n : 1)) * 255).toString(16).padStart(2, '0');
  return `#${byte(json[0])}${byte(json[1])}${byte(json[2])}`;
}

/** A color input's `#rrggbb` (and the alpha it had) as [r, g, b, a]. */
export function hexColor(hex: string, alpha: number): Json {
  const n = (i: number): number => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1e4) / 1e4;
  return [n(1), n(3), n(5), alpha];
}

export type Parsed = { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly error: string };

/** Text typed into a field's input as JSON for `kind`. */
export function parseInput(kind: WidgetKind, text: string): Parsed {
  const trimmed = text.trim();
  switch (kind) {
    case 'number':
    case 'int': {
      const n = Number(trimmed);
      if (trimmed === '' || !Number.isFinite(n)) return { ok: false, error: t('fields.notANumber') };
      if (kind === 'int' && !Number.isInteger(n)) return { ok: false, error: t('fields.notAWholeNumber') };
      return { ok: true, value: n };
    }
    case 'string':
    case 'enum':
      return { ok: true, value: text };
    case 'bool':
      return trimmed === 'true' || trimmed === 'false' ? { ok: true, value: trimmed === 'true' } : { ok: false, error: 'true or false' };
    default:
      try {
        return { ok: true, value: JSON.parse(trimmed) as Json };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
  }
}

/** A number for a compact input: five decimals at most, no float noise. */
export function shortNumber(n: number): string {
  const r = Math.round(n * 1e5) / 1e5;
  return String(Object.is(r, -0) ? 0 : r);
}

/** "move_speed" → "Move speed". */
export function label(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ── The inspector's widgets, labels and visibility ────────────────────────────────────────

/** What a declared field is edited with (richer than `widgetKind`: pickers, optional values, flags). */
export type FieldWidget =
  | { readonly kind: 'number' | 'int' | 'bool' | 'string' | 'vec2' | 'vec3' | 'color' | 'json' | 'entity'; readonly optional: boolean }
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly optional: boolean }
  /** A list of enum values, shown as toggles (`lock_axes`). */
  | { readonly kind: 'flags'; readonly values: readonly string[]; readonly optional: boolean }
  /** An asset (`ref` to "asset/<folder>"), a prefab, or another kind of id (a plain text box). */
  | { readonly kind: 'asset'; readonly folder: AssetFolder; readonly optional: boolean }
  | { readonly kind: 'prefab'; readonly optional: boolean }
  | { readonly kind: 'ref'; readonly to: string; readonly optional: boolean };

export type AssetFolder = 'models' | 'images' | 'sfx' | 'music' | 'vfx';
const ASSET_FOLDERS: readonly AssetFolder[] = ['models', 'images', 'sfx', 'music', 'vfx'];

export function fieldWidget(type: FieldType, optional = false): FieldWidget {
  switch (type.kind) {
    case 'optional':
      return fieldWidget(type.of, true);
    case 'number': case 'int': case 'bool': case 'string': case 'vec2': case 'vec3': case 'color': case 'entity':
      return { kind: type.kind, optional };
    case 'tag':
      return { kind: 'string', optional };
    case 'enum':
      return { kind: 'enum', values: type.values, optional };
    case 'ref': {
      const folder = type.to.startsWith('asset/') ? type.to.slice('asset/'.length) as AssetFolder : undefined;
      if (folder !== undefined && ASSET_FOLDERS.includes(folder)) return { kind: 'asset', folder, optional };
      if (type.to === 'prefab') return { kind: 'prefab', optional };
      return { kind: 'ref', to: type.to, optional };
    }
    case 'list':
      return type.of.kind === 'enum' ? { kind: 'flags', values: type.of.values, optional } : { kind: 'json', optional };
    default:
      return { kind: 'json', optional };
  }
}

/** Words a label writes in capitals. */
const ACRONYMS = new Set(['fov', 'id', 'ui', 'hp', 'fps', 'ai', 'uv', 'vfx', 'sfx', 'lod', 'rgb', 'xp', 'npc', 'hud', 'ik']);

/** "move_speed" → "Move speed"; "fov" → "FOV". */
export function readableLabel(name: string): string {
  const words = label(name).split(' ').map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w));
  return words.join(' ');
}

type Values = Readonly<Record<string, unknown>>;

interface FieldHint {
  readonly label?: string;
  /** Shown only when this holds for the component's current values. */
  readonly visible?: (values: Values) => boolean;
  /** Never shown (state the engine keeps current). */
  readonly hidden?: true;
}

const isNot = (field: string, ...values: string[]) => (v: Values): boolean => !values.includes(String(v[field]));
const isOne = (field: string, ...values: string[]) => (v: Values): boolean => values.includes(String(v[field]));
const following = isNot('rig', 'fixed');

/**
 * The inspector's labels, and fields that only show when they matter, where the
 * engine's schema decides it (a light's range means nothing for a directional light).
 */
const FIELD_HINTS: Readonly<Record<string, Readonly<Record<string, FieldHint>>>> = {
  light: {
    kind: { label: 'Type' },
    range: { visible: isNot('kind', 'directional') },
    angle: { label: 'Spot angle', visible: isOne('kind', 'spot') },
    inner_angle: { label: 'Inner angle', visible: isOne('kind', 'spot') },
    shadows: { label: 'Cast shadows' },
    when: { label: 'Lit' },
  },
  camera: {
    fov: { label: 'FOV', visible: isNot('mode', 'orthographic') },
    size: { label: 'Size (half height)', visible: isOne('mode', 'orthographic') },
    follow: { visible: following },
    follow_weights: { visible: following },
    pitch: { visible: following },
    pitch_limits: { visible: following },
    offset: { visible: following },
    world_offset: { visible: following },
    smoothing: { visible: following },
    background: { label: 'Clear color' },
  },
  collider: {
    size: { visible: isOne('shape', 'box') },
    radius: { visible: isOne('shape', 'sphere', 'capsule', 'cylinder', 'circle') },
    height: { visible: isOne('shape', 'capsule', 'cylinder') },
    trigger: { label: 'Is trigger' },
    bounce: { label: 'Bounciness' },
  },
  rigidbody: {
    kind: { label: 'Type' },
    linear_damping: { label: 'Linear drag' },
    angular_damping: { label: 'Angular drag' },
    continuous: { label: 'Continuous collision' },
  },
  shape: {
    kind: { label: 'Mesh' },
    points: { visible: isOne('kind', 'polygon') },
    thickness: { visible: isOne('kind', 'ring') },
    corner_radius: { visible: isOne('kind', 'rect', 'box') },
  },
  sprite: { animation_started: { hidden: true } },
  model: { model: { label: 'Model' }, tint: { label: 'Tint' } },
  audio_source: { sound: { label: 'Audio clip' }, playing: { label: 'Play on start' } },
  particles: { effect: { label: 'Effect' } },
};

/**
 * A field's label in the editor's language: `field.<component>.<field>` for the labels above,
 * `component.<id>` for a component's own title (componentId ''), else the readable name.
 */
export function fieldLabel(componentId: string, field: string): string {
  const key = componentId === '' ? `component.${field}` : `field.${componentId}.${field}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return FIELD_HINTS[componentId]?.[field]?.label ?? readableLabel(field);
}

/** Whether a field shows, given its component's current values (every field does by default). */
export function fieldVisible(componentId: string, field: string, values: Values): boolean {
  const hint = FIELD_HINTS[componentId]?.[field];
  if (hint?.hidden === true) return false;
  return hint?.visible?.(values) ?? true;
}

/** The field a component is switched on and off with (a bool defaulting to on), if it has one. */
export function enableField(schema: Readonly<Record<string, FieldSpec>>): string | undefined {
  for (const name of ['enabled', 'active', 'on']) {
    const spec = schema[name];
    if (spec !== undefined && spec.type.kind === 'bool' && spec.default === true) return name;
  }
  return undefined;
}

// ── Numbers ───────────────────────────────────────────────────────────────────────────────

/** A number kept inside the field's declared range (and whole, for ints). */
export function clampNumber(n: number, spec: Pick<FieldSpec, 'min' | 'max'>, int = false): number {
  let v = int ? Math.round(n) : n;
  if (spec.min !== undefined && v < spec.min) v = spec.min;
  if (spec.max !== undefined && v > spec.max) v = spec.max;
  return v;
}

/** "0 – 1", "≥ 0", "≤ 10", or '' when the field has no range. */
export function rangeText(spec: Pick<FieldSpec, 'min' | 'max'>): string {
  if (spec.min !== undefined && spec.max !== undefined) return `${shortNumber(spec.min)} – ${shortNumber(spec.max)}`;
  if (spec.min !== undefined) return `≥ ${shortNumber(spec.min)}`;
  if (spec.max !== undefined) return `≤ ${shortNumber(spec.max)}`;
  return '';
}

/** How much one pixel of label drag changes a value starting at `start`. */
export function scrubStep(start: number, spec: Pick<FieldSpec, 'min' | 'max'>, int = false): number {
  if (spec.min !== undefined && spec.max !== undefined && spec.max > spec.min) {
    const step = (spec.max - spec.min) / 300;
    return int ? Math.max(step, 0.1) : step;
  }
  if (int) return 0.1;
  return Math.max(Math.abs(start) / 100, 0.01);
}

/** The value after dragging `dx` pixels from `start` (Shift ×10, Alt ×0.1), clamped and rounded. */
export function scrubValue(start: number, dx: number, spec: Pick<FieldSpec, 'min' | 'max'>, int = false, modifiers: { readonly fast?: boolean; readonly fine?: boolean } = {}): number {
  const factor = modifiers.fast === true ? 10 : modifiers.fine === true ? 0.1 : 1;
  const step = scrubStep(start, spec, int) * factor;
  const raw = start + dx * step;
  // Round to the step's precision so a drag writes 1.25, not 1.2500000003.
  const digits = Math.max(0, Math.min(5, Math.ceil(-Math.log10(step)) + 1));
  const rounded = Math.round(raw * 10 ** digits) / 10 ** digits;
  return clampNumber(rounded, spec, int);
}

/** Where `n` sits in the field's range, 0..1 (undefined without both bounds). */
export function rangeFraction(n: number, spec: Pick<FieldSpec, 'min' | 'max'>): number | undefined {
  if (spec.min === undefined || spec.max === undefined || spec.max <= spec.min) return undefined;
  return Math.min(1, Math.max(0, (n - spec.min) / (spec.max - spec.min)));
}

// ── Colors ────────────────────────────────────────────────────────────────────────────────

/** "#rgb", "#rrggbb" or "#rrggbbaa" (the "#" optional) as [r, g, b, a] in 0..1; null if it isn't one. */
export function parseHexColor(text: string, alpha = 1): [number, number, number, number] | null {
  const hex = text.trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const n = (i: number): number => Math.round((parseInt(full.slice(i, i + 2), 16) / 255) * 1e4) / 1e4;
  return [n(0), n(2), n(4), full.length === 8 ? n(6) : alpha];
}

/** A color field's JSON (any authored colour form, see the runtime's parseColor) as [r, g, b, a]; white if it isn't one. */
export function colorParts(json: Json | undefined): [number, number, number, number] {
  const c = parseColor(json);
  return c === null ? [1, 1, 1, 1] : [c.r, c.g, c.b, c.a];
}

// ── Multi-selection ───────────────────────────────────────────────────────────────────────

/** The value every selected entity shares, or `mixed` when they differ. */
export function sharedValue(values: readonly (Json | undefined)[]): { readonly mixed: boolean; readonly value: Json | undefined } {
  const first = values[0];
  const key = JSON.stringify(first);
  const mixed = values.some((v) => JSON.stringify(v) !== key);
  return { mixed, value: mixed ? undefined : first };
}

/** The ids every list holds, in the first list's order. */
export function sharedIds(lists: readonly (readonly string[])[]): string[] {
  if (lists.length === 0) return [];
  return lists[0]!.filter((id) => lists.every((list) => list.includes(id)));
}

// ── Add Component ─────────────────────────────────────────────────────────────────────────

export interface ComponentChoice {
  readonly id: string;
  /** "Game" for the game's own components, else the engine area that provides it. */
  readonly category: string;
}

const CATEGORY_NAMES: Readonly<Record<string, string>> = {
  visuals: 'Rendering', render3d: 'Rendering', render2d: 'Rendering', models: 'Rendering',
  physics3d: 'Physics', physics2d: 'Physics', softbody: 'Physics', destruction: 'Physics',
  audio: 'Audio', voice: 'Audio', vehicles: 'Vehicles', characters: 'Characters', ai: 'AI', nav: 'Navigation',
  combat: 'Gameplay', interaction: 'Gameplay', economy: 'Gameplay', spawning: 'Gameplay', story: 'Gameplay', grid: 'Gameplay',
  net: 'Multiplayer', ui: 'UI', hud: 'UI', screens: 'UI',
  terrain: 'World', foliage: 'World', water: 'World', weather: 'World', wind: 'World', environment: 'World',
  city: 'World', voxels: 'World', procgen: 'World',
};

export function categoryName(pluginId: string): string {
  return CATEGORY_NAMES[pluginId] ?? readableLabel(pluginId);
}

/** A category as shown in the Add Component menu (`categoryName`'s English, or 'Game', translated). */
export function categoryLabel(category: string): string {
  const key = `category.${category}`;
  const translated = t(key);
  return translated === key ? category : translated;
}

/**
 * The choices matching every word of `query` (in the id or its category), the game's own
 * first, then by category and id.
 */
export function filterComponents(choices: readonly ComponentChoice[], query: string): ComponentChoice[] {
  const words = query.trim().toLowerCase().replace(/[_-]+/g, ' ').split(/\s+/).filter((w) => w !== '');
  const order = (c: ComponentChoice): string => `${c.category === 'Game' ? '0' : '1'}${c.category}\u0000${c.id}`;
  return choices
    .filter((c) => {
      const text = `${c.id.replace(/_/g, ' ')} ${c.category}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => order(a).localeCompare(order(b)));
}

// ── Assets ────────────────────────────────────────────────────────────────────────────────

const FOLDER_EXTENSIONS: Readonly<Record<AssetFolder, RegExp>> = {
  models: /\.(glb|gltf|obj|fbx|vox|model\.json)$/i,
  images: /\.(png|jpe?g|webp|ktx2|hdr|gif|svg)$/i,
  sfx: /\.(mp3|ogg|wav|m4a|flac|opus)$/i,
  music: /\.(mp3|ogg|wav|m4a|flac|opus)$/i,
  vfx: /\.vfx\.json$/i,
};

/** Which used-asset kind (the Files tab) holds a folder's assets. */
const USED_KIND: Readonly<Record<AssetFolder, string | undefined>> = { models: 'models', images: 'textures', sfx: 'audio', music: 'audio', vfx: undefined };

export interface AssetChoice {
  /** What the field is set to. */
  readonly ref: string;
  readonly name: string;
  readonly source: 'project' | 'hosted' | 'builtin';
}

/**
 * The assets a field of `folder` can name: the project's files under assets/<folder>/ (any
 * folder, for models and images), hosted assets the project already uses, and built-ins.
 */
export function assetChoices(
  folder: AssetFolder, paths: readonly string[], used: readonly { readonly kind: string; readonly ref: string; readonly name: string }[],
  builtins: readonly string[] = [],
): AssetChoice[] {
  const out = new Map<string, AssetChoice>();
  const ext = FOLDER_EXTENSIONS[folder];
  for (const path of paths) {
    if (!path.startsWith('assets/') || !ext.test(path)) continue;
    if ((folder === 'sfx' || folder === 'music' || folder === 'vfx') && !path.startsWith(`assets/${folder}/`)) continue;
    // A field names the file by its handle ("models/knight"), the one spelling of an asset.
    const ref = assetHandle(path);
    if (out.has(ref)) continue;
    out.set(ref, { ref, name: ref.split('/').at(-1) ?? ref, source: 'project' });
  }
  const kind = USED_KIND[folder];
  for (const asset of used) {
    if (kind === undefined || asset.kind !== kind || out.has(asset.ref) || !/^https?:\/\//.test(asset.ref)) continue;
    out.set(asset.ref, { ref: asset.ref, name: asset.name, source: 'hosted' });
  }
  for (const ref of builtins) if (!out.has(ref)) out.set(ref, { ref, name: ref.replace(/^(effect|synth)\//, ''), source: 'builtin' });
  return [...out.values()].sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source.localeCompare(b.source) * -1));
}

/** Choices whose name or reference holds every word of `query`. */
export function filterAssets<T extends { readonly name: string; readonly ref: string }>(choices: readonly T[], query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
  return choices.filter((c) => words.every((w) => `${c.name} ${c.ref}`.toLowerCase().includes(w)));
}

/** A short name for a reference shown in an asset field: the file name, or the built-in's. */
export function assetName(ref: string): string {
  if (ref === '') return '';
  const last = ref.replace(/[?#].*$/, '').split('/').at(-1) ?? ref;
  return last.replace(/(\.model|\.vfx)?\.[a-z0-9]+$/i, '');
}

/** `assets/models/knight.glb` → `models/knight`: the handle a field names the file by. */
export function assetHandle(path: string): string {
  const relative = path.replace(/^assets\//, '');
  const slash = relative.lastIndexOf('/');
  const dot = relative.indexOf('.', slash + 1);
  return dot === -1 ? relative : relative.slice(0, dot);
}

/** The project file a handle names (for previews), or undefined. A model file wins over its textures. */
export function assetFile(ref: string, paths: readonly string[]): string | undefined {
  const files = paths.filter((p) => p.startsWith('assets/') && assetHandle(p) === ref);
  return files.find((p) => /\.(glb|gltf|model\.json)$/i.test(p)) ?? files[0];
}

// ── Collapsed sections ────────────────────────────────────────────────────────────────────

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Which inspector sections are collapsed, by kind (`component:light`), kept across renders and reloads. */
export class CollapsedSections {
  readonly #store: KeyValueStore | undefined;
  readonly #key: string;
  readonly #collapsed: Set<string>;

  constructor(store: KeyValueStore | undefined, key = 'parallax.inspector.collapsed') {
    this.#store = store;
    this.#key = key;
    let saved: unknown = [];
    try {
      saved = JSON.parse(store?.getItem(key) ?? '[]');
    } catch {
      saved = [];
    }
    this.#collapsed = new Set(Array.isArray(saved) ? saved.filter((s): s is string => typeof s === 'string') : []);
  }

  has(section: string): boolean {
    return this.#collapsed.has(section);
  }

  set(section: string, collapsed: boolean): void {
    if (collapsed) this.#collapsed.add(section); else this.#collapsed.delete(section);
    try {
      this.#store?.setItem(this.#key, JSON.stringify([...this.#collapsed]));
    } catch {
      // Storage full or blocked: the state still holds for this page.
    }
  }
}
