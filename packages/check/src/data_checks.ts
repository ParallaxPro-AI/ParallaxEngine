/**
 * Data files against the game's declarations: component, behavior, tag, panel, resource
 * and content ids; component fields, behavior params, config documents and content
 * entries against their schemas; behavior `requires` against what an entity really has.
 */

import { closestMatch } from '@parallax/runtime/core';
import { resolvePrefab, withoutDeletions } from '@parallax/runtime/resource';
import type { InstanceFields, JsonObject, Origin, PrefabDoc, ResolvedPrefab } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';
import type { DeclaredSchema } from './declarations.js';
import { pointerTo, Validator } from './values.js';
import type { RefIndex } from './values.js';

const BUILTIN_VERBS = ['reach', 'talk', 'obtain', 'defeat', 'use', 'wait', 'fact'];

/** Engine component ids that were renamed: the old id → the fix naming the new one. */
const RENAMED_COMPONENTS: Readonly<Record<string, string>> = {
  effects: 'The combat status-effects component is now "status_effects" (parallax.combat.StatusEffects).',
};

function suggest(name: string, known: Iterable<string>): string | undefined {
  const guess = closestMatch(name, known);
  return guess === undefined ? undefined : `Did you mean "${guess}"?`;
}

/** Engine data the SDK documents outside the component's typed fields. */
const DOCUMENTED_EXTRAS: Readonly<Record<string, Readonly<Record<string, (value: unknown) => boolean>>>> = {
  // Sprite: "`animations` (in the prefab) maps names to frame lists".
  sprite: { animations: (v) => typeof v === 'object' && v !== null && !Array.isArray(v) },
  // Animator: the animation graph (`params`, `layers`, `events`, `ik`); animation_checks.ts reads it in full.
  animator: {
    params: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
    layers: (v) => Array.isArray(v),
    events: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
    ik: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  },
};
/** JSON-only spellings the SDK documents for typed fields. */
/**
 * Sprite `animations`, typed as the runtime reads it (visuals/schemas.ts SPRITE_ANIMATION):
 * each frame is an image reference, so a bare name is PP2063 as it is on `image`.
 */
const SPRITE_ANIMATIONS = {
  kind: 'dict',
  of: {
    kind: 'record',
    fields: {
      frames: { type: { kind: 'list', of: { kind: 'ref', to: 'asset/images' } } },
      fps: { type: { kind: 'number' }, min: 0 },
      loop: { type: { kind: 'bool' } },
    },
  },
} as unknown as Parameters<Validator['value']>[0];
/** JSON-only spellings the SDK documents for typed fields. */
const DOCUMENTED_ALTERNATIVES: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>> = {
  camera: { fit: ['grid'], follow: ['local_player'] },
};

/**
 * Components a plugin attaches to entities it spawns itself, keyed by the content field
 * that names the prefab. voxels: "A block entry with a "prefab" gets an entity spawned for
 * every placed block of that type ..., carrying `VoxelBlock(cell=...)`".
 */
const PLUGIN_SPAWNED: readonly { readonly kind: string; readonly field: string; readonly component: string }[] = [
  { kind: 'block', field: 'prefab', component: 'voxel_block' },
];

function pluginSupplied(ctx: CheckContext): Map<string, string[]> {
  const supplied = new Map<string, string[]>();
  for (const rule of PLUGIN_SPAWNED) {
    for (const entry of ctx.project.content.get(rule.kind)?.values() ?? []) {
      const prefab = entry.values[rule.field];
      if (typeof prefab === 'string') supplied.set(prefab, [...(supplied.get(prefab) ?? []), rule.component]);
    }
  }
  return supplied;
}

