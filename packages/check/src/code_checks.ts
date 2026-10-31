/**
 * Code against data: handles the code takes from `project` (Prefabs.x, Content.k.x, …),
 * the Game declaration, `scenes=` scopes, systems that never run, and feature boundaries
 * for Python imports and JSON references.
 */

import { closestMatch } from '@parallax/runtime/core';
import type { CheckContext } from './context.js';
import type { ProjectRefUse, ScopeEntry } from './declarations.js';
import { pointerTo, refsIn } from './values.js';

const NAMESPACES = ['Prefabs', 'Scenes', 'Placed', 'Assets', 'Content', 'Text', 'Dialogue', 'WorldLayers'];

function fix(name: string, known: Iterable<string>, otherwise: string): string {
  const guess = closestMatch(name, known);
  return guess !== undefined ? `Change "${name}" to "${guess}".` : otherwise;
}

export function checkCode(ctx: CheckContext): void {
  for (const use of ctx.decl.project_refs) projectRef(ctx, use);
  game(ctx);
  scopes(ctx);
  features(ctx);
}

function projectRef(ctx: CheckContext, use: ProjectRefUse): void {
  const [namespace, first, second, third, fourth] = use.ref;
  const at = { path: use.path, line: use.line };
  const known = (what: string, code: `PP${number}`, iterable: Iterable<string>, id: string, otherwise: string): void => {
    const ids = [...iterable];
    if (!ids.includes(id)) ctx.report(code, `Unknown ${what} "${id}" (${use.ref.join('.')})`, { ...at, fix: fix(id, ids, otherwise) });
  };
  switch (namespace) {
    case 'Prefabs':
      return known('prefab', 'PP2041', ctx.project.prefabs.keys(), first!, `Create prefabs/${first!}.prefab.json.`);
    case 'Scenes':
      return known('scene', 'PP2045', ctx.project.scenes.keys(), first!, `Create scenes/${first!}/scene.json.`);
    case 'Placed':
      return known('placed entity', 'PP2046', ctx.placedIds, first!, `Give a placement "id": "${first!}" in a scene.`);
    case 'Dialogue':
      return known('dialogue', 'PP2067', ctx.dialogues, first!, `Create story/${first!}.yarn.`);
    case 'WorldLayers':
      return known('world layer', 'PP2044', ctx.worldLayers, first!, 'Declare it under "layers" in a scene\'s world.json.');
    case 'Content': {
      if (second === undefined) return;
      if (!ctx.project.content.has(first!) && !ctx.contentKinds.has(first!)) {
        ctx.report('PP2056', `Unknown content kind "${first!}" (${use.ref.join('.')})`, { ...at, fix: fix(first!, ctx.contentKinds.keys(), `Declare @content("${first!}").`) });
        return;
      }
      return known(`${first!} entry`, 'PP2057', ctx.project.content.get(first!)?.keys() ?? [], second, `Create content/${first!}/${second}.json.`);
    }
    case 'Text': {
      // Text.<key>; dotted keys (automatic Localized keys) nest: Text.enemy.slime.name.
      const parts = use.ref.slice(1);
      for (let n = parts.length; n >= 1; n--) if (ctx.textKeys.has(parts.slice(0, n).join('.'))) return;
      if (parts.length > 1 && [...ctx.textKeys].some((k) => k.startsWith(`${parts[0]!}.`))) return;
      ctx.report('PP2062', `Unknown text key "${parts[0]!}" (${use.ref.join('.')})`, { ...at, fix: fix(parts[0]!, ctx.sourceKeys, `Add "${parts[0]!}" to locale/en.json.`) });
      return;
    }
    case 'Assets': {
      if (second === undefined) return;
      const handle = `${first!}/${second}`;
      if (third === 'clips' && fourth !== undefined) {
        if (first !== 'models') ctx.report('PP2063', `Only models have clips (${use.ref.join('.')})`, at);
      }
      const missing = ctx.missingAsset('asset', handle, third === 'clips' && fourth !== undefined && first === 'models' ? fourth : undefined);
      if (missing !== undefined) {
        ctx.report('PP2063', `Unknown asset "${handle}" (${use.ref.join('.')})`, { ...at,
          fix: fix(handle, missing.known, `Add a file under assets/${first!}/ named ${second}.<ext>.`) });
      }
      return;
    }
    default:
      ctx.report('PP2069', `The project module has no "${namespace!}"`, { ...at, fix: fix(namespace!, NAMESPACES, `Namespaces: ${NAMESPACES.join(', ')}.`) });
  }
}

