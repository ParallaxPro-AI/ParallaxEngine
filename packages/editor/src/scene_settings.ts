/**
 * Scene settings: the open scene's "environment" block (see the engine's environment
 * spec: sky, time of day, sun, fog, clouds, atmosphere, weather, post), shown when the
 * scene itself is inspected. A key the scene doesn't write shows the engine's default in
 * grey; editing it writes the key, and its ↺ removes it again. Gravity is the physics
 * plugin's (`physics3d(gravity=...)` in game code), shown read-only.
 */

import { DEFAULT_CLOUDS, DEFAULT_POST, POST_FIELDS, POST_PRESETS, SKY_PRESETS } from '@parallax/runtime/plugins/environment';
import { WEATHER_PRESET_NAMES } from '@parallax/runtime/plugins/weather';
import type { Json, JsonObject } from '@parallax/runtime/resource';
import { h, icon } from './dom.js';
import { assetName } from './fields.js';
import { t } from './i18n.js';
import type { CollapsedSections } from './fields.js';
import { hexColorControl, plainNumberControl } from './inspector_widgets.js';
import type { FieldEnv, WidgetServices } from './inspector_widgets.js';
import { openAssetPicker } from './inspector_pickers.js';

export interface SceneSettingsContext {
  readonly editable: boolean;
  readonly environment: JsonObject;
  /** Set a key (undefined removes it); `merge` joins a drag's steps into one undo step. */
  readonly set: (keys: readonly string[], value: Json | undefined, merge?: boolean) => void;
  /** A drag ended: its steps are one undo step. */
  readonly settle: () => void;
  readonly collapsed: CollapsedSections;
  readonly services: WidgetServices;
  /** The physics plugin's gravity (m/s², along y), when the game has one. */
  readonly gravity: number | undefined;
  readonly dimension: '2d' | '3d';
}

type Kind =
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly int?: boolean }
  | { readonly kind: 'bool' }
  | { readonly kind: 'color' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'image' };

interface EnvField {
  readonly keys: readonly string[];
  readonly label: string;
  readonly type: Kind;
  /** What the engine uses when the key is absent (shown greyed out). */
  readonly fallback: Json;
  readonly hint?: string;
}

const num = (min?: number, max?: number, int = false): Kind => ({ kind: 'number', ...(min !== undefined && { min }), ...(max !== undefined && { max }), int });

function at(obj: Json | undefined, keys: readonly string[]): Json | undefined {
  let value: Json | undefined = obj;
  for (const key of keys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = (value as JsonObject)[key];
  }
  return value;
}

const colorJson = (c: { r: number; g: number; b: number; a: number }): Json => [c.r, c.g, c.b, c.a];

const POST_ROWS: readonly EnvField[] = POST_FIELDS.map((f): EnvField => {
  const fallback = DEFAULT_POST[f.prop] as unknown;
  // Grouped fields (stylize) are written inside their block: "post": {"stylize": {"pixelate": 4}}.
  const keys = f.group === undefined ? ['post', f.key] : ['post', f.group, f.key];
  if (f.kind === 'number') return { keys, label: labelOf(f.key), type: num(f.min, f.max, f.whole === true), fallback: fallback as number, hint: f.doc };
  if (f.kind === 'bool') return { keys, label: labelOf(f.key), type: { kind: 'bool' }, fallback: fallback as boolean, hint: f.doc };
  return { keys, label: labelOf(f.key), type: { kind: 'color' }, fallback: colorJson(fallback as never), hint: f.doc };
});

/** `key` in the editor's language, or `english` while it has no translation. */
function tr(key: string, english: string): string {
  const text = t(key);
  return text === key ? english : text;
}

const fieldName = (field: EnvField): string => tr(`env.${field.keys.join('.')}`, field.label);
const fieldHint = (field: EnvField): string | undefined => (field.hint === undefined ? undefined : tr(`env.${field.keys.join('.')}.hint`, field.hint));
const optionText = (value: string): string => tr(`env.option.${value}`, value);

