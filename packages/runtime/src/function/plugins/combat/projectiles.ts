/**
 * Projectiles (sdk/parallax/combat.pyi `Projectile`, `ctx.combat.fire`), one fixed step at
 * a time (the kernel's 'physics' hook).
 *
 *   straight   flies along its velocity
 *   ballistic  falls under `gravity` (None: the physics world's, else −9.8 m/s²)
 *   homing     turns towards its `target` at up to `turn_rate` deg/s (straight once the
 *              target is gone)
 *
 * Each step sweeps the path just flown against the world as the last physics step left
 * it — physics3d: a ray, or a sphere of `radius`; physics2d: a ray, then a circle of
 * `radius` at the end; neither: entities with a `health` component within `radius` +
 * 0.5 m of the path — ignoring itself, its `source`, what it already pierced and, unless
 * `friendly_fire`, everything on its source's Side (as `area_damage` does: allies are
 * flown through, never hit). A hit raises `projectile_hit` and, when the target has a
 * Health, deals `damage` through the one damage pipeline (`hit()`), with the source as the
 * hit's source. It flies through up to `pierce` targets; the next hit, a hit on scenery,
 * or the end of its `lifetime` (`projectile_expired`) retires it.
 *
 * Pooling. A retired projectile is not destroyed: it is hidden and marked inactive, and
 * the next `ctx.combat.fire()` of the same prefab takes it back — so a bullet hell spawns
 * once per bullet alive at the same time, not once per shot. The pool is derived from
 * the components (inactive projectiles of a prefab), so it saves and replays with them.
 */

import { fail, Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, EventDef, Fields, FieldSpec, FieldType, Schema } from '../../kernel/index.js';
import { PHYSICS2D_SERVICE, PHYSICS3D_SERVICE } from '../../services/index.js';
import type { WorldFilter } from '../../services/index.js';
import { bind, describe, entityId, nonNegative } from './args.js';
import { HEALTH, SIDE } from './state.js';
import type { CombatState } from './state.js';

export const PROJECTILE = 'projectile';

export const PROJECTILE_EVENTS = {
  projectileHit: { id: 'projectile_hit', target: 'entity' },
  projectileExpired: { id: 'projectile_expired', target: 'entity' },
} as const satisfies Record<string, EventDef>;

export const PROJECTILE_MOTIONS = ['straight', 'ballistic', 'homing'] as const;

const optional = (of: FieldType): FieldSpec => ({ type: { kind: 'optional', of }, default: null });

export const PROJECTILE_SCHEMA: Schema = {
  motion: t.enum(PROJECTILE_MOTIONS, { default: 'straight' }),
  speed: t.number({ default: 20, min: 0 }),
  gravity: optional({ kind: 'number' }),
  turn_rate: t.number({ default: 180, min: 0 }),
  lifetime: t.number({ default: 3, min: 0 }),
  radius: t.number({ default: 0, min: 0 }),
  damage: t.number({ default: 0, min: 0 }),
  damage_kind: optional({ kind: 'tag' }),
  pierce: t.int({ default: 0, min: 0 }),
  layers: t.list({ kind: 'string' }, { default: [] }),
  /** Hit (and hurt) entities on the source's Side too. */
  friendly_fire: t.bool({ default: false }),
  // Kept by the engine:
  active: t.bool({ default: true }),
  velocity: t.vec3({ default: Vec3.ZERO }),
  age: t.number({ default: 0, min: 0 }),
  source: optional({ kind: 'entity' }),
  target: optional({ kind: 'entity' }),
  hits: t.list({ kind: 'entity' }, { default: [] }),
};

export const DEFAULT_GRAVITY = -9.8;
/** Without physics: how far from the path (beyond `radius`) a Health entity counts as hit. */
export const BARE_HIT_RADIUS = 0.5;

interface Hit {
  readonly entity: EntityId | undefined;
  readonly point: Vec3;
  readonly normal: Vec3;
}

/** The id of a PrefabRef / Tag (an object with `id` or `__tag_id__`), or a bare id string. */
function idOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const o = value as { id?: unknown; __tag_id__?: unknown };
    if (typeof o.__tag_id__ === 'string') return o.__tag_id__;
    if (typeof o.id === 'string') return o.id;
  }
  return null;
}

