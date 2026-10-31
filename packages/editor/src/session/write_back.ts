/**
 * Write-back: an edit to a live entity as an edit to the documents it came from.
 *
 *   instance  the placement in the scene file: its "at" / "rotation" / "scale" / "z", and
 *             overrides under "components" and "params" — only this entity changes
 *   prefab    the prefab file (a root) or the child's entry in the prefab that declares it
 *             (a child): every instance of the prefab changes
 *
 * Values go in as JSON (what the files hold) and are checked against the game's schemas
 * before any patch is made. Transforms are written in the file's own forms: [x, y] plus
 * "z" in 2D, euler degrees in 3D, a single number for a uniform scale, and nothing when the
 * value is the default the spawner would use anyway.
 */

import { fail, Quat, Vec3 } from '@parallax/runtime/core';
import { decode } from '@parallax/runtime/kernel';
import type { Kernel } from '@parallax/runtime/kernel';
import { resolvePrefab } from '@parallax/runtime/resource';
import type { Json, JsonObject, Project } from '@parallax/runtime/resource';
import { asObject, pointerOf } from './documents.js';
import type { FilePatch, JsonOp, ProjectDocuments } from './documents.js';
import type { EntitySource } from './sources.js';

export type EditTarget = 'instance' | 'prefab';

/** An entity's transform relative to its parent, as the kernel holds it. */
export interface LocalTransform {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

type Registry = Kernel['registry'];

/** Five decimals: what a hand-written file would hold, without float noise (and never -0). */
export function tidy(n: number): number {
  const r = Math.round(n * 1e5) / 1e5;
  return Object.is(r, -0) ? 0 : r;
}

function same(a: Json | undefined, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function objectAt(docs: ProjectDocuments, path: string, pointer: string): JsonObject {
  const obj = asObject(docs.get(path, pointer));
  if (obj === undefined) fail('PP9622', `${path}${pointer === '' ? '' : ` at ${pointer}`} is not an object`, { fix: 'Re-read the documents; they changed.' });
  return obj;
}

function editable(source: EntitySource, what: string): void {
  if (source.cell !== undefined) {
    fail('PP9626', `This entity is cell ${source.cell} of a "grid" ${source.kind === 'placement' ? 'placement' : 'child'}, so its ${what} can't change on its own`, {
      path: source.path, pointer: source.pointer,
      fix: 'Edit the grid (origin, spacing, cols, rows), or replace it with separate entries first.',
    });
  }
}

/** Where `target` edits land for this entity: a file and the object's pointer in it. */
export function location(docs: ProjectDocuments, project: Project, source: EntitySource, target: EditTarget): { path: string; base: string } {
  if (target === 'instance') {
    if (source.kind === 'child') {
      fail('PP9627', 'A placement can\'t override its prefab\'s children', {
        path: source.path, pointer: source.pointer, fix: 'Edit the child in its prefab (target "prefab"): every instance changes.',
      });
    }
    return { path: source.path, base: source.pointer };
  }
  if (source.kind === 'child') return { path: source.path, base: source.pointer };
  const prefab = project.prefabs.get(source.prefab);
  if (prefab === undefined) fail('PP2041', `Unknown prefab "${source.prefab}"`);
  if (!docs.has(prefab.path)) fail('PP9623', `There is no file "${prefab.path}" in the project`);
  return { path: prefab.path, base: '' };
}

/** Ops setting `obj[key1][key2]...` under `base`, creating the objects on the way. */
export function setNested(obj: JsonObject, base: string, keys: readonly string[], value: Json): JsonOp[] {
  let at: JsonObject | undefined = obj;
  const done: string[] = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const next = asObject(at?.[keys[i]!]);
    if (next === undefined) {
      // Build the rest as one nested object.
      let built: Json = value;
      for (let j = keys.length - 1; j > i; j--) built = { [keys[j]!]: built };
      return [{ op: 'add', pointer: base + pointerOf(...done, keys[i]!), value: built }];
    }
    done.push(keys[i]!);
    at = next;
  }
  const last = keys[keys.length - 1]!;
  if (at !== undefined && same(at[last], value)) return [];
  return [{ op: 'add', pointer: base + pointerOf(...done, last), value }];
}

/** The scale the spawner gives an entry without "scale": its prefab's, else 1 (as the spawner reads it). */
function defaultScale(project: Project, source: EntitySource): Vec3 {
  const prefab = source.prefab;
  const scale = prefab === undefined || !project.prefabs.has(prefab) ? undefined : resolvePrefab(project, prefab).scale;
  if (scale === undefined) return Vec3.ONE;
  if (typeof scale === 'number') return new Vec3(scale, scale, scale);
  return new Vec3(scale[0]!, scale[1]!, scale[2] ?? 1);
}

function defaultZ(project: Project, source: EntitySource): number | undefined {
  const prefab = source.prefab;
  return prefab === undefined || !project.prefabs.has(prefab) ? undefined : resolvePrefab(project, prefab).z;
}

function scaleJson(scale: Vec3, dimension: '2d' | '3d'): Json {
  const [x, y, z] = [tidy(scale.x), tidy(scale.y), tidy(scale.z)];
  if (dimension === '2d') return x === y ? x : [x, y];
  return x === y && y === z ? x : [x, y, z];
}

function isIdentity(q: Quat): boolean {
  return Math.abs(Math.abs(q.w) - 1) < 1e-9;
}

/** The patch writing an entity's local transform into its placement or prefab child entry. */
export function transformPatch(
  docs: ProjectDocuments, project: Project, source: EntitySource, transform: LocalTransform, dimension: '2d' | '3d',
): FilePatch {
  editable(source, 'transform');
  const { path, pointer } = source;
  const obj = objectAt(docs, path, pointer);
  const ops: JsonOp[] = [];
  const put = (key: string, value: Json | undefined, isDefault: boolean): void => {
    if (value === undefined) return;
    if (!(key in obj) && isDefault) return;
    if (same(obj[key], value)) return;
    ops.push({ op: 'add', pointer: pointer + pointerOf(key), value });
  };
  const p = transform.position;
  const at = obj['at'];
  if (dimension === '2d') {
    const threeNumbers = Array.isArray(at) && at.length === 3;
    put('at', threeNumbers ? [tidy(p.x), tidy(p.y), tidy(p.z)] : [tidy(p.x), tidy(p.y)], false);
    if (!threeNumbers) {
      const z = typeof obj['z'] === 'number' ? obj['z'] : defaultZ(project, source) ?? 0;
      if (tidy(p.z) !== tidy(z)) ops.push({ op: 'add', pointer: pointer + pointerOf('z'), value: tidy(p.z) });
    }
    put('rotation', tidy(transform.rotation.angle()), isIdentity(transform.rotation));
  } else {
    put('at', [tidy(p.x), tidy(p.y), tidy(p.z)], false);
    const e = transform.rotation.to_euler();
    put('rotation', [tidy(e.x), tidy(e.y), tidy(e.z)], isIdentity(transform.rotation));
  }
  const d = defaultScale(project, source);
  const s = transform.scale;
  const isDefault = tidy(d.x) === tidy(s.x) && tidy(d.y) === tidy(s.y) && (dimension === '2d' || tidy(d.z) === tidy(s.z));
  put('scale', scaleJson(s, dimension), isDefault);
  return { path, ops };
}

/** Check a component field's JSON value against the game's schema (PP2xxx/PP4xxx as the loader would raise). */
export function checkField(registry: Registry, componentId: string, field: string, value: Json): void {
  const def = registry.component(componentId, 'the editor');
  const spec = def.schema[field];
  if (spec === undefined) {
    fail('PP4104', `component "${componentId}" has no field "${field}"`, { fix: `Fields: ${Object.keys(def.schema).join(', ')}.` });
  }
  decode(spec.type, value, `${componentId}.${field}`);
}

/** The patch setting a component field on an entity's placement (instance) or prefab. */
export function fieldPatch(
  docs: ProjectDocuments, project: Project, registry: Registry, source: EntitySource,
  componentId: string, field: string, value: Json, target: EditTarget,
): FilePatch {
  checkField(registry, componentId, field, value);
  const { path, base } = location(docs, project, source, target);
  const obj = objectAt(docs, path, base);
  return { path, ops: setNested(obj, base, ['components', componentId, field], value) };
}

/** The patch setting a behavior param on an entity's placement (instance) or prefab. */
export function paramPatch(
  docs: ProjectDocuments, project: Project, registry: Registry, source: EntitySource,
  behavior: string, param: string, value: Json, target: EditTarget,
): FilePatch {
  const def = registry.behavior(behavior, 'the editor');
  const spec = def.params[param];
  if (spec === undefined) fail('PP4104', `behavior "${behavior}" has no param "${param}"`, { fix: `Params: ${Object.keys(def.params).join(', ')}.` });
  decode(spec.type, value, `${behavior}.${param}`);
  const prefabId = source.prefab;
  if (prefabId !== undefined && !resolvePrefab(project, prefabId).behaviors.some((b) => b.use === behavior)) {
    fail('PP2052', `params given for behavior "${behavior}", which prefab "${prefabId}" doesn't have`, {
      fix: `Add "${behavior}": {} to the prefab's "behaviors" first.`,
    });
  }
  const { path, base } = location(docs, project, source, target);
  const obj = objectAt(docs, path, base);
  if (target === 'instance' || source.kind === 'child') return { path, ops: setNested(obj, base, ['params', behavior, param], value) };
  // The prefab's own "behaviors" map (behavior id → params), the same shape as an instance's
  // "params": an inherited behavior gets an entry that merges over its params.
  return { path, ops: setNested(obj, base, ['behaviors', behavior, param], value) };
}

/** The patch removing an instance override (back to the prefab's value). Empty when there is none. */
export function revertPatch(docs: ProjectDocuments, source: EntitySource, componentId: string, field: string): FilePatch {
  if (source.kind !== 'placement') fail('PP9627', 'Only placements have instance overrides', { path: source.path, pointer: source.pointer });
  const pointer = source.pointer + pointerOf('components', componentId, field);
  return { path: source.path, ops: docs.get(source.path, pointer) === undefined ? [] : [{ op: 'remove', pointer }] };
}

/** A new placement at the end of a scene file's "entities". */
export function addPlacementPatch(docs: ProjectDocuments, scenePath: string, placement: JsonObject): FilePatch {
  const scene = objectAt(docs, scenePath, '');
  if (typeof placement['prefab'] !== 'string') fail('PP9628', 'A placement needs a "prefab"', { fix: 'Pass {"prefab": "<id>", "at": [...]}.' });
  return Array.isArray(scene['entities'])
    ? { path: scenePath, ops: [{ op: 'add', pointer: pointerOf('entities', '-'), value: placement }] }
    : { path: scenePath, ops: [{ op: 'add', pointer: pointerOf('entities'), value: [placement] }] };
}

/** Remove a placement (a region's one-entity file is removed whole). */
export function removePlacementPatch(source: EntitySource): FilePatch {
  if (source.kind !== 'placement') {
    fail('PP9627', 'A prefab\'s child is removed from its prefab, not from the scene', { path: source.path, pointer: source.pointer, fix: 'Edit the prefab\'s "children".' });
  }
  editable(source, 'placement');
  return { path: source.path, ops: [{ op: 'remove', pointer: source.pointer }] };
}
