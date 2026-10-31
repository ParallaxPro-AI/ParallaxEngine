/**
 * Load a project's data files into a `Project`. Code, UI markup and binary assets are not
 * this layer's business; every JSON data file is, and each one lives at exactly one kind
 * of path:
 *
 *   [features/<f>/]prefabs/**\/<id>.prefab.json
 *   [features/<f>/]config/<id>.json
 *   [features/<f>/]content/<kind>/<id>.json
 *   scenes/<id>/scene.json  (+ world.json, regions/<region>/region.json,
 *                            regions/<region>/entities/<id>.json)
 *   locale/<language>.json
 *   assets/audio.json
 *
 * and one text kind, kept as text for the story plugin to parse:
 *
 *   [features/<f>/]story/<id>.yarn
 */

import { closestMatch } from '../core/index.js';
import type { Diagnostic, ProjectFiles } from '../core/index.js';
import { checkReferences } from './references.js';
import {
  parseAudio, parseConfig, parseContent, parseLocale, parsePlacement, parsePrefab, parseRegion, parseWorld,
  idMap, PLUGIN_SCENE_BLOCKS, SCENE_KEYS, SCENE_RENAMED,
} from './documents.js';
import { mergeInstance, mergeJson, mergeMap, mergeNamed, notedKeys, withoutNulls } from './merge.js';
import { childPointer, DocReader } from './reader.js';
import type {
  AudioDefaults, ConfigDoc, ContentEntry, DialogueFile, FeatureId, Json, JsonObject, LocaleDoc, Placement,
  PrefabDoc, Project, RegionDoc, SceneDoc, WorldDoc,
} from './model.js';

const ID = '[a-z][a-z0-9_]*';
const FEATURE = `(?:features/(${ID})/)?`;

const PREFAB = new RegExp(`^${FEATURE}prefabs/(?:.+/)?([^/]+)\\.prefab\\.json$`);
const CONFIG = new RegExp(`^${FEATURE}config/([^/]+)\\.json$`);
const CONTENT = new RegExp(`^${FEATURE}content/([^/]+)/([^/]+)\\.json$`);
const SCENE_FILE = /^scenes\/([^/]+)\/scene\.json$/;
const WORLD_FILE = /^scenes\/([^/]+)\/world\.json$/;
const REGION_FILE = /^scenes\/([^/]+)\/regions\/([^/]+)\/region\.json$/;
const REGION_ENTITY = /^scenes\/([^/]+)\/regions\/([^/]+)\/entities\/([^/]+)\.json$/;
const LOCALE = /^locale\/([^/]+)\.json$/;
const AUDIO = 'assets/audio.json';
const DIALOGUE = new RegExp(`^${FEATURE}story/([^/]+)\\.yarn$`);
const SNAKE_CASE = new RegExp(`^${ID}$`);

/** JSON that is not project data: asset definitions and generated output (`build/`, the transpiler's default). */
function isOutsideData(path: string): boolean {
  return path.startsWith('assets/') || path.startsWith('.parallax/') || path.startsWith('build/');
}

/**
 * One scene file read on its own, before inheritance: `doc` is the scene as if it
 * extended nothing, `present` the top-level keys the file writes.
 */
interface OwnScene {
  readonly doc: SceneDoc;
  readonly reader: DocReader;
  readonly present: ReadonlySet<string>;
  readonly base?: string;
  readonly exclude: readonly { readonly id: string; readonly pointer: string }[];
}

interface ScenePieces {
  scene?: { reader: DocReader; doc: Json };
  world?: WorldDoc;
  regionDocs: Map<string, RegionDoc>;
  regions: Placement[];
}

class Loader {
  readonly diagnostics: Diagnostic[] = [];
  readonly prefabs = new Map<string, PrefabDoc>();
  readonly config = new Map<string, ConfigDoc>();
  readonly content = new Map<string, Map<string, ContentEntry>>();
  readonly locales = new Map<string, LocaleDoc>();
  audio = new Map<string, AudioDefaults>();
  readonly dialogues = new Map<string, DialogueFile>();
  readonly plans = new Map<string, string>();
  readonly scenePieces = new Map<string, ScenePieces>();

