/**
 * Everything one check run knows: the loaded data, the declarations, and indexes over
 * both (ids by kind, text keys, asset names). Checks read this and push diagnostics.
 */

import { BUILTIN_EFFECT_PREFIX, BUILTIN_EFFECTS, diagnostic, isAssetUrl, remoteAssetProblem } from '@parallax/runtime/core';
import { handleFormProblem } from '@parallax/runtime/resource';
import type { Diagnostic, DiagnosticCode, DiagnosticInit } from '@parallax/runtime/core';
import type { Json, JsonObject, Project } from '@parallax/runtime/resource';
import { lineKeys, parseDialogue } from '@parallax/runtime/plugins/story';
import { SYNTH_PRESET_NAMES } from '@parallax/runtime/plugins/audio';
import type { ParseResult } from '@parallax/runtime/plugins/story';
import type { DeclaredSchema, Declarations } from './declarations.js';
import type { ProjectTree } from './files.js';
import type { RefIndex } from './values.js';

export interface CheckOptions {
  /**
   * Check that every referenced asset file exists under assets/ (default true). The SDK
   * examples are written before their art exists (examples/README.md, rule 1); they are
   * checked with this off, which still checks every asset reference's form and folder.
   */
  readonly assetFiles?: boolean;
}

export interface ComponentInfo {
  readonly id: string;
  readonly fields: DeclaredSchema;
  /** Engine components: the plugins that provide it ("core" = always). */
  readonly plugins?: readonly string[];
  readonly feature: string | null;
}

export interface ContentKindInfo {
  readonly kind: string;
  readonly fields: DeclaredSchema;
  readonly localized: readonly string[];
  readonly plugins?: readonly string[];
  /** The Python class that types its entries (for codegen): module + name. */
  readonly module: string;
  readonly name: string;
}

/** Asset folders and the ref targets they serve. */
export const ASSET_FOLDERS: Readonly<Record<string, string>> = {
  sfx: 'asset/sfx', music: 'asset/music', images: 'asset/images', models: 'asset/models', vfx: 'asset/vfx',
};

/** A handle a generated `Assets.<folder>.<name>` can carry. */
const FOLDER_HANDLE = /^[a-z0-9_]+\/[A-Za-z0-9_]+$/;