export function checkData(ctx: CheckContext): void {
  // A Localized field holds the text itself; a locale key written there shows as "title_game".
  const strings = ctx.project.locales.get('en')?.strings ?? {};
  for (const { value, path, pointer } of ctx.localizedTexts()) {
    if (!ctx.sourceKeys.has(value) || strings[value] === value) continue;
    ctx.report('PP2079', `"${value}" is a key in locale/en.json, but this field takes the text itself (players would see "${value}")`, {
      path, pointer, fix: `Write the text here: ${JSON.stringify(strings[value])}. Localized fields are translated from their inline text.`,
    });
  }
  const supplied = pluginSupplied(ctx);
  const placedPrefabs = new Set<string>();
  for (const scene of ctx.project.scenes.values()) for (const p of scene.entities) placedPrefabs.add(p.prefab);
  const extended = new Set([...ctx.project.prefabs.values()].flatMap((p) => (p.extends === undefined ? [] : [p.extends])));
  const dynamicSites = ctx.decl.spawns.filter((s) => s.prefab === null);
  // null: some runtime-chosen spawn passes components we can't read, so nothing can be said.
  const dynamicComponents = dynamicSites.some((s) => s.components === null) ? null
    : new Set(dynamicSites.flatMap((s) => s.components ?? []));
  const dynamicParams = dynamicSites.some((s) => s.params === null) ? Object.keys(ctx.decl.behaviors)
    : [...new Set(dynamicSites.flatMap((s) => s.params ?? []))];

  for (const prefab of ctx.project.prefabs.values()) {
    const refs = ctx.refsFor(undefined);
    // A variant's `null`s delete inherited values (the "extends" rule); what it sets is checked.
    const own = prefab.extends === undefined ? prefab.components : withoutDeletions(prefab.components);
    instance(ctx, own, prefab.tags, {}, { path: prefab.path, pointer: '' }, refs);
    behaviorUses(ctx, prefab, refs);
    prefab.children.forEach((child, i) => {
      const at = { path: prefab.path, pointer: pointerTo('/children', i) };
      instance(ctx, child.components, child.tags, child.params, at, refs);
      if (child.prefab !== undefined) paramTargets(ctx, child.prefab, child, at);
    });
    const sites = ctx.decl.spawns.filter((s) => s.prefab === prefab.id);
    for (const site of sites) {
      if (site.components === null) continue;
      const components = Object.fromEntries(site.components.map((id) => [id, {}]));
      requirements(ctx, prefab.id, components, site.params ?? Object.keys(ctx.decl.behaviors), { path: site.path, line: site.line }, 'error');
    }
    // Spawned only where code picks the prefab at runtime: what those sites pass in
    // spawn(components=...) may supply what is missing, so only what no site supplies is
    // reported, as a warning. Bases of variants are never spawned as-is.
    if (!placedPrefabs.has(prefab.id) && sites.length === 0 && !extended.has(prefab.id) && dynamicComponents !== null) {
      const given = [...dynamicComponents, ...(supplied.get(prefab.id) ?? [])];
      requirements(ctx, prefab.id, Object.fromEntries(given.map((id) => [id, {}])), dynamicParams,
        { path: prefab.path }, 'warning');
    }
  }

  for (const scene of ctx.project.scenes.values()) {
    const refs = ctx.refsFor(scene.id);
    for (const placement of scene.entities) {
      instance(ctx, placement.components, placement.tags, placement.params, placement.origin, refs);
      if (!ctx.project.prefabs.has(placement.prefab)) continue;
      paramTargets(ctx, placement.prefab, placement, placement.origin);
      requirements(ctx, placement.prefab, placement.components, Object.keys(placement.params),
        { path: placement.origin.path, pointer: placement.origin.pointer }, 'error', placement.params);
    }
    scene.ui.forEach((id, i) => {
      if (!(id in ctx.decl.panels)) {
        ctx.report('PP2054', `Unknown panel "${id}"`, {
          path: scene.path, pointer: pointerTo('/ui', i),
          fix: suggest(id, Object.keys(ctx.decl.panels)) ?? 'Declare it with @ui("...") or fix the name.',
        });
      }
    });
    for (const [id, values] of Object.entries(scene.init)) {
      const resource = ctx.decl.resources[id];
      const at = { path: scene.path, pointer: pointerTo('/init', id) };
      if (resource === undefined) {
        ctx.report('PP2053', `Unknown resource "${id}"`, { ...at, fix: suggest(id, Object.keys(ctx.decl.resources)) });
        continue;
      }
      new Validator(refs, ctx.out).fields(resource.fields, values, id, at, false);
    }
    if (scene.music !== undefined) {
      // Written as a handle ("music/x") or a hosted URL; a file path or a bare name is
      // reported with the handle to write (missingAsset's message and fix).
      const written = scene.music;
      const missing = ctx.missingAsset('asset/music', written);
      if (missing?.message !== undefined) {
        ctx.report('PP2063', `Scene music: ${missing.message}`, { path: scene.path, pointer: '/music', fix: missing.fix! });
      } else if (missing !== undefined) {
        ctx.report('PP2063', `Unknown music "${written}"`, { path: scene.path, pointer: '/music',
          fix: suggest(written, missing.known) ?? `Add assets/${written}.<ogg|mp3>, or name an existing track ("music/<name>").` });
      }
    }
  }

  configs(ctx);
  content(ctx);
}

