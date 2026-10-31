/**
 * Per-vehicle state and the fixed step: controls, seats, fuel, grounded/airborne
 * tracking, the optional depth components (drivetrain, damage, effects, rig), simulation
 * tiers (internal), and the vehicle events.
 *
 * Controls are "for this frame": `drive()`/`fly()` in frame F drive the fixed steps of
 * frames F and F+1, then lapse to zero. A vehicle nobody controls and nobody sits in has
 * its parking brake on (brake 1); one with an occupant who stops steering coasts.
 *
 * Seats are the vehicle's Seat children (the shared `seat` component), in child order; seat
 * 0 is the driver's. A rider is mounted on its seat through the physics3d service: its
 * colliders are off and it rides there until it exits, when it is put down at the first
 * clear exit point (the seat's own `exits`, else exits.ts). Character riders sit and stand
 * through the characters service (see "Seats" below).
 */

import { fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, EventDef, Fields, Kernel } from '../../kernel/index.js';
import {
  CAMERAS_SERVICE, CHARACTERS_SERVICE, PHYSICS3D_SERVICE, SEAT, WATER_SERVICE, WATER_WORLD_SERVICE, WEATHER_SERVICE,
} from '../../services/index.js';
import type { BodyState, LocalBounds, Physics3dService } from '../../services/index.js';
import { damagePart, effectsOf, floodRate, fraction, modelParts, partAt, wrecks } from './damage.js';
import type { DamageFields, VehiclePart } from './damage.js';
import { freshDrivetrain, stepDrivetrain } from './drivetrain.js';
import type { DrivetrainFields, DrivetrainState } from './drivetrain.js';
import { chooseExit, groundedExits } from './exits.js';
import {
  axes, boatBite, headingOf, slipAngle, stallSpeed, stepBoat, stepPlane, stepSimple, stepWheeled, wheelLayout,
} from './models.js';
import type { DriveInput, FlyInput, StepResult, VehicleFields, WheelTuning } from './models.js';
import { presentEffects, presentRig, VEHICLE_EFFECTS, VEHICLE_RIG } from './rig.js';
import type { Presented } from './rig.js';
import { assignTiers } from './tiers.js';
import type { SimTier, TierSettings } from './tiers.js';

export const VEHICLE = 'vehicle';
export const DRIVETRAIN = 'drivetrain';
export const VEHICLE_DAMAGE = 'vehicle_damage';
const RIGIDBODY = 'rigidbody';
/** The water plugin's Buoyancy, by id (plugins don't import each other). */
const BUOYANCY = 'buoyancy';
/** kg/m³ a fully flooded hull weighs per m³ of its volume (above sea water's 1025: it sinks). */
const FLOODED_DENSITY = 1100;
const COLLIDER = 'collider';
const MODEL = 'model';
const CAMERA = 'camera';
/** The combat plugin's damage event, by id (plugins don't import each other). */
export const COMBAT_DAMAGED = 'damaged';
const WATCH = 'vehicles';

export const VEHICLE_EVENTS = {
  entered: { id: 'vehicle_entered', target: 'entity' },
  exited: { id: 'vehicle_exited', target: 'entity' },
  landed: { id: 'vehicle_landed', target: 'entity' },
  partDamaged: { id: 'vehicle_part_damaged', target: 'entity' },
  partDestroyed: { id: 'vehicle_part_destroyed', target: 'entity' },
  wrecked: { id: 'vehicle_disabled', target: 'entity' },
} as const satisfies Record<string, EventDef>;

/** Seconds airborne before touching down counts as a landing (small bumps don't). */
export const LANDING_AIRTIME = 0.3;
/** Drifting: grounded, above this speed (m/s) and sliding more than this angle (deg). */
export const DRIFT_SPEED = 5;
export const DRIFT_ANGLE = 10;

const AIRCRAFT = new Set(['plane']);
const WHEELED = new Set(['car', 'tracked']);

interface Controls {
  readonly drive?: DriveInput;
  readonly fly?: FlyInput;
  readonly frame: number;
}

export interface VehicleState {
  seats: Array<EntityId | null>;
  controls: Controls | undefined;
  grounded: boolean;
  ground: EntityId | undefined;
  airborne: number;
  /** Vertical speed at the last step (for VehicleLanded). */
  verticalSpeed: number;
  slip: number;
  stall: number;
  tier: SimTier;
  /** Per wheel, from the last full step. */
  surfaces: Array<string | undefined>;
  skids: boolean[];
  drivetrain: DrivetrainState | undefined;
}

