/**
 * Prefab variants: `"extends": "brick"` plus overrides. Resolution flattens the chain so
 * the kernel only ever instantiates complete prefabs. The merge rule is the one every
 * `"extends"` follows (merge.ts; scenes use it too):
 *
 *   components   object: per component, fields deep-merge; `null` removes a component or field
 *   behaviors    object keyed by behavior id: params deep-merge; `null` removes a behavior
 *   tags         plain list: the variant's replaces the base's
 *   children     named list, by "name": a matching child merges over the base's (an
 *                instance merge, as scene entities by "id"); the rest are appended
 *   pool, z, scale, replicate_transform   the variant's value; `null` removes the base's
 */

import { fail } from '../core/index.js';
import { mergeInstance, mergeJson, mergeMap, mergeNamed, notedKeys, pick, writtenKeys } from './merge.js';
import type { BehaviorUse, JsonObject, PrefabChild, PrefabDoc, Project } from './model.js';

export type ResolvedPrefab = Omit<PrefabDoc, 'extends'>;

/** Behaviors as an object keyed by id: params deep-merge, a written-but-absent id is removed. */
function mergeBehaviors(base: readonly BehaviorUse[], over: readonly BehaviorUse[]): BehaviorUse[] {
  const removed = [...(notedKeys(over) ?? [])].filter((use) => !over.some((o) => o.use === use));
  const merged = mergeNamed(base, over, (b) => b.use, (b, o) => ({ ...o, params: (mergeJson(b.params, o.params) ?? {}) as JsonObject }));
  return merged.filter((b) => !removed.includes(b.use));
}

function mergeChildren(base: readonly PrefabChild[], over: readonly PrefabChild[]): PrefabChild[] {
  return mergeNamed(base, over, (c) => c.name, (b, o) => mergeInstance(b, o, [['prefab', 'prefab']]));
}

export function resolvePrefab(project: Pick<Project, 'prefabs'>, id: string, seen: readonly string[] = []): ResolvedPrefab {
  const prefab = project.prefabs.get(id);
  if (prefab === undefined) fail('PP2041', `Unknown prefab "${id}"`);
  if (seen.includes(id)) fail('PP2043', `Prefabs extend each other in a cycle: ${[...seen, id].join(' → ')}`);
  const { extends: baseId, ...own } = prefab;
  if (baseId === undefined) return own;

  const base = resolvePrefab(project, baseId, [...seen, id]);
  const written = writtenKeys(prefab);
  const pool = pick(written, 'pool', base.pool, own.pool);
  const z = pick(written, 'z', base.z, own.z);
  const scale = pick(written, 'scale', base.scale, own.scale);
  // (A PrefabDoc not read from a file names its keys by field: replicateTransform.)
  const replicateKey = written.has('replicateTransform') ? 'replicateTransform' : 'replicate_transform';
  const replicateTransform = pick(written, replicateKey, base.replicateTransform, own.replicateTransform);
  return {
    id: own.id,
    feature: own.feature,
    path: own.path,
    components: mergeMap(base.components, own.components),
    tags: written.has('tags') ? own.tags : base.tags,
    behaviors: mergeBehaviors(base.behaviors, own.behaviors),
    children: mergeChildren(base.children, own.children),
    ...(pool !== undefined && { pool }),
    ...(z !== undefined && { z }),
    ...(scale !== undefined && { scale }),
    ...(replicateTransform !== undefined && { replicateTransform }),
  };
}