function game(ctx: CheckContext): void {
  const g = ctx.decl.game;
  if (g === null) return;
  const at = { path: g.path, line: g.line };
  if (g.start_scene !== undefined && !ctx.project.scenes.has(g.start_scene)) {
    ctx.report('PP2045', `Unknown start scene "${g.start_scene}"`, { ...at, fix: fix(g.start_scene, ctx.project.scenes.keys(), `Create scenes/${g.start_scene}/scene.json.`) });
  }
  for (const plugin of g.plugins) {
    for (const ref of projectRefsIn(plugin.options)) projectRef(ctx, { ref, path: g.path, line: plugin.line, column: 0 });
  }
  for (const id of g.features) {
    if (!(id in ctx.decl.features)) ctx.report('PP2018', `Unknown feature "${id}"`, at);
  }
  for (const [id, feature] of Object.entries(ctx.decl.features)) {
    if (!g.features.includes(id)) {
      ctx.report('PP2085', `Feature "${id}" is not listed in Game(features=[...])`, {
        severity: 'warning', path: feature.path, line: feature.line, fix: `Add ${id} to Game(features=[...]) in game/main.py.`,
      });
    }
  }
  const run = new Set([...g.systems, ...g.features.flatMap((f) => ctx.decl.features[f]?.systems ?? [])]);
  for (const [id, system] of Object.entries(ctx.decl.systems)) {
    if (!run.has(id)) {
      ctx.report('PP2090', `System "${id}" is never run`, {
        severity: 'warning', path: system.path, line: system.line,
        fix: system.feature !== null ? `List ${system.name} in its Feature(systems=[...]).` : `List ${system.name} in Game(systems=[...]).`,
      });
    }
    for (const after of system.after) {
      if (!run.has(after)) {
        ctx.report('PP2065', `System "${id}" runs after "${after}", which never runs`, { path: system.path, line: system.line });
      }
    }
  }
}

function projectRefsIn(value: unknown): string[][] {
  if (Array.isArray(value)) return value.flatMap(projectRefsIn);
  if (typeof value === 'object' && value !== null) {
    const project = (value as { project?: unknown }).project;
    if (Array.isArray(project)) return [project as string[]];
    return Object.values(value).flatMap(projectRefsIn);
  }
  return [];
}

/** `scenes=` on systems, panels, action sets and features: scenes exist, tags tag a scene. */
function scopes(ctx: CheckContext): void {
  const check = (entries: readonly ScopeEntry[], path: string): void => {
    for (const entry of entries) {
      if ('scene' in entry && !ctx.project.scenes.has(entry.scene)) {
        ctx.report('PP2045', `Unknown scene "${entry.scene}" in scenes=`, { path, line: entry.line,
          fix: fix(entry.scene, ctx.project.scenes.keys(), `Create scenes/${entry.scene}/scene.json.`) });
      }
      if ('tag' in entry && !ctx.sceneTags.has(entry.tag)) {
        ctx.report('PP2091', `No scene is tagged "${entry.tag}", so this scope never matches`, { severity: 'warning', path, line: entry.line,
          fix: `Add "tags": ["${entry.tag}"] to the scenes it should cover.` });
      }
    }
  };
  for (const s of Object.values(ctx.decl.systems)) check(s.scenes, s.path);
  for (const p of Object.values(ctx.decl.panels)) check(p.scenes, p.path);
  for (const a of Object.values(ctx.decl.action_sets)) check(a.scenes, a.path);
  for (const f of Object.values(ctx.decl.features)) check(f.scenes, f.path);
}

/**
 * Features depend on the features they `require`, never in a cycle. Code outside a
 * feature reaches it only through its feature.py; a feature's JSON may name ids only
 * from itself, the core and the features it requires.
 */
