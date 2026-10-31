/**
 * Instantiation: a prefab (resolved through its variants) plus instance overrides →
 * entities in the world. Spawning is a batch: every entity of a prefab and its children
 * is created first; the kernel runs `start` on the whole batch afterwards.
 */

import { fail, Quat, Vec3 } from '../../core/index.js';
import type { EntityId } from '../../core/index.js';
import { resolvePrefab } from '../../resource/index.js';
import type { InstanceFields, InstanceGrid, JsonObject, Project } from '../../resource/index.js';
import type { Registry } from './registry.js';
import { copy, instantiate, instantiateValues, instantiateWith } from './schema.js';
import type { Fields, FieldType, Schema } from './schema.js';
import { COMPONENT_ENTITY } from './definitions.js';
import type { ComponentDef } from './definitions.js';
import type { EntityRecord, World } from './world.js';

export interface SpawnTarget {
  readonly world: World;
  readonly registry: Registry;
  readonly project: Pick<Project, 'prefabs'>;
  /** The game-facing handle stored on behaviors (`self.entity`) and in event payloads. */
  readonly wrap: (id: EntityId) => unknown;
  /** The game's dimension: a number `rotation` is a 2D angle (about +z) or a 3D yaw (about +y). Default "2d". */
  readonly mode?: '2d' | '3d';
}

/** What a placement or child can set on the entity it creates. */
export type Overrides = Partial<Omit<InstanceFields, 'origin' | 'grid'>>;

export interface SpawnOptions {
  readonly placedId?: string;
  readonly childName?: string;
  readonly parent?: EntityRecord;
  /** The player it is spawned for; its prefab children inherit it. */
  readonly owner?: number;
  /** The root's spawn name (`spawn(name=)`). */
  readonly name?: string;
  /**
   * Component values in runtime form (game code's `spawn(components=)`), applied to the
   * root over its prefab and JSON overrides: listed fields are set, a component the prefab
   * lacks is added with defaults for the rest. Values are copied.
   */
  readonly components?: Readonly<Record<string, Fields>>;
  /** Behavior params in runtime form, by behavior id, applied like `components`. */
  readonly params?: Readonly<Record<string, Fields>>;
}

function toPosition(at: readonly number[] | undefined, z: number | undefined): Vec3 {
  if (at === undefined) return new Vec3(0, 0, z ?? 0);
  // A 2D position takes its draw order from the instance or prefab "z".
  return new Vec3(at[0]!, at[1]!, at.length === 3 ? at[2]! : z ?? 0);
}

/**
 * Euler degrees [pitch, yaw, roll] (as `Transform.euler`), or one number: in a 3D game a
 * yaw about +y (`spawn(rotation=90)` faces +x), in a 2D game an angle about +z.
 */
function toRotation(rotation: number | readonly number[] | undefined, mode: '2d' | '3d'): Quat {
  if (rotation === undefined) return Quat.IDENTITY;
  if (typeof rotation === 'number') return mode === '3d' ? Quat.from_euler(new Vec3(0, rotation, 0)) : Quat.from_angle(rotation);
  return Quat.from_euler(new Vec3(rotation[0], rotation[1], rotation[2]));
}

function toScale(scale: number | readonly number[] | undefined): Vec3 {
  if (scale === undefined) return Vec3.ONE;
  if (typeof scale === 'number') return new Vec3(scale, scale, scale);
  return new Vec3(scale[0], scale[1], scale[2] ?? 1);
}

/** The positions of a gridded instance: column i, row j at origin + (i·dx, −j·dy). */
export function gridPositions(grid: InstanceGrid): number[][] {
  const positions: number[][] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const at = [grid.origin[0]! + col * grid.spacing[0]!, grid.origin[1]! - row * grid.spacing[1]!];
      if (grid.origin.length === 3) at.push(grid.origin[2]!);
      positions.push(at);
    }
  }
  return positions;
}

function mergeComponentData(base: Readonly<Record<string, JsonObject>>, over: Readonly<Record<string, JsonObject>> = {}): Record<string, JsonObject> {
  const merged: Record<string, JsonObject> = { ...base };
  for (const [id, fields] of Object.entries(over)) merged[id] = { ...base[id], ...fields };
  return merged;
}

/** Give a fields object its component's methods and its owner (engine components). */
export function bindComponent(def: ComponentDef, fields: Fields, entity: EntityId): Fields {
  if (def.methods !== undefined) Object.setPrototypeOf(fields, def.methods);
  Object.defineProperty(fields, COMPONENT_ENTITY, { value: entity, enumerable: false });
  return fields;
}

function addComponents(target: SpawnTarget, record: EntityRecord, data: Record<string, JsonObject>, where: string): void {
  for (const [id, fields] of Object.entries(data)) {
    const def = target.registry.component(id, where);
    record.components.set(id, bindComponent(def, instantiate(def.schema, fields, `${where}.${id}`), record.id));
  }
}

function configureInstance(record: EntityRecord, over: Overrides, mode: '2d' | '3d',
  prefab: { readonly z?: number; readonly scale?: number | readonly number[] } = {}): void {
  record.transform.position = toPosition(over.at, over.z ?? prefab.z);
  record.transform.rotation = toRotation(over.rotation, mode);
  record.transform.scale = toScale(over.scale ?? prefab.scale);
  record.visible = over.visible ?? true;
  for (const tag of over.tags ?? []) record.tags.add(tag);
}