/** A list field as an array (pyrt lists are arrays; tuples and iterables are spread). */
function listOf<T>(value: unknown): readonly T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'object' && Symbol.iterator in value) return [...(value as Iterable<T>)];
  return [];
}

/** A point or direction: Vec3 as is, Vec2 → (x, y, 0). */
function point(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  if (value instanceof Vec2) return new Vec3(value.x, value.y, 0);
  return fail('PP7404', `${where} must be a Vec3 or Vec2, got ${describe(value)}`);
}

function optionalId(s: CombatState, value: unknown, where: string): EntityId | null {
  return value === undefined || value === null ? null : entityId(s.kernel.handles, value, where);
}

function wrap(s: CombatState, id: EntityId | null): unknown {
  return id === null ? null : s.kernel.handles.wrap(id);
}

/** `[entity, fields]` for every live projectile, in spawn order. */
function projectiles(s: CombatState): Array<[EntityId, Fields]> {
  return s.kernel.world.query([PROJECTILE]).map((r) => [r[0], r[1]!]);
}

/** Rotate `v` towards `to` by at most `maxDegrees` (both non-zero), keeping |v|. */
export function turnTowards(v: Vec3, to: Vec3, maxDegrees: number): Vec3 {
  const speed = v.length();
  const a = v.normalized();
  const b = to.normalized();
  const angle = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
  const max = (maxDegrees * Math.PI) / 180;
  if (angle <= max || angle < 1e-9) return angle <= max ? b.__mul__(speed) : v;
  let axis = a.cross(b);
  if (axis.length() < 1e-9) axis = Math.abs(a.y) < 0.9 ? a.cross(Vec3.UP) : a.cross(Vec3.RIGHT);
  axis = axis.normalized();
  // Rodrigues: a·cos + (k×a)·sin (k ⟂ a).
  const turned = a.__mul__(Math.cos(max)).__add__(axis.cross(a).__mul__(Math.sin(max)));
  return turned.normalized().__mul__(speed);
}

function face(record: EntityRecord, v: Vec3, threeD: boolean): void {
  if (v.length() === 0) return;
  record.transform.rotation = threeD || v.z !== 0
    ? Quat.look_rotation(v)
    : Quat.from_angle((Math.atan2(v.y, v.x) * 180) / Math.PI);
}

function sweep(s: CombatState, from: Vec3, to: Vec3, radius: number, filter: WorldFilter): Hit | undefined {
  const delta = to.__sub__(from);
  const length = delta.length();
  if (length === 0) return undefined;
  const dir = delta.__mul__(1 / length);
  const p3 = s.kernel.tryService(PHYSICS3D_SERVICE);
  if (p3 !== undefined) {
    const hit = radius > 0
      ? p3.shapecast({ kind: 'sphere', radius }, from, Quat.IDENTITY, dir, length, filter)
      : p3.raycast(from, dir, length, filter);
    return hit === undefined ? undefined : { entity: hit.entity, point: hit.point, normal: hit.normal };
  }
  const p2 = s.kernel.tryService(PHYSICS2D_SERVICE);
  if (p2 !== undefined) {
    const hit = p2.raycast(from, dir, length, filter);
    if (hit !== undefined) return { entity: hit.entity, point: hit.point, normal: hit.normal };
    if (radius > 0) {
      const near = p2.overlapCircle(to, radius, filter)[0];
      if (near !== undefined) return { entity: near, point: to, normal: dir.__neg__() };
    }
    return undefined;
  }
  // No physics: the nearest Health entity along the path.
  let best: { entity: EntityId; t: number } | undefined;
  const reach = radius + BARE_HIT_RADIUS;
  for (const [id] of s.kernel.world.query([HEALTH])) {
    if (filter.ignore?.includes(id) === true) continue;
    const c = s.kernel.world.get(id)!.transform.worldPosition();
    const t = Math.max(0, Math.min(length, c.__sub__(from).dot(dir)));
    const closest = from.__add__(dir.__mul__(t));
    if (closest.distance_to(c) <= reach && (best === undefined || t < best.t)) best = { entity: id, t };
  }
  return best === undefined ? undefined : { entity: best.entity, point: from.__add__(dir.__mul__(best.t)), normal: dir.__neg__() };
}

