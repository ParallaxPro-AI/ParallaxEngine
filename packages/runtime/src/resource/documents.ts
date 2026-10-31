/** Parsers for each kind of data file. Each returns plain model data and reports into its reader. */

import { isAssetUrl, remoteAssetProblem, remoteAssetUrl } from '../core/index.js';
import { noteWritten, withoutNulls } from './merge.js';
import { assetHandle } from './asset_catalog.js';
import { childPointer, DocReader, isObject } from './reader.js';
import type {
  AudioDefaults, AudioLevel, BehaviorUse, ConfigDoc, ContentEntry, FeatureId, InstanceFields, InstanceGrid,
  Json, JsonObject, LocaleDoc, Placement, PrefabChild, PrefabDoc, RegionDoc, WorldDoc, WorldLayerDoc,
} from './model.js';

const INSTANCE_KEYS = ['at', 'rotation', 'scale', 'z', 'components', 'tags', 'params', 'grid', 'visible'] as const;
const PLACEMENT_KEYS = ['prefab', 'id', ...INSTANCE_KEYS] as const;
const REGION_ENTITY_KEYS = [...PLACEMENT_KEYS, 'layer', 'always_loaded'] as const;
const CHILD_KEYS = ['name', 'prefab', ...INSTANCE_KEYS] as const;
const PREFAB_KEYS = ['extends', 'components', 'tags', 'behaviors', 'children', 'pool', 'z', 'scale', 'replicate_transform'] as const;
export const SCENE_KEYS = ['extends', 'exclude', 'tags', 'ui', 'music', 'music_volume', 'environment', 'init', 'entities'] as const;
/** Scene blocks owned and validated by plugins. */
export const PLUGIN_SCENE_BLOCKS = ['terrain', 'voxels', 'navmesh', 'foliage', 'wind', 'city'] as const;
const WORLD_KEYS = ['cell_size', 'streaming', 'layers'] as const;

/** Keys people reach for that have one right spelling. */
const RENAMED: Readonly<Record<string, string>> = {
  position: 'Use "at".',
  pos: 'Use "at".',
  behaviors: 'Per-instance behavior settings go in "params": {"<behavior id>": {...}}.',
};

/** Retired top-level scene keys: ignored, with a warning naming where the setting lives now. */
export const SCENE_RENAMED: Readonly<Record<string, string>> = {
  mode: 'Remove "mode": a game is 2D or 3D as a whole, set once by Game(mode="2d" | "3d") in game/main.py.',
};

/**
 * A map of objects keyed by id ("components", "params", "behaviors", "init"). An entry may
 * be `null`: it deletes the inherited entry of that id (see merge.ts).
 */
export function idMap(r: DocReader, obj: JsonObject, key: string, pointer: string): Readonly<Record<string, JsonObject>> {
  const map = r.objectMap(obj, key, pointer, true);
  const raw = obj[key];
  return isObject(raw) ? noteWritten(map, raw) : map;
}

/** "components" of a prefab or instance. The transform is the entity's, not a component. */
function components(r: DocReader, obj: JsonObject, pointer: string): Readonly<Record<string, JsonObject>> {
  const map = idMap(r, obj, 'components', pointer);
  if ('transform' in map) {
    r.report('PP1008', 'The transform is not a component', `${pointer}/components/transform`,
      'Use "at", "rotation" and "scale" on the instance (or "scale" and "z" on the prefab).');
    const { transform: _, ...rest } = map;
    return noteWritten(rest, withoutTransform(obj['components']));
  }
  return map;
}

function withoutTransform(raw: Json | undefined): JsonObject {
  if (!isObject(raw)) return {};
  const { transform: _, ...rest } = raw;
  return rest;
}

/**
 * The instance fields of `written` (a placement or child object). A top-level `null`
 * deletes an inherited value when the instance merges over a base one (see merge.ts).
 */
function instanceFields(r: DocReader, written: JsonObject, pointer: string): InstanceFields {
  const obj = withoutNulls(written);
  const at = r.numbers(obj, 'at', pointer, [2, 3]);
  const rotation = r.numberOrNumbers(obj, 'rotation', pointer, [3]);
  const scale = r.numberOrNumbers(obj, 'scale', pointer, [2, 3]);
  const z = r.number(obj, 'z', pointer);
  const grid = instanceGrid(r, obj, pointer);
  const visible = r.boolean(obj, 'visible', pointer);
  return {
    ...(at !== undefined && { at }),
    ...(rotation !== undefined && { rotation }),
    ...(scale !== undefined && { scale }),
    ...(z !== undefined && { z }),
    components: components(r, obj, pointer),
    tags: r.strings(obj, 'tags', pointer),
    params: idMap(r, obj, 'params', pointer),
    ...(grid !== undefined && { grid }),
    ...(visible !== undefined && { visible }),
    origin: r.origin(pointer),
  };
}