/** Spawn one prefab instance (and its children). Returns the batch, root first. */
export function spawnPrefab(target: SpawnTarget, prefabId: string, over: Overrides, options: SpawnOptions = {}): EntityRecord[] {
  const prefab = resolvePrefab(target.project, prefabId);
  const where = `prefab "${prefabId}"`;
  const record = target.world.create({
    prefab: prefabId,
    ...(options.placedId !== undefined && { placedId: options.placedId }),
    ...(options.childName !== undefined && { childName: options.childName }),
    ...(options.owner !== undefined && { owner: options.owner }),
    ...(options.name !== undefined && { name: options.name }),
  });
  if (options.parent !== undefined) target.world.attach(record, options.parent);

  for (const tag of prefab.tags) record.tags.add(tag);
  configureInstance(record, over, target.mode ?? '2d', prefab);
  // Runtime values (`spawn(components=)`) merge over the authored data before required
  // fields are checked, so they may supply what the prefab leaves out.
  const runtime = options.components ?? {};
  const data = mergeComponentData(prefab.components, over.components);
  for (const [id, fields] of Object.entries(data)) {
    const def = target.registry.component(id, where);
    const values = runtime[id] ?? {};
    record.components.set(id, bindComponent(def, instantiateWith(def.schema, fields, values, `${where}.${id}`), record.id));
  }
  for (const [id, values] of Object.entries(runtime)) {
    if (id in data) continue;
    const def = target.registry.component(id, where);
    record.components.set(id, bindComponent(def, instantiateValues(def.schema, values, `${where}.${id}`), record.id));
  }

  const paramOverrides = over.params ?? {};
  for (const use of new Set([...Object.keys(paramOverrides), ...Object.keys(options.params ?? {})])) {
    if (!prefab.behaviors.some((b) => b.use === use)) {
      fail('PP2052', `params given for behavior "${use}", which ${where} doesn't have`, {
        fix: `Add "${use}": {} to the prefab's "behaviors", or remove these params.`,
      });
    }
  }
  for (const use of prefab.behaviors) {
    const def = target.registry.behavior(use.use, where);
    for (const required of def.requires) {
      if (!record.components.has(required)) {
        fail('PP3103', `Behavior "${def.id}" requires component "${required}", which ${where} doesn't have`, {
          fix: `Add "${required}" to the prefab's components (or pass it when spawning).`,
        });
      }
    }
    const params = instantiateWith(def.params, { ...use.params, ...paramOverrides[use.use] }, options.params?.[use.use] ?? {},
      `${where} behavior "${def.id}" params`);
    const state = instantiate(def.state, undefined, `${where} behavior "${def.id}" state`);
    const instance = def.create();
    Object.assign(instance, params, state, { entity: target.wrap(record.id) });
    record.behaviors.push({ def, instance, started: false });
  }

  const batch = [record];
  for (const child of prefab.children) {
    const positions = child.grid === undefined ? [child.at] : gridPositions(child.grid);
    for (const at of positions) {
      const childOver: Overrides = { ...child, ...(at !== undefined && { at }) };
      const childOptions: SpawnOptions = {
        parent: record,
        ...(child.name !== undefined && { childName: child.name }),
        ...(options.owner !== undefined && { owner: options.owner }),
      };
      if (child.prefab !== undefined) {
        batch.push(...spawnPrefab(target, child.prefab, childOver, childOptions));
      } else {
        const inline = target.world.create({
          ...(child.name !== undefined && { childName: child.name }),
          ...(options.owner !== undefined && { owner: options.owner }),
        });
        target.world.attach(inline, record);
        configureInstance(inline, childOver, target.mode ?? '2d');
        addComponents(target, inline, { ...child.components }, `${where} child "${child.name ?? '(unnamed)'}"`);
        batch.push(inline);
      }
    }
  }
  return batch;
}

function entityFieldsOf(type: FieldType): boolean {
  if (type.kind === 'entity') return true;
  if (type.kind === 'list' || type.kind === 'optional' || type.kind === 'dict') return entityFieldsOf(type.of);
  if (type.kind === 'union' || type.kind === 'tuple') return type.of.some(entityFieldsOf);
  return false;
}

/**
 * Entity-typed component fields and behavior params authored as placed ids
 * (`"follow": "player"`) become entity handles once the whole scene exists. `local_player` stays a marker for the api layer.
 */
export function resolvePlacedReferences(target: SpawnTarget, batch: readonly EntityRecord[]): void {
  const placed = new Map<string, EntityId>();
  for (const record of target.world.live()) if (record.placedId !== undefined) placed.set(record.placedId, record.id);
  const resolve = (value: unknown, where: string): unknown => {
    if (Array.isArray(value)) return value.map((v, i) => resolve(v, `${where}[${i}]`));
    if (typeof value !== 'string' || value === 'local_player') return value;
    const id = placed.get(value);
    if (id === undefined) fail('PP2046', `${where} names "${value}", but no entity is placed with that id`);
    return target.wrap(id);
  };
  const resolveAll = (fields: Fields, schema: Schema, where: string): void => {
    for (const [name, spec] of Object.entries(schema)) {
      if (entityFieldsOf(spec.type) && fields[name] !== undefined && fields[name] !== null) {
        fields[name] = resolve(fields[name], `${where}.${name}`);
      }
    }
  };
  for (const record of batch) {
    for (const [componentId, fields] of record.components) {
      resolveAll(fields, target.registry.components.get(componentId)!.schema, componentId);
    }
    for (const slot of record.behaviors) resolveAll(slot.instance as Fields, slot.def.params, `behavior "${slot.def.id}" params`);
  }
}

