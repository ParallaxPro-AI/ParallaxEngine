/**
 * `ctx.physics`: questions about the world (PhysicsApi in sdk/parallax/physics.pyi).
 * Raycasts skip trigger colliders; overlaps include them. Layers are passed as `Layer`
 * handles (anything with a `name`) or plain names; an empty list means every layer.
 */

import { fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { LayerTable } from './layers.js';
import { rapier } from './rapier.js';
import type { Hit, Physics2dSim, QueryFilter } from './sim.js';
import { entityId, finite, splitKeywords, xy } from './values.js';
import type { XY } from './values.js';

/** Every method takes Python-style arguments: positional values, then optional keywords. */
export interface PhysicsNamespace {
  readonly gravity: number;
  /** raycast(origin, direction, max_distance=1000, *, layers=(), ignore=()) */
  raycast(...args: unknown[]): Hit | null;
  raycast_all(...args: unknown[]): Hit[];
  /** overlap(center, radius, *, layers=(), ignore=()) */
  overlap(...args: unknown[]): unknown[];
  /** overlap_box(center, size, *, layers=(), ignore=()) */
  overlap_box(...args: unknown[]): unknown[];
  /** explode(center, radius, strength) */
  explode(...args: unknown[]): unknown[];
  /** circle_cast(origin, radius, direction, max_distance=1000, *, layers=(), ignore=()) */
  circle_cast(...args: unknown[]): Hit | null;
  /** box_cast(origin, size, direction, max_distance=1000, *, rotation=None (degrees), layers=(), ignore=()) */
  box_cast(...args: unknown[]): Hit | null;
  /** capsule_cast(origin, radius, height, direction, max_distance=1000, *, layers=(), ignore=()) */
  capsule_cast(...args: unknown[]): Hit | null;
  /** sweep(entity, direction, distance, *, layers=(), ignore=()) */
  sweep(...args: unknown[]): Hit | null;
}

function list(value: unknown, where: string): readonly unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return fail('PP3300', `${where} must be a list`, { fix: 'Pass a list, e.g. layers=[Layers.enemy].' });
}

function layerName(layer: unknown, where: string): string {
  if (typeof layer === 'string') return layer;
  const name = (layer as { name?: unknown } | null)?.name;
  if (typeof name === 'string' && name !== '') return name;
  return fail('PP3104', `${where}: this layer has no name`, {
    fix: 'Pass a layer declared in the Layers class given to physics2d(layers=...), e.g. Layers.enemy.',
  });
}

