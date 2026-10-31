/**
 * The `characters` service: what a character is doing, for plugins that present it, provided
 * by the characters plugin (`kernel.tryService(CHARACTERS_SERVICE)`, looked up at use). The
 * viewmodel paces its bob, sprint pose and landing dip from it; a first-person camera rig can
 * sit at `eye`. Characters are steered through their component's methods; the one exception
 * is seating, which the vehicles plugin drives for `Vehicle.enter/exit` (`sit`, `leaveSeat`).
 *
 * Seats. The `seat` component (sdk `Seat`, in parallax.characters) is shared: the characters
 * plugin and the vehicles plugin both register this same definition (a game with vehicles and
 * no characters still has seats), and the kernel accepts one definition registered twice. A
 * vehicle's seats are its Seat children, in child order (the first is the driver's).
 */

import { Vec3 } from '../../core/index.js';
import type { EntityId } from '../../core/index.js';
import { serviceKey, t } from '../kernel/index.js';
import type { ComponentDef, Schema, ServiceKey } from '../kernel/index.js';

export type CharacterMotion = 'ground' | 'air' | 'swim' | 'traverse' | 'free_fall' | 'glide' | 'seated' | 'riding' | 'carried' | 'ragdoll';
export type CharacterStance = 'stand' | 'crouch' | 'prone';

export interface CharacterView {
  readonly motion: CharacterMotion;
  readonly stance: CharacterStance;
  /** World m/s. */
  readonly velocity: Vec3;
  readonly grounded: boolean;
  /** It ran (sprinted) in the last step. */
  readonly running: boolean;
  /** The eyes relative to the entity's origin (the feet), in its parent's axes; eased across stance changes. */
  readonly eye: Vec3;
  /** Downward m/s of the last landing, and the frame it happened on (`kernel.time.frame`). */
  readonly landed: { readonly speed: number; readonly frame: number } | null;
}

export interface CharactersService {
  /** Undefined when the entity has no Character. */
  view(entity: EntityId): CharacterView | undefined;
  /** `Character.sit(seat)`: false when the seat is taken or disabled, or the character is busy. */
  sit(entity: EntityId, seat: EntityId): boolean;
  /** `Character.leave_seat()`: false when it isn't seated or every exit is blocked (it stays). */
  leaveSeat(entity: EntityId): boolean;
}

export const CHARACTERS_SERVICE: ServiceKey<CharactersService> = serviceKey<CharactersService>(
  'characters', 'Add characters() to Game(plugins=[...]).',
);

/** Where a rider may stand up from a seat its host owns (a vehicle's): world points, tried in order. */
export interface SeatExitsService {
  /** Undefined when the seat isn't one this host manages (the seat's own `exits` apply). */
  exits(seat: EntityId, rider: EntityId): Vec3[] | undefined;
}

export const SEAT_EXITS_SERVICE: ServiceKey<SeatExitsService> = serviceKey<SeatExitsService>(
  'seat_exits', 'Provided by the vehicles plugin for vehicle seats.',
);

export const SEAT = 'seat';

export const SEAT_SCHEMA: Schema = {
  offset: t.vec3({ default: Vec3.ZERO }),
  facing: t.number({ default: 0 }),
  exits: t.list({ kind: 'vec3' }, { default: [] }),
  enter_time: t.number({ default: 0.4, min: 0 }),
  param: { type: { kind: 'optional', of: { kind: 'string' } }, default: null },
  enabled: t.bool({ default: true }),
  occupant: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null },
};

/** The one `seat` definition: characters() and vehicles() both register this object. */
export const SEAT_COMPONENT: ComponentDef = { id: SEAT, schema: SEAT_SCHEMA };
