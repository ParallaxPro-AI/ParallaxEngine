/**
 * `Entity` and `Transform`: facades over a kernel entity id and its `TransformNode`.
 * An Entity is a generational handle — after `destroy()` it reports `alive == False`.
 * Until the phase ends it can still be read (a `Died` handler or an `end()` hook reads
 * where it was); changing it raises PP3002, and so does any use after teardown.
 */

import { fail, Quat, Vec2, Vec3, wrapAngle } from '../core/index.js';
import type { EntityId } from '../core/index.js';
import type { EntityRecord, FieldType, ModifierInit, TransformNode } from '../function/kernel/index.js';
import { bindArgs } from './kwargs.js';
import { attachToSocket, leaveSocket } from './model_sockets.js';
import { startTween } from './time.js';
import type { Handle } from './time.js';
import { PrefabRef, Tag } from './types.js';
import type { GameRuntime } from './runtime.js';

/** A component class or engine component handle (`__component_id__`, contract C3). */
export function componentIdOf(kind: unknown, where: string): string {
  const id = typeof kind === 'function' ? (kind as { __component_id__?: unknown }).__component_id__ : undefined;
  if (typeof id !== 'string') {
    const name = typeof kind === 'function' ? kind.name : String(kind);
    fail('PP3003', `${where}: ${name} is not a component`, { fix: 'Pass a @component class or an engine component (Health, Rigidbody…).' });
  }
  return id;
}

/** `ModifierInit` from `modify(..., multiply=, add=, key=, seconds=, stack=)` keywords. */
export function modifierInit(name: string, args: readonly unknown[]): { kind: unknown; field: string; init: ModifierInit } {
  const a = bindArgs(name, args, {
    positional: ['kind', 'field'], keyword: ['multiply', 'add', 'key', 'seconds', 'stack'], required: ['kind', 'field'],
  }).args;
  const init: ModifierInit = {
    ...(a['multiply'] !== undefined && { multiply: a['multiply'] as number }),
    ...(a['add'] !== undefined && { add: a['add'] as number }),
    ...(a['key'] !== undefined && a['key'] !== null && { key: a['key'] as string }),
    ...(a['seconds'] !== undefined && a['seconds'] !== null && { seconds: a['seconds'] as number }),
    ...(a['stack'] === true && { stack: true }),
  };
  return { kind: a['kind'], field: a['field'] as string, init };
}

function readable(rt: GameRuntime, id: EntityId): EntityRecord {
  return rt.kernel.world.peek(id) ?? rt.kernel.world.require(id);
}

export class Entity {
  static readonly __field_type__: FieldType = { kind: 'entity' };
  readonly #rt: GameRuntime;
  readonly #id: EntityId;
  #transform: Transform | undefined;

  constructor(rt: GameRuntime, id: EntityId) {
    this.#rt = rt;
    this.#id = id;
  }