function labelOf(key: string): string {
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The groups shown, in order. A group with `present` shows its fields only once its block exists. */
const GROUPS: readonly { readonly id: string; readonly title: string; readonly fields: readonly EnvField[] }[] = [
  {
    id: 'sky', title: 'Sky and time', fields: [
      { keys: ['sky'], label: 'Sky', type: { kind: 'enum', values: SKY_PRESETS }, fallback: 'clear_day' },
      { keys: ['time_of_day'], label: 'Time of day', type: num(0, 24), fallback: 12, hint: 'Hours, 0–24' },
      { keys: ['day_length'], label: 'Day length (s)', type: num(0), fallback: 0, hint: 'Real seconds per in-game day; 0: time stands still' },
      { keys: ['ambient'], label: 'Ambient', type: { kind: 'color' }, fallback: null, hint: 'Default: the sky preset\'s' },
      { keys: ['skybox'], label: 'Skybox', type: { kind: 'image' }, fallback: null, hint: 'An equirectangular (2:1) panorama drawn as the sky' },
    ],
  },
  {
    id: 'sun', title: 'Sun', fields: [
      { keys: ['sun', 'intensity'], label: 'Intensity', type: num(0), fallback: null, hint: 'Default: from the time of day' },
      { keys: ['sun', 'color'], label: 'Color', type: { kind: 'color' }, fallback: null },
      { keys: ['sun', 'shadow_distance'], label: 'Shadow distance', type: num(0), fallback: null, hint: 'Meters the sun\'s shadows reach (default: the quality level\'s)' },
    ],
  },
  {
    id: 'atmosphere', title: 'Atmosphere', fields: [
      { keys: ['atmosphere', 'haze'], label: 'Haze', type: num(0, 4), fallback: 1, hint: 'The "atmosphere" sky\'s air: 0 crisp … 4 hazy' },
      { keys: ['atmosphere', 'sun_size'], label: 'Sun size', type: num(0), fallback: 1 },
    ],
  },
  {
    id: 'debug', title: 'Debug', fields: [
      { keys: ['debug', 'wireframe'], label: 'Wireframe', type: { kind: 'bool' }, fallback: false, hint: 'Every mesh and the terrain drawn as triangle edges' },
      { keys: ['debug', 'wire_color'], label: 'Wire color', type: { kind: 'color' }, fallback: null, hint: 'Default: each surface\'s color' },
      { keys: ['debug', 'wire_background'], label: 'Wire background', type: { kind: 'color' }, fallback: null, hint: 'Default: the sky' },
    ],
  },
];

const FOG_EXP: readonly EnvField[] = [
  { keys: ['fog', 'density'], label: 'Density', type: num(0, 1), fallback: 0 },
  { keys: ['fog', 'height_falloff'], label: 'Height falloff', type: num(0, 10), fallback: 0, hint: 'Thins the fog with altitude (0.02–0.3: ground mist)' },
  { keys: ['fog', 'height'], label: 'Height', type: num(), fallback: 0 },
];
const FOG_LINEAR: readonly EnvField[] = [
  { keys: ['fog', 'near'], label: 'Near', type: num(0), fallback: 20 },
  { keys: ['fog', 'far'], label: 'Far', type: num(0), fallback: 80 },
];
const FOG_COMMON: readonly EnvField[] = [
  { keys: ['fog', 'color'], label: 'Color', type: { kind: 'color' }, fallback: null, hint: 'Default: the sky\'s horizon' },
  { keys: ['fog', 'volumetric'], label: 'Volumetric', type: num(0, 1), fallback: 0, hint: 'Sunlight scattered by the fog (light shafts)' },
];
const CLOUDS: readonly EnvField[] = (Object.keys(DEFAULT_CLOUDS) as (keyof typeof DEFAULT_CLOUDS)[]).map((key): EnvField => ({
  keys: ['clouds', key], label: labelOf(key),
  type: key === 'coverage' || key === 'density' ? num(0, 1) : key === 'direction' ? num(0, 360) : num(0),
  fallback: DEFAULT_CLOUDS[key],
}));

export function sceneSettings(scene: string, ctx: SceneSettingsContext): HTMLElement {
  const env = ctx.environment;
  const root = h('div.scene-settings');
  root.append(h('div.inspector-header', {},
    h('div.inspector-name', { text: scene }),
    h('div.inspector-meta', {}, h('span.badge', { text: t('env.sceneBadge') }), h('span.inspector-source', { text: 'environment', title: t('env.environmentTitle') }))));
  if (!ctx.editable) root.append(h('p.panel-note', { text: t('env.editModeOnly') }));
  if (ctx.dimension === '2d') root.append(h('p.panel-note', { text: t('env.note2d') }));

  for (const group of GROUPS) root.append(section(`env:${group.id}`, tr(`env.group.${group.id}`, group.title), group.fields.map((f) => row(f, env, ctx)), ctx));

  // Fog: none, exponential (density) or linear (near / far).
  const fog = at(env, ['fog']);
  const fogMode = fog === undefined ? 'none' : at(fog, ['near']) !== undefined ? 'linear' : 'exponential';
  const fogColor = at(fog, ['color']);
  const fogRows = [selectRow(t('env.fog'), ['none', 'exponential', 'linear'], fogMode, ctx, (mode) => {
    if (mode === 'none') ctx.set(['fog'], undefined);
    else ctx.set(['fog'], { ...(mode === 'linear' ? { near: 20, far: 80 } : { density: 0.01 }), ...(fogColor !== undefined && { color: fogColor }) });
  })];
  if (fogMode !== 'none') fogRows.push(...[...(fogMode === 'linear' ? FOG_LINEAR : FOG_EXP), ...FOG_COMMON].map((f) => row(f, env, ctx)));
  root.append(section('env:fog', t('env.fog'), fogRows, ctx));

  // Clouds: a layer only when the block exists.
  const clouds = at(env, ['clouds']);
  const cloudRows = [toggleRow(t('env.cloudLayer'), clouds !== undefined, ctx, (on) => ctx.set(['clouds'], on ? {} : undefined))];
  if (clouds !== undefined) cloudRows.push(...CLOUDS.map((f) => row(f, env, ctx)));
  root.append(section('env:clouds', t('env.clouds'), cloudRows, ctx));

  // Weather: a preset name (a written object keeps its other keys).
  const weather = at(env, ['weather']);
  const weatherPreset = typeof weather === 'string' ? weather : typeof at(weather, ['preset']) === 'string' ? at(weather, ['preset']) as string : 'none';
  root.append(section('env:weather', t('env.weather'), [
    selectRow(t('env.preset'), ['none', ...WEATHER_PRESET_NAMES], weatherPreset, ctx, (preset) => {
      if (preset === 'none') ctx.set(['weather'], undefined);
      else if (typeof weather === 'object' && weather !== null && !Array.isArray(weather)) ctx.set(['weather', 'preset'], preset);
      else ctx.set(['weather'], preset);
    }, t('env.weatherHint')),
  ], ctx));

  // Post-processing: a preset, then each field over it.
  const preset = at(env, ['post', 'preset']);
  const postRows = [selectRow(t('env.preset'), ['none', ...Object.keys(POST_PRESETS)], typeof preset === 'string' ? preset : 'none', ctx,
    (name) => ctx.set(['post', 'preset'], name === 'none' ? undefined : name))];
  postRows.push(...POST_ROWS.map((f) => row(f, env, ctx)));
  root.append(section('env:post', t('env.post'), postRows, ctx));

  root.append(section('env:physics', t('category.Physics'), [
    h('div.field-row', { title: t('env.gravityTitle') },
      h('span.field-label', { text: t('env.gravity') }),
      h('span.field-readonly', { text: ctx.gravity === undefined ? t('env.noPhysics') : t('env.gravityValue', { value: ctx.gravity }) })),
  ], ctx));
  return root;
}

function section(key: string, title: string, rows: readonly HTMLElement[], ctx: SceneSettingsContext): HTMLElement {
  const details = h('details.inspector-section', {}, h('summary', {}, h('span.section-title', { text: title })), h('div.fields', {}, ...rows));
  details.open = !ctx.collapsed.has(key);
  details.addEventListener('toggle', () => ctx.collapsed.set(key, !details.open));
  return details;
}

function rowFrame(label: string, control: HTMLElement, hint: string | undefined, revert: (() => void) | undefined, isSet: boolean, labelEl?: HTMLElement): HTMLElement {
  const l = labelEl ?? h('span.field-label', { text: label });
  if (hint !== undefined) l.title = hint;
  const row = h('div.field-row', {}, l, control,
    revert !== undefined ? h('button.field-revert', { type: 'button', title: t('env.backToDefault'), onclick: () => revert() }, icon('reload', 11)) : null);
  if (!isSet) row.classList.add('defaulted');
  return row;
}

function selectRow(label: string, values: readonly string[], current: string, ctx: SceneSettingsContext, change: (value: string) => void, hint?: string): HTMLElement {
  const select = h('select.field-input', { disabled: !ctx.editable }, ...values.map((v) => h('option', { value: v, text: optionText(v), selected: v === current })));
  select.addEventListener('change', () => change(select.value));
  return rowFrame(label, select, hint, undefined, true);
}

function toggleRow(label: string, on: boolean, ctx: SceneSettingsContext, change: (on: boolean) => void): HTMLElement {
  const box = h('input.field-check', { type: 'checkbox', disabled: !ctx.editable });
  box.checked = on;
  box.addEventListener('change', () => change(box.checked));
  return rowFrame(label, box, undefined, undefined, true);
}

function row(field: EnvField, env: JsonObject, ctx: SceneSettingsContext): HTMLElement {
  const written = at(env, field.keys);
  const isSet = written !== undefined;
  const value = written ?? field.fallback;
  const label = h('span.field-label', { text: fieldName(field) });
  const fieldEnv: FieldEnv = {
    editable: ctx.editable, mixed: false, services: ctx.services,
    commit: (v) => ctx.set(field.keys, v),
    preview: (v) => ctx.set(field.keys, v, true),
    settle: () => ctx.settle(),
  };
  let control: HTMLElement;
  switch (field.type.kind) {
    case 'number':
      control = plainNumberControl(typeof value === 'number' ? value : null, field.type, typeof value === 'number' ? fieldEnv : { ...fieldEnv, mixed: true }, label, field.type.int === true);
      if (typeof value !== 'number') control.querySelector('input')?.setAttribute('placeholder', t('env.default'));
      break;
    case 'bool': {
      const box = h('input.field-check', { type: 'checkbox', disabled: !ctx.editable });
      box.checked = value === true;
      box.addEventListener('change', () => ctx.set(field.keys, box.checked));
      control = box;
      break;
    }
    case 'color':
      control = value === null && !isSet
        ? h('button.optional-set', { type: 'button', text: t('widgets.set'), disabled: !ctx.editable, onclick: () => ctx.set(field.keys, '#ffffff') })
        : hexColorControl(value, fieldEnv);
      break;
    case 'enum': {
      const values = field.type.values;
      const select = h('select.field-input', { disabled: !ctx.editable }, ...values.map((v) => h('option', { value: v, text: optionText(v), selected: v === value })));
      select.addEventListener('change', () => ctx.set(field.keys, select.value));
      control = select;
      break;
    }
    case 'image': {
      const texture = typeof value === 'string' ? value : typeof at(value, ['texture']) === 'string' ? at(value, ['texture']) as string : '';
      const keys = typeof value === 'object' && value !== null ? [...field.keys, 'texture'] : field.keys;
      const button = h('button.picker-field.asset-field', { type: 'button', disabled: !ctx.editable, title: texture || t('env.choosePanorama') },
        h('span.picker-icon', {}, ctx.services.assets.thumb(texture, 'images') ?? icon('image', 13)),
        h('span.picker-name', { text: texture === '' ? t('inspector.none') : assetName(texture) }));
      if (texture === '') button.classList.add('empty');
      button.addEventListener('click', () => openAssetPicker(button, 'images', texture, ctx.services.assets, (ref) => ctx.set(ref === '' ? field.keys : keys, ref === '' ? undefined : ref)));
      control = h('div.picker-row', {}, button);
      break;
    }
  }
  return rowFrame(fieldName(field), control, fieldHint(field), isSet && ctx.editable ? () => ctx.set(field.keys, undefined) : undefined, isSet, label);
}