/** The plugin to suggest: the one matching the game's mode (physics2d / physics3d), else the first. */
function pluginFor(ctx: CheckContext, plugins: readonly string[]): string {
  const mode = ctx.decl.game?.mode;
  return (mode !== undefined ? plugins.find((p) => p.endsWith(mode)) : undefined) ?? plugins[0]!;
}

/** Component overrides, tags and behavior params written on one prefab/child/placement. */
function instance(ctx: CheckContext, components: Readonly<Record<string, JsonObject>>, tags: readonly string[],
  params: Readonly<Record<string, JsonObject>>, at: Origin, refs: RefIndex): void {
  const validator = new Validator(refs, ctx.out);
  for (const [id, data] of Object.entries(components)) {
    const where = { path: at.path, pointer: pointerTo(pointerTo(at.pointer, 'components'), id) };
    const info = ctx.components.get(id);
    if (info === undefined) {
      ctx.report('PP2050', `Unknown component "${id}"`, { ...where,
        fix: RENAMED_COMPONENTS[id] ?? suggest(id, ctx.components.keys()) ?? 'Declare it with @component("...") or use an engine component.' });
      continue;
    }
    if (!ctx.available(info.plugins)) {
      ctx.report('PP2066', `Component "${id}" needs the ${info.plugins!.join(' or ')} plugin`, { ...where,
        fix: `Add ${pluginFor(ctx, info.plugins!)}() to Game(plugins=[...]).` });
    }
    const extras = DOCUMENTED_EXTRAS[id] ?? {};
    const alternatives = DOCUMENTED_ALTERNATIVES[id] ?? {};
    const typed: Record<string, JsonObject[string]> = {};
    for (const [key, value] of Object.entries(data)) {
      const extra = extras[key];
      if (extra !== undefined) {
        if (!extra(value)) ctx.report('PP4102', `${id}.${key} has the wrong shape`, { path: where.path, pointer: pointerTo(where.pointer, key) });
        else if (id === 'sprite' && key === 'animations') {
          validator.value(SPRITE_ANIMATIONS, value, `${id}.${key}`, { path: where.path, pointer: pointerTo(where.pointer, key) });
        }
        continue;
      }
      if (alternatives[key]?.includes(value)) continue;
      typed[key] = value;
    }
    validator.fields(info.fields, typed, id, where, false);
  }
  tags.forEach((tag, i) => {
    if (!ctx.tags.has(tag)) {
      ctx.report('PP2055', `Unknown tag "${tag}"`, { path: at.path, pointer: pointerTo(pointerTo(at.pointer, 'tags'), i),
        fix: suggest(tag, ctx.tags) ?? `Declare it: ${pascal(tag)} = tag("${tag}").` });
    }
  });
  for (const [id, values] of Object.entries(params)) {
    const behavior = ctx.decl.behaviors[id];
    const where = { path: at.path, pointer: pointerTo(pointerTo(at.pointer, 'params'), id) };
    if (behavior === undefined) {
      ctx.report('PP2051', `Unknown behavior "${id}"`, { ...where, fix: suggest(id, Object.keys(ctx.decl.behaviors)) });
      continue;
    }
    validator.fields(behavior.params, values, `${id} params`, where, false);
  }
}

function behaviorUses(ctx: CheckContext, prefab: PrefabDoc, refs: RefIndex): void {
  const validator = new Validator(refs, ctx.out);
  for (const use of prefab.behaviors) {
    const behavior = ctx.decl.behaviors[use.use];
    if (behavior === undefined) {
      // `origin` points at the behavior's entry: "behaviors": {"<id>": {params}}.
      ctx.report('PP2051', `Unknown behavior "${use.use}"`, { path: use.origin.path, pointer: use.origin.pointer,
        fix: suggest(use.use, Object.keys(ctx.decl.behaviors)) ?? 'Declare it with @behavior("...") or fix the name.' });
      continue;
    }
    const params = prefab.extends === undefined ? use.params : withoutDeletions({ p: use.params })['p']!;
    validator.fields(behavior.params, params, `${use.use} params`, { path: use.origin.path, pointer: use.origin.pointer }, false);
  }
}