function instanceGrid(r: DocReader, obj: JsonObject, pointer: string): InstanceGrid | undefined {
  if (obj['grid'] === undefined) return undefined;
  const at = childPointer(pointer, 'grid');
  const grid = r.object(obj['grid'], at, '"grid"');
  if (grid === undefined) return undefined;
  r.keys(grid, at, ['cols', 'rows', 'spacing', 'origin']);
  const cols = r.number(grid, 'cols', at, true);
  const rows = r.number(grid, 'rows', at, true);
  const spacing = r.numbers(grid, 'spacing', at, [2, 3], true);
  const origin = r.numbers(grid, 'origin', at, [2, 3], true);
  if (cols === undefined || rows === undefined || spacing === undefined || origin === undefined) return undefined;
  return { cols, rows, spacing, origin };
}

/**
 * A scene placement. With `override` (a derived scene), "prefab" may be left out: the
 * placement then merges over the base scene's placement with the same "id", and the
 * scene loader reports it if there is none. Such a placement has `prefab: ''`.
 */
export function parsePlacement(
  r: DocReader, value: Json | undefined, pointer: string, allowLayer: boolean, override = false,
): Placement | undefined {
  const written = r.object(value, pointer, 'A placement');
  if (written === undefined) return undefined;
  r.keys(written, pointer, allowLayer ? REGION_ENTITY_KEYS : PLACEMENT_KEYS, RENAMED);
  const obj = withoutNulls(written);
  const prefab = r.string(obj, 'prefab', pointer, !override);
  if (prefab === undefined && !override) return undefined;
  const id = r.string(obj, 'id', pointer);
  const layer = allowLayer ? r.string(obj, 'layer', pointer) : undefined;
  const alwaysLoaded = allowLayer ? r.boolean(obj, 'always_loaded', pointer) : undefined;
  return noteWritten({
    prefab: prefab ?? '',
    ...(id !== undefined && { id }),
    ...(layer !== undefined && { layer }),
    ...(alwaysLoaded !== undefined && { alwaysLoaded }),
    ...instanceFields(r, written, pointer),
  }, written);
}

/**
 * A prefab's "behaviors": a map keyed by behavior id, each value that behavior's params —
 * the same shape as a placement's "params" and `spawn(params=...)`. `null` removes a
 * behavior the prefab inherits.
 */
function behaviorUses(r: DocReader, obj: JsonObject): BehaviorUse[] {
  const value = obj['behaviors'];
  if (value === undefined) return [];
  if (Array.isArray(value)) return oldBehaviorList(r, value);
  const map = idMap(r, obj, 'behaviors', '');
  const uses = Object.entries(map).map(([use, params]) => ({ use, params, origin: r.origin(childPointer('/behaviors', use)) }));
  return isObject(value) ? noteWritten(uses, value) : uses;
}

/** The retired `"behaviors": [{"use": ..., "params": {...}}]` list: an error whose fix is the map. */
function oldBehaviorList(r: DocReader, list: readonly Json[]): BehaviorUse[] {
  const uses: BehaviorUse[] = [];
  const map: Record<string, Json> = {};
  list.forEach((entry: Json, i: number) => {
    if (!isObject(entry) || typeof entry['use'] !== 'string') return;
    const params = isObject(entry['params']) ? entry['params'] : {};
    map[entry['use']] = params;
    uses.push({ use: entry['use'], params, origin: r.origin(childPointer('/behaviors', i)) });
  });
  r.report('PP1002', '"behaviors" is a map keyed by behavior id, not a list of {"use": ..., "params": ...}', '/behaviors',
    `Write "behaviors": ${JSON.stringify(map)} (each behavior id → its params, {} for none).`);
  return uses;
}

function children(r: DocReader, obj: JsonObject): PrefabChild[] {
  const list = obj['children'];
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    r.report('PP1002', '"children" must be a list', '/children');
    return [];
  }
  const result: PrefabChild[] = [];
  list.forEach((entry: Json, i: number) => {
    const pointer = childPointer('/children', i);
    const child = r.object(entry, pointer, 'A child');
    if (child === undefined) return;
    // One level of inline children by design: a child that needs its own children is a prefab
    // (`"prefab": ...`), whose children spawn under it.
    if ('children' in child) {
      r.report('PP1003', 'An inline child can\'t have "children" of its own', childPointer(pointer, 'children'),
        'Move this child into its own prefab (prefabs/<name>.prefab.json, with these children) and write {"prefab": "<name>"} here.');
    }
    r.keys(Object.fromEntries(Object.entries(child).filter(([k]) => k !== 'children')), pointer, CHILD_KEYS, RENAMED);
    const name = r.string(withoutNulls(child), 'name', pointer);
    const prefab = r.string(withoutNulls(child), 'prefab', pointer);
    result.push(noteWritten({
      ...(name !== undefined && { name }),
      ...(prefab !== undefined && { prefab }),
      ...instanceFields(r, child, pointer),
    }, child));
  });
  return result;
}