function features(ctx: CheckContext): void {
  const all = ctx.decl.features;
  for (const [id, feature] of Object.entries(all)) {
    for (const required of feature.requires) {
      if (!(required in all)) {
        ctx.report('PP2018', `Feature "${id}" requires unknown feature "${required}"`, { path: feature.path, line: feature.line,
          fix: fix(required, Object.keys(all), 'Remove it or create that feature.') });
      }
    }
  }
  const reported = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, chain: string[]): void => {
    if (done.has(id)) return;
    if (chain.includes(id)) {
      const cycle = chain.slice(chain.indexOf(id));
      const key = [...cycle].sort().join(',');
      if (!reported.has(key)) {
        reported.add(key);
        const at = all[id]!;
        ctx.report('PP2017', `Features require each other in a cycle: ${[...cycle, id].join(' → ')}`, { path: at.path, line: at.line,
          fix: 'Move what both need into a third feature, or into the core.' });
      }
      return;
    }
    for (const next of all[id]?.requires ?? []) if (next in all) visit(next, [...chain, id]);
    if (chain.length === 0) done.add(id);
  };
  for (const id of Object.keys(all)) visit(id, []);

  const allowed = (from: string | null, to: string): boolean => from === to || (from !== null && (all[from]?.requires.includes(to) ?? false));
  for (const module of Object.values(ctx.decl.modules)) {
    for (const imported of module.imports) {
      const match = /^features\.([a-z0-9_]+)(?:\.(.+))?$/.exec(imported.module);
      if (match === null) continue;
      const target = match[1]!;
      const inner = match[2];
      if (target === module.feature) continue;
      if (inner !== undefined && inner !== 'feature') {
        ctx.report('PP2016', `${imported.module} is internal to feature "${target}"`, { path: module.path, line: imported.line,
          fix: `Import it from features.${target}.feature (add it to that module's exports if it is meant to be shared).` });
      }
      if (module.feature !== null && !allowed(module.feature, target)) {
        ctx.report('PP2015', `Feature "${module.feature}" imports feature "${target}" without requiring it`, { path: module.path, line: imported.line,
          fix: `Add "${target}" to Feature("${module.feature}", requires=[...]).` });
      }
    }
  }

  const ownerOfPrefab = new Map([...ctx.project.prefabs.values()].map((p) => [p.id, p.feature ?? null]));
  const ownerOfContent = new Map<string, string | null>();
  for (const [kind, entries] of ctx.project.content) for (const e of entries.values()) ownerOfContent.set(`${kind}/${e.id}`, e.feature ?? null);
  const crossing = (from: string | null, to: string | null | undefined, what: string, path: string, pointer: string): void => {
    if (from === null || to === null || to === undefined || allowed(from, to)) return;
    ctx.report('PP2084', `Feature "${from}" names ${what} from feature "${to}" without requiring it`, { path, pointer,
      fix: `Add "${to}" to Feature("${from}", requires=[...]).` });
  };
  for (const prefab of ctx.project.prefabs.values()) {
    const from = prefab.feature ?? null;
    if (prefab.extends !== undefined) crossing(from, ownerOfPrefab.get(prefab.extends), `prefab "${prefab.extends}"`, prefab.path, '/extends');
    prefab.children.forEach((child, i) => {
      if (child.prefab !== undefined) crossing(from, ownerOfPrefab.get(child.prefab), `prefab "${child.prefab}"`, prefab.path, pointerTo(pointerTo('/children', i), 'prefab'));
    });
    for (const use of prefab.behaviors) {
      const owner = ctx.decl.behaviors[use.use]?.feature;
      crossing(from, owner, `behavior "${use.use}"`, prefab.path, use.origin.pointer);
    }
    for (const id of Object.keys(prefab.components)) crossing(from, ctx.components.get(id)?.feature, `component "${id}"`, prefab.path, pointerTo('/components', id));
  }
  const ownerOf = (to: string, id: string): string | null | undefined =>
    to === 'prefab' ? ownerOfPrefab.get(id) : to.startsWith('content/') ? ownerOfContent.get(`${to.slice(8)}/${id}`) : undefined;
  for (const entries of ctx.project.content.values()) {
    for (const entry of entries.values()) {
      const fields = ctx.contentKinds.get(entry.kind)?.fields;
      if (fields === undefined) continue;
      for (const ref of refsIn(fields, entry.values, '')) {
        crossing(entry.feature ?? null, ownerOf(ref.to, ref.id), `${ref.to} "${ref.id}"`, entry.path, ref.pointer);
      }
    }
  }
  for (const config of ctx.project.config.values()) {
    const fields = ctx.decl.configs[config.id]?.fields;
    if (fields === undefined) continue;
    for (const ref of refsIn(fields, config.values, '')) {
      crossing(config.feature ?? null, ownerOf(ref.to, ref.id), `${ref.to} "${ref.id}"`, config.path, ref.pointer);
    }
  }
}
