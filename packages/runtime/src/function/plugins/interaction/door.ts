/**
 * Doors (sdk/parallax/interaction.pyi `Door`). `wants_open` is the wanted state; `amount`
 * follows it over `seconds` (eased), driving the door's local transform from the shut pose
 * captured on first sight — `swing`: about +y through the local `hinge` point by
 * `open_value` degrees; `slide`: by the local `slide` offset — or, for `joint`, the
 * entity's Model joint (`Model.joints[joint]` = amount × open_value). A locked door opens
 * only for someone carrying its `key` item (used up with `consume_key`) or after
 * `unlock()` from code. `auto_close` shuts it that many seconds after it is fully open.
 * Using an Interactable door (`Interacted` on it) toggles it when `toggle_on_interact`.
 * Events: door_opened / door_closed when it gets there, door_blocked when a locked door
 * refuses someone.
 *
 * Keys are economy items: the key check goes through the holder's `inventory` component's
 * own methods (`count`, `remove`) by component id — this plugin never imports economy, and
 * without an Inventory (or the economy plugin) a locked door opens only from code.
 */

import { fail, Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, EventDef, Fields, FieldSpec, FieldType, Kernel, Schema } from '../../kernel/index.js';

export const DOOR = 'door';
/** The economy plugin's component that carries keys, read by id. */
const INVENTORY = 'inventory';

export const DOOR_EVENTS = {
  doorOpened: { id: 'door_opened', target: 'entity' },
  doorClosed: { id: 'door_closed', target: 'entity' },
  doorBlocked: { id: 'door_blocked', target: 'entity' },
} as const satisfies Record<string, EventDef>;

export const DOOR_MODES = ['swing', 'slide', 'joint'] as const;

const optional = (of: FieldType): FieldSpec => ({ type: { kind: 'optional', of }, default: null });

export const DOOR_SCHEMA: Schema = {
  mode: t.enum(DOOR_MODES, { default: 'swing' }),
  /** swing: degrees about +y; slide: meters along `slide`; joint: the joint's open value. */
  open_value: t.number({ default: 90 }),
  hinge: t.vec3({ default: Vec3.ZERO }),
  slide: t.vec3({ default: Vec3.ZERO }),
  joint: optional({ kind: 'string' }),
  seconds: t.number({ default: 0.6, min: 0 }),
  auto_close: { ...optional({ kind: 'number' }), min: 0 },
  locked: t.bool({ default: false }),
  key: optional({ kind: 'ref', to: 'content/item' }),
  consume_key: t.bool({ default: false }),
  /** Using the door (Interacted on it) toggles it, as `toggle(by=user)`. */
  toggle_on_interact: t.bool({ default: true }),
  /** The wanted state: the door moves towards open while true. */
  wants_open: t.bool({ default: false }),
  /** 0 shut … 1 open (kept by the engine). */
  amount: t.number({ default: 0, min: 0, max: 1 }),
  /** `ctx.time.now` it closes by itself; -1: not scheduled (kept by the engine). */
  close_at: t.number({ default: -1 }),
  /** The shut pose, captured on first sight (kept by the engine). */
  rest_position: optional({ kind: 'vec3' }),
  rest_rotation: optional({ kind: 'vec3' }),
};

/** What the api supplies: an `item` content ref by id (DoorBlocked's `key`). */
export type ItemRefOf = (kernel: Kernel, id: string) => unknown;

/** The id of a ContentRef (an object with `id`), or a bare id string. */
function idOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id;
  return null;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return JSON.stringify(value);
}

/** Bind `args` to keyword-only names (door methods take `by=` only); a trailing object or Kwargs holds them. */
function keywords(name: string, args: readonly unknown[], known: readonly string[]): Readonly<Record<string, unknown>> {
  const last = args[args.length - 1];
  let given: Readonly<Record<string, unknown>> | undefined;
  if (typeof last === 'object' && last !== null && !Array.isArray(last) && !(last instanceof Vec2) && !(last instanceof Vec3)) {
    if (Object.getPrototypeOf(last) === Object.prototype) given = last as Record<string, unknown>;
    else {
      const values = (last as { values?: unknown }).values;
      if (typeof values === 'object' && values !== null && !Array.isArray(values)) given = values as Record<string, unknown>;
    }
  }
  const positional = given === undefined ? args.length : args.length - 1;
  if (positional > 0) {
    fail('PP3030', `${name}() takes 0 positional arguments but ${positional} were given`, {
      fix: known.length > 0 ? `Pass ${known.join(', ')} by name.` : 'Remove the arguments.',
    });
  }
  for (const key of Object.keys(given ?? {})) {
    if (!known.includes(key)) fail('PP3030', `${name}() got an unexpected keyword argument "${key}"`, { fix: `Accepted: ${known.join(', ') || '(none)'}.` });
  }
  return given ?? {};
}