export function physicsNamespace(sim: () => Physics2dSim, layers: LayerTable, gravity: number): PhysicsNamespace {
  const filter = (keywords: Readonly<Record<string, unknown>>, where: string): QueryFilter => ({
    layers: layers.mask(list(keywords['layers'], `${where} layers`).map((l) => layerName(l, where)), where),
    ignore: new Set<EntityId>(list(keywords['ignore'], `${where} ignore`).map((e) => entityId(sim().handles, e, `${where} ignore`))),
  });
  const direction = (value: unknown, where: string): XY => {
    const d = xy(value, `${where} direction`);
    const length = Math.hypot(d.x, d.y);
    if (length === 0) fail('PP3305', `${where} direction is zero`, { fix: 'Pass a non-zero direction.' });
    return { x: d.x / length, y: d.y / length };
  };
  const distance = (value: unknown, where: string): number => {
    const d = finite(value, where);
    if (d < 0) fail('PP3306', `${where} is ${d}; it can't be negative`);
    return d;
  };
  const positive = (value: unknown, where: string): number => {
    const d = finite(value, where);
    if (!(d > 0)) fail('PP3305', `${where} is ${d}; it must be above 0`);
    return d;
  };
  const RAY = ['origin', 'direction', 'max_distance', 'layers', 'ignore'];
  const ray = (name: string, args: unknown[]): [XY, XY, number, QueryFilter] => {
    const { positional: p, keywords: k } = splitKeywords(args, name, RAY);
    return [
      xy(p[0] ?? k['origin'], `${name} origin`),
      direction(p[1] ?? k['direction'], name),
      distance(p[2] ?? k['max_distance'] ?? 1000, `${name} max_distance`),
      filter(k, name),
    ];
  };

  return {
    get gravity(): number {
      return gravity;
    },
    raycast(...args) {
      return sim().raycast(...ray('raycast', args)) ?? null;
    },
    raycast_all(...args) {
      return sim().raycastAll(...ray('raycast_all', args));
    },
    overlap(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'overlap', ['center', 'radius', 'layers', 'ignore']);
      const shape = new (rapier().Ball)(distance(p[1] ?? k['radius'], 'overlap radius'));
      return sim().overlap(xy(p[0] ?? k['center'], 'overlap center'), shape, filter(k, 'overlap')).map((id) => sim().handles.wrap(id));
    },
    overlap_box(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'overlap_box', ['center', 'size', 'layers', 'ignore']);
      const s = xy(p[1] ?? k['size'], 'overlap_box size');
      const shape = new (rapier().Cuboid)(distance(s.x, 'overlap_box size.x') / 2, distance(s.y, 'overlap_box size.y') / 2);
      return sim().overlap(xy(p[0] ?? k['center'], 'overlap_box center'), shape, filter(k, 'overlap_box')).map((id) => sim().handles.wrap(id));
    },
    explode(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'explode', ['center', 'radius', 'strength']);
      const c = xy(p[0] ?? k['center'], 'explode center');
      const r = distance(p[1] ?? k['radius'], 'explode radius');
      const strength = finite(p[2] ?? k['strength'], 'explode strength');
      const world = sim();
      const hit = world.overlap(c, new (rapier().Ball)(r), { layers: 0, ignore: new Set() });
      world.explode(c, r, strength, hit);
      return hit.map((id) => sim().handles.wrap(id));
    },
    circle_cast(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'circle_cast', ['origin', 'radius', 'direction', 'max_distance', 'layers', 'ignore']);
      const shape = new (rapier().Ball)(positive(p[1] ?? k['radius'], 'circle_cast radius'));
      return sim().shapecast(shape, xy(p[0] ?? k['origin'], 'circle_cast origin'), 0, direction(p[2] ?? k['direction'], 'circle_cast'),
        distance(p[3] ?? k['max_distance'] ?? 1000, 'circle_cast max_distance'), filter(k, 'circle_cast')) ?? null;
    },
    box_cast(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'box_cast', ['origin', 'size', 'direction', 'max_distance', 'rotation', 'layers', 'ignore']);
      const size = xy(p[1] ?? k['size'], 'box_cast size');
      const shape = new (rapier().Cuboid)(positive(size.x, 'box_cast size.x') / 2, positive(size.y, 'box_cast size.y') / 2);
      const rotation = k['rotation'] === undefined || k['rotation'] === null ? 0 : finite(k['rotation'], 'box_cast(rotation=)') * Math.PI / 180;
      return sim().shapecast(shape, xy(p[0] ?? k['origin'], 'box_cast origin'), rotation, direction(p[2] ?? k['direction'], 'box_cast'),
        distance(p[3] ?? k['max_distance'] ?? 1000, 'box_cast max_distance'), filter(k, 'box_cast')) ?? null;
    },
    capsule_cast(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'capsule_cast', ['origin', 'radius', 'height', 'direction', 'max_distance', 'layers', 'ignore']);
      const radius = positive(p[1] ?? k['radius'], 'capsule_cast radius');
      const height = positive(p[2] ?? k['height'], 'capsule_cast height');
      if (height < 2 * radius) fail('PP3305', `capsule_cast: a capsule ${height} tall can't have radius ${radius}`, { fix: '`height` is the full height, caps included.' });
      const shape = new (rapier().Capsule)(height / 2 - radius, radius);
      return sim().shapecast(shape, xy(p[0] ?? k['origin'], 'capsule_cast origin'), 0, direction(p[3] ?? k['direction'], 'capsule_cast'),
        distance(p[4] ?? k['max_distance'] ?? 1000, 'capsule_cast max_distance'), filter(k, 'capsule_cast')) ?? null;
    },
    sweep(...args) {
      const { positional: p, keywords: k } = splitKeywords(args, 'sweep', ['entity', 'direction', 'distance', 'layers', 'ignore']);
      const id = entityId(sim().handles, p[0] ?? k['entity'], 'sweep entity');
      const pose = sim().colliderPose(id);
      if (pose === undefined) fail('PP3305', 'sweep() casts the entity\'s own collider, and this entity has none', { fix: 'Give it a collider, or use circle_cast/box_cast.' });
      return sim().shapecast(pose.shape, pose.position, pose.angle, direction(p[1] ?? k['direction'], 'sweep'),
        distance(p[2] ?? k['distance'], 'sweep distance'), filter(k, 'sweep'), id) ?? null;
    },
  };
}
