/**
 * `parallax.characters` (sdk/parallax/characters.pyi): the Character and Seat handles, the
 * humanoid records (Stances, Traversal, Swimming, Skydive, Parachute, Carry), the events, and
 * the `characters()` factory `parallax.plugins` re-exports. The behavior lives in the
 * characters plugin (it moves through physics3d); held items attach to Model sockets with
 * `attach(child, socket=...)`'s own checks.
 */

import { fail, Vec3 } from '../core/index.js';
import type { FieldType, KernelPlugin, Schema } from '../function/kernel/index.js';
import {
  CARRY_RECORD, CHARACTER, CHARACTER_EVENTS, CHARACTER_SCHEMA, characters as charactersPlugin, PARACHUTE_RECORD, SEAT, SEAT_SCHEMA,
  SKYDIVE_RECORD, STANCES_RECORD, SWIMMING_RECORD, TRAVERSAL_RECORD,
} from '../function/plugins/characters/index.js';
import { record } from './declarations.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs } from './kwargs.js';
import { attachToSocket } from './model_sockets.js';
import { rt } from './types.js';

/** `entity.get(Character)`: speeds, jump, shape, humanoid abilities… and their methods. */
export const Character = componentHandle({ id: CHARACTER, schema: CHARACTER_SCHEMA }, 'Character');
/** `entity.get(Seat)`: a place a character sits (offset, facing, exits, occupant). */
export const Seat = componentHandle({ id: SEAT, schema: SEAT_SCHEMA }, 'Seat');

function marker(type: FieldType, where: string, nested: unknown): unknown {
  switch (type.kind) {
    case 'number': return rt.float;
    case 'int': return rt.int;
    case 'bool': return rt.bool;
    case 'string': return rt.str;
    case 'vec3': return Vec3;
    case 'record':
      if (nested === undefined) return fail('PP9163', `${where}: a record field needs its record class`);
      return nested;
    case 'list': return rt.list(marker(type.of, `${where}[]`, nested));
    default: return fail('PP9163', `${where}: no Python type for a ${type.kind} record field`);
  }
}

/**
 * A Python-facing record class whose fields and defaults are a plugin's schema. `nested`
 * gives the record classes of record-typed fields (and lists of them), by field name.
 */
export function schemaRecord(name: string, schema: Schema, nested: Readonly<Record<string, unknown>> = {}): unknown {
  const fields = class {};
  Object.defineProperty(fields, 'name', { value: name });
  const annotations: Record<string, () => unknown> = {};
  for (const [field, spec] of Object.entries(schema)) {
    const type = marker(spec.type, `${name}.${field}`, nested[field]);
    annotations[field] = () => type;
    if ('default' in spec) (fields as unknown as Record<string, unknown>)[field] = spec.default;
  }
  Object.defineProperty(fields, '__annotations__', { value: annotations });
  return record(fields);
}

/** `Character(stances=Stances(crouch_height=1.1))`. */
export const Stances = schemaRecord('Stances', STANCES_RECORD);
export const Traversal = schemaRecord('Traversal', TRAVERSAL_RECORD);
export const Swimming = schemaRecord('Swimming', SWIMMING_RECORD);
export const Skydive = schemaRecord('Skydive', SKYDIVE_RECORD);
export const Parachute = schemaRecord('Parachute', PARACHUTE_RECORD);
export const Carry = schemaRecord('Carry', CARRY_RECORD);

/** `@on(Landed)`: entity, fall_speed (m/s, ≥ 0), target (the ground: Entity | None). */
export const Landed = eventHandle(CHARACTER_EVENTS.landed, 'Landed');
/** `@on(Jumped)`: entity, in_air (an air jump). */
export const Jumped = eventHandle(CHARACTER_EVENTS.jumped, 'Jumped');
/** `@on(Traversed)`: entity, kind ("vault" | "climb"), height. */
export const Traversed = eventHandle(CHARACTER_EVENTS.traversed, 'Traversed');
/** `@on(StanceChanged)`: entity, stance. */
export const StanceChanged = eventHandle(CHARACTER_EVENTS.stanceChanged, 'StanceChanged');
/** `@on(MotionChanged)`: entity, motion, previous. */
export const MotionChanged = eventHandle(CHARACTER_EVENTS.motionChanged, 'MotionChanged');
/** `@on(Seated)`: entity (the character), target (the seat). */
export const Seated = eventHandle(CHARACTER_EVENTS.seated, 'Seated');
/** `@on(LeftSeat)`: entity (the character), target (the seat). */
export const LeftSeat = eventHandle(CHARACTER_EVENTS.leftSeat, 'LeftSeat');

/** `parallax.plugins.characters()`. */
export function characters(...args: unknown[]): KernelPlugin {
  bindArgs('characters', args, {});
  return charactersPlugin({ attach: (kernel, parent, child, socket) => attachToSocket(kernel, parent, child, socket, false) });
}
