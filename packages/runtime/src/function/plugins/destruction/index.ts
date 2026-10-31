/**
 * destruction — breakable objects on physics3d (sdk/parallax/destruction.pyi).
 *
 * A `Breakable` entity has `health`. It loses health from
 *
 *   - impacts: contacts pressing at least `impact_threshold` newtons (physics3d's contact
 *     force watch) deal `force / impact_threshold` damage — an impact exactly at the
 *     threshold deals 1, twice as hard deals 2;
 *   - code: `breakable.damage(amount, source=, point=)`, `ctx.destruction.blast(...)`.
 *
 * Each hit raises `breakable_damaged`; at 0 health it breaks: `breakable_broken` is raised,
 * its `pieces` are spawned, and it stops colliding and is hidden at once — it is destroyed at
 * the next fixed step, so its own behaviors still hear `breakable_broken`. Pieces are either
 * a pre-fractured prefab (spawned once at the entity's pose, `fracture=0`) or, with
 * `fracture=N`, N copies of a unit-cube piece prefab scaled to fill the entity's box collider
 * (a deterministic recursive split, so a replay breaks the same way). The pieces' dynamic
 * bodies start with the body's velocity plus `scatter` m/s outward from where it broke.
 *
 * Everything this plugin keeps is in components; it has no snapshot of its own. It needs
 * physics3d (looked up at use).
 */

import { fail, hashNumbers, SeededRandom, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, EventDef, Fields, Kernel, KernelPlugin, Schema } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE } from '../../services/index.js';

export const BREAKABLE = 'breakable';
const WATCH = 'destruction';

export const DESTRUCTION_EVENTS = {
  damaged: { id: 'breakable_damaged', target: 'entity' },
  broken: { id: 'breakable_broken', target: 'entity' },
} as const satisfies Record<string, EventDef>;

export const BREAKABLE_SCHEMA: Schema = {
  health: t.number({ default: 1 }),
  /** Newtons of contact force that deal 1 damage; None: impacts don't damage it. */
  impact_threshold: { type: { kind: 'optional', of: { kind: 'number' } }, default: null, min: 0 },
  /** The prefab spawned when it breaks (pre-fractured, or the unit piece with `fracture`); None: it just vanishes. */
  pieces: { type: { kind: 'optional', of: { kind: 'ref', to: 'prefab' } }, default: null },
  /** 0: spawn `pieces` once at its pose; N: N unit pieces filling its box collider. */
  fracture: t.int({ default: 0, min: 0 }),
  /** m/s pieces fly apart at, away from where it broke. */
  scatter: t.number({ default: 2, min: 0 }),
};

export interface DestructionNamespace {
  /** blast(center, radius, damage, *, strength=0, source=None): damage breakables in range (falling off linearly), push bodies. */
  blast(...args: unknown[]): unknown[];
}

function keywords(args: readonly unknown[], name: string, allowed: readonly string[]): { p: unknown[]; k: Readonly<Record<string, unknown>> } {
  const last = args[args.length - 1];
  let k: Readonly<Record<string, unknown>> | undefined;
  if (typeof last === 'object' && last !== null && !(last instanceof Vec3) && !Array.isArray(last)) {
    const values = (last as { values?: unknown }).values;
    if (Object.getPrototypeOf(last) === Object.prototype) k = last as Record<string, unknown>;
    else if (typeof values === 'object' && values !== null) k = values as Record<string, unknown>;
  }
  if (k === undefined) return { p: [...args], k: {} };
  for (const key of Object.keys(k)) {
    if (!allowed.includes(key)) fail('PP3030', `${name}() got an unexpected keyword argument "${key}"`, { fix: `Accepted: ${allowed.join(', ')}.` });
  }
  return { p: args.slice(0, -1), k };
}

function number(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3211', `${where} must be a finite number, got ${String(value)}`);
}

function point(value: unknown, where: string): Vec3 | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Vec3) return value;
  return fail('PP3211', `${where} must be a Vec3`, { fix: 'Pass vec3(x, y, z).' });
}

