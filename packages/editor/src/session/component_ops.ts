/**
 * Structure edits as document patches: adding and removing a component, setting several of
 * a component's fields at once (reset, paste), renaming an entity and editing the scene's
 * "environment" block. Like write_back.ts, every function only builds a patch from the
 * documents as they are; the session commits it and rebuilds the world.
 *
 * Where a component lives decides where it can be removed: a placement only adds
 * components over its prefab (it can't take one away), so a component the prefab gives is
 * removed from the prefab (every instance), and one a base prefab gives ("extends") from that
 * base (PP9638 says which).
 */

import { fail } from '@parallax/runtime/core';
import { encode } from '@parallax/runtime/kernel';
import type { FieldSpec, FieldType, Kernel, Schema } from '@parallax/runtime/kernel';
import { resolvePrefab } from '@parallax/runtime/resource';
import type { Json, JsonObject, Project } from '@parallax/runtime/resource';
import { asObject, parsePointer, pointerOf } from './documents.js';
import type { FilePatch, JsonOp, ProjectDocuments } from './documents.js';
import type { EntitySource } from './sources.js';
import { checkField, location, objectAt, setNested } from './write_back.js';
import type { EditTarget } from './write_back.js';

type Registry = Kernel['registry'];

/**
 * A value a required field (one without a default) can start from when its component is
 * added: zero, empty, the first choice. Undefined for references (an entity, a prefab, an
 * asset), which have no neutral value: the caller must supply them.
 */
export function placeholderJson(type: FieldType): Json | undefined {
  switch (type.kind) {
    case 'number': case 'int': return 0;
    case 'bool': return false;
    case 'string': case 'tag': return '';
    case 'enum': return type.values[0] ?? '';
    case 'vec2': case 'cell': return [0, 0];
    case 'vec3': case 'cell3': return [0, 0, 0];
    case 'color': return [1, 1, 1, 1];
    case 'json': case 'optional': return null;
    case 'list': return [];
    case 'dict': return {};
    case 'tuple': {
      const items = type.of.map(placeholderJson);
      return items.every((v) => v !== undefined) ? items as Json[] : undefined;
    }
    case 'record': {
      const out: Record<string, Json> = {};
      for (const [name, spec] of Object.entries(type.fields)) {
        if (spec.default !== undefined) continue;
        const v = placeholderJson(spec.type);
        if (v === undefined) return undefined;
        out[name] = v;
      }
      return out;
    }
    case 'union': return type.of.length > 0 ? placeholderJson(type.of[0]!) : undefined;
    default: return undefined;
  }
}

/** A field's default as JSON (undefined: the field has none, or it isn't plain data). */
export function defaultJson(spec: FieldSpec, where: string): Json | undefined {
  if (spec.default === undefined) return undefined;
  try {
    return encode(spec.type, spec.default, where);
  } catch {
    return undefined;
  }
}

/** The fields a new component must be written with: each required field's placeholder. */
export function requiredFields(schema: Schema): { readonly values: JsonObject; readonly missing: readonly string[] } {
  const values: Record<string, Json> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.default !== undefined) continue;
    const v = placeholderJson(spec.type);
    if (v === undefined) missing.push(name); else values[name] = v;
  }
  return { values, missing };
}