export type SavedVehicle = {
  readonly entity: number;
  readonly seats: Array<number | null>;
  readonly controls: { drive?: DriveInput; fly?: FlyInput; frame: number } | null;
  readonly grounded: boolean;
  readonly ground: number | null;
  readonly airborne: number;
  readonly verticalSpeed: number;
  readonly slip: number;
  readonly tier?: SimTier;
  readonly surfaces?: Array<string | null>;
  readonly skids?: boolean[];
  readonly drivetrain?: DrivetrainState | null;
};

/** The surface key for ground that isn't an entity (terrain, voxels). */
export const TERRAIN_SURFACE = 'terrain';

function fresh(): VehicleState {
  return {
    seats: [], controls: undefined, grounded: true, ground: undefined, airborne: 0, verticalSpeed: 0, slip: 0, stall: 0,
    tier: 'full', surfaces: [], skids: [], drivetrain: undefined,
  };
}

function where(record: EntityRecord): string {
  return `entity ${record.placedId ?? record.prefab ?? record.id} vehicle`;
}

export interface VehicleSettings {
  /** Undefined: every vehicle runs the full model. */
  readonly tiers: TierSettings | undefined;
}

export class Vehicles {
  readonly #kernel: Kernel;
  readonly #settings: VehicleSettings;
  readonly #states = new Map<EntityId, VehicleState>();

  constructor(kernel: Kernel, settings: VehicleSettings) {
    this.#kernel = kernel;
    this.#settings = settings;
  }

  get kernel(): Kernel {
    return this.#kernel;
  }

  service(): Physics3dService {
    return this.#kernel.service(PHYSICS3D_SERVICE);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  added(records: readonly EntityRecord[]): void {
    for (const record of records) {
      const fields = record.components.get(VEHICLE);
      if (fields === undefined) continue;
      if (!this.#states.has(record.id)) this.#states.set(record.id, fresh());
      this.#watchImpacts(record);
    }
  }

  removed(records: readonly EntityRecord[]): void {
    const gone = new Set(records.map((r) => r.id));
    for (const id of gone) this.#states.delete(id);
    // A rider destroyed in its seat leaves the seat free.
    for (const s of this.#states.values()) s.seats = s.seats.map((rider) => (rider !== null && gone.has(rider) ? null : rider));
  }

  changed(record: EntityRecord): void {
    if (record.components.has(VEHICLE)) {
      if (!this.#states.has(record.id)) this.#states.set(record.id, fresh());
      this.#watchImpacts(record);
      return;
    }
    const s = this.#states.get(record.id);
    if (s === undefined) return;
    const service = this.#kernel.tryService(PHYSICS3D_SERVICE);
    for (const rider of s.seats) if (rider !== null) service?.dismount(rider);
    service?.releaseWheels(record.id);
    service?.watchContactForces(record.id, WATCH, undefined);
    this.#states.delete(record.id);
  }

  #watchImpacts(record: EntityRecord): void {
    const damage = record.components.get(VEHICLE_DAMAGE);
    const threshold = (damage?.['impact_threshold'] ?? null) as number | null;
    this.#kernel.tryService(PHYSICS3D_SERVICE)?.watchContactForces(record.id, WATCH, threshold === null ? undefined : threshold);
  }

  state(entity: EntityId): VehicleState {
    let s = this.#states.get(entity);
    if (s === undefined) {
      s = fresh();
      this.#states.set(entity, s);
    }
    return s;
  }

  snapshot(): SavedVehicle[] {
    return [...this.#states].map(([entity, s]) => ({
      entity: entity as number,
      seats: s.seats.map((r) => (r === null ? null : r as number)),
      controls: s.controls === undefined ? null : { ...s.controls },
      grounded: s.grounded,
      ground: s.ground === undefined ? null : s.ground as number,
      airborne: s.airborne,
      verticalSpeed: s.verticalSpeed,
      slip: s.slip,
      tier: s.tier,
      surfaces: s.surfaces.map((x) => x ?? null),
      skids: [...s.skids],
      drivetrain: s.drivetrain === undefined ? null : { ...s.drivetrain },
    }));
  }