/** Split a box (half extents) into `count` boxes, always cutting the longest side somewhere in its middle 40%. */
export function fractureBox(half: Vec3, count: number, seed: number): Array<{ center: Vec3; size: Vec3 }> {
  const random = new SeededRandom(seed);
  let boxes = [{ min: half.__neg__(), max: half }];
  while (boxes.length < count) {
    // Cut the biggest box first: pieces end up of similar size.
    let index = 0;
    const volume = (b: { min: Vec3; max: Vec3 }): number => (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
    boxes.forEach((b, i) => { if (volume(b) > volume(boxes[index]!)) index = i; });
    const box = boxes[index]!;
    const size = box.max.__sub__(box.min);
    const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
    const cut = box.min[axis] + size[axis] * (0.3 + 0.4 * random.next());
    const low = { min: box.min, max: axis === 'x' ? box.max.with_x(cut) : axis === 'y' ? box.max.with_y(cut) : box.max.with_z(cut) };
    const high = { min: axis === 'x' ? box.min.with_x(cut) : axis === 'y' ? box.min.with_y(cut) : box.min.with_z(cut), max: box.max };
    boxes = [...boxes.slice(0, index), low, high, ...boxes.slice(index + 1)];
  }
  return boxes.map((b) => ({ center: b.min.__add__(b.max).__mul__(0.5), size: b.max.__sub__(b.min) }));
}

class Destruction {
  readonly #kernel: Kernel;
  readonly #breakables = new Set<EntityId>();
  /** Breakables whose impact watch is registered, and at what threshold. */
  readonly #watched = new Map<EntityId, number>();
  /** Broken this step: destroyed at the next one. */
  readonly #shattered = new Set<EntityId>();

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  track(record: EntityRecord): void {
    if (record.components.has(BREAKABLE)) this.#breakables.add(record.id);
    else this.#breakables.delete(record.id);
  }

  forget(record: EntityRecord): void {
    this.#breakables.delete(record.id);
    this.#watched.delete(record.id);
  }

  rebuild(): void {
    this.#breakables.clear();
    this.#watched.clear();
    this.#shattered.clear();
    for (const record of this.#kernel.world.live()) {
      this.track(record);
      if ((record.components.get(BREAKABLE)?.['health'] as number | undefined ?? 1) <= 0) this.#shattered.add(record.id);
    }
  }

  /** Each fixed step: destroy last step's broken, keep impact watches in line, take last step's impacts. */
  step(): void {
    for (const id of this.#shattered) if (this.#kernel.world.isAlive(id)) this.#kernel.destroy(id);
    this.#shattered.clear();
    const physics = this.#kernel.service(PHYSICS3D_SERVICE);
    for (const id of this.#breakables) {
      const threshold = this.#kernel.world.get(id)?.components.get(BREAKABLE)?.['impact_threshold'] as number | null | undefined;
      const want = threshold ?? undefined;
      if (this.#watched.get(id) !== want) {
        physics.watchContactForces(id, WATCH, want);
        if (want === undefined) this.#watched.delete(id);
        else this.#watched.set(id, want);
      }
    }
    for (const contact of physics.contactForces()) {
      const fields = this.#kernel.world.get(contact.entity)?.components.get(BREAKABLE);
      const threshold = fields?.['impact_threshold'] as number | null | undefined;
      if (fields === undefined || threshold === null || threshold === undefined || contact.force < threshold || !this.#kernel.world.isAlive(contact.entity)) continue;
      const damage = threshold === 0 ? Infinity : contact.force / threshold;
      this.damage(contact.entity, damage, contact.other, contact.point, contact.force);
    }
  }

  damage(entity: EntityId, amount: number, source: EntityId | undefined, at: Vec3 | undefined, force: number): void {
    const record = this.#kernel.world.require(entity);
    const fields = record.components.get(BREAKABLE);
    if (fields === undefined) fail('PP3211', `entity ${record.placedId ?? record.prefab ?? record.id} has no breakable component`);
    if (!record.alive || this.#shattered.has(entity)) return;
    if (!(amount >= 0)) fail('PP3211', `damage(${amount}): the amount can't be negative`);
    const handles = this.#kernel.handles;
    const by = source === undefined || !this.#kernel.world.isAlive(source) ? null : handles.wrap(source);
    const where = at ?? record.transform.worldPosition();
    fields['health'] = Math.max(0, (fields['health'] as number) - amount);
    this.#kernel.emit(DESTRUCTION_EVENTS.damaged, { entity: handles.wrap(entity), amount, source: by, point: where, force });
    if ((fields['health'] as number) === 0) this.shatter(record, fields, where, by, force);
  }

  shatter(record: EntityRecord, fields: Fields, at: Vec3, by: unknown, force: number): void {
    const kernel = this.#kernel;
    const physics = kernel.service(PHYSICS3D_SERVICE);
    fields['health'] = 0;
    kernel.emit(DESTRUCTION_EVENTS.broken, { entity: kernel.handles.wrap(record.id), source: by, point: at, force });
    const prefab = fields['pieces'] as string | null;
    if (prefab !== null) {
      const t = record.transform;
      const position = t.worldPosition();
      const rotation = t.worldRotation();
      const euler = rotation.to_euler();
      const velocity = physics.body(record.id)?.velocity ?? Vec3.ZERO;
      const scatter = fields['scatter'] as number;
      const count = fields['fracture'] as number;
      const place = (center: Vec3, scale: Vec3 | undefined): void => {
        // Spawned in place, turned as the breakable was (children and their bodies with it).
        const spawned = kernel.spawn(prefab, {
          at: [center.x, center.y, center.z], rotation: [euler.x, euler.y, euler.z],
          ...(scale !== undefined && { scale: [scale.x, scale.y, scale.z] }),
        }, {});
        for (const piece of [spawned, ...this.#descendants(spawned)]) {
          const body = physics.body(piece.id);
          if (body === undefined || body.kind !== 'dynamic') continue;
          const out = piece.transform.worldPosition().__sub__(at);
          const length = out.length();
          const away = length === 0 ? new Vec3(0, 1, 0) : out.__mul__(1 / length);
          physics.setVelocity(piece.id, velocity.__add__(away.__mul__(scatter)));
        }
      };
      if (count === 0) {
        place(position, undefined);
      } else {
        const bounds = physics.bounds(record.id);
        if (bounds === undefined) {
          fail('PP3212', `entity ${record.placedId ?? record.prefab ?? record.id} breakable fractures into ${count} pieces, but it has no collider to fill`, { fix: 'Give it a box collider, or set fracture=0 with a pre-fractured pieces prefab.' });
        }
        for (const chunk of fractureBox(bounds.halfExtents, count, hashNumbers(record.id, kernel.time.frame))) {
          place(position.__add__(rotation.rotate(bounds.center.__add__(chunk.center))), chunk.size);
        }
      }
    }
    // Gone from the world now; destroyed next step, once its behaviors heard `breakable_broken`.
    if (record.components.has('collider')) kernel.removeComponent(record.id, 'collider');
    if (record.components.has('rigidbody')) kernel.removeComponent(record.id, 'rigidbody');
    record.visible = false;
    this.#shattered.add(record.id);
  }

  #descendants(record: EntityRecord): EntityRecord[] {
    const out: EntityRecord[] = [];
    for (const child of record.children) {
      const c = this.#kernel.world.get(child);
      if (c !== undefined) out.push(c, ...this.#descendants(c));
    }
    return out;
  }

  blast(center: Vec3, radius: number, damage: number, strength: number, source: EntityId | undefined): EntityId[] {
    if (!(radius > 0)) fail('PP3211', `blast radius must be above 0, got ${radius}`);
    const physics = this.#kernel.service(PHYSICS3D_SERVICE);
    const inside = physics.overlapSphere(center, radius);
    if (strength !== 0) physics.explode(center, radius, strength);
    const hit: EntityId[] = [];
    for (const id of inside) {
      const record = this.#kernel.world.get(id);
      if (record === undefined || !record.components.has(BREAKABLE)) continue;
      const d = record.transform.worldPosition().distance_to(center);
      hit.push(id);
      this.damage(id, damage * Math.max(0, 1 - d / radius), source, record.transform.worldPosition(), 0);
    }
    return hit;
  }
}

export function destruction(): KernelPlugin {
  let state: Destruction | undefined;
  let installed: Kernel | undefined;
  const current = (): Destruction => {
    if (state === undefined) fail('PP9200', 'destruction is used before its kernel was built');
    return state;
  };
  const handleOf = (value: unknown, where: string): EntityId | undefined => {
    if (value === undefined || value === null) return undefined;
    const id = installed!.handles.unwrap(value);
    if (id === undefined) fail('PP3211', `${where} must be an entity`);
    return id;
  };
  const methods = {
    damage(this: Fields, ...args: unknown[]): void {
      const { p, k } = keywords(args, 'damage', ['amount', 'source', 'point']);
      current().damage(componentEntity(this), number(p[0] ?? k['amount'], 'damage amount'), handleOf(k['source'], 'damage(source=)'),
        point(k['point'], 'damage(point=)'), 0);
    },
    shatter(this: Fields, ...args: unknown[]): void {
      const { k } = keywords(args, 'shatter', ['point', 'source']);
      const entity = componentEntity(this);
      const record = installed!.world.require(entity);
      if (!record.alive || (this['health'] as number) <= 0) return;
      const source = handleOf(k['source'], 'shatter(source=)');
      current().shatter(record, this, point(k['point'], 'shatter(point=)') ?? record.transform.worldPosition(),
        source === undefined ? null : installed!.handles.wrap(source), 0);
    },
  };
  const components: ComponentDef[] = [
    { id: BREAKABLE, schema: BREAKABLE_SCHEMA, methods },
  ];
  return {
    id: 'destruction',
    components,
    events: Object.values(DESTRUCTION_EVENTS),
    install(kernel) {
      if (installed !== undefined) fail('PP9201', 'This destruction plugin is already installed in another kernel', { fix: 'Call destruction() once per kernel.' });
      installed = kernel;
      const created = new Destruction(kernel);
      state = created;
      kernel.observeEntities({
        added: (records) => { for (const r of records) created.track(r); },
        removed: (records) => { for (const r of records) created.forget(r); },
        changed: (record) => created.track(record),
      });
      kernel.addHook('physics', () => created.step());
    },
    // Breakable state is in components; watches are re-registered from them.
    snapshot: () => null,
    restore: () => current().rebuild(),
    namespace: {
      name: 'destruction',
      create: (): DestructionNamespace => ({
        blast(...args) {
          const { p, k } = keywords(args, 'blast', ['center', 'radius', 'damage', 'strength', 'source']);
          const center = point(p[0] ?? k['center'], 'blast center');
          if (center === undefined) fail('PP3211', 'blast() needs a center');
          const ids = current().blast(center, number(p[1] ?? k['radius'], 'blast radius'), number(p[2] ?? k['damage'], 'blast damage'),
            number(k['strength'] ?? 0, 'blast(strength=)'), handleOf(k['source'], 'blast(source=)'));
          return ids.map((id) => installed!.handles.wrap(id));
        },
      }),
    },
  };
}