export class Doors {
  readonly #kernel: () => Kernel;
  readonly #itemRef: ItemRefOf | undefined;

  constructor(kernel: () => Kernel, itemRef: ItemRefOf | undefined) {
    this.#kernel = kernel;
    this.#itemRef = itemRef;
  }

  get kernel(): Kernel {
    return this.#kernel();
  }

  #wrap(id: EntityId | null): unknown {
    return id === null ? null : this.kernel.handles.wrap(id);
  }

  #where(id: EntityId): string {
    const record = this.kernel.world.peek(id);
    return `entity ${record?.placedId ?? record?.prefab ?? id} ${DOOR}`;
  }

  /** Capture the shut pose the first time a door is seen (placement or spawn). */
  see(record: EntityRecord, door: Fields): void {
    if (door['rest_position'] === null) door['rest_position'] = record.transform.position;
    if (door['rest_rotation'] === null) door['rest_rotation'] = record.transform.rotation.to_euler();
  }

  /** A door entering the world: its shut pose, and its pose when it starts (part) open. */
  added(record: EntityRecord): void {
    const door = record.components.get(DOOR);
    if (door === undefined) return;
    if (door['mode'] !== 'joint') this.see(record, door);
    if ((door['amount'] as number) > 0) this.pose(record.id, record, door);
  }

  pose(id: EntityId, record: EntityRecord, door: Fields): void {
    const a = door['amount'] as number;
    const eased = a * a * (3 - 2 * a);
    const mode = door['mode'] as string;
    if (mode === 'joint') {
      const joint = idOf(door['joint']);
      const model = record.components.get('model');
      if (joint === null || model === undefined) {
        fail('PP3583',`${this.#where(id)} in "joint" mode needs "joint" and a Model`, { fix: 'Set "joint": "<the model\'s hinge joint>" and give it a model document with that joint.' });
      }
      const joints = model['joints'] as Readonly<Record<string, number>> | null;
      const plain = joints !== null && typeof (joints as { toJSON?: unknown }).toJSON === 'function' && Object.getPrototypeOf(joints) !== Object.prototype
        ? (joints as unknown as { toJSON(): Record<string, number> }).toJSON() : joints ?? {};
      model['joints'] = { ...plain, [joint]: eased * (door['open_value'] as number) };
      return;
    }
    this.see(record, door);
    const restPos = door['rest_position'] as Vec3;
    const restRot = Quat.from_euler(door['rest_rotation'] as Vec3);
    if (mode === 'swing') {
      const hinge = door['hinge'] as Vec3;
      const half = (eased * (door['open_value'] as number) * Math.PI) / 360;
      const turn = new Quat(Vec3.UP.x * Math.sin(half), Vec3.UP.y * Math.sin(half), Vec3.UP.z * Math.sin(half), Math.cos(half));
      const rot = restRot.__mul__(turn);
      record.transform.rotation = rot;
      record.transform.position = restPos.__add__(restRot.rotate(hinge)).__sub__(rot.rotate(hinge));
    } else {
      record.transform.position = restPos.__add__(restRot.rotate((door['slide'] as Vec3).__mul__(eased)));
    }
  }

  /** Each frame (before the game's systems): auto-close timers, then movement towards the wanted state. */
  tick(dt: number): void {
    const kernel = this.kernel;
    const now = kernel.time.now;
    for (const row of kernel.world.query([DOOR])) {
      const id = row[0];
      const door = row[1]!;
      const record = kernel.world.get(id)!;
      const closeAt = door['close_at'] as number;
      if (closeAt >= 0 && now >= closeAt) {
        door['close_at'] = -1;
        door['wants_open'] = false;
      }
      const target = door['wants_open'] === true ? 1 : 0;
      const before = door['amount'] as number;
      if (before === target) continue;
      const seconds = door['seconds'] as number;
      const after = seconds <= 0 ? target : target > before ? Math.min(1, before + dt / seconds) : Math.max(0, before - dt / seconds);
      door['amount'] = after;
      this.pose(id, record, door);
      if (after === 1) {
        const auto = door['auto_close'];
        if (typeof auto === 'number') door['close_at'] = now + auto;
        kernel.emit(DOOR_EVENTS.doorOpened, { entity: this.#wrap(id) });
      } else if (after === 0) {
        kernel.emit(DOOR_EVENTS.doorClosed, { entity: this.#wrap(id) });
      }
    }
  }

  /** Unlock with `by`'s key (or unconditionally from code, `by` null). */
  unlock(door: Fields, by: EntityId | null): boolean {
    if (door['locked'] !== true) return true;
    if (by !== null) {
      const key = idOf(door['key']);
      const inv = this.kernel.world.get(by)?.components.get(INVENTORY) as
        { count?: (...args: unknown[]) => unknown; remove?: (...args: unknown[]) => unknown } | undefined;
      if (key === null || inv === undefined || typeof inv.count !== 'function') return false;
      if ((inv.count.call(inv, key) as number) <= 0) return false;
      if (door['consume_key'] === true && typeof inv.remove === 'function') inv.remove.call(inv, key, 1);
    }
    door['locked'] = false;
    return true;
  }

  open(id: EntityId, door: Fields, by: EntityId | null): boolean {
    if (door['locked'] === true && (by === null || !this.unlock(door, by))) {
      const key = idOf(door['key']);
      this.kernel.emit(DOOR_EVENTS.doorBlocked, {
        entity: this.#wrap(id), source: this.#wrap(by), key: key === null ? null : this.#itemRef?.(this.kernel, key) ?? key,
      });
      return false;
    }
    door['wants_open'] = true;
    return true;
  }

  close(door: Fields): void {
    door['wants_open'] = false;
    door['close_at'] = -1;
  }

  /** `Interacted` on `entity` by `by`: an Interactable door toggles (Door.toggle_on_interact), keys and all. */
  interacted(entity: EntityId, by: EntityId | null): void {
    const door = this.kernel.world.get(entity)?.components.get(DOOR);
    if (door === undefined || door['toggle_on_interact'] !== true) return;
    if (door['wants_open'] === true) this.close(door);
    else this.open(entity, door, by);
  }

  component(): ComponentDef {
    const owner = (fields: unknown): EntityId => componentEntity(fields as Fields);
    const by = (a: Readonly<Record<string, unknown>>, where: string): EntityId | null => {
      const value = a['by'];
      if (value === undefined || value === null) return null;
      const id = this.kernel.handles.unwrap(value);
      if (id === undefined) fail('PP3584',`${where} must be an Entity, got ${describe(value)}`);
      return id;
    };
    const doors = this;
    const methods = {
      open(this: Fields, ...args: unknown[]): boolean {
        return doors.open(owner(this), this, by(keywords('open', args, ['by']), 'open() by'));
      },
      close(this: Fields, ...args: unknown[]): null {
        keywords('close', args, []);
        doors.close(this);
        return null;
      },
      toggle(this: Fields, ...args: unknown[]): boolean {
        const a = keywords('toggle', args, ['by']);
        if (this['wants_open'] === true) {
          doors.close(this);
          return true;
        }
        return doors.open(owner(this), this, by(a, 'toggle() by'));
      },
      lock(this: Fields, ...args: unknown[]): null {
        keywords('lock', args, []);
        this['locked'] = true;
        return null;
      },
      unlock(this: Fields, ...args: unknown[]): boolean {
        return doors.unlock(this, by(keywords('unlock', args, ['by']), 'unlock() by'));
      },
    };
    Object.defineProperty(methods, 'entity', {
      get(this: Fields): unknown { return doors.kernel.handles.wrap(owner(this)); }, enumerable: false,
    });
    Object.defineProperty(methods, 'is_open', { get(this: Fields): unknown { return (this['amount'] as number) >= 1; }, enumerable: false });
    Object.defineProperty(methods, 'is_closed', { get(this: Fields): unknown { return (this['amount'] as number) <= 0; }, enumerable: false });
    return { id: DOOR, schema: DOOR_SCHEMA, methods };
  }
}