/** Every field with a default at that default ("Reset"); required fields are left as they are. */
export function defaultFields(schema: Schema, componentId: string): JsonObject {
  const out: Record<string, Json> = {};
  for (const [name, spec] of Object.entries(schema)) {
    const v = defaultJson(spec, `${componentId}.${name}`);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

function hasComponent(components: Readonly<Record<string, unknown>> | undefined, id: string): boolean {
  return components !== undefined && Object.prototype.hasOwnProperty.call(components, id);
}

/** The patch adding a component with `values` (checked against its schema) to the placement or prefab. */
export function addComponentPatch(
  docs: ProjectDocuments, project: Project, registry: Registry, source: EntitySource,
  componentId: string, values: JsonObject, target: EditTarget,
): FilePatch {
  const def = registry.component(componentId, 'the editor');
  for (const [field, value] of Object.entries(values)) checkField(registry, componentId, field, value);
  const missing = Object.keys(def.schema).filter((f) => def.schema[f]!.default === undefined && !(f in values));
  if (missing.length > 0) {
    fail('PP9638', `"${componentId}" needs ${missing.map((f) => `"${f}"`).join(', ')} set when it is added`, {
      fix: `Pass a value for ${missing.join(', ')} (it has no default).`,
    });
  }
  const { path, base } = location(docs, project, source, target);
  const obj = objectAt(docs, path, base);
  const existing = asObject(asObject(obj['components'])?.[componentId]);
  return { path, ops: setNested(obj, base, ['components', componentId], { ...values, ...existing }) };
}

/** Where a component the entry doesn't declare itself comes from (a prefab id), if anywhere. */
function inheritedFrom(project: Project, source: EntitySource, componentId: string, target: EditTarget): string | undefined {
  const has = (prefab: string | undefined): boolean => prefab !== undefined && project.prefabs.has(prefab)
    && hasComponent(resolvePrefab(project, prefab).components, componentId);
  if (source.kind === 'child') return has(source.prefab) ? source.prefab : undefined;
  if (target === 'instance') return has(source.prefab) ? source.prefab : undefined;
  const base = project.prefabs.get(source.prefab)?.extends;
  return has(base) ? base : undefined;
}

/** The patch removing a component from the placement or prefab entry that declares it. */
export function removeComponentPatch(
  docs: ProjectDocuments, project: Project, source: EntitySource, componentId: string, target: EditTarget,
): FilePatch {
  const { path, base } = location(docs, project, source, target);
  const obj = objectAt(docs, path, base);
  const from = inheritedFrom(project, source, componentId, target);
  if (from !== undefined) {
    const placement = source.kind === 'placement' && target === 'instance';
    fail('PP9638', `"${componentId}" comes from prefab "${from}", so it can't be removed here`, {
      path, pointer: base,
      fix: placement
        ? 'Edit the Prefab instead (every instance loses it): a placement can add components but not take its prefab\'s away.'
        : `Remove it from prefab "${from}" (every prefab built on it loses it).`,
    });
  }
  const components = asObject(obj['components']);
  if (components === undefined || !hasComponent(components, componentId)) {
    fail('PP9638', `${path}${base === '' ? '' : ` at ${base}`} has no "${componentId}" component to remove`, { path, pointer: base });
  }
  return { path, ops: [{ op: 'remove', pointer: base + pointerOf('components', componentId) }] };
}

/** The patch setting several fields of one component at once (one op; the others keep their values). */
export function componentValuesPatch(
  docs: ProjectDocuments, project: Project, registry: Registry, source: EntitySource,
  componentId: string, values: JsonObject, target: EditTarget,
): FilePatch {
  for (const [field, value] of Object.entries(values)) checkField(registry, componentId, field, value);
  const { path, base } = location(docs, project, source, target);
  const obj = objectAt(docs, path, base);
  const existing = asObject(asObject(obj['components'])?.[componentId]) ?? {};
  const merged = { ...existing, ...values };
  if (JSON.stringify(merged) === JSON.stringify(existing) && Object.keys(existing).length > 0) return { path, ops: [] };
  return { path, ops: setNested(obj, base, ['components', componentId], merged) };
}

/** What renaming writes: a placement's "id" (`Placed.<id>`), a prefab child's "name" (`entity.child(name)`). */
export function nameKey(source: EntitySource): 'id' | 'name' {
  return source.kind === 'placement' ? 'id' : 'name';
}

/**
 * The patch renaming an entity: its placement's "id" or its child entry's "name"; an empty
 * name removes the key. An id must be a Python name (`Placed.<id>`) and unique in the scene;
 * a child's name unique among its siblings.
 */
export function renamePatch(docs: ProjectDocuments, project: Project, source: EntitySource, name: string): FilePatch {
  if (source.cell !== undefined) {
    fail('PP9626', `This entity is cell ${source.cell} of a "grid" entry, so it can't be named on its own`, {
      path: source.path, pointer: source.pointer, fix: 'Name the grid entry, or replace it with separate entries first.',
    });
  }
  const key = nameKey(source);
  const obj = objectAt(docs, source.path, source.pointer);
  const pointer = source.pointer + pointerOf(key);
  const trimmed = name.trim();
  if (trimmed === '') return { path: source.path, ops: obj[key] === undefined ? [] : [{ op: 'remove', pointer }] };
  if (obj[key] === trimmed) return { path: source.path, ops: [] };
  if (source.kind === 'placement') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      fail('PP9640', `"${trimmed}" can't be an entity id`, {
        path: source.path, pointer, fix: 'Use letters, digits and _ (not starting with a digit): code names it Placed.<id>.',
      });
    }
    const taken = project.scenes.get(source.scene)?.entities.some((p) => p.id === trimmed) ?? false;
    if (taken) fail('PP9640', `Another entity in scene "${source.scene}" is already "${trimmed}"`, { path: source.path, pointer, fix: 'Pick a name no other placement has.' });
  } else {
    const keys = parsePointer(source.pointer);
    const siblings = docs.get(source.path, pointerOf(...keys.slice(0, -1)));
    if (Array.isArray(siblings) && siblings.some((c) => asObject(c)?.['name'] === trimmed)) {
      fail('PP9640', `This prefab already has a child named "${trimmed}"`, { path: source.path, pointer, fix: 'Child names are unique within their prefab.' });
    }
  }
  return { path: source.path, ops: [{ op: 'add', pointer, value: trimmed }] };
}

/**
 * The patch setting (or, with `value` undefined, removing) a key of a scene's "environment"
 * block: `["fog", "density"]` → environment.fog.density. Removing the last key of a nested
 * block removes the block.
 */
export function environmentPatch(docs: ProjectDocuments, scenePath: string, keys: readonly string[], value: Json | undefined): FilePatch {
  if (keys.length === 0) fail('PP9622', 'environmentPatch needs a key');
  const scene = objectAt(docs, scenePath, '');
  const full = ['environment', ...keys];
  if (value !== undefined) return { path: scenePath, ops: setNested(scene, '', full, value) };
  if (docs.get(scenePath, pointerOf(...full)) === undefined) return { path: scenePath, ops: [] };
  // Drop the emptied blocks too (keep "environment" itself).
  let depth = full.length;
  while (depth > 2) {
    const parent = asObject(docs.get(scenePath, pointerOf(...full.slice(0, depth - 1))));
    if (parent === undefined || Object.keys(parent).length > 1) break;
    depth--;
  }
  const ops: JsonOp[] = [{ op: 'remove', pointer: pointerOf(...full.slice(0, depth)) }];
  return { path: scenePath, ops };
}