function resolved(ctx: CheckContext, id: string): ResolvedPrefab | undefined {
  try {
    return resolvePrefab(ctx.project, id);
  } catch {
    return undefined; // unknown base or a cycle: the loader already reported it
  }
}

/** Per-instance `params` may only target behaviors the prefab has. */
function paramTargets(ctx: CheckContext, prefabId: string, inst: InstanceFields, at: Origin): void {
  const prefab = resolved(ctx, prefabId);
  if (prefab === undefined) return;
  const uses = prefab.behaviors.map((b) => b.use);
  for (const id of Object.keys(inst.params)) {
    if (id in ctx.decl.behaviors && !uses.includes(id)) {
      ctx.report('PP2052', `params given for behavior "${id}", which prefab "${prefabId}" doesn't have`, {
        path: at.path, pointer: pointerTo(pointerTo(at.pointer, 'params'), id),
        fix: uses.length > 0 ? `Its behaviors: ${uses.join(', ')}.` : 'The prefab has no behaviors.',
      });
    }
  }
}

/**
 * What a spawned entity must have: every component its behaviors `requires`, every
 * required param and every required game-component field. A placement is checked with
 * its overrides (errors); a prefab no scene places may get components from
 * `spawn(components=...)`, so it is only warned about.
 */
function requirements(ctx: CheckContext, prefabId: string, components: Readonly<Record<string, JsonObject>>,
  paramIds: readonly string[], at: { readonly path: string; readonly pointer?: string; readonly line?: number },
  severity: 'error' | 'warning', params: Readonly<Record<string, JsonObject>> = {}): void {
  const prefab = resolved(ctx, prefabId);
  if (prefab === undefined) return;
  const has = new Set([...Object.keys(prefab.components), ...Object.keys(components)]);
  const fix = severity === 'warning' ? ' (or pass it in spawn(components=[...]))' : '';
  for (const use of prefab.behaviors) {
    const behavior = ctx.decl.behaviors[use.use];
    if (behavior === undefined) continue;
    for (const required of behavior.requires) {
      if (!has.has(required)) {
        ctx.report('PP2104', `Behavior "${use.use}" requires component "${required}", which prefab "${prefabId}" doesn't have`, {
          severity, ...at, fix: `Add "${required}" to the prefab's components${fix}.`,
        });
      }
    }
    // Params given from code (spawn(params=...)) can't be read: count them as given.
    if (paramIds.includes(use.use) && params[use.use] === undefined) continue;
    const given = { ...use.params, ...(params[use.use] ?? {}) };
    for (const [name, spec] of Object.entries(behavior.params)) {
      if (given[name] === undefined && !('default' in spec) && spec.default_expr === undefined) {
        ctx.report('PP4105', `Behavior "${use.use}" param "${name}" is required on prefab "${prefabId}"`, {
          severity, ...at, fix: `Set it in "behaviors": {"${use.use}": {"${name}": ...}}.`,
        });
      }
    }
  }
  for (const [id, data] of Object.entries(prefab.components)) {
    const info = ctx.decl.components[id];
    if (info === undefined) continue;
    const merged = { ...data, ...(components[id] ?? {}) };
    for (const [name, spec] of Object.entries(info.fields)) {
      if (merged[name] === undefined && !('default' in spec) && spec.default_expr === undefined && spec.runtime_only !== true) {
        ctx.report('PP4105', `Component "${id}" field "${name}" is required on prefab "${prefabId}"`, {
          severity, ...at, fix: `Set "components": {"${id}": {"${name}": ...}}${fix}.`,
        });
      }
    }
  }
}