/**
 * A prefab file. In a variant (`"extends"`), a top-level `null` deletes the inherited value;
 * `resolvePrefab` (variants.ts) merges by the rule in merge.ts.
 */
export function parsePrefab(r: DocReader, doc: Json, id: string, feature: FeatureId): PrefabDoc | undefined {
  const written = r.object(doc, '', 'A prefab');
  if (written === undefined) return undefined;
  r.keys(written, '', PREFAB_KEYS);
  const obj = typeof written['extends'] === 'string' ? withoutNulls(written) : written;
  const base = r.string(obj, 'extends', '');
  const pool = r.number(obj, 'pool', '');
  const z = r.number(obj, 'z', '');
  const scale = r.numberOrNumbers(obj, 'scale', '', [2, 3]);
  const replicateTransform = r.boolean(obj, 'replicate_transform', '');
  return noteWritten({
    id,
    feature,
    path: r.path,
    ...(base !== undefined && { extends: base }),
    components: components(r, obj, ''),
    tags: r.strings(obj, 'tags', ''),
    behaviors: behaviorUses(r, obj),
    children: children(r, obj),
    ...(pool !== undefined && { pool }),
    ...(z !== undefined && { z }),
    ...(scale !== undefined && { scale }),
    ...(replicateTransform !== undefined && { replicateTransform }),
  }, written);
}

export function parseWorld(r: DocReader, doc: Json): WorldDoc | undefined {
  const obj = r.object(doc, '', 'world.json');
  if (obj === undefined) return undefined;
  r.keys(obj, '', WORLD_KEYS);
  const cellSize = r.number(obj, 'cell_size', '', true);
  if (cellSize === undefined) return undefined;
  const layers = new Map<string, WorldLayerDoc>();
  for (const [id, layer] of Object.entries(r.objectMap(obj, 'layers', ''))) {
    const pointer = childPointer('/layers', id);
    r.keys(layer, pointer, ['active_when']);
    const activeWhen = layer['active_when'] === undefined
      ? undefined
      : r.object(layer['active_when'], childPointer(pointer, 'active_when'), '"active_when"');
    layers.set(id, { id, ...(activeWhen !== undefined && { activeWhen }) });
  }
  const streaming = obj['streaming'] === undefined ? undefined : r.object(obj['streaming'], '/streaming', '"streaming"');
  return { path: r.path, cellSize, ...(streaming !== undefined && { streaming }), layers };
}

export function parseRegion(r: DocReader, doc: Json, id: string): RegionDoc | undefined {
  const obj = r.object(doc, '', 'region.json');
  if (obj === undefined) return undefined;
  r.keys(obj, '', ['bounds', 'budget']);
  let bounds: RegionDoc['bounds'];
  if (obj['bounds'] !== undefined) {
    const b = r.object(obj['bounds'], '/bounds', '"bounds"');
    if (b !== undefined) {
      r.keys(b, '/bounds', ['min', 'max']);
      const min = r.numbers(b, 'min', '/bounds', [2], true);
      const max = r.numbers(b, 'max', '/bounds', [2], true);
      if (min !== undefined && max !== undefined) bounds = { min, max };
    }
  }
  let budget: RegionDoc['budget'];
  if (obj['budget'] !== undefined) {
    const b = r.object(obj['budget'], '/budget', '"budget"');
    if (b !== undefined) {
      r.keys(b, '/budget', ['entities']);
      const entities = r.number(b, 'entities', '/budget');
      budget = entities === undefined ? {} : { entities };
    }
  }
  return { id, path: r.path, ...(bounds !== undefined && { bounds }), ...(budget !== undefined && { budget }) };
}

export function parseConfig(r: DocReader, doc: Json, id: string, feature: FeatureId): ConfigDoc | undefined {
  const values = r.object(doc, '', 'A config document');
  return values === undefined ? undefined : { id, feature, path: r.path, values };
}

export function parseContent(r: DocReader, doc: Json, kind: string, id: string, feature: FeatureId): ContentEntry | undefined {
  const values = r.object(doc, '', 'A content entry');
  return values === undefined ? undefined : { kind, id, feature, path: r.path, values };
}