  readonly #files: ProjectFiles;

  constructor(files: ProjectFiles) {
    this.#files = files;
  }

  load(): Project {
    for (const path of this.#files.list()) {
      if (path.endsWith('.json')) this.#loadFile(path);
      else if (DIALOGUE.test(path)) this.#loadDialogue(path);
      else if (path.endsWith('.plan')) this.plans.set(path, this.#files.read(path));
    }
    const own = new Map<string, OwnScene>();
    for (const [id, pieces] of this.scenePieces) {
      const scene = this.#assembleScene(id, pieces);
      if (scene !== undefined) own.set(id, scene);
    }
    const resolved = new Map<string, SceneDoc>();
    for (const id of own.keys()) resolveScene(id, own, resolved, []);
    const scenes = new Map([...own.keys()].map((id) => [id, resolved.get(id)!]));
    const partial = {
      prefabs: this.prefabs, scenes, config: this.config, content: this.content,
      locales: this.locales, audio: this.audio, dialogues: this.dialogues, plans: this.plans,
    };
    this.diagnostics.push(...checkReferences(partial));
    return { ...partial, diagnostics: unique(this.diagnostics) };
  }

  #reader(path: string): DocReader {
    return new DocReader(path, this.diagnostics);
  }

  #parse(path: string): { reader: DocReader; doc: Json } | undefined {
    const reader = this.#reader(path);
    const doc = reader.parse(this.#files.read(path));
    return doc === undefined ? undefined : { reader, doc };
  }

  #loadDialogue(path: string): void {
    const [, feature, id] = DIALOGUE.exec(path)!;
    const reader = this.#reader(path);
    this.#checkId(reader, id!, 'Dialogue');
    const existing = this.dialogues.get(id!);
    if (existing !== undefined) {
      reader.report('PP2010', `Dialogue id "${id}" is already defined in ${existing.path}`, '');
      return;
    }
    this.dialogues.set(id!, { id: id!, feature: feature as FeatureId, path, text: this.#files.read(path) });
  }

  /** Ids come from file names; report one that isn't snake_case. */
  #checkId(reader: DocReader, id: string, what: string): void {
    if (!SNAKE_CASE.test(id)) {
      reader.report('PP1004', `${what} id "${id}" must be snake_case`, '',
        `Rename the file to "${id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}".`);
    }
  }

