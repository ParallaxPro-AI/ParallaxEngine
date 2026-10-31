/**
 * `ctx.physics` in 3D: questions about the world (PhysicsApi in sdk/parallax/physics.pyi).
 * Raycasts skip trigger colliders; overlaps include them. Layers are passed as `Layer`
 * handles (anything with a `name`) or plain names; an empty list means every layer.
 * The terrain is hit by raycasts as `RayHit.entity = None` (it is not an entity) and is never
 * in an overlap's entity list.
 */

import { fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { LayerTable } from './layers.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { rapier } from './rapier.js';
import { rapierShape } from './sim.js';
import type { Hit3d, Physics3dSim, QueryFilter } from './sim.js';
import { arg, entityId, finite, splitKeywords, vec3 } from './values.js';

/** What `ctx.physics.raycast` returns: the SDK's `parallax.physics.RayHit`. */
export interface Hit {
  readonly entity: unknown;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly distance: number;
}

/** Every method takes Python-style arguments: positional values, then optional keywords. */
export interface Physics3dNamespace {
  readonly gravity: number;
  /** raycast(origin, direction, max_distance=1000, *, layers=(), ignore=()) */
  raycast(...args: unknown[]): Hit | null;
  raycast_all(...args: unknown[]): Hit[];
  /** overlap(center, radius, *, layers=(), ignore=()) */
  overlap(...args: unknown[]): unknown[];
  /** overlap_box(center, size, *, layers=(), ignore=()): an axis-aligned box of full extent `size`. */
  overlap_box(...args: unknown[]): unknown[];
  /** explode(center, radius, strength): impulse `strength` N·s at the centre, falling off linearly. */
  explode(...args: unknown[]): unknown[];
  /** sphere_cast(origin, radius, direction, max_distance=1000, *, layers=(), ignore=()) */
  sphere_cast(...args: unknown[]): Hit | null;
  /** box_cast(origin, size, direction, max_distance=1000, *, rotation=None, layers=(), ignore=()) */
  box_cast(...args: unknown[]): Hit | null;
  /** capsule_cast(origin, radius, height, direction, max_distance=1000, *, layers=(), ignore=()) */
  capsule_cast(...args: unknown[]): Hit | null;
  /** sweep(entity, direction, distance, *, layers=(), ignore=()): the entity's own collider swept from where it is. */
  sweep(...args: unknown[]): Hit | null;
}

function list(value: unknown, where: string): readonly unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return fail('PP3153', `${where} must be a list`, { fix: 'Pass a list, e.g. layers=[Layers.enemy].' });
}

function layerName(layer: unknown, where: string): string {
  if (typeof layer === 'string') return layer;
  const name = (layer as { name?: unknown } | null)?.name;
  if (typeof name === 'string' && name !== '') return name;
  return fail('PP3152', `${where}: this layer has no name`, {
    fix: 'Pass a layer declared in the Layers class given to physics3d(layers=...), e.g. Layers.enemy.',
  });
}