export function retire(record: EntityRecord, p: Fields): void {
  p['active'] = false;
  p['velocity'] = Vec3.ZERO;
  p['target'] = null;
  p['hits'] = [];
  record.visible = false;
}

/** Through the target's Health: the one damage pipeline. */
function damage(s: CombatState, projectile: EntityId, p: Fields, target: EntityId, at: Vec3): void {
  const amount = p['damage'] as number;
  if (amount <= 0) return;
  if (s.kernel.world.get(target)?.components.get(HEALTH) === undefined) return;
  const kind = idOf(p['damage_kind']);
  s.hit(target, {
    amount,
    source: p['source'] ?? wrap(s, projectile),
    kind: kind === null ? null : s.host.tag(kind),
    point: at,
    ignoresArmor: false,
    lethal: true,
  });
}

/** Entities a projectile from `source` passes through: everyone on its Side (not `source`, already ignored). */
function allies(s: CombatState, source: EntityId | undefined, self: EntityId): EntityId[] {
  if (source === undefined) return [];
  const side = s.sideOf(source);
  if (side === undefined) return [];
  const out: EntityId[] = [];
  for (const [id] of s.kernel.world.query([SIDE])) {
    if (id !== source && id !== self && s.sideOf(id) === side) out.push(id);
  }
  return out;
}

export function stepProjectiles(s: CombatState, dt: number): void {
  const kernel = s.kernel;
  const threeD = kernel.tryService(PHYSICS3D_SERVICE) !== undefined;
  const gravityOf = (p: Fields): number => {
    const g = p['gravity'];
    if (typeof g === 'number') return g;
    return kernel.tryService(PHYSICS3D_SERVICE)?.gravity ?? kernel.tryService(PHYSICS2D_SERVICE)?.gravity ?? DEFAULT_GRAVITY;
  };
  for (const [id, p] of projectiles(s)) {
    if (p['active'] !== true) continue;
    const record = kernel.world.get(id)!;
    const age = (p['age'] as number) + dt;
    p['age'] = age;
    if (age >= (p['lifetime'] as number)) {
      kernel.emit(PROJECTILE_EVENTS.projectileExpired, { entity: wrap(s, id) });
      retire(record, p);
      continue;
    }
    let v = p['velocity'] as Vec3;
    const motion = p['motion'] as string;
    if (motion === 'ballistic') v = v.__add__(new Vec3(0, gravityOf(p) * dt, 0));
    else if (motion === 'homing') {
      const target = kernel.handles.unwrap(p['target']);
      const at = target === undefined ? undefined : kernel.world.get(target);
      if (at !== undefined && v.length() > 0) {
        const to = at.transform.worldPosition().__sub__(record.transform.worldPosition());
        if (to.length() > 1e-6) v = turnTowards(v, to, (p['turn_rate'] as number) * dt);
      }
    }
    p['velocity'] = v;
    const from = record.transform.worldPosition();
    const to = from.__add__(v.__mul__(dt));
    const ignore: EntityId[] = [id];
    const source = kernel.handles.unwrap(p['source']);
    if (source !== undefined) ignore.push(source);
    for (const h of listOf<unknown>(p['hits'])) {
      const x = kernel.handles.unwrap(h);
      if (x !== undefined) ignore.push(x);
    }
    if (p['friendly_fire'] !== true) ignore.push(...allies(s, source, id));
    const layers = listOf<string>(p['layers']);
    const hit = sweep(s, from, to, p['radius'] as number, { ignore, ...(layers.length > 0 && { layers }) });
    if (hit === undefined) {
      record.transform.setWorldPosition(to);
      face(record, v, threeD);
      continue;
    }
    record.transform.setWorldPosition(hit.point);
    kernel.emit(PROJECTILE_EVENTS.projectileHit, {
      entity: wrap(s, id), target: hit.entity === undefined ? null : wrap(s, hit.entity), point: hit.point, normal: hit.normal,
    });
    if (hit.entity !== undefined) damage(s, id, p, hit.entity, hit.point);
    const hits = listOf<unknown>(p['hits']);
    if (hit.entity !== undefined && hits.length < (p['pierce'] as number) && kernel.world.isAlive(id)) {
      p['hits'] = [...hits, wrap(s, hit.entity)];
      continue;
    }
    if (kernel.world.isAlive(id)) retire(record, p);
  }
}