  /** The kernel id (engine-facing; not part of the Python API). */
  get __entity_id__(): EntityId { return this.#id; }

  get #record(): EntityRecord { return this.#rt.kernel.world.require(this.#id); }

  /** Live, or destroyed this phase and not yet torn down. */
  get #readable(): EntityRecord { return readable(this.#rt, this.#id); }

  get alive(): boolean { return this.#rt.kernel.world.isAlive(this.#id); }

  get name(): string {
    const record = this.#readable;
    return record.name ?? record.childName ?? record.placedId ?? record.prefab ?? 'entity';
  }

  get prefab(): PrefabRef | null {
    const prefab = this.#readable.prefab;
    return prefab === undefined ? null : new PrefabRef(prefab);
  }

  get transform(): Transform {
    this.#readable;
    this.#transform ??= new Transform(this.#rt, this.#id);
    return this.#transform;
  }

  get parent(): Entity | null {
    const parent = this.#readable.parent;
    return parent === null ? null : this.#rt.wrap(parent);
  }

  get children(): Entity[] {
    return this.#readable.children.filter((id) => this.#rt.kernel.world.isAlive(id)).map((id) => this.#rt.wrap(id));
  }

  /** The player who controls this entity (kernel `EntityRecord.owner` is the seat index). */
  get owner(): unknown {
    const seat = this.#readable.owner;
    return seat === undefined ? null : this.#rt.ctx.players.find((p) => p.index === seat) ?? null;
  }

  get visible(): boolean { return this.#readable.visible; }
  set visible(value: boolean) { this.#record.visible = value; }

  get(kind: unknown): object {
    const id = componentIdOf(kind, 'get');
    const record = this.#readable;
    const fields = record.components.get(id);
    if (fields === undefined) {
      const of = record.prefab === undefined ? 'This entity' : `This "${record.prefab}" entity`;
      fail('PP3001', `${of} has no ${(kind as { name: string }).name} ("${id}") component`, {
        fix: record.prefab === undefined
          ? `Add it with entity.add(...), or use try_get to handle its absence.`
          : `Add "${id}" to prefabs/${record.prefab}.prefab.json, or use try_get to handle its absence.`,
      });
    }
    return this.#rt.presentComponent(id, fields);
  }

  try_get(kind: unknown): object | null {
    const id = componentIdOf(kind, 'try_get');
    const fields = this.#readable.components.get(id);
    return fields === undefined ? null : this.#rt.presentComponent(id, fields);
  }

  has(kind: unknown): boolean {
    const record = this.#readable;
    if (kind instanceof Tag) return record.tags.has(kind.id);
    return record.components.has(componentIdOf(kind, 'has'));
  }

  /**
   * Attach a component instance. The fields passed to its constructor merge into a
   * component of the same type the entity already has (as `spawn(components=)` merges over
   * the prefab's); the rest keep their values. Returns the entity's component.
   */
  add(component: unknown): object {
    const id = componentIdOf((component as { constructor?: unknown } | null)?.constructor, 'add');
    this.#record;
    const fields = this.#rt.kernel.mergeComponent(this.#id, id, this.#rt.componentValues(id, component as object, 'given'));
    return this.#rt.presentComponent(id, fields);
  }

  remove(kind: unknown): void {
    if (kind instanceof Tag) { this.untag(kind); return; }
    this.#rt.kernel.removeComponent(this.#id, componentIdOf(kind, 'remove'));
  }

  tag(t: unknown): void {
    if (!(t instanceof Tag)) fail('PP3004', `tag() takes a Tag, got ${String(t)}`);
    this.#record.tags.add(t.id);
  }

  untag(t: unknown): void {
    if (!(t instanceof Tag)) fail('PP3004', `untag() takes a Tag, got ${String(t)}`);
    this.#record.tags.delete(t.id);
  }

  modify(...args: unknown[]): void {
    const { kind, field, init } = modifierInit('modify', args);
    if (kind === Transform) {
      fail('PP3005', 'Transform.scale modifiers are not available yet', { fix: 'Assign transform.scale, or tween it with scale_to().' });
    }
    this.#rt.kernel.modify(this.#id, componentIdOf(kind, 'modify'), field, init);
  }

  unmodify(key: string): void { this.#rt.kernel.unmodify(this.#id, key); }

  base(kind: unknown, field: string): unknown {
    return this.#rt.kernel.base(this.#id, componentIdOf(kind, 'base'), field);
  }

  child(name: string): Entity {
    const record = this.#readable;
    for (const id of record.children) {
      const child = this.#rt.kernel.world.get(id);
      if (child?.childName === name) return this.#rt.wrap(id);
    }
    const names = record.children.map((id) => this.#rt.kernel.world.get(id)?.childName).filter((n) => n !== undefined);
    return fail('PP3012', `This entity has no child named "${name}"`, {
      fix: names.length > 0 ? `Children: ${names.join(', ')}.` : 'Give the child a "name" in the prefab\'s "children".',
    });
  }

  attach(...args: unknown[]): void {
    const a = bindArgs('attach', args, { positional: ['child'], keyword: ['socket', 'keep_world'], required: ['child'] }).args;
    const child = a['child'];
    if (!(child instanceof Entity)) fail('PP3004', 'attach() takes an Entity');
    const world = this.#rt.kernel.world;
    const childRecord = world.require(child.#id);
    const parent = this.#record;
    for (let p: EntityRecord | undefined = parent; p !== undefined; p = p.parent === null ? undefined : world.get(p.parent)) {
      if (p === childRecord) fail('PP3006', 'attach() would make an entity its own ancestor');
    }
    if (a['socket'] !== undefined && a['socket'] !== null) {
      attachToSocket(this.#rt.kernel, parent, childRecord, a['socket'], a['keep_world']);
      return;
    }
    leaveSocket(this.#rt.kernel, childRecord);
    const node = childRecord.transform;
    const position = node.worldPosition();
    const rotation = node.worldRotation();
    world.attach(childRecord, parent);
    if (a['keep_world'] === true) {
      node.setWorldPosition(position);
      node.rotation = parent.transform.worldRotation().inverse().__mul__(rotation);
    }
  }

  /** Unparent, keeping the world position and rotation. */
  detach(): void {
    const record = this.#record;
    leaveSocket(this.#rt.kernel, record);
    const node = record.transform;
    const position = node.worldPosition();
    const rotation = node.worldRotation();
    this.#rt.kernel.world.detach(record);
    node.position = position;
    node.rotation = rotation;
  }

  destroy(...args: unknown[]): void {
    const after = (bindArgs('destroy', args, { keyword: ['after'] }).args['after'] ?? 0) as number;
    if (!this.alive) return;
    if (after > 0) {
      this.#rt.kernel.after({ kind: 'entity', id: this.#id }, after, () => this.#rt.kernel.destroy(this.#id));
      return;
    }
    this.#rt.kernel.destroy(this.#id);
  }

  __eq__(other: unknown): boolean { return other instanceof Entity && other.#id === this.#id; }
  __hash__(): number { return this.#id; }
  toString(): string { return `Entity(${this.alive ? this.name : 'destroyed'})`; }
}

/** Quaternion with the given orthonormal basis as its x, y and z axes. */
function basisQuat(x: Vec3, y: Vec3, z: Vec3): Quat {
  const trace = x.x + y.y + z.z;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return new Quat((y.z - z.y) / s, (z.x - x.z) / s, (x.y - y.x) / s, s / 4);
  }
  if (x.x > y.y && x.x > z.z) {
    const s = Math.sqrt(1 + x.x - y.y - z.z) * 2;
    return new Quat(s / 4, (y.x + x.y) / s, (z.x + x.z) / s, (y.z - z.y) / s);
  }
  if (y.y > z.z) {
    const s = Math.sqrt(1 + y.y - x.x - z.z) * 2;
    return new Quat((y.x + x.y) / s, s / 4, (z.y + y.z) / s, (z.x - x.z) / s);
  }
  const s = Math.sqrt(1 + z.z - x.x - y.y) * 2;
  return new Quat((z.x + x.z) / s, (z.y + y.z) / s, s / 4, (x.y - y.x) / s);
}

function toVec3(value: unknown, keepZ: number, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  if (value instanceof Vec2) return new Vec3(value.x, value.y, keepZ);
  return fail('PP3007', `${where} must be a Vec3 or Vec2, got ${String(value)}`);
}

function toScale(value: unknown, where: string): Vec3 {
  if (typeof value === 'number') return new Vec3(value, value, value);
  if (value instanceof Vec3) return value;
  return fail('PP3007', `${where} must be a float or a Vec3, got ${String(value)}`);
}

export class Transform {
  readonly #rt: GameRuntime;
  readonly #id: EntityId;

  constructor(rt: GameRuntime, id: EntityId) {
    this.#rt = rt;
    this.#id = id;
  }

  /** For reading: also a destroyed entity's, until teardown. */
  get #node(): TransformNode { return readable(this.#rt, this.#id).transform; }
  /** For changing: live entities only. */
  get #liveNode(): TransformNode { return this.#rt.kernel.world.require(this.#id).transform; }

  /** World position. Assigning a Vec2 keeps z (2D draw order). */
  get position(): Vec3 { return this.#node.worldPosition(); }
  set position(value: Vec3 | Vec2) {
    const node = this.#liveNode;
    node.setWorldPosition(toVec3(value, node.worldPosition().z, 'transform.position'));
  }

  get local_position(): Vec3 { return this.#node.position; }
  set local_position(value: Vec3 | Vec2) {
    const node = this.#liveNode;
    node.position = toVec3(value, node.position.z, 'transform.local_position');
  }

  get rotation(): Quat { return this.#node.worldRotation(); }
  set rotation(value: Quat) {
    if (!(value instanceof Quat)) fail('PP3007', 'transform.rotation must be a Quat');
    const node = this.#liveNode;
    node.rotation = node.parent === null ? value : node.parent.worldRotation().inverse().__mul__(value);
  }

  get euler(): Vec3 { return this.rotation.to_euler(); }
  set euler(value: Vec3) { this.rotation = Quat.from_euler(toVec3(value, 0, 'transform.euler')); }

  get local_euler(): Vec3 { return this.#node.rotation.to_euler(); }
  set local_euler(value: Vec3) { this.#liveNode.rotation = Quat.from_euler(toVec3(value, 0, 'transform.local_euler')); }

  get angle(): number { return this.rotation.angle(); }
  set angle(value: number) { this.rotation = Quat.from_angle(value); }

  get local_angle(): number { return this.#node.rotation.angle(); }
  set local_angle(value: number) { this.#liveNode.rotation = Quat.from_angle(value); }

  /** Local scale. Assigning a float sets a uniform scale. */
  get scale(): Vec3 { return this.#node.scale; }
  set scale(value: Vec3 | number) { this.#liveNode.scale = toScale(value, 'transform.scale'); }

  get forward(): Vec3 { return this.rotation.rotate(Vec3.FORWARD); }
  get right(): Vec3 { return this.rotation.rotate(Vec3.RIGHT); }
  get up(): Vec3 { return this.rotation.rotate(Vec3.UP); }

  to_world(local_point: Vec3): Vec3 { return this.#node.toWorld(local_point); }
  to_local(world_point: Vec3): Vec3 { return this.#node.toLocal(world_point); }

  look_at(target: Vec3, up: Vec3 = Vec3.UP): void {
    const forward = target.__sub__(this.position);
    if (forward.length_squared() === 0) return;
    const z = forward.normalized();
    let x = up.cross(z);
    if (x.length_squared() < 1e-12) x = (Math.abs(z.y) < 0.99 ? Vec3.UP : Vec3.FORWARD).cross(z);
    x = x.normalized();
    this.rotation = basisQuat(x, z.cross(x), z);
  }

  /** Tween the position. Replaces any running move tween on this entity. */
  move_to(...args: unknown[]): Handle {
    const a = this.#tweenArgs('move_to', args, 'in_out_quad');
    const start = this.position;
    const end = toVec3(a.target, start.z, 'move_to target');
    return this.#tween('move', start, end, a.seconds, (v) => { this.position = v as Vec3; }, a.ease);
  }

  /** Tween to euler degrees (a Vec3), or a number: a yaw in 3D, an angle in 2D. */
  rotate_to(...args: unknown[]): Handle {
    const a = this.#tweenArgs('rotate_to', args, 'in_out_quad');
    if (typeof a.target === 'number') {
      if (this.#rt.mode === '3d') {
        // A 3D game: a number is a yaw (pitch and roll kept), the short way round.
        const from = this.euler;
        const end = new Vec3(from.x, from.y + wrapAngle(a.target - from.y), from.z);
        return this.#tween('rotate', from, end, a.seconds, (v) => { this.euler = v as Vec3; }, a.ease);
      }
      const start = this.angle;
      return this.#tween('rotate', start, a.target, a.seconds, (v) => { this.angle = v as number; }, a.ease);
    }
    const end = toVec3(a.target, 0, 'rotate_to target');
    return this.#tween('rotate', this.euler, end, a.seconds, (v) => { this.euler = v as Vec3; }, a.ease);
  }

  /** Tween the scale; a float is uniform. */
  scale_to(...args: unknown[]): Handle {
    const a = this.#tweenArgs('scale_to', args, 'out_back');
    return this.#tween('scale', this.scale, toScale(a.target, 'scale_to target'), a.seconds, (v) => { this.scale = v as Vec3; }, a.ease);
  }

  #tweenArgs(name: string, args: readonly unknown[], defaultEase: string): { target: unknown; seconds: number; ease: unknown } {
    const a = bindArgs(name, args, { positional: ['target', 'seconds'], keyword: ['ease'], required: ['target', 'seconds'] }).args;
    return { target: a['target'], seconds: a['seconds'] as number, ease: a['ease'] ?? defaultEase };
  }

  #tween(channel: string, start: unknown, end: unknown, seconds: number, apply: (v: unknown) => void, ease: unknown): Handle {
    this.#liveNode;
    const key = `${this.#id}:${channel}`;
    this.#rt.tweens.get(key)?.cancel();
    const handle = this.#rt.withOwner({ kind: 'entity', id: this.#id }, () => startTween(this.#rt, start, end, seconds, apply, ease));
    this.#rt.tweens.set(key, handle);
    return handle;
  }
}