  restore(saved: readonly SavedVehicle[]): void {
    this.#states.clear();
    const byId = new Map(saved.map((s) => [s.entity, s]));
    const alive = (id: number | null): EntityId | null => (id !== null && this.#kernel.world.isAlive(id as EntityId) ? id as EntityId : null);
    for (const record of this.#kernel.world.live()) {
      if (!record.components.has(VEHICLE)) continue;
      const s = byId.get(record.id as number);
      if (s === undefined) {
        this.#states.set(record.id, fresh());
        continue;
      }
      this.#states.set(record.id, {
        seats: s.seats.map(alive),
        controls: s.controls === null ? undefined : { ...s.controls },
        grounded: s.grounded,
        ground: alive(s.ground) ?? undefined,
        airborne: s.airborne,
        verticalSpeed: s.verticalSpeed,
        slip: s.slip,
        stall: 0,
        tier: s.tier ?? 'full',
        surfaces: (s.surfaces ?? []).map((x) => x ?? undefined),
        skids: [...(s.skids ?? [])],
        drivetrain: s.drivetrain === null || s.drivetrain === undefined ? undefined : { ...s.drivetrain },
      });
    }
  }

  // ── Commands ─────────────────────────────────────────────────────────────────

  drive(entity: EntityId, fields: Fields, input: DriveInput): void {
    if (AIRCRAFT.has(fields['kind'] as string)) {
      fail('PP7310', `drive() on a ${String(fields['kind'])}`, { fix: 'Fly aircraft with vehicle.fly(throttle=..., pitch=..., roll=..., yaw=...).' });
    }
    this.state(entity).controls = { drive: input, frame: this.#kernel.time.frame };
  }

  fly(entity: EntityId, fields: Fields, input: FlyInput): void {
    if (!AIRCRAFT.has(fields['kind'] as string)) {
      fail('PP7310', `fly() on a ${String(fields['kind'])}`, { fix: 'Drive cars, boats and tracked vehicles with vehicle.drive(throttle=..., steer=...).' });
    }
    this.state(entity).controls = { fly: input, frame: this.#kernel.time.frame };
  }

  // ── Seats ────────────────────────────────────────────────────────────────────
  //
  // A vehicle's seats are its Seat children, in child order (the first is the driver's);
  // who sits where is each Seat's `occupant`. A character rider goes through its own
  // Character.sit / leave_seat (the characters service), so Seated/LeftSeat, the seat's
  // enter_time and the Animator's `seated` param work the same in a car as on a bench; any
  // other rider (an AI driver with no Character) is mounted on the seat here. `s.seats` is
  // derived from the occupants (#syncSeats), which also raises VehicleEntered/Exited, so a
  // character that sits in a vehicle seat directly counts too.

  /** The vehicle's Seat children, in child order. */
  seatsOf(entity: EntityId): EntityId[] {
    const world = this.#kernel.world;
    const record = world.peek(entity);
    if (record === undefined) return [];
    return record.children.filter((child) => world.peek(child)?.components.has(SEAT) === true);
  }

  /** Who is in the seat (null: free); clears an occupant that no longer exists. */
  #occupant(seat: EntityId): EntityId | null {
    const fields = this.#kernel.world.peek(seat)?.components.get(SEAT);
    if (fields === undefined) return null;
    const id = this.#kernel.handles.unwrap(fields['occupant']);
    if (id === undefined) return null;
    if (this.#kernel.world.isAlive(id)) return id;
    fields['occupant'] = null;
    return null;
  }

  /** Re-read who sits where; VehicleEntered/Exited for each change. */
  #syncSeats(entity: EntityId): void {
    const s = this.state(entity);
    const before = s.seats;
    const now = this.seatsOf(entity).map((seat) => this.#occupant(seat));
    s.seats = now;
    const handles = this.#kernel.handles;
    for (const rider of before) {
      if (rider === null || now.includes(rider) || !this.#kernel.world.isAlive(rider)) continue;
      this.#kernel.emit(VEHICLE_EVENTS.exited, { entity: handles.wrap(entity), source: handles.wrap(rider) });
    }
    for (const rider of now) {
      if (rider === null || before.includes(rider)) continue;
      this.#kernel.emit(VEHICLE_EVENTS.entered, { entity: handles.wrap(entity), source: handles.wrap(rider) });
    }
  }

  /** The seat's position in the chassis frame (exit sides are chosen from it). */
  #chassisLocal(body: BodyState, world: Vec3): Vec3 {
    return body.rotation.inverse().rotate(world.__sub__(body.position));
  }

  /** `seat_exits` service: where a character may stand up from one of this vehicle's seats (world points). */
  seatExits(seat: EntityId, rider: EntityId): Vec3[] | undefined {
    const record = this.#kernel.world.peek(seat);
    const vehicle = record?.parent ?? null;
    if (record === undefined || vehicle === null || !this.#states.has(vehicle)) return undefined;
    const service = this.service();
    const body = service.body(vehicle);
    const bounds = service.bounds(vehicle);
    if (body === undefined || bounds === undefined) return undefined;
    return groundedExits(service, vehicle, rider, body, bounds, this.#chassisLocal(body, record.transform.worldPosition()), []);
  }

  enter(entity: EntityId, rider: EntityId, seat: number): boolean {
    if (rider === entity) fail('PP7309', 'A vehicle can\'t enter itself', { fix: 'Pass the entity getting in: vehicle.enter(player).' });
    const seats = this.seatsOf(entity);
    if (seats.length === 0) {
      fail('PP7309', 'enter() on a vehicle with no seats', {
        fix: 'Give the vehicle prefab a child per seat with a "seat" component (the first child seat is the driver\'s): "children": [{"name": "driver_seat", "at": [x, y, z], "components": {"seat": {}}}].',
      });
    }
    if (!Number.isInteger(seat) || seat < 0 || seat >= seats.length) {
      fail('PP7309', `enter(seat=${seat}) on a vehicle with ${seats.length} seat(s)`, { fix: `Seats are 0 (the driver) to ${seats.length - 1}.` });
    }
    const seatId = seats[seat]!;
    const characters = this.#kernel.tryService(CHARACTERS_SERVICE);
    let sat: boolean;
    if (characters?.view(rider) !== undefined) {
      sat = characters.sit(rider, seatId);
    } else {
      const fields = this.#kernel.world.require(seatId).components.get(SEAT)!;
      const service = this.service();
      sat = fields['enabled'] === true && this.#occupant(seatId) === null && service.mountOf(rider) === undefined;
      if (sat) {
        service.mount(rider, seatId, fields['offset'] as Vec3, Quat.from_euler(new Vec3(0, fields['facing'] as number, 0)));
        fields['occupant'] = this.#kernel.handles.wrap(rider);
      }
    }
    if (sat) this.#syncSeats(entity);
    return sat;
  }

  /** False when the rider isn't in this vehicle, or (a character) every exit is blocked. */
  exit(entity: EntityId, rider: EntityId): boolean {
    this.#syncSeats(entity);
    const seat = this.state(entity).seats.indexOf(rider);
    if (seat < 0) return false;
    const characters = this.#kernel.tryService(CHARACTERS_SERVICE);
    if (characters?.view(rider) !== undefined) {
      const left = characters.leaveSeat(rider);
      if (left) this.#syncSeats(entity);
      return left;
    }
    const seatId = this.seatsOf(entity)[seat]!;
    const seatRecord = this.#kernel.world.require(seatId);
    seatRecord.components.get(SEAT)!['occupant'] = null;
    const service = this.service();
    service.dismount(rider);
    const body = service.body(entity);
    const bounds = service.bounds(entity);
    if (body !== undefined && bounds !== undefined) {
      const t = seatRecord.transform;
      const exits = (seatRecord.components.get(SEAT)!['exits'] as Vec3[])
        .map((local) => this.#chassisLocal(body, t.worldPosition().__add__(t.worldRotation().rotate(local))));
      const at = chooseExit(service, entity, rider, body, bounds, this.#chassisLocal(body, t.worldPosition()), exits);
      const yaw = headingOf(body.rotation);
      service.teleport(rider, at, Quat.from_euler(new Vec3(0, yaw, 0)), false);
    }
    this.#syncSeats(entity);
    return true;
  }

  refuel(fields: Fields, liters: number): void {
    const fuel = fields['fuel'] as number;
    const capacity = fields['fuel_capacity'] as number;
    if (fuel < 0) fail('PP3189', 'refuel() on a vehicle without a fuel model (fuel = -1)', { fix: 'Give the vehicle "fuel" and "fuel_capacity" in its prefab.' });
    if (liters < 0) fail('PP3189', `refuel(${liters}) can't be negative`);
    fields['fuel'] = capacity >= 0 ? Math.min(capacity, fuel + liters) : fuel + liters;
  }

  driver(entity: EntityId): EntityId | null {
    const first = this.seatsOf(entity)[0];
    return first === undefined ? null : this.#occupant(first);
  }

  /** Everyone in a seat, in seat order. */
  riders(entity: EntityId): EntityId[] {
    return this.seatsOf(entity).map((seat) => this.#occupant(seat)).filter((r): r is EntityId => r !== null);
  }

  speed(entity: EntityId): number {
    const body = this.service().body(entity);
    return body === undefined ? 0 : body.velocity.dot(axes(body.rotation).forward);
  }

  stalled(entity: EntityId, fields: Fields): boolean {
    const fuel = fields['fuel'] as number;
    if (fuel >= 0 && fuel <= 0) return true;
    const s = this.state(entity);
    if (fields['kind'] !== 'plane' || s.grounded) return false;
    return this.speed(entity) < stallSpeed(fields as unknown as VehicleFields, s.controls?.fly?.flaps ?? 0);
  }

  drifting(entity: EntityId): boolean {
    const s = this.state(entity);
    return s.grounded && Math.abs(s.slip) > DRIFT_ANGLE && Math.abs(this.speed(entity)) > DRIFT_SPEED;
  }

  // ── Drivetrain ───────────────────────────────────────────────────────────────

  drivetrain(entity: EntityId, fields: Fields): DrivetrainState {
    const s = this.state(entity);
    s.drivetrain ??= freshDrivetrain(fields as unknown as DrivetrainFields);
    return s.drivetrain;
  }

  // ── Damage ───────────────────────────────────────────────────────────────────

  partFraction(d: DamageFields, name: string): number {
    const part = d.parts.find((p) => p.name === name);
    if (part === undefined) {
      fail('PP7303', `This vehicle has no part "${name}"`, { fix: `Parts: ${d.parts.map((p) => p.name).join(', ') || '(none)'}.` });
    }
    return fraction(d, part);
  }

  /** Damage one part (named, or the one at the world point `at`). Returns the damage dealt. */
  damage(entity: EntityId, d: DamageFields, amount: number, at: Vec3 | undefined, name: string | undefined, source: EntityId | null): number {
    if (d.parts.length === 0) {
      fail('PP7304', 'damage() on a vehicle_damage without parts', { fix: 'Give "vehicle_damage" its "parts": [{"name": "engine", "role": "engine", "at": [0, 0.6, 1]}, ...].' });
    }
    let part: VehiclePart | undefined;
    if (name !== undefined) {
      part = d.parts.find((p) => p.name === name);
      if (part === undefined) this.partFraction(d, name);
    } else {
      const record = this.#kernel.world.require(entity);
      part = partAt(d, at === undefined ? undefined : record.transform.toLocal(at));
    }
    const change = damagePart(d, part!, amount);
    if (change.dealt <= 0) return 0;
    const h = this.#kernel.handles;
    this.#kernel.emit(VEHICLE_EVENTS.partDamaged, {
      entity: h.wrap(entity), part: change.part.name, amount: change.dealt, health: d.health[change.part.name] ?? 0,
      point: at ?? null, source: source === null ? null : h.wrap(source),
    });
    if (change.destroyed) {
      this.#kernel.emit(VEHICLE_EVENTS.partDestroyed, { entity: h.wrap(entity), part: change.part.name });
      if (wrecks(change.part)) this.#wreck(entity, d, 'destroyed');
    }
    this.#showDamage(entity, d);
    return change.dealt;
  }

  repair(entity: EntityId, d: DamageFields, amount: number | undefined, name: string | undefined): void {
    const parts = name === undefined ? d.parts : d.parts.filter((p) => p.name === name);
    if (name !== undefined && parts.length === 0) this.partFraction(d, name);
    const health = { ...d.health };
    for (const p of parts) health[p.name] = amount === undefined ? p.health : Math.min(p.health, (health[p.name] ?? p.health) + amount);
    d.health = health;
    if (amount === undefined && name === undefined) {
      d.flooded = 0;
      d.wrecked = false;
    }
    this.#showDamage(entity, d);
  }

  #wreck(entity: EntityId, d: DamageFields, reason: 'destroyed' | 'sunk'): void {
    if (d.wrecked) return;
    d.wrecked = true;
    // Sunk: the hull fills, and its weight takes it down.
    if (reason === 'sunk') d.flooded = 1;
    this.#kernel.emit(VEHICLE_EVENTS.wrecked, { entity: this.#kernel.handles.wrap(entity), reason });
  }

  #showDamage(entity: EntityId, d: DamageFields): void {
    const model = this.#kernel.world.get(entity)?.components.get(MODEL);
    const shown = modelParts(d);
    if (model === undefined || Object.keys(shown).length === 0) return;
    const before = (model['parts'] ?? {}) as Record<string, boolean>;
    if (Object.entries(shown).every(([k, v]) => before[k] === v)) return;
    model['parts'] = { ...before, ...shown };
  }

  /** The combat plugin's `damaged` on a vehicle with `from_health`: route it to the part hit. */
  combatDamaged(payload: Fields): void {
    const id = this.#kernel.handles.unwrap(payload['entity']);
    const record = id === undefined ? undefined : this.#kernel.world.get(id);
    const d = record?.components.get(VEHICLE_DAMAGE) as DamageFields | undefined;
    if (record === undefined || d === undefined || !d.from_health || d.parts.length === 0) return;
    const amount = payload['amount'] as number;
    if (!(amount > 0)) return;
    const point = payload['point'];
    const source = this.#kernel.handles.unwrap(payload['source'] ?? null) ?? null;
    this.damage(record.id, d, amount, point instanceof Vec3 ? point : undefined, undefined, source);
  }

  #impacts(service: Physics3dService): void {
    for (const c of service.contactForces()) {
      const record = this.#kernel.world.get(c.entity);
      const d = record?.components.get(VEHICLE_DAMAGE) as DamageFields | undefined;
      const threshold = d?.impact_threshold ?? null;
      if (record === undefined || d === undefined || threshold === null || threshold <= 0 || d.parts.length === 0) continue;
      if (c.force < threshold) continue;
      this.damage(record.id, d, c.force / threshold, c.point, undefined, c.other ?? null);
    }
  }

  // ── The fixed step ───────────────────────────────────────────────────────────

  step(dt: number): void {
    if (this.#states.size === 0) return;
    const service = this.service();
    this.#impacts(service);
    if (this.#settings.tiers !== undefined) this.#assignTiers(this.#settings.tiers);
    for (const [entity, s] of [...this.#states]) {
      const record = this.#kernel.world.get(entity);
      const fields = record?.components.get(VEHICLE);
      if (record === undefined || fields === undefined) continue;
      this.#syncSeats(entity);
      this.#stepOne(service, record, fields, s, dt);
    }
  }

  #assignTiers(settings: TierSettings): void {
    const world = this.#kernel.world;
    // Around what players see: each seat's live camera (cameras no seat looks through don't count).
    const live = this.#kernel.tryService(CAMERAS_SERVICE)?.live();
    const foci = live !== undefined
      ? live.map((c) => c.position)
      : world.query([CAMERA]).map(([id]) => world.require(id).transform.worldPosition());
    const candidates = [...this.#states].flatMap(([entity, s]) => {
      const record = world.get(entity);
      const fields = record?.components.get(VEHICLE);
      if (record === undefined || fields === undefined || !WHEELED.has(fields['kind'] as string)) return [];
      return [{
        entity, position: record.transform.worldPosition(), current: s.tier,
        pinned: s.seats.some((r) => r !== null),
      }];
    });
    for (const [entity, tier] of assignTiers(settings, foci, candidates)) {
      const s = this.#states.get(entity)!;
      if (s.tier === 'full' && tier !== 'full') this.service().releaseWheels(entity);
      s.tier = tier;
    }
  }

  #surfaceOf(ground: EntityId | undefined, inContact: boolean): string | undefined {
    if (!inContact) return undefined;
    if (ground === undefined) return TERRAIN_SURFACE;
    const material = this.#kernel.world.get(ground)?.components.get(COLLIDER)?.['material'];
    return typeof material === 'string' ? material : undefined;
  }

  #stepOne(service: Physics3dService, record: EntityRecord, fields: Fields, s: VehicleState, dt: number): void {
    const rb = record.components.get(RIGIDBODY);
    if (rb === undefined || rb['kind'] !== 'dynamic' || !record.components.has(COLLIDER)) {
      fail('PP7308', `${where(record)} needs a dynamic Rigidbody and a Collider (its chassis)`, {
        fix: 'Add "rigidbody": {"kind": "dynamic", "mass": ...} and a box "collider" around the body to the prefab.',
      });
    }
    const body = service.body(record.id)!;
    const bounds = service.bounds(record.id);
    if (bounds === undefined) return; // A mesh/convex chassis whose model geometry is still loading.
    const v = fields as unknown as VehicleFields;
    const kind = v.kind;
    const occupied = s.seats.some((r) => r !== null);
    const live = s.controls !== undefined && s.controls.frame >= this.#kernel.time.frame - 1 ? s.controls : undefined;
    if (live === undefined) s.controls = undefined;
    if (s.tier === 'dormant') return;

    const damage = record.components.get(VEHICLE_DAMAGE) as DamageFields | undefined;
    const hurt = effectsOf(damage);
    // Fuel: an empty tank gives no thrust; burning scales with |throttle|.
    const fuel = fields['fuel'] as number;
    const engineOn = (fuel < 0 || fuel > 0) && hurt.engine > 0;
    const throttle = (live?.drive?.throttle ?? live?.fly?.throttle ?? 0) * (engineOn ? 1 : 0);
    if (fuel > 0) fields['fuel'] = Math.max(0, fuel - (fields['fuel_burn'] as number) * Math.abs(throttle) * dt);

    let result: StepResult;
    let roll = 0;
    let steerAngle = 0;
    let revs = Math.min(1, Math.abs(this.speed(record.id)) / Math.max(v.max_speed, 1));
    const parked = occupied || live !== undefined ? 0 : 1;
    if (AIRCRAFT.has(kind)) {
      const input: FlyInput = {
        throttle, pitch: 0, roll: 0, yaw: 0, flaps: 0, airbrake: false, brake: parked,
        ...(live?.fly !== undefined && { ...live.fly, throttle }),
      };
      const r = stepPlane(service, record.id, v, body, input, dt);
      s.stall = r.stall;
      result = r;
    } else {
      const input: DriveInput = {
        throttle, steer: 0, brake: parked, handbrake: false,
        ...(live?.drive !== undefined && { ...live.drive, throttle }),
      };
      if (kind === 'boat') {
        result = this.#stepBoat(service, record, v, body, bounds, input, damage, hurt, dt);
      } else if (s.tier === 'simple') {
        result = stepSimple(service, record.id, v, body, bounds, input, hurt.engine, dt);
        roll = (this.speed(record.id) * dt / wheelLayout(bounds, service.gravity, body.mass)[0]!.radius) * (180 / Math.PI);
      } else {
        const r = stepWheeled(service, record.id, v, body, bounds, input, dt, this.#tuning(record, s, hurt, dt));
        s.surfaces = r.contacts.map((c) => this.#surfaceOf(c.ground, c.inContact));
        s.skids = [...r.skids];
        result = r;
        const lock = v.steering * hurt.steer * (1 - 0.65 * Math.min(1, Math.abs(this.speed(record.id)) / Math.max(v.max_speed, 1e-6)));
        steerAngle = kind === 'tracked' ? 0 : input.steer * lock;
        roll = (body.velocity.dot(axes(body.rotation).forward) * dt / r.radius) * (180 / Math.PI);
        if (s.drivetrain !== undefined) {
          const d = record.components.get(DRIVETRAIN) as unknown as DrivetrainFields;
          revs = (s.drivetrain.rpm - d.idle_rpm) / Math.max(d.redline_rpm - d.idle_rpm, 1);
        }
      }
    }

    const after = service.body(record.id)!;
    s.slip = slipAngle(after);
    const wasAirborne = s.airborne;
    if (result.grounded) {
      if (!s.grounded && wasAirborne >= LANDING_AIRTIME) {
        const handles = this.#kernel.handles;
        this.#kernel.emit(VEHICLE_EVENTS.landed, {
          entity: handles.wrap(record.id),
          fall_speed: Math.max(0, -s.verticalSpeed),
          target: result.ground === undefined ? null : handles.wrap(result.ground),
        });
      }
      s.airborne = 0;
    } else {
      s.airborne += dt;
    }
    s.grounded = result.grounded;
    s.ground = result.ground;
    s.verticalSpeed = after.velocity.y;
    this.#present(record, {
      engineOn, throttle, revs, skidding: s.skids.some(Boolean), slip: s.slip,
      damaged: damage !== undefined && damage.parts.some((p) => p.role === 'engine' && fraction(damage, p) < 0.5),
      steerAngle, roll, dt,
      inputs: {
        pitch: live?.fly?.pitch ?? 0, roll: live?.fly?.roll ?? 0, yaw: live?.fly?.yaw ?? 0, steer: live?.drive?.steer ?? 0,
        throttle, flaps: live?.fly?.flaps ?? 0,
      },
    });
  }

  #tuning(record: EntityRecord, s: VehicleState, hurt: ReturnType<typeof effectsOf>, dt: number): WheelTuning {
    const dtFields = record.components.get(DRIVETRAIN) as unknown as DrivetrainFields | undefined;
    let drive: WheelTuning['drive'];
    if (dtFields !== undefined) {
      const state = this.drivetrain(record.id, dtFields as unknown as Fields);
      const throttle = s.controls?.drive?.throttle ?? 0;
      const engineOn = hurt.engine > 0;
      drive = (speed, radius) => stepDrivetrain(dtFields, state, { throttle: engineOn ? throttle : 0, speed, radius, dt });
    }
    return {
      drive, driven: dtFields === undefined ? 'all' : (dtFields as unknown as { drive: 'all' | 'front' | 'rear' }).drive,
      engine: hurt.engine, steer: hurt.steer, wheelGrip: hurt.wheelGrip,
      weather: this.#weatherGrip(record),
    };
  }

  /** Tyre grip under the weather: its friction out in the open, 1 under cover (a tunnel, a garage) or without weather(). */
  #weatherGrip(record: EntityRecord): number {
    const weather = this.#kernel.tryService(WEATHER_SERVICE);
    if (weather === undefined) return 1;
    const friction = weather.conditions().friction;
    return friction >= 1 || weather.sheltered(record.transform.worldPosition(), [record.id]) ? 1 : friction;
  }

  #stepBoat(
    service: Physics3dService, record: EntityRecord, v: VehicleFields, body: BodyState, bounds: LocalBounds, input: DriveInput,
    damage: DamageFields | undefined, hurt: ReturnType<typeof effectsOf>, dt: number,
  ): StepResult {
    const buoyancy = record.components.get(BUOYANCY);
    const submerged = this.#kernel.tryService(WATER_WORLD_SERVICE)?.submerged(record.id);
    if (buoyancy === undefined || submerged === undefined) {
      fail('PP7311', `${where(record)} is a boat, which floats with Buoyancy`, {
        fix: 'Add "buoyancy": {} to the prefab and water() to Game(plugins=[...]), with a water_body (an ocean, a lake) under it.',
      });
    }
    if (damage !== undefined) {
      if (!damage.wrecked) {
        const flooded = Math.min(1, Math.max(0, damage.flooded + floodRate(damage) * dt));
        if (flooded !== damage.flooded) damage.flooded = flooded;
        if (flooded >= damage.sink_at) this.#wreck(record.id, damage, 'sunk');
      }
      // The water aboard weighs it down: full, the hull is heavier than the sea it displaces.
      if (damage.flooded > 0) {
        const h = bounds.halfExtents;
        const volume = (buoyancy['volume'] as number | null) ?? 8 * h.x * h.y * h.z;
        const aboard = damage.flooded * Math.max(0, FLOODED_DENSITY * volume - body.mass);
        service.applyImpulse(record.id, new Vec3(0, -aboard * Math.abs(service.gravity) * dt, 0));
      }
      if (damage.wrecked) return { grounded: false, ground: undefined };
    }
    const flow = this.#kernel.tryService(WATER_SERVICE)?.sample(body.position)?.flow ?? Vec3.ZERO;
    const water = { bite: boatBite(submerged), drag: (buoyancy['drag'] as number) * submerged, flow };
    // Read again: the flooding weight above is in the velocity now.
    return stepBoat(service, record.id, v, service.body(record.id)!, input, dt, water, { engine: hurt.engine, speed: hurt.speed, steer: hurt.steer });
  }

  #present(record: EntityRecord, p: Presented): void {
    const effects = record.components.get(VEHICLE_EFFECTS);
    if (effects !== undefined) presentEffects(this.#kernel, record, effects, p);
    const rig = record.components.get(VEHICLE_RIG);
    if (rig !== undefined) presentRig(record, rig, p);
  }
}