export function physicsNamespace(sim: () => Physics3dSim, layers: LayerTable, gravity: number): Physics3dNamespace {
  const filter = (keywords: Readonly<Record<string, unknown>>, where: string): QueryFilter => ({
    layers: layers.mask(list(keywords['layers'], `${where} layers`).map((l) => layerName(l, where)), where),
    ignore: new Set<EntityId>(list(keywords['ignore'], `${where} ignore`).map((e) => entityId(sim().handles, e, `${where} ignore`))),
  });
  const direction = (value: unknown, where: string): Vec3 => {
    const d = vec3(value, `${where} direction`);
    if (d.length() === 0) fail('PP3158', `${where} direction is zero`, { fix: 'Pass a non-zero direction.' });
    return d.normalized();
  };
  const distance = (value: unknown, where: string): number => {
    const d = finite(value, where);
    if (d < 0) fail('PP3158', `${where} is ${d}; it can't be negative`);
    return d;
  };
  const present = (hit: Hit3d): Hit => ({ ...hit, entity: hit.entity === undefined ? null : sim().handles.wrap(hit.entity) });
  const RAY = ['origin', 'direction', 'max_distance', 'layers', 'ignore'];
  const ray = (name: string, args: unknown[]): [Vec3, Vec3, number, QueryFilter] => {
    const { positional: p, keywords: k } = splitKeywords(args, name, RAY);
    return [
      vec3(arg(p, k, 0, 'origin'), `${name} origin`),
      direction(arg(p, k, 1, 'direction'), name),
      distance(arg(p, k, 2, 'max_distance') ?? 1000, `${name} max_distance`),
      filter(k, name),
    ];
  };
  const wrap = (ids: EntityId[]): unknown[] => ids.map((id) => sim().handles.wrap(id));
  const cast = (shape: RAPIER.Shape, origin: Vec3, q: Quat, dir: Vec3, max: number, f: QueryFilter): Hit | null => {
    const hit = sim().shapecast(shape, origin, q, dir, max, f);
    return hit === undefined ? null : present(hit);
  };
  const rotation = (value: unknown, where: string): Quat => {
    if (value === undefined || value === null) return Quat.IDENTITY;
    if (value instanceof Quat) return value;
    if (value instanceof Vec3) return Quat.from_euler(value);
    return fail('PP3153', `${where}(rotation=) must be euler degrees (Vec3) or a Quat`, { fix: 'Pass rotation=vec3(pitch, yaw, roll).' });
  };

  return {
    get gravity(): number {
      return gravity;
    },
    raycast(...args) {
      const hit = sim().raycast(...ray('raycast', args));
      return hit === undefined ? null : present(hit);
    },
    raycast_all(...args) {
      return sim().raycastAll(...ray('raycast_all', args)).map(present);
    },
    overlap(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'overlap', ['center', 'radius', 'layers', 'ignore']);
      const shape = new (rapier().Ball)(distance(arg(p, k, 1, 'radius'), 'overlap radius'));
      return wrap(sim().overlap(vec3(arg(p, k, 0, 'center'), 'overlap center'), Quat.IDENTITY, shape, filter(k, 'overlap')));
    },
    overlap_box(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'overlap_box', ['center', 'size', 'layers', 'ignore']);
      const s = vec3(arg(p, k, 1, 'size'), 'overlap_box size');
      const shape = new (rapier().Cuboid)(distance(s.x, 'overlap_box size.x') / 2, distance(s.y, 'overlap_box size.y') / 2,
        distance(s.z, 'overlap_box size.z') / 2);
      return wrap(sim().overlap(vec3(arg(p, k, 0, 'center'), 'overlap_box center'), Quat.IDENTITY, shape, filter(k, 'overlap_box')));
    },
    explode(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'explode', ['center', 'radius', 'strength']);
      const c = vec3(arg(p, k, 0, 'center'), 'explode center');
      const r = distance(arg(p, k, 1, 'radius'), 'explode radius');
      const strength = finite(arg(p, k, 2, 'strength'), 'explode strength');
      const world = sim();
      const hit = world.overlap(c, Quat.IDENTITY, new (rapier().Ball)(r), { layers: 0, ignore: new Set() });
      world.explode(c, r, strength, hit);
      return wrap(hit);
    },
    sphere_cast(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'sphere_cast', ['origin', 'radius', 'direction', 'max_distance', 'layers', 'ignore']);
      const shape = rapierShape({ kind: 'sphere', radius: distance(arg(p, k, 1, 'radius'), 'sphere_cast radius') });
      return cast(shape, vec3(arg(p, k, 0, 'origin'), 'sphere_cast origin'), Quat.IDENTITY, direction(arg(p, k, 2, 'direction'), 'sphere_cast'),
        distance(arg(p, k, 3, 'max_distance') ?? 1000, 'sphere_cast max_distance'), filter(k, 'sphere_cast'));
    },
    box_cast(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'box_cast', ['origin', 'size', 'direction', 'max_distance', 'rotation', 'layers', 'ignore']);
      const size = vec3(arg(p, k, 1, 'size'), 'box_cast size');
      const shape = rapierShape({ kind: 'box', halfExtents: size.__mul__(0.5) });
      return cast(shape, vec3(arg(p, k, 0, 'origin'), 'box_cast origin'), rotation(k['rotation'], 'box_cast'), direction(arg(p, k, 2, 'direction'), 'box_cast'),
        distance(arg(p, k, 3, 'max_distance') ?? 1000, 'box_cast max_distance'), filter(k, 'box_cast'));
    },
    capsule_cast(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'capsule_cast', ['origin', 'radius', 'height', 'direction', 'max_distance', 'layers', 'ignore']);
      const shape = rapierShape({
        kind: 'capsule', radius: distance(arg(p, k, 1, 'radius'), 'capsule_cast radius'), height: distance(arg(p, k, 2, 'height'), 'capsule_cast height'),
      });
      return cast(shape, vec3(arg(p, k, 0, 'origin'), 'capsule_cast origin'), Quat.IDENTITY, direction(arg(p, k, 3, 'direction'), 'capsule_cast'),
        distance(arg(p, k, 4, 'max_distance') ?? 1000, 'capsule_cast max_distance'), filter(k, 'capsule_cast'));
    },
    sweep(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'sweep', ['entity', 'direction', 'distance', 'layers', 'ignore']);
      const id = entityId(sim().handles, arg(p, k, 0, 'entity'), 'sweep entity');
      const pose = sim().colliderPose(id);
      if (pose === undefined) {
        fail('PP3158', 'sweep() casts the entity\'s own collider, and this entity has none', { fix: 'Give it a collider, or use sphere_cast/box_cast/capsule_cast.' });
      }
      const hit = sim().shapecast(pose.shape, pose.position, pose.rotation, direction(arg(p, k, 1, 'direction'), 'sweep'),
        distance(arg(p, k, 2, 'distance'), 'sweep distance'), filter(k, 'sweep'), id);
      return hit === undefined ? null : present(hit);
    },
  };
}