function configs(ctx: CheckContext): void {
  for (const [id, doc] of ctx.project.config) {
    const decl = ctx.decl.configs[id];
    if (decl === undefined) {
      ctx.report('PP2058', `config/${id}.json has no @config("${id}") class`, {
        path: doc.path, fix: suggest(id, Object.keys(ctx.decl.configs)) ?? `Declare it: @config("${id}") class ${pascal(id)}: ...`,
      });
      continue;
    }
    new Validator(ctx.refs, ctx.out).fields(decl.fields, doc.values, id, { path: doc.path, pointer: '' }, true);
  }
  for (const [id, decl] of Object.entries(ctx.decl.configs)) {
    if (ctx.project.config.has(id)) continue;
    const required = Object.entries(decl.fields).filter(([, s]) => !('default' in s) && s.default_expr === undefined);
    if (required.length > 0) {
      ctx.report('PP2059', `@config("${id}") has required fields but no config/${id}.json`, {
        path: decl.path, line: decl.line, fix: `Create config/${id}.json with ${required.map(([n]) => `"${n}"`).join(', ')}.`,
      });
    }
  }
}

function content(ctx: CheckContext): void {
  const verbs = new Set([...BUILTIN_VERBS, ...Object.values(ctx.decl.functions).flatMap((f) => (f.kind === 'quest_verb' && f.id ? [f.id] : []))]);
  for (const [kind, entries] of ctx.project.content) {
    const info = ctx.contentKinds.get(kind);
    const first = entries.values().next().value;
    if (info === undefined) {
      ctx.report('PP2056', `Unknown content kind "${kind}"`, {
        path: first?.path, fix: suggest(kind, ctx.contentKinds.keys()) ?? `Declare it: @content("${kind}") class ${pascal(kind)}Def: ...`,
      });
      continue;
    }
    if (!ctx.available(info.plugins)) {
      ctx.report('PP2066', `Content kind "${kind}" needs the ${info.plugins!.join(' or ')} plugin`, {
        path: first?.path, fix: `Add ${info.plugins![0]}() to Game(plugins=[...]).`,
      });
    }
    const validator = new Validator(ctx.refs, ctx.out);
    for (const entry of entries.values()) {
      validator.fields(info.fields as DeclaredSchema, entry.values, `${kind}/${entry.id}`, { path: entry.path, pointer: '' }, true);
      if (kind === 'quest') questVerbs(ctx, entry.values, entry.path, verbs);
    }
  }
  emptyKindsRead(ctx);
}

/**
 * A declared content kind with no entries that code reads with `ctx.content(KindDef)`:
 * every index into it fails at runtime (PP3031) and every loop over it is empty. Found by
 * the call's text, so a kind passed around as a value isn't seen (no warning, never a wrong one).
 */
function emptyKindsRead(ctx: CheckContext): void {
  const empty = Object.values(ctx.decl.content).filter((c) => c.extends === undefined && (ctx.project.content.get(c.kind)?.size ?? 0) === 0);
  if (empty.length === 0) return;
  const sources = ctx.files.all().filter((p) => p.endsWith('.py'));
  for (const decl of empty) {
    const call = new RegExp(`\\bcontent\\(\\s*${decl.name}\\s*[,)]`);
    for (const path of sources) {
      const lines = ctx.files.read(path).split('\n');
      const at = lines.findIndex((line) => call.test(line));
      if (at < 0) continue;
      ctx.report('PP2083', `ctx.content(${decl.name}) reads content kind "${decl.kind}", which has no entries`, {
        severity: 'warning', path, line: at + 1,
        fix: `Add its entries as content/${decl.kind}/<id>.json, one file each with the fields ${decl.name} declares.`,
      });
      break;
    }
  }
}

function questVerbs(ctx: CheckContext, values: JsonObject, path: string, verbs: ReadonlySet<string>): void {
  const steps = values['steps'];
  if (typeof steps !== 'object' || steps === null || Array.isArray(steps)) return;
  for (const [name, step] of Object.entries(steps as JsonObject)) {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) continue;
    const verb = (step as JsonObject)['verb'];
    if (typeof verb === 'string' && !verbs.has(verb)) {
      ctx.report('PP2068', `Unknown quest verb "${verb}"`, {
        path, pointer: pointerTo(pointerTo('/steps', name), 'verb'),
        fix: suggest(verb, verbs) ?? `Use a built-in verb (${BUILTIN_VERBS.join(', ')}) or declare @quest_verb("${verb}").`,
      });
    }
  }
}

export function pascal(id: string): string {
  return id.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}