  #loadFile(path: string): void {
    let match: RegExpExecArray | null;
    if ((match = PREFAB.exec(path)) !== null) return this.#loadPrefab(path, match[2]!, match[1]);
    if ((match = CONFIG.exec(path)) !== null) return this.#loadConfig(path, match[2]!, match[1]);
    if ((match = CONTENT.exec(path)) !== null) return this.#loadContent(path, match[2]!, match[3]!, match[1]);
    if ((match = SCENE_FILE.exec(path)) !== null) {
      const parsed = this.#parse(path);
      if (parsed !== undefined) this.#pieces(match[1]!).scene = parsed;
      return;
    }
    if ((match = WORLD_FILE.exec(path)) !== null) {
      const parsed = this.#parse(path);
      const world = parsed && parseWorld(parsed.reader, parsed.doc);
      if (world !== undefined) this.#pieces(match[1]!).world = world;
      return;
    }
    if ((match = REGION_FILE.exec(path)) !== null) {
      const parsed = this.#parse(path);
      const region = parsed && parseRegion(parsed.reader, parsed.doc, match[2]!);
      if (region !== undefined) this.#pieces(match[1]!).regionDocs.set(region.id, region);
      return;
    }
    if ((match = REGION_ENTITY.exec(path)) !== null) return this.#loadRegionEntity(path, match[1]!, match[2]!, match[3]!);
    if ((match = LOCALE.exec(path)) !== null) {
      const parsed = this.#parse(path);
      const locale = parsed && parseLocale(parsed.reader, parsed.doc, match[1]!);
      if (locale !== undefined) this.locales.set(locale.language, locale);
      return;
    }
    if (path === AUDIO) {
      const parsed = this.#parse(path);
      if (parsed !== undefined) this.audio = parseAudio(parsed.reader, parsed.doc);
      return;
    }
    if (!isOutsideData(path)) {
      this.#reader(path).report('PP1005', 'Not a recognized project data file', '',
        'Data files live in prefabs/, scenes/, config/, content/<kind>/, locale/ (optionally under features/<f>/).');
    }
  }

  #loadPrefab(path: string, id: string, feature: FeatureId): void {
    const parsed = this.#parse(path);
    if (parsed === undefined) return;
    this.#checkId(parsed.reader, id, 'Prefab');
    const existing = this.prefabs.get(id);
    if (existing !== undefined) {
      parsed.reader.report('PP2010', `Prefab id "${id}" is already defined in ${existing.path}`, '',
        'Prefab ids are global across features; rename one of them.');
      return;
    }
    const prefab = parsePrefab(parsed.reader, parsed.doc, id, feature);
    if (prefab !== undefined) this.prefabs.set(id, prefab);
  }

  #loadConfig(path: string, id: string, feature: FeatureId): void {
    const parsed = this.#parse(path);
    if (parsed === undefined) return;
    this.#checkId(parsed.reader, id, 'Config');
    const existing = this.config.get(id);
    if (existing !== undefined) {
      parsed.reader.report('PP2010', `Config id "${id}" is already defined in ${existing.path}`, '');
      return;
    }
    const config = parseConfig(parsed.reader, parsed.doc, id, feature);
    if (config !== undefined) this.config.set(id, config);
  }

  #loadContent(path: string, kind: string, id: string, feature: FeatureId): void {
    const parsed = this.#parse(path);
    if (parsed === undefined) return;
    this.#checkId(parsed.reader, kind, 'Content kind');
    this.#checkId(parsed.reader, id, 'Content');
    const entries = this.content.get(kind) ?? new Map<string, ContentEntry>();
    this.content.set(kind, entries);
    const existing = entries.get(id);
    if (existing !== undefined) {
      parsed.reader.report('PP2010', `Content "${kind}/${id}" is already defined in ${existing.path}`, '');
      return;
    }
    const entry = parseContent(parsed.reader, parsed.doc, kind, id, feature);
    if (entry !== undefined) entries.set(id, entry);
  }

  #loadRegionEntity(path: string, scene: string, region: string, id: string): void {
    const parsed = this.#parse(path);
    if (parsed === undefined) return;
    this.#checkId(parsed.reader, id, 'Placed entity');
    const placement = parsePlacement(parsed.reader, parsed.doc, '', true);
    if (placement === undefined) return;
    if (placement.id !== undefined && placement.id !== id) {
      parsed.reader.report('PP1007', `"id" is "${placement.id}" but the file is named "${id}"`, '/id',
        'A region entity\'s id is its file name; remove "id" or rename the file.');
    }
    this.#pieces(scene).regions.push({ ...placement, id, region });
  }

  #pieces(scene: string): ScenePieces {
    let pieces = this.scenePieces.get(scene);
    if (pieces === undefined) {
      pieces = { regionDocs: new Map(), regions: [] };
      this.scenePieces.set(scene, pieces);
    }
    return pieces;
  }

  #assembleScene(id: string, pieces: ScenePieces): OwnScene | undefined {
    if (pieces.scene === undefined) {
      this.#reader(`scenes/${id}`).report('PP1006', `Scene "${id}" has world or region files but no scene.json`, '');
      return undefined;
    }
    const { reader: r, doc } = pieces.scene;
    this.#checkId(r, id, 'Scene');
    const written = r.object(doc, '', 'A scene');
    if (written === undefined) return undefined;
    r.keys(withoutRetired(written), '', [...SCENE_KEYS, ...PLUGIN_SCENE_BLOCKS]);
    // A retired key is ignored with a warning (older scenes still load).
    for (const [key, fix] of Object.entries(SCENE_RENAMED)) {
      if (key in written) r.report('PP1003', `"${key}" is not a scene key`, childPointer('', key), fix, 'warning');
    }

    const base = r.string(written, 'extends', '');
    // In a derived scene, `null` deletes an inherited key ("music": null: a silent title).
    const obj = base === undefined ? written : withoutNulls(written);
    const excludeIds = r.strings(obj, 'exclude', '');
    if (obj['exclude'] !== undefined && base === undefined) {
      r.report('PP1002', '"exclude" removes entities inherited from a base scene, so it needs "extends"', '/exclude',
        'Add "extends": "<scene id>", or remove "exclude".');
    }

    const music = r.string(obj, 'music', '');
    const musicVolume = r.number(obj, 'music_volume', '');
    if (musicVolume !== undefined && !(musicVolume >= 0 && musicVolume <= 4)) {
      r.report('PP1002', '"music_volume" must be 0..4 (× the track\'s audio.json volume)', '/music_volume', 'e.g. "music_volume": 0.5 for a quieter menu.');
    }
    const environment = obj['environment'] === undefined ? undefined : r.object(obj['environment'], '/environment', '"environment"');

    const entities: Placement[] = [];
    const list = obj['entities'];
    if (list !== undefined && !Array.isArray(list)) r.report('PP1002', '"entities" must be a list', '/entities');
    if (Array.isArray(list)) {
      list.forEach((entry: Json, i: number) => {
        // A derived scene's placement may leave out "prefab" to merge over the base's with its "id".
        const placement = parsePlacement(r, entry, childPointer('/entities', i), false, base !== undefined);
        if (placement !== undefined) entities.push(placement);
      });
    }
    entities.push(...pieces.regions);

    const plugins: Record<string, JsonObject> = {};
    for (const block of PLUGIN_SCENE_BLOCKS) {
      if (obj[block] === undefined) continue;
      const value = r.object(obj[block], `/${block}`, `"${block}"`);
      if (value !== undefined) plugins[block] = value;
    }

    const scene: SceneDoc = {
      id,
      path: r.path,
      tags: r.strings(obj, 'tags', ''),
      ui: r.strings(obj, 'ui', ''),
      ...(music !== undefined && { music }),
      ...(musicVolume !== undefined && { musicVolume }),
      ...(environment !== undefined && { environment }),
      init: idMap(r, obj, 'init', ''),
      entities,
      ...(pieces.world !== undefined && { world: pieces.world }),
      regions: pieces.regionDocs,
      plugins,
    };
    return {
      doc: scene,
      reader: r,
      present: new Set(Object.keys(written)),
      ...(base !== undefined && { base }),
      exclude: excludeIds.map((excluded, i) => ({ id: excluded, pointer: childPointer('/exclude', i) })),
    };
  }
}