export function parseLocale(r: DocReader, doc: Json, language: string): LocaleDoc | undefined {
  const obj = r.object(doc, '', 'A locale file');
  if (obj === undefined) return undefined;
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') strings[key] = value;
    else r.report('PP1002', `Locale entry "${key}" must be a string`, childPointer('', key));
  }
  return { language, path: r.path, strings };
}

function audioLevel(r: DocReader, entry: JsonObject, key: string, pointer: string): AudioLevel | undefined {
  const value = entry[key];
  if (value === undefined || typeof value === 'number') return value;
  const range = r.numbers(entry, key, pointer, [2]);
  return range === undefined ? undefined : [range[0]!, range[1]!];
}

/** "sfx/jump.ogg", "assets/sfx/jump.synth.json" or a bare "jump" → "sfx/jump" (what `Assets.sfx.jump` names). */
function canonicalAudioKey(key: string): string {
  const handle = assetHandle(key);
  return handle.includes('/') ? handle : `sfx/${handle}`;
}

export function parseAudio(r: DocReader, doc: Json): Map<string, AudioDefaults> {
  const audio = new Map<string, AudioDefaults>();
  const obj = r.object(doc, '', 'assets/audio.json');
  if (obj === undefined) return audio;
  for (const [written, entry] of Object.entries(obj)) {
    const pointer = childPointer('', written);
    // A hosted sound (core/remote_assets.ts) is keyed by its URL, the handle it plays under.
    const hosted = isAssetUrl(written) ? remoteAssetProblem(written, 'sfx') : undefined;
    const key = isAssetUrl(written) && hosted === undefined ? remoteAssetUrl(written)! : written;
    if (hosted !== undefined) {
      r.report('PP1009', `Audio key: ${hosted}`, pointer, 'Key a hosted sound by its URL, https://r2.parallaxpro.ai/assets/….ogg (or .mp3, .wav, .m4a).');
    } else if (!isAssetUrl(written) && !/^(sfx|music)\/[a-z0-9_]+$/.test(key)) {
      // The one spelling of every asset reference: the handle (`Assets.sfx.jump` → "sfx/jump").
      r.report('PP1009', `Audio key "${key}" must be the sound's handle, "sfx/<name>" or "music/<name>"`, pointer,
        `Use "${canonicalAudioKey(key)}" (no "assets/", no extension).`);
    }
    if (!isObject(entry)) {
      r.report('PP1002', `"${key}" must be an object`, pointer);
      continue;
    }
    r.keys(entry, pointer, ['volume', 'pitch', 'duck', 'bank', 'priority', 'limit', 'pauses', 'group']);
    const volume = audioLevel(r, entry, 'volume', pointer);
    const pitch = audioLevel(r, entry, 'pitch', pointer);
    const duck = r.boolean(entry, 'duck', pointer);
    const bank = r.string(entry, 'bank', pointer);
    const priority = r.number(entry, 'priority', pointer);
    const limit = r.number(entry, 'limit', pointer);
    const pauses = r.boolean(entry, 'pauses', pointer);
    const group = r.string(entry, 'group', pointer);
    if (group !== undefined && !/^[a-z][a-z0-9_]*$/.test(group)) {
      r.report('PP1002', `"${key}" group must be a snake_case name, got ${JSON.stringify(group)}`, childPointer(pointer, 'group'), 'e.g. "group": "voice" (then ctx.audio.set_group("voice", volume=0.5)).');
    }
    if (pauses !== undefined && !key.startsWith('music/') && !isAssetUrl(written)) {
      r.report('PP1002', `"${key}" "pauses" applies to music tracks only`, childPointer(pointer, 'pauses'),
        'Remove "pauses" (entity sounds already mute while the game is paused), or move the track under assets/music/.');
    }
    if (priority !== undefined && !(priority >= 0 && priority <= 255)) {
      r.report('PP1002', `"${key}" priority must be 0..255`, childPointer(pointer, 'priority'), 'Higher is kept when too many sounds play; the default is 64.');
    }
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) {
      r.report('PP1002', `"${key}" limit must be a whole number of sounds, at least 1`, childPointer(pointer, 'limit'), 'e.g. "limit": 4.');
    }
    audio.set(key, {
      ...(volume !== undefined && { volume }), ...(pitch !== undefined && { pitch }),
      ...(duck !== undefined && { duck }), ...(bank !== undefined && { bank }),
      ...(priority !== undefined && { priority }), ...(limit !== undefined && { limit }),
      ...(pauses !== undefined && { pauses }), ...(group !== undefined && { group }),
    });
  }
  return audio;
}