export interface FireInit {
  readonly at: Vec3;
  /** Exact launch velocity; else `direction` (unit) × `speed` (null: the projectile's own). */
  readonly velocity: Vec3 | null;
  readonly direction: Vec3 | null;
  readonly speed: number | null;
  readonly source: EntityId | null;
  readonly target: EntityId | null;
}

/** Launch `prefab`'s projectile: a retired one of the same prefab when there is one, else a new spawn. */
export function fire(s: CombatState, prefab: string, init: FireInit): EntityRecord {
  const kernel = s.kernel;
  let record: EntityRecord | undefined;
  for (const [id, p] of projectiles(s)) {
    const r = kernel.world.get(id)!;
    if (p['active'] === false && r.prefab === prefab && r.parent === null) {
      record = r;
      break;
    }
  }
  if (record === undefined) record = kernel.spawn(prefab, { at: [init.at.x, init.at.y, init.at.z] });
  const p = record.components.get(PROJECTILE);
  if (p === undefined) {
    fail('PP7407', `fire("${prefab}"): prefab "${prefab}" has no "${PROJECTILE}" component`, { fix: `Add "${PROJECTILE}" to its prefab.` });
  }
  record.transform.setWorldPosition(init.at);
  record.visible = true;
  p['active'] = true;
  p['age'] = 0;
  const velocity = init.velocity ?? init.direction!.__mul__(init.speed ?? (p['speed'] as number));
  p['velocity'] = velocity;
  p['source'] = wrap(s, init.source);
  p['target'] = wrap(s, init.target);
  p['hits'] = [];
  face(record, velocity, kernel.tryService(PHYSICS3D_SERVICE) !== undefined);
  return record;
}

/** `ctx.combat.fire(prefab, *, at, direction=None, velocity=None, speed=None, source=None, target=None) -> Entity`. */
export function fireCall(s: CombatState, args: readonly unknown[]): unknown {
  const a = bind('fire', args, ['prefab'], ['at', 'direction', 'velocity', 'speed', 'source', 'target'], ['prefab', 'at']);
  const prefab = idOf(a['prefab']);
  if (prefab === null) fail('PP7405','fire() prefab must be a prefab (Prefabs.<id>)');
  let velocity: Vec3 | null = null;
  let direction: Vec3 | null = null;
  if (a['velocity'] !== undefined && a['velocity'] !== null) {
    if (a['direction'] !== undefined && a['direction'] !== null) fail('PP7406', 'fire() takes direction= or velocity=, not both');
    velocity = point(a['velocity'], 'fire() velocity');
  } else {
    if (a['direction'] === undefined || a['direction'] === null) {
      fail('PP7406', 'fire() needs direction= or velocity=', { fix: 'ctx.combat.fire(Prefabs.arrow, at=muzzle, direction=forward)' });
    }
    direction = point(a['direction'], 'fire() direction');
    if (direction.length() === 0) fail('PP7406', 'fire() direction is zero');
    direction = direction.normalized();
  }
  const record = fire(s, prefab, {
    at: point(a['at'], 'fire() at'),
    velocity,
    direction,
    speed: a['speed'] === undefined || a['speed'] === null ? null : nonNegative(a['speed'], 'fire() speed'),
    source: optionalId(s, a['source'], 'fire() source'),
    target: optionalId(s, a['target'], 'fire() target'),
  });
  return wrap(s, record.id);
}

export function projectileComponent(state: () => CombatState): ComponentDef {
  const methods = {
    retire(this: Fields, ...args: unknown[]): null {
      bind('retire', args, []);
      const record = state().kernel.world.get(componentEntity(this));
      if (record !== undefined && this['active'] === true) retire(record, this);
      return null;
    },
  };
  Object.defineProperty(methods, 'entity', {
    get(this: Fields): unknown { return state().kernel.handles.wrap(componentEntity(this)); },
    enumerable: false,
  });
  return { id: PROJECTILE, schema: PROJECTILE_SCHEMA, methods };
}