/** `assets/sfx/hit.ogg` → `sfx/hit`; `assets/vfx/sparks.vfx.json` → `vfx/sparks`. */
export function assetHandle(path: string): string {
  const relative = path.replace(/^assets\//, '');
  const slash = relative.lastIndexOf('/');
  const dot = relative.indexOf('.', slash + 1);
  return dot === -1 ? relative : relative.slice(0, dot);
}

export class CheckContext {
  readonly files: ProjectTree;
  readonly project: Project;
  readonly decl: Declarations;
  readonly options: Required<CheckOptions>;
  readonly out: Diagnostic[] = [];

  /** The game's plugins plus "core". */
  readonly plugins: ReadonlySet<string>;
  readonly components = new Map<string, ComponentInfo>();
  readonly contentKinds = new Map<string, ContentKindInfo>();
  readonly tags: ReadonlySet<string>;
  readonly sceneTags: ReadonlySet<string>;
  readonly placedIds: ReadonlySet<string>;
  readonly worldLayers: ReadonlySet<string>;
  readonly dialogues: ReadonlySet<string>;
  /** Every `.yarn` file parsed, by dialogue id (`Project.dialogues`). */
  readonly dialogueFiles = new Map<string, ParseResult>();
  /** Localization keys of every dialogue line (`story.<file>.<line>`): their source text is the .yarn file. */
  readonly dialogueKeys = new Set<string>();
  /** Asset handles (`sfx/hit`) → file path. */
  readonly assets = new Map<string, string>();
  /**
   * With asset files unchecked: handles the data and code reference that have no file here,
   * each with the clip names code reads off it (`Assets.models.knight.clips.run`). Codegen
   * gives them handles too, so `Assets.sfx.hit` exists before its file does.
   */
  readonly referencedAssets = new Map<string, Set<string>>();
  /** Locale keys of the source language, plus automatic keys for Localized data fields. */
  readonly textKeys = new Set<string>();
  readonly sourceKeys: ReadonlySet<string>;

  constructor(files: ProjectTree, project: Project, decl: Declarations, options: CheckOptions) {
    this.files = files;
    this.project = project;
    this.decl = decl;
    this.options = { assetFiles: options.assetFiles ?? true };
    this.plugins = new Set(['core', ...(decl.game?.plugins.map((p) => p.id) ?? [])]);

    for (const [id, engine] of Object.entries(decl.engine.components)) {
      this.components.set(id, { id, fields: engine.fields, plugins: engine.plugins, feature: null });
    }
    for (const [id, component] of Object.entries(decl.components)) {
      this.components.set(id, { id, fields: component.fields, feature: component.feature });
    }
    for (const [kind, engine] of Object.entries(decl.engine.content)) {
      this.contentKinds.set(kind, { kind, fields: engine.fields, localized: engine.localized ?? [], plugins: engine.plugins,
        module: engine.module, name: engine.name });
    }
    for (const [kind, content] of Object.entries(decl.content)) {
      this.contentKinds.set(kind, { kind, fields: content.fields, localized: content.localized, module: content.module, name: content.name });
    }
    this.tags = new Set(Object.keys(decl.tags));
    this.sceneTags = new Set([...project.scenes.values()].flatMap((s) => s.tags));
    this.placedIds = new Set([...project.scenes.values()].flatMap((s) => s.entities.flatMap((e) => (e.id === undefined ? [] : [e.id]))));
    this.worldLayers = new Set([...project.scenes.values()].flatMap((s) => [...(s.world?.layers.keys() ?? [])]));
    this.dialogues = new Set(files.all().flatMap((p) => {
      const match = /^(?:features\/[^/]+\/)?story\/([^/]+)\.yarn$/.exec(p);
      return match === null ? [] : [match[1]!];
    }));
    for (const path of files.all()) {
      if (path.startsWith('assets/') && path !== 'assets/audio.json') this.assets.set(assetHandle(path), path);
    }
    const source = project.locales.get('en');
    this.sourceKeys = new Set(Object.keys(source?.strings ?? {}));
    for (const key of this.sourceKeys) this.textKeys.add(key);
    for (const key of this.localizedKeys()) this.textKeys.add(key);
    for (const file of project.dialogues.values()) {
      const parsed = parseDialogue(file.id, file.path, file.text);
      this.dialogueFiles.set(file.id, parsed);
      if (parsed.doc !== undefined) for (const key of lineKeys(parsed.doc).values()) this.dialogueKeys.add(key);
    }
  }

  report(code: DiagnosticCode, message: string, init: DiagnosticInit = {}): void {
    this.out.push(diagnostic(code, message, init));
  }

  /** Is this engine component / content kind available with the game's plugins? */
  available(plugins: readonly string[] | undefined): boolean {
    return plugins === undefined || plugins.some((p) => this.plugins.has(p));
  }

  /** Every Localized string written in content and config, with where it is. */
  localizedTexts(): { value: string; path: string; pointer: string }[] {
    const out: { value: string; path: string; pointer: string }[] = [];
    for (const [kind, entries] of this.project.content) {
      const info = this.contentKinds.get(kind);
      if (info === undefined) continue;
      for (const entry of entries.values()) {
        for (const path of info.localized) out.push(...localizedValues(entry.values, path).map((v) => ({ ...v, path: entry.path })));
      }
    }
    for (const [id, config] of this.project.config) {
      const decl = this.decl.configs[id];
      if (decl === undefined) continue;
      for (const path of decl.localized) out.push(...localizedValues(config.values, path).map((v) => ({ ...v, path: config.path })));
    }
    return out;
  }

  /** Automatic text keys of Localized fields: `<kind>.<id>.<path>` and `config.<id>.<path>`. */
  localizedKeys(): string[] {
    const keys: string[] = [];
    for (const [kind, entries] of this.project.content) {
      const info = this.contentKinds.get(kind);
      if (info === undefined) continue;
      for (const entry of entries.values()) {
        for (const path of info.localized) keys.push(...walkLocalized(`${kind}.${entry.id}`, entry.values, path));
      }
    }
    for (const [id, config] of this.project.config) {
      const decl = this.decl.configs[id];
      if (decl === undefined) continue;
      for (const path of decl.localized) keys.push(...walkLocalized(`config.${id}`, config.values, path));
    }
    return keys;
  }

  get refs(): RefIndex {
    return this.refsFor(undefined);
  }

  /** Ref lookups; `scene` scopes entity ids to one scene's placements. */
  refsFor(scene: string | undefined): RefIndex {
    const placedInScene = scene === undefined ? undefined
      : new Set(this.project.scenes.get(scene)?.entities.flatMap((e) => (e.id === undefined ? [] : [e.id])) ?? []);
    const check = (known: Iterable<string>, id: string, code: DiagnosticCode, what: string) => {
      const list = [...known];
      return list.includes(id) ? undefined : { code, known: list, what };
    };
    return {
      missing: (to, id) => {
        if (to === 'prefab') return check(this.project.prefabs.keys(), id, 'PP2041', 'prefab');
        if (to === 'scene') return check(this.project.scenes.keys(), id, 'PP2045', 'scene');
        if (to === 'placed') return check(this.placedIds, id, 'PP2046', 'placed entity');
        if (to === 'entity') return placedInScene === undefined ? undefined : check(placedInScene, id, 'PP2046', 'placed entity');
        if (to === 'tag') return check(this.tags, id, 'PP2055', 'tag');
        if (to === 'text') return check(this.textKeys, id, 'PP2062', 'text key');
        if (to === 'panel') return check(Object.keys(this.decl.panels), id, 'PP2054', 'panel');
        if (to === 'world_layer') return check(this.worldLayers, id, 'PP2044', 'world layer');
        if (to === 'dialogue') return check(this.dialogues, id, 'PP2067', 'dialogue');
        if (to.startsWith('content/')) {
          const kind = to.slice('content/'.length);
          return check(this.project.content.get(kind)?.keys() ?? [], id, 'PP2057', `${kind} entry`);
        }
        if (to === 'asset' || to.startsWith('asset/')) return this.missingAsset(to, id);
        return undefined; // clip: the clip names live inside model files
      },
    };
  }

  /**
   * An asset reference is written one way: the handle `Assets.sfx.hit` names (`sfx/hit`,
   * "<folder>/<name>"). The file path (`assets/sfx/hit.ogg`) and a bare name (`hit`) are
   * PP2063 with the handle as the fix (runtime resource `handleFormProblem`, the rule the
   * game applies). Its folder must match the ref's kind. Built-ins are `synth/<name>`
   * (sounds) and `effect/<name>` (3D effects).
   * With asset files unchecked, a well-formed reference is recorded (`referencedAssets`).
   *
   * A hosted asset URL (`https://r2.parallaxpro.ai/assets/…`, runtime core/remote_assets.ts)
   * is checked for form only — host, path, an extension the ref's kind loads — with or
   * without asset files: nothing is fetched, and it gets no `Assets.*` handle.
   */
  missingAsset(to: string, id: string, clip?: string): ReturnType<RefIndex['missing']> {
    const folder = to === 'asset' ? undefined : to.slice('asset/'.length);
    if (isAssetUrl(id)) {
      const problem = remoteAssetProblem(id, folder);
      return problem === undefined ? undefined : {
        code: 'PP2063', known: [], what: 'asset URL', message: problem,
        fix: `Use a hosted asset URL (https://r2.parallaxpro.ai/assets/…)${folder === undefined ? '' : ` of a file ${folder} load`}, or a file under assets/${folder ?? '<folder>'}/.`,
      };
    }
    // A built-in synthesized sound (`synth/<name>`, SDK `Synth.<name>`) is a sound effect with no file.
    if (/^synth\/[a-z0-9_]+$/.test(id) && (folder === 'sfx' || folder === undefined)) {
      return SYNTH_PRESET_NAMES.includes(id.slice('synth/'.length)) ? undefined : {
        code: 'PP2063', known: SYNTH_PRESET_NAMES.map((n) => `synth/${n}`), what: 'built-in synth sound',
      };
    }
    // A built-in 3D effect (`effect/<name>`, SDK `Effect.<name>`) is no file, as a synth sound is none.
    if ((folder === 'vfx' || folder === undefined) && (id.startsWith(BUILTIN_EFFECT_PREFIX) || id.startsWith('builtin:'))) {
      const known = BUILTIN_EFFECTS.map((n) => `${BUILTIN_EFFECT_PREFIX}${n}`);
      if (id.startsWith('builtin:')) {
        const name = id.slice('builtin:'.length);
        return { code: 'PP2063', known, what: 'built-in effect', message: `"${id}": a built-in effect is written "${BUILTIN_EFFECT_PREFIX}<name>"`, fix: `Write "${BUILTIN_EFFECT_PREFIX}${name}" (SDK Effect.${name}).` };
      }
      if (this.decl.game?.mode === '2d') {
        return { code: 'PP2063', known: [], what: 'built-in effect', message: `"${id}" is a built-in 3D effect, which a 2D game doesn't have`, fix: 'Name an effect file of this game, "vfx/<name>".' };
      }
      return (BUILTIN_EFFECTS as readonly string[]).includes(id.slice(BUILTIN_EFFECT_PREFIX.length)) ? undefined
        : { code: 'PP2063', known, what: 'built-in effect' };
    }
    // One spelling per local asset: the handle ("models/knight"). A file path or a bare name
    // is reported with the handle to write.
    const form = handleFormProblem(id, folder);
    if (form !== undefined) {
      return { code: 'PP2063', known: [form.handle], what: 'asset', message: form.message, fix: `Write "${form.handle}" ("<folder>/<name>": no "assets/", no extension).` };
    }
    const handle = id;
    const known = [...this.assets.keys()].filter((h) => folder === undefined || h.startsWith(`${folder}/`));
    if (folder !== undefined && !handle.startsWith(`${folder}/`)) {
      return { code: 'PP2063', known: known.length > 0 ? known : [`${folder}/<name>`], what: `asset in ${folder}/ (written "${folder}/<name>")` };
    }
    if (!this.options.assetFiles) {
      if (FOLDER_HANDLE.test(handle) && !this.assets.has(handle)) {
        const clips = this.referencedAssets.get(handle) ?? new Set<string>();
        if (clip !== undefined) clips.add(clip);
        this.referencedAssets.set(handle, clips);
      }
      return undefined;
    }
    if (this.assets.has(handle)) return undefined;
    return { code: 'PP2063', known, what: 'asset' };
  }
}

/** Keys for one localized path inside a value: "", "[]", "{}", "a.b", "[].title", "steps{}.text". */
/** Each Localized string value under `path`, with its JSON pointer (for diagnostics). */
export function localizedValues(data: Json | undefined, path: string, pointer = ''): { value: string; pointer: string }[] {
  if (data === undefined || data === null) return [];
  if (path === '') return typeof data === 'string' ? [{ value: data, pointer }] : [];
  if (path.startsWith('[]') || path.startsWith('{}')) {
    const rest = path.slice(2).replace(/^\./, '');
    if (path.startsWith('[]') ? !Array.isArray(data) : typeof data !== 'object' || Array.isArray(data)) return [];
    return Object.entries(data as JsonObject).flatMap(([key, item]) => localizedValues(item as Json, rest, `${pointer}/${key}`));
  }
  const match = /^([^.[{]+)(.*)$/.exec(path);
  if (match === null || typeof data !== 'object' || Array.isArray(data)) return [];
  const [, head, rest] = match;
  return localizedValues((data as JsonObject)[head!], rest!.replace(/^\./, ''), `${pointer}/${head!}`);
}

function walkLocalized(prefix: string, data: Json | undefined, path: string): string[] {
  if (data === undefined || data === null) return [];
  if (path === '') return typeof data === 'string' ? [prefix] : [];
  if (path.startsWith('[]')) {
    if (!Array.isArray(data)) return [];
    const rest = path.slice(2).replace(/^\./, '');
    return data.flatMap((item: Json, i: number) => {
      const key = typeof item === 'object' && item !== null && !Array.isArray(item) && typeof (item as JsonObject)['id'] === 'string'
        ? (item as JsonObject)['id'] as string : String(i);
      return walkLocalized(`${prefix}.${key}`, item, rest);
    });
  }
  if (path.startsWith('{}')) {
    if (typeof data !== 'object' || Array.isArray(data)) return [];
    const rest = path.slice(2).replace(/^\./, '');
    return Object.entries(data as JsonObject).flatMap(([key, item]) => walkLocalized(`${prefix}.${key}`, item, rest));
  }
  const match = /^([^.[{]+)(.*)$/.exec(path);
  if (match === null || typeof data !== 'object' || Array.isArray(data)) return [];
  const [, head, rest] = match;
  return walkLocalized(`${prefix}.${head!}`, (data as JsonObject)[head!], rest!.replace(/^\./, ''));
}