function withoutRetired(obj: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !(key in SCENE_RENAMED)));
}

/** The same problem reached twice (a base scene's placement read again for each derived scene) is reported once. */
function unique(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.code}|${d.path ?? ''}|${d.pointer ?? ''}|${d.line ?? ''}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Top-level scene keys holding a plain value or list (replaced whole), and the SceneDoc field each fills. */
const SCENE_VALUES = [
  ['tags', 'tags'], ['ui', 'ui'], ['music', 'music'], ['music_volume', 'musicVolume'],
] as const satisfies readonly (readonly [string, keyof SceneDoc])[];

/**
 * Scene inheritance: `"extends": "<scene id>"`. The base is resolved first (recursively),
 * then the derived file merges over it by the one `"extends"` rule (merge.ts), the same as
 * prefab variants: objects ("environment", "init", plugin blocks) deep-merge, `null`
 * deletes, plain lists ("tags", "ui") replace, and "entities" merge by "id" — a placement
 * whose id the base places merges over that placement ("prefab" may be left out); the
 * rest are appended. "exclude" removes base placements by id.
 */
function resolveScene(
  id: string, own: ReadonlyMap<string, OwnScene>, scenes: Map<string, SceneDoc>, chain: readonly string[],
): SceneDoc | undefined {
  const done = scenes.get(id);
  if (done !== undefined) return done;
  const scene = own.get(id);
  if (scene === undefined) return undefined;
  const { doc, reader: r, base: baseId } = scene;
  const flat = (): SceneDoc => {
    // A base that can't be resolved (reported): placements meant to merge over it are dropped.
    const kept = baseId === undefined ? doc : { ...doc, entities: doc.entities.filter((p) => p.prefab !== '') };
    scenes.set(id, kept);
    return kept;
  };
  if (baseId === undefined) return flat();
  const path = [...chain, id];
  if (baseId === id || path.includes(baseId)) {
    const cycle = [...path.slice(path.indexOf(baseId)), baseId];
    r.report('PP2048', `Scenes extend each other in a cycle: ${cycle.join(' → ')}`, '/extends', 'Remove "extends" from one of them.');
    return flat();
  }
  if (!own.has(baseId)) {
    const guess = closestMatch(baseId, own.keys());
    r.report('PP2047', `Unknown base scene "${baseId}"`, '/extends',
      guess !== undefined ? `Change "${baseId}" to "${guess}".` : `Scenes: ${[...own.keys()].sort().join(', ')}.`);
    return flat();
  }
  const base = resolveScene(baseId, own, scenes, path)!;

  const baseIds = base.entities.flatMap((p) => (p.id === undefined ? [] : [p.id]));
  const excluded = new Set<string>();
  for (const { id: name, pointer } of scene.exclude) {
    if (baseIds.includes(name)) {
      excluded.add(name);
      continue;
    }
    const guess = closestMatch(name, baseIds);
    r.report('PP2049', `"exclude" names "${name}", which scene "${baseId}" doesn't place`, pointer,
      guess !== undefined ? `Did you mean "${guess}"?` : `Give the base placement an "id", or remove "${name}" from "exclude".`);
  }

  const has = (key: string): boolean => scene.present.has(key);
  const fields: Record<string, unknown> = {};
  for (const [key, field] of SCENE_VALUES) {
    const value = (has(key) ? doc : base)[field];
    if (value !== undefined) fields[field] = value;
  }
  const environment = has('environment') ? mergeJson(base.environment, doc.environment ?? null) : base.environment;
  if (environment !== undefined) fields['environment'] = environment;
  const plugins: Record<string, JsonObject> = { ...base.plugins };
  for (const block of PLUGIN_SCENE_BLOCKS) {
    if (!has(block)) continue;
    const value = mergeJson(base.plugins[block], doc.plugins[block] ?? null);
    if (value === undefined) delete plugins[block];
    else plugins[block] = value as JsonObject;
  }

  const entities: Placement[] = [];
  const merged = mergeNamed(base.entities.filter((p) => p.id === undefined || !excluded.has(p.id)), doc.entities, (p) => p.id,
    (b, o) => mergeInstance(b, o, [['prefab', 'prefab'], ['layer', 'layer'], ['always_loaded', 'alwaysLoaded']]));
  for (const placement of merged) {
    if (placement.prefab !== '') {
      entities.push(placement);
      continue;
    }
    const guess = placement.id === undefined ? undefined : closestMatch(placement.id, baseIds);
    r.report('PP1002', 'Missing required "prefab" (a string)', placement.origin.pointer,
      placement.id === undefined
        ? 'Add "prefab": "<prefab id>".'
        : `No placement in scene "${baseId}" has the id "${placement.id}" to merge over${guess !== undefined ? ` (did you mean "${guess}"?)` : ''}; add "prefab": "<prefab id>" to place a new one.`);
  }
  const keyPaths: Record<string, string> = { ...(base.keyPaths ?? Object.fromEntries(
    [...(own.get(baseId)!.present)].map((key) => [key, base.path]))) };
  for (const key of scene.present) keyPaths[key] = doc.path;
  delete keyPaths['extends'];
  delete keyPaths['exclude'];
  delete keyPaths['entities'];

  const world = doc.world ?? base.world;
  const resolved = {
    ...fields,
    id,
    path: doc.path,
    tags: (fields['tags'] ?? []) as readonly string[],
    ui: (fields['ui'] ?? []) as readonly string[],
    // "init": null (no map was read) deletes the base's.
    init: !has('init') ? base.init : notedKeys(doc.init) === undefined ? {} : mergeMap(base.init, doc.init),
    entities,
    ...(world !== undefined && { world }),
    regions: new Map([...base.regions, ...doc.regions]),
    plugins,
    extends: baseId,
    keyPaths,
  } as SceneDoc;
  scenes.set(id, resolved);
  return resolved;
}

export function loadProject(files: ProjectFiles): Project {
  return new Loader(files).load();
}
