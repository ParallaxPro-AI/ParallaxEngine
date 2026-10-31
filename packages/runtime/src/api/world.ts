/**
 * `ctx.world`: spawning, queries, placed entities and open-world layers (`layer()`, over
 * the core streaming plugin).
 */

import { Color, fail, Vec2, Vec3 } from '../core/index.js';
import type { Fields, Overrides } from '../function/kernel/index.js';
import type { Json, JsonObject } from '../resource/index.js';
import { Entity, componentIdOf } from './entity.js';
import { Player } from './context.js';
import { bindArgs } from './kwargs.js';
import { dictEntries } from './py.js';
import { runQuery } from './query.js';
import { worldLayer } from './streaming.js';
import type { WorldLayer } from './streaming.js';
import type { Query } from './query.js';
import { Enum, EntityRef, PrefabRef, Tag } from './types.js';
import type { GameRuntime } from './runtime.js';

/** A runtime value → the JSON form prefab data uses (for spawn overrides). */
export function toJson(value: unknown, where: string): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Vec2) return [value.x, value.y];
  if (value instanceof Vec3) return [value.x, value.y, value.z];
  if (value instanceof Color) return [value.r, value.g, value.b, value.a];
  if (value instanceof Enum) return value.value;
  if (value instanceof Entity) {
    return fail('PP3008', `${where}: an Entity can't be passed through spawn() yet`, {
      fix: 'Set the field on the spawned entity after spawn() returns.',
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => toJson(v, `${where}[${i}]`));
  if (typeof value === 'object') {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') return toJson(toJSON.call(value), where);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v, `${where}.${k}`)]));
  }
  return fail('PP3008', `${where}: ${String(value)} can't be stored in a component`);
}

function tagIds(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  const list = value instanceof Tag ? [value] : [...(value as Iterable<unknown>)];
  return list.map((t) => {
    if (!(t instanceof Tag)) fail('PP3004', `${where} takes Tags, got ${String(t)}`);
    return t.id;
  });
}

export class Placement {
  readonly ref: EntityRef;
  readonly position: Vec3;
  readonly prefab: PrefabRef;
  readonly #rt: GameRuntime;

  constructor(rt: GameRuntime, ref: EntityRef, position: Vec3, prefab: PrefabRef) {
    this.#rt = rt;
    this.ref = ref;
    this.position = position;
    this.prefab = prefab;
  }

  get loaded(): Entity | null {
    for (const record of this.#rt.kernel.world.live()) {
      if (record.placedId === this.ref.id) return this.#rt.wrap(record.id);
    }
    return null;
  }
}

export class World {
  readonly #rt: GameRuntime;

  constructor(rt: GameRuntime) {
    this.#rt = rt;
  }

  spawn(...args: unknown[]): Entity {
    const a = bindArgs('spawn', args, {
      positional: ['prefab'],
      keyword: ['at', 'rotation', 'scale', 'z', 'parent', 'name', 'owner', 'components', 'tags', 'params'],
      required: ['prefab'],
    }).args;
    const prefab = a['prefab'];
    if (!(prefab instanceof PrefabRef)) fail('PP3009', `spawn() takes a prefab (Prefabs.<name>), got ${String(prefab)}`);
    const rt = this.#rt;
    const over: { -readonly [K in keyof Overrides]: Overrides[K] } = {};

    const at = a['at'];
    if (at !== undefined && at !== null) {
      if (at instanceof Vec2) over.at = [at.x, at.y];
      // 2D: draw order comes from the prefab "z" (or z=), never from `at`.
      else if (at instanceof Vec3) over.at = rt.mode === '2d' ? [at.x, at.y] : [at.x, at.y, at.z];
      else fail('PP3007', `spawn() at= must be a Vec2 or Vec3, got ${String(at)}`);
    }
    const rotation = a['rotation'];
    if (rotation !== undefined && rotation !== null) {
      if (typeof rotation === 'number') over.rotation = rotation;
      else if (rotation instanceof Vec3) over.rotation = [rotation.x, rotation.y, rotation.z];
      else fail('PP3007', `spawn() rotation= must be degrees or a Vec3, got ${String(rotation)}`);
    }
    const scale = a['scale'];
    if (scale !== undefined && scale !== null) {
      if (typeof scale === 'number') over.scale = scale;
      else if (scale instanceof Vec3) over.scale = [scale.x, scale.y, scale.z];
      else fail('PP3007', `spawn() scale= must be a float or a Vec3, got ${String(scale)}`);
    }
    if (a['z'] !== undefined && a['z'] !== null) over.z = a['z'] as number;
    over.tags = tagIds(a['tags'], 'spawn() tags=');

    // Component and param values go to the kernel in runtime form (entities, refs and
    // records included); it applies them before any behavior starts.
    const components: Record<string, Fields> = {};
    for (const component of (a['components'] ?? []) as Iterable<object>) {
      const id = componentIdOf((component as { constructor?: unknown } | null)?.constructor, 'spawn() components=');
      components[id] = rt.componentValues(id, component, 'given');
    }
    const params: Record<string, Fields> = {};
    const given = a['params'];
    if (given !== undefined && given !== null) {
      for (const [behaviorId, values] of dictEntries(given, 'spawn() params=')) {
        params[behaviorId] = Object.fromEntries(dictEntries(values, `spawn() params=["${behaviorId}"]`));
      }
    }

    const owner = a['owner'] ?? null;
    if (owner !== null && !(owner instanceof Player)) fail('PP3004', `spawn() owner= must be a Player, got ${String(owner)}`);
    const parent = a['parent'];
    if (parent !== undefined && parent !== null && !(parent instanceof Entity)) fail('PP3004', 'spawn() parent= must be an Entity');
    const name = a['name'] ?? null;
    if (name !== null && typeof name !== 'string') fail('PP3004', `spawn() name= must be a str, got ${String(name)}`);
    const record = rt.kernel.spawn(prefab.id, over, {
      components,
      params,
      ...(parent instanceof Entity && { parent: parent.__entity_id__ }),
      ...(owner !== null && { owner: owner.index }),
      ...(name !== null && { name }),
    });
    return rt.wrap(record.id);
  }

  /** `query(C1, C2, tagged=Tag | [Tag], without=[C | Tag])`. */
  query(...args: unknown[]): Query {
    const a = bindArgs('query', args, { keyword: ['tagged', 'without'], rest: true });
    const componentIds = a.rest.map((kind) => componentIdOf(kind, 'query'));
    const tagged = tagIds(a.args['tagged'], 'query() tagged=');
    const withoutValue = a.args['without'];
    const without = withoutValue === undefined || withoutValue === null
      ? []
      : [...(withoutValue instanceof Tag ? [withoutValue] : (withoutValue as Iterable<unknown>))].map((x) =>
        x instanceof Tag ? x.id : componentIdOf(x, 'query() without='));
    if (componentIds.length === 0 && tagged.length === 0) {
      fail('PP3010', 'query() needs at least one component or tagged=', { fix: 'Query by component (query(Health)) or by tag (query(tagged=Enemy)).' });
    }
    return runQuery(this.#rt, componentIds, tagged, without);
  }

  /**
   * The first live entity (spawn order) named `name` — `spawn(name=...)`, else its scene
   * placement id — or None. For names computed at run time (`f"lane_{i}"`); a placed
   * entity known in advance is `placed(Placed.x)`, which is checked.
   */
  named(name: unknown): Entity | null {
    if (typeof name !== 'string') fail('PP3011', `named() takes a str, got ${String(name)}`);
    for (const record of this.#rt.kernel.world.live()) {
      if ((record.name ?? record.placedId) === name) return this.#rt.wrap(record.id);
    }
    return null;
  }

  /** The entity placed in the loaded scene with this stable id. */
  placed(ref: unknown): Entity {
    const id = placedId(ref);
    for (const record of this.#rt.kernel.world.live()) if (record.placedId === id) return this.#rt.wrap(record.id);
    return fail('PP3011', `No entity placed as "${id}" is loaded`, { fix: 'Use world.placement(ref) for data of unloaded entities.' });
  }

  /** A world layer of the current scene's world.json (`WorldLayers.<id>`). Prefer declarative `active_when`. */
  layer(ref: unknown): WorldLayer {
    return worldLayer(this.#rt.kernel, ref);
  }

    /** Authored data of a placed entity, available even when it isn't loaded. */
  placement(ref: unknown): Placement {
    const id = placedId(ref);
    const scene = this.#rt.kernel.scene;
    const placement = scene?.entities.find((p) => p.id === id);
    if (scene === undefined || placement === undefined) {
      return fail('PP3011', `The current scene places no entity "${id}"`);
    }
    const at = placement.at ?? [0, 0];
    const z = placement.z ?? this.#rt.project.prefabs.get(placement.prefab)?.z ?? 0;
    const position = new Vec3(at[0]!, at[1]!, at.length === 3 ? at[2]! : z);
    return new Placement(this.#rt, ref as EntityRef, position, new PrefabRef(placement.prefab));
  }
}

function placedId(ref: unknown): string {
  if (!(ref instanceof EntityRef)) fail('PP3011', `Expected a placed entity ref (Placed.<id>), got ${String(ref)}`);
  return ref.id;
}
