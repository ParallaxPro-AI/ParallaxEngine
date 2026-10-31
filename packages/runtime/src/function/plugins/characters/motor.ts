/**
 * The character motor: per-entity movement state and one fixed step of it. Moves go
 * through the physics3d service (Rapier's kinematic character controller); this file is
 * the gameplay layer on top — speeds, acceleration, air control, gravity, jumps (coyote
 * time, air jumps), facing, riding moving ground (carried along and turned with its spin), and the Landed / Jumped events — plus the
 * humanoid tier: stances (the capsule's height), vault/climb traversals, swimming in the
 * water service's volumes, free fall and the parachute, holding and carrying, and seats.
 *
 * Timing. `move()` is "move this frame": the intent given in frame F drives the fixed
 * steps of frames F and F+1 (game code usually calls it in `update`, which runs after
 * that frame's fixed steps), and then lapses, so a character nobody steers slows to a
 * stop at its acceleration. `jump`, `launch`, `knockback`, `stop` act on the velocity at
 * once; the next fixed step moves by it. `motion` is derived at the start of every step
 * from what the character is in (a seat, a mount, a traversal, water, the air).
 *
 * Mounts (physics3d). A seated character rides its seat, a carried one its carrier, a held
 * item its holder: physics3d turns their colliders off and keeps them on the carrier. A held
 * item is also parented to the holder's Model socket, which places it exactly (posed) every
 * frame.
 */

import { deg, fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, Fields, Kernel } from '../../kernel/index.js';
import { MODEL_RIG_SERVICE, PHYSICS3D_SERVICE, SEAT_EXITS_SERVICE, WATER_SERVICE, WATER_WORLD_SERVICE, WEATHER_SERVICE } from '../../services/index.js';
import type { CharacterMotion, CharacterShape, CharacterStance, CharacterView, Physics3dService } from '../../services/index.js';
import { animatorOf, driveParams, takeRootMotion } from './animate.js';
import { LocomotionDriver } from './locomotion_driver.js';
import { airBelow, bezier, capsuleFits, findLedge, headroom, smoothstep, traversalControl } from './probes.js';
import type { Ledge } from './probes.js';
import { characterProblems, eyeHeight } from './rules.js';
import { CHARACTER, SEAT } from './schemas.js';
import type { Carry, Parachute, Skydive, Stances, Swimming, Traversal } from './schemas.js';

export { CHARACTER, SEAT } from './schemas.js';

/** The vehicles plugin's Vehicle, by id (plugins don't import each other): its Seat children are its seats. */
const VEHICLE = 'vehicle';

/** Seconds after walking off a ledge during which `jump()` still counts as a ground jump. */
export const COYOTE_TIME = 0.1;
/** How fast the eyes follow a stance change (1/s, exponential). */
export const EYE_RATE = 12;

export const CHARACTER_EVENTS = {
  landed: { id: 'landed', target: 'entity' },
  jumped: { id: 'jumped', target: 'entity' },
  traversed: { id: 'traversed', target: 'entity' },
  stanceChanged: { id: 'stance_changed', target: 'entity' },
  motionChanged: { id: 'motion_changed', target: 'entity' },
  seated: { id: 'seated', target: 'entity' },
  leftSeat: { id: 'left_seat', target: 'entity' },
} as const;

/** Entities a held item may be attached with: the api supplies `attach(child, socket=...)`'s checks. */
export type AttachToSocket = (kernel: Kernel, parent: EntityRecord, child: EntityRecord, socket: string) => void;

interface Intent {
  readonly direction: Vec3;
  readonly speed: number | null;
  readonly run: boolean;
  readonly frame: number;
}

interface TraverseRun {
  readonly kind: 'vault' | 'climb';
  readonly from: Vec3;
  readonly control: Vec3;
  readonly to: Vec3;
  t: number;
  readonly duration: number;
}

interface SeatRun {
  readonly seat: EntityId;
  phase: 'enter' | 'sit' | 'leave';
  t: number;
  readonly duration: number;
  from: Vec3;
  fromYaw: number;
  to: Vec3;
  toYaw: number;
  readonly param: string | null;
}

export interface CharacterState {
  velocity: Vec3;
  grounded: boolean;
  ground: EntityId | undefined;
  /** Seconds since it last stood on the ground. */
  airborne: number;
  airJumpsUsed: number;
  /** A jump or launch this step: don't snap back down. */
  leaving: boolean;
  intent: Intent | undefined;
  yaw: number | undefined;
  /** The ground's velocity under the feet at the last step (moving platforms carry it). */
  groundVelocity: Vec3;
  motion: CharacterMotion;
  stance: CharacterStance;
  /** Eye height now (eases toward the stance's). */
  eye: number;
  running: boolean;
  traverse: TraverseRun | undefined;
  /** In free fall (skydive). */
  falling: boolean;
  /** Seconds since the parachute opened; undefined while closed. */
  glide: number | undefined;
  held: EntityId | undefined;
  carried: EntityId | undefined;
  seat: SeatRun | undefined;
  landed: { speed: number; frame: number } | null;
  /** Animator triggers to fire at the end of this step. */
  cues: string[];
}

function fresh(eye: number): CharacterState {
  return {
    velocity: Vec3.ZERO, grounded: false, ground: undefined, airborne: 0, airJumpsUsed: 0, leaving: false, intent: undefined, yaw: undefined,
    groundVelocity: Vec3.ZERO, motion: 'air', stance: 'stand', eye, running: false, traverse: undefined, falling: false, glide: undefined,
    held: undefined, carried: undefined, seat: undefined, landed: null, cues: [],
  };
}

function where(record: EntityRecord): string {
  return `entity ${record.placedId ?? record.prefab ?? record.id} character`;
}

function moveToward(current: Vec3, target: Vec3, maxStep: number): Vec3 {
  const d = target.__sub__(current);
  const length = d.length();
  return length <= maxStep || length === 0 ? target : current.__add__(d.__mul__(maxStep / length));
}

function approach(current: number, target: number, maxStep: number): number {
  return Math.abs(target - current) <= maxStep ? target : current + Math.sign(target - current) * maxStep;
}

/** A seat's `facing` as the rider's rotation in the seat's frame (physics keeps it while mounted). */
function seatRotation(fields: Fields): Quat {
  return Quat.from_euler(new Vec3(0, fields['facing'] as number, 0));
}

function yawOf(record: EntityRecord): number {
  return record.transform.worldRotation().to_euler().y;
}

function forward(yaw: number): Vec3 {
  const r = (yaw * Math.PI) / 180;
  return new Vec3(Math.sin(r), 0, Math.cos(r));
}

function wrap180(a: number): number {
  return ((a + 540) % 360) - 180;
}

function rec<T>(fields: Fields, key: string): T | null {
  return (fields[key] ?? null) as T | null;
}

// ── Saved state (JSON) ────────────────────────────────────────────────────────

type V = [number, number, number];
const v3 = (v: Vec3): V => [v.x, v.y, v.z];
const V3 = (a: readonly number[]): Vec3 => new Vec3(a[0]!, a[1]!, a[2]!);

export interface SavedCharacter {
  readonly entity: number;
  readonly velocity: V;
  readonly grounded: boolean;
  readonly ground: number | null;
  readonly airborne: number;
  readonly airJumpsUsed: number;
  readonly leaving: boolean;
  readonly intent: { direction: V; speed: number | null; run: boolean; frame: number } | null;
  readonly yaw: number | null;
  readonly groundVelocity: V;
  readonly motion: CharacterMotion;
  readonly stance: CharacterStance;
  readonly eye: number;
  readonly running: boolean;
  readonly traverse: { kind: 'vault' | 'climb'; from: V; control: V; to: V; t: number; duration: number } | null;
  readonly falling: boolean;
  readonly glide: number | null;
  readonly held: number | null;
  readonly carried: number | null;
  readonly seat: { seat: number; phase: SeatRun['phase']; t: number; duration: number; from: V; fromYaw: number; to: V; toYaw: number; param: string | null } | null;
  readonly landed: { speed: number; frame: number } | null;
}

/** 0..1: a splash for going into the water at this vertical speed (a step in: 0.2; a dive at 8 m/s and up: 1). */
export function splashStrength(verticalSpeed: number): number {
  return Math.min(1, 0.2 + Math.max(0, -verticalSpeed) / 10);
}

export class Characters {
  readonly #kernel: Kernel;
  readonly #attach: AttachToSocket | undefined;
  readonly #states = new Map<EntityId, CharacterState>();

  readonly #locomotion: LocomotionDriver;

  constructor(kernel: Kernel, attach: AttachToSocket | undefined) {
    this.#kernel = kernel;
    this.#attach = attach;
    this.#locomotion = new LocomotionDriver(kernel);
  }

  /** Automatic locomotion (tests, tools). */
  get locomotion(): LocomotionDriver {
    return this.#locomotion;
  }

  service(): Physics3dService {
    return this.#kernel.service(PHYSICS3D_SERVICE);
  }

  get kernel(): Kernel {
    return this.#kernel;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  #arrive(record: EntityRecord): void {
    const fields = record.components.get(CHARACTER)!;
    const problem = characterProblems(fields)[0];
    if (problem !== undefined) fail(problem.code, `${where(record)}: ${problem.message} (at character${problem.pointer})`, { fix: problem.fix });
    this.#states.set(record.id, fresh(eyeHeight(fields)));
  }

  added(records: readonly EntityRecord[]): void {
    for (const record of records) {
      if (record.components.has(CHARACTER) && !this.#states.has(record.id)) this.#arrive(record);
    }
  }

  removed(records: readonly EntityRecord[]): void {
    const gone = new Set(records.map((r) => r.id));
    for (const record of records) {
      const s = this.#states.get(record.id);
      if (s?.seat !== undefined) this.#vacate(s.seat.seat, record.id);
      this.#states.delete(record.id);
      this.#locomotion.forget(record.id);
    }
    // What the living held, carried or sat on may be gone.
    for (const s of this.#states.values()) {
      if (s.held !== undefined && gone.has(s.held)) s.held = undefined;
      if (s.carried !== undefined && gone.has(s.carried)) s.carried = undefined;
      if (s.seat !== undefined && gone.has(s.seat.seat)) s.seat = undefined;
    }
  }

  changed(record: EntityRecord): void {
    if (record.components.has(CHARACTER)) {
      if (!this.#states.has(record.id)) this.#arrive(record);
      return;
    }
    if (this.#states.delete(record.id)) this.#kernel.tryService(PHYSICS3D_SERVICE)?.releaseCharacter(record.id);
  }

  state(entity: EntityId): CharacterState {
    const s = this.#states.get(entity);
    if (s === undefined) {
      fail('PP3120', `Entity ${entity as number} has no Character`, { fix: 'Use the Character of an entity that has one.' });
    }
    return s;
  }

  view(entity: EntityId): CharacterView | undefined {
    const s = this.#states.get(entity);
    if (s === undefined) return undefined;
    return {
      motion: s.motion, stance: s.stance, velocity: this.velocity(entity), grounded: s.grounded, running: s.running,
      eye: new Vec3(0, s.eye, 0), landed: s.landed,
    };
  }

  snapshot(): SavedCharacter[] {
    return [...this.#states].map(([entity, s]) => ({
      entity: entity as number,
      velocity: v3(s.velocity),
      grounded: s.grounded,
      ground: s.ground === undefined ? null : s.ground as number,
      airborne: s.airborne,
      airJumpsUsed: s.airJumpsUsed,
      leaving: s.leaving,
      intent: s.intent === undefined ? null : { direction: v3(s.intent.direction), speed: s.intent.speed, run: s.intent.run, frame: s.intent.frame },
      yaw: s.yaw ?? null,
      groundVelocity: v3(s.groundVelocity),
      motion: s.motion,
      stance: s.stance,
      eye: s.eye,
      running: s.running,
      traverse: s.traverse === undefined ? null : {
        kind: s.traverse.kind, from: v3(s.traverse.from), control: v3(s.traverse.control), to: v3(s.traverse.to), t: s.traverse.t, duration: s.traverse.duration,
      },
      falling: s.falling,
      glide: s.glide ?? null,
      held: s.held === undefined ? null : s.held as number,
      carried: s.carried === undefined ? null : s.carried as number,
      seat: s.seat === undefined ? null : {
        seat: s.seat.seat as number, phase: s.seat.phase, t: s.seat.t, duration: s.seat.duration, from: v3(s.seat.from), fromYaw: s.seat.fromYaw,
        to: v3(s.seat.to), toYaw: s.seat.toYaw, param: s.seat.param,
      },
      landed: s.landed,
    }));
  }

  restore(saved: readonly SavedCharacter[]): void {
    this.#states.clear();
    const byId = new Map(saved.map((s) => [s.entity, s]));
    const world = this.#kernel.world;
    const alive = (id: number | null): EntityId | undefined => (id === null || !world.isAlive(id as EntityId) ? undefined : id as EntityId);
    for (const record of world.live()) {
      const fields = record.components.get(CHARACTER);
      if (fields === undefined) continue;
      const s = byId.get(record.id as number);
      if (s === undefined) {
        this.#states.set(record.id, fresh(eyeHeight(fields)));
        continue;
      }
      const seat = s.seat === null || alive(s.seat.seat) === undefined ? undefined : {
        seat: s.seat.seat as EntityId, phase: s.seat.phase, t: s.seat.t, duration: s.seat.duration, from: V3(s.seat.from), fromYaw: s.seat.fromYaw,
        to: V3(s.seat.to), toYaw: s.seat.toYaw, param: s.seat.param,
      };
      this.#states.set(record.id, {
        velocity: V3(s.velocity),
        grounded: s.grounded,
        ground: alive(s.ground),
        airborne: s.airborne,
        airJumpsUsed: s.airJumpsUsed,
        leaving: s.leaving,
        intent: s.intent === null ? undefined : { direction: V3(s.intent.direction), speed: s.intent.speed, run: s.intent.run, frame: s.intent.frame },
        yaw: s.yaw ?? undefined,
        groundVelocity: V3(s.groundVelocity),
        motion: s.motion,
        stance: s.stance,
        eye: s.eye,
        running: s.running,
        traverse: s.traverse === null ? undefined : {
          kind: s.traverse.kind, from: V3(s.traverse.from), control: V3(s.traverse.control), to: V3(s.traverse.to), t: s.traverse.t, duration: s.traverse.duration,
        },
        falling: s.falling,
        glide: s.glide ?? undefined,
        held: alive(s.held),
        carried: alive(s.carried),
        seat,
        landed: s.landed,
        cues: [],
      });
    }
  }

  // ── Shapes ───────────────────────────────────────────────────────────────────

  #stanceHeight(fields: Fields, stance: CharacterStance): number {
    const stances = rec<Stances>(fields, 'stances');
    if (stance === 'stand' || stances === null) return fields['height'] as number;
    return stance === 'crouch' ? stances.crouch_height : stances.prone_height;
  }

  #shape(fields: Fields, stance: CharacterStance): CharacterShape {
    return {
      radius: fields['radius'] as number,
      height: this.#stanceHeight(fields, stance),
      stepHeight: stance === 'prone' ? Math.min(fields['step_height'] as number, 0.1) : fields['step_height'] as number,
      maxSlope: fields['max_slope'] as number,
    };
  }

  carrierOf(entity: EntityId): EntityId | undefined {
    for (const [carrier, s] of this.#states) if (s.carried === entity) return carrier;
    return undefined;
  }

  /** The vehicle whose seat (a Seat child of a Vehicle) the character is in or getting into. */
  vehicleOf(entity: EntityId): EntityId | undefined {
    const run = this.#states.get(entity)?.seat;
    if (run === undefined || run.phase === 'leave') return undefined;
    return this.#vehicleOfSeat(run.seat);
  }

  #vehicleOfSeat(seat: EntityId): EntityId | undefined {
    const parent = this.#kernel.world.peek(seat)?.parent ?? null;
    if (parent === null) return undefined;
    return this.#kernel.world.peek(parent)?.components.has(VEHICLE) === true ? parent : undefined;
  }

  #holderOf(entity: EntityId): EntityId | undefined {
    for (const [holder, s] of this.#states) if (s.held === entity) return holder;
    return undefined;
  }

  // ── Commands (component methods) ─────────────────────────────────────────────

  move(entity: EntityId, direction: Vec3, speed: number | null, run: boolean): void {
    if (speed !== null && speed < 0) fail('PP3173', `move(speed=${speed}) can't be negative`, { fix: 'Pass a speed in m/s ≥ 0, or reverse the direction.' });
    this.state(entity).intent = { direction, speed, run, frame: this.#kernel.time.frame };
  }

  jump(entity: EntityId, fields: Fields): boolean {
    const s = this.state(entity);
    const service = this.service();
    if (s.seat !== undefined || s.traverse !== undefined || service.mountOf(entity) !== undefined || service.ragdollOf(entity) !== undefined) return false;
    const record = this.#kernel.world.require(entity);
    const traversal = rec<Traversal>(fields, 'traversal');
    if (s.motion === 'swim') {
      // Out of the water onto a ledge, else nothing (swimmers rise with move()).
      const ledge = traversal === null ? undefined : this.#ledge(record, fields, s, traversal, false);
      if (ledge === undefined) return false;
      this.#startTraverse(record, s, ledge, traversal!);
      return true;
    }
    if (s.falling) {
      const chute = rec<Parachute>(fields, 'parachute');
      if (chute === null || s.glide !== undefined) return false;
      if (airBelow(service, entity, record.transform.worldPosition(), chute.min_height) <= chute.min_height) return false;
      s.glide = 0;
      return true;
    }
    if (s.glide !== undefined || s.stance === 'prone') return false;
    if (s.stance === 'crouch' && !this.setStance(entity, fields, 'stand')) return false;
    const onGround = s.grounded || (s.airborne <= COYOTE_TIME && !s.leaving && s.velocity.y <= 0);
    if (onGround && traversal !== null && s.carried === undefined) {
      const ledge = this.#ledge(record, fields, s, traversal);
      if (ledge !== undefined) {
        this.#startTraverse(record, s, ledge, traversal);
        return true;
      }
    }
    const airJumps = fields['air_jumps'] as number;
    if (!onGround && s.airJumpsUsed >= airJumps) return false;
    if (!onGround) s.airJumpsUsed++;
    const g = Math.abs(service.gravity * (fields['gravity_scale'] as number));
    const up = Math.sqrt(2 * g * (fields['jump_height'] as number));
    s.velocity = s.velocity.with_y(up);
    s.grounded = false;
    s.ground = undefined;
    s.leaving = true;
    // A ground (or coyote) jump uses up the coyote window.
    if (onGround) s.airborne = COYOTE_TIME + 1e-9;
    s.cues.push('jumped');
    this.#kernel.emit(CHARACTER_EVENTS.jumped, { entity: this.#kernel.handles.wrap(entity), in_air: !onGround });
    return true;
  }

  launch(entity: EntityId, velocity: Vec3): void {
    const s = this.state(entity);
    s.velocity = velocity;
    s.grounded = false;
    s.ground = undefined;
    s.leaving = true;
  }

  /** Add `push` (m/s) to the character's velocity. */
  knockback(entity: EntityId, push: Vec3): void {
    const s = this.state(entity);
    s.velocity = s.velocity.__add__(push);
    if (push.y > 0) {
      s.grounded = false;
      s.ground = undefined;
      s.leaving = true;
    }
  }

  stop(entity: EntityId): void {
    const s = this.state(entity);
    s.velocity = Vec3.ZERO;
    s.intent = undefined;
  }

  face(entity: EntityId, yaw: number): void {
    const record = this.#kernel.world.require(entity);
    this.state(entity).yaw = yaw;
    this.#setYaw(record, yaw);
  }

  teleport(entity: EntityId, position: Vec3, yaw: number | undefined): void {
    const service = this.service();
    if (service.mountOf(entity) !== undefined || this.state(entity).seat !== undefined) {
      fail('PP3174', 'teleport() on a character that is seated, carried or riding a vehicle', {
        fix: 'Call leave_seat(), put_down() or vehicle.exit(driver) first, then teleport.',
      });
    }
    const s = this.state(entity);
    s.traverse = undefined;
    service.teleport(entity, position, yaw === undefined ? undefined : Quat.from_euler(new Vec3(0, yaw, 0)), true);
    if (yaw !== undefined) s.yaw = yaw;
  }

  velocity(entity: EntityId): Vec3 {
    const mount = this.service().mountOf(entity);
    if (mount !== undefined) return this.#carrierVelocity(mount.carrier);
    return this.state(entity).velocity;
  }

  /** What a mounted rider moves with: the carrier's body, or the nearest ancestor with one (a Seat child rides its Vehicle). */
  #carrierVelocity(carrier: EntityId): Vec3 {
    const service = this.service();
    let at: EntityId | null = carrier;
    while (at !== null) {
      const body = service.body(at);
      if (body !== undefined) return body.velocity;
      at = this.#kernel.world.peek(at)?.parent ?? null;
    }
    return Vec3.ZERO;
  }

  setStance(entity: EntityId, fields: Fields, stance: CharacterStance): boolean {
    const s = this.state(entity);
    const stances = rec<Stances>(fields, 'stances');
    if (stance !== 'stand' && stances === null) {
      fail('PP3175', `set_stance("${stance}") on a character without stances`, { fix: 'Give its Character "stances": {} (and "prone": true for prone).' });
    }
    if (stance === 'prone' && !stances!.prone) {
      fail('PP3175', 'set_stance("prone") on a character whose stances don\'t allow prone', { fix: 'Set "stances": {"prone": true}.' });
    }
    if (stance === s.stance) return true;
    if (s.traverse !== undefined || s.seat !== undefined || this.service().mountOf(entity) !== undefined) return false;
    if (s.motion === 'swim' || s.falling || s.glide !== undefined) return false;
    if (stance === 'prone' && !s.grounded) return false;
    const record = this.#kernel.world.require(entity);
    const from = this.#stanceHeight(fields, s.stance);
    const to = this.#stanceHeight(fields, stance);
    if (!headroom(this.service(), entity, record.transform.worldPosition(), fields['radius'] as number, from, to)) return false;
    s.stance = stance;
    this.#kernel.emit(CHARACTER_EVENTS.stanceChanged, { entity: this.#kernel.handles.wrap(entity), stance });
    return true;
  }

  releaseParachute(entity: EntityId): boolean {
    const s = this.state(entity);
    if (s.glide === undefined) return false;
    s.glide = undefined;
    s.falling = true;
    return true;
  }

  /** What jump() would do at the ledge ahead now. */
  ledge(entity: EntityId, fields: Fields): 'vault' | 'climb' | null {
    const s = this.state(entity);
    const traversal = rec<Traversal>(fields, 'traversal');
    if (traversal === null || s.traverse !== undefined || s.seat !== undefined || this.service().mountOf(entity) !== undefined) return null;
    if (s.motion !== 'swim' && !s.grounded) return null;
    const ledge = this.#ledge(this.#kernel.world.require(entity), fields, s, traversal, s.motion !== 'swim');
    return ledge === undefined ? null : ledge.kind;
  }

  eye(entity: EntityId): Vec3 {
    const record = this.#kernel.world.require(entity);
    const t = record.transform;
    return t.worldPosition().__add__(new Vec3(0, this.state(entity).eye * t.worldScale().y, 0));
  }

  // ── Holding and carrying ─────────────────────────────────────────────────────

  #busy(entity: EntityId): boolean {
    return this.service().mountOf(entity) !== undefined || this.#holderOf(entity) !== undefined || this.carrierOf(entity) !== undefined;
  }

  hold(entity: EntityId, fields: Fields, item: EntityId, socket: string | null): boolean {
    const s = this.state(entity);
    if (item === entity) fail('PP3198', 'A character can\'t hold itself', { fix: 'Hold another entity.' });
    if (s.held !== undefined || this.#busy(item)) return false;
    const kernel = this.#kernel;
    const holder = kernel.world.require(entity);
    const thing = kernel.world.require(item);
    const name = socket ?? fields['hold_socket'] as string;
    let seat = fields['hold_offset'] as Vec3;
    if (holder.components.has('model')) {
      if (this.#attach === undefined) fail('PP9162', 'characters() was built without its socket attacher', { fix: 'Build it through the api (parallax.plugins.characters()).' });
      this.#attach(kernel, holder, thing, name);
      const frame = kernel.tryService(MODEL_RIG_SERVICE)?.socket(entity, name, 'local');
      if (frame !== null && frame !== undefined) seat = frame.position;
    } else {
      kernel.world.attach(thing, holder);
      thing.transform.position = seat;
      thing.transform.rotation = Quat.IDENTITY;
    }
    this.service().mount(item, entity, seat);
    s.held = item;
    return true;
  }

  /** Let go of the held item: unparented where it is now, physics back on. */
  #release(entity: EntityId): EntityRecord | undefined {
    const s = this.state(entity);
    if (s.held === undefined) return undefined;
    const kernel = this.#kernel;
    const item = kernel.world.get(s.held);
    s.held = undefined;
    if (item === undefined) return undefined;
    const position = item.transform.worldPosition();
    const rotation = item.transform.worldRotation();
    if (item.components.has('socket')) kernel.removeComponent(item.id, 'socket');
    kernel.world.detach(item);
    item.transform.position = position;
    item.transform.rotation = rotation;
    const service = this.service();
    service.dismount(item.id);
    service.teleport(item.id, position, rotation, false);
    return item;
  }

  drop(entity: EntityId): unknown {
    const item = this.#release(entity);
    return item === undefined ? null : this.#kernel.handles.wrap(item.id);
  }

  throw(entity: EntityId, velocity: Vec3): unknown {
    const s = this.state(entity);
    if (s.held !== undefined && this.service().body(s.held)?.kind !== 'dynamic') {
      fail('PP3198', 'throw(): the held item has no dynamic Rigidbody, so it can\'t fly', {
        fix: 'Give the item "rigidbody": {"kind": "dynamic"}, or drop()/place() it.',
      });
    }
    const item = this.#release(entity);
    if (item === undefined) return null;
    this.service().setVelocity(item.id, velocity);
    return this.#kernel.handles.wrap(item.id);
  }

  place(entity: EntityId, position: Vec3, yaw: number): unknown {
    const item = this.#release(entity);
    if (item === undefined) return null;
    const service = this.service();
    const rotation = Quat.from_euler(new Vec3(0, yaw, 0));
    item.transform.setWorldPosition(position);
    item.transform.rotation = rotation;
    service.teleport(item.id, position, rotation, false);
    return this.#kernel.handles.wrap(item.id);
  }

  lift(entity: EntityId, fields: Fields, other: EntityId): boolean {
    const s = this.state(entity);
    const carry = rec<Carry>(fields, 'carry');
    if (carry === null) fail('PP3198', 'lift() on a character without carry', { fix: 'Give its Character "carry": {}.' });
    if (other === entity) fail('PP3198', 'A character can\'t lift itself', { fix: 'Lift another entity.' });
    if (s.carried !== undefined || s.seat !== undefined || this.#busy(other) || this.service().mountOf(entity) !== undefined) return false;
    const target = this.#states.get(other);
    if (target !== undefined && (target.seat !== undefined || target.carried !== undefined)) return false;
    if (target !== undefined) {
      target.traverse = undefined;
      target.glide = undefined;
      target.falling = false;
    }
    this.service().mount(other, entity, carry.offset);
    s.carried = other;
    if (s.stance !== 'stand') s.stance = 'stand';
    return true;
  }

  putDown(entity: EntityId, fields: Fields): unknown {
    const s = this.state(entity);
    if (s.carried === undefined) return null;
    const carry = rec<Carry>(fields, 'carry')!;
    const kernel = this.#kernel;
    const me = kernel.world.require(entity);
    const other = kernel.world.require(s.carried);
    const service = this.service();
    const spot = me.transform.worldPosition().__add__(me.transform.worldRotation().rotate(carry.drop));
    // Onto the floor under the drop point.
    const floor = service.raycast(spot.__add__(new Vec3(0, 1.5, 0)), Vec3.DOWN, 4, { ignore: [entity, other.id] });
    const at = floor === undefined ? spot : floor.point;
    const otherFields = other.components.get(CHARACTER);
    const radius = (otherFields?.['radius'] as number | undefined) ?? 0.3;
    const height = otherFields === undefined ? radius * 2 : this.#stanceHeight(otherFields, this.#states.get(other.id)?.stance ?? 'stand');
    service.dismount(other.id);
    if (!capsuleFits(service, other.id, at, radius, height)) {
      service.mount(other.id, entity, carry.offset);
      return null;
    }
    s.carried = undefined;
    service.teleport(other.id, at, me.transform.worldRotation(), false);
    const target = this.#states.get(other.id);
    if (target !== undefined) {
      target.velocity = Vec3.ZERO;
      target.grounded = false;
    }
    return kernel.handles.wrap(other.id);
  }

  // ── Seats ────────────────────────────────────────────────────────────────────

  #seatTarget(seat: EntityRecord, fields: Fields): { position: Vec3; yaw: number } {
    const t = seat.transform;
    return {
      position: t.worldPosition().__add__(t.worldRotation().rotate(fields['offset'] as Vec3)),
      yaw: yawOf(seat) + (fields['facing'] as number),
    };
  }

  sit(entity: EntityId, seatId: EntityId): boolean {
    const kernel = this.#kernel;
    const seat = kernel.world.require(seatId);
    const fields = seat.components.get(SEAT);
    if (fields === undefined) fail('PP3198', 'sit(): that entity has no Seat', { fix: 'Give it a "seat" component.' });
    const s = this.state(entity);
    if (fields['enabled'] !== true || fields['occupant'] !== null) return false;
    if (s.seat !== undefined || s.carried !== undefined || s.traverse !== undefined || this.#busy(entity)) return false;
    const me = kernel.world.require(entity);
    const target = this.#seatTarget(seat, fields);
    const duration = fields['enter_time'] as number;
    s.seat = {
      seat: seatId, phase: 'enter', t: 0, duration, from: me.transform.worldPosition(), fromYaw: s.yaw ?? yawOf(me),
      to: target.position, toYaw: target.yaw, param: fields['param'] as string | null,
    };
    s.intent = undefined;
    s.velocity = Vec3.ZERO;
    s.falling = false;
    s.glide = undefined;
    if (s.stance !== 'stand') s.stance = 'stand';
    fields['occupant'] = kernel.handles.wrap(entity);
    if (duration === 0) this.#seatDown(me, s);
    return true;
  }

  #seatDown(me: EntityRecord, s: CharacterState): void {
    const run = s.seat!;
    const seat = this.#kernel.world.require(run.seat);
    const fields = seat.components.get(SEAT)!;
    run.phase = 'sit';
    run.t = 1;
    this.service().mount(me.id, run.seat, fields['offset'] as Vec3, seatRotation(fields));
    s.yaw = this.#seatTarget(seat, fields).yaw;
    this.#setYaw(me, s.yaw);
    this.#kernel.emit(CHARACTER_EVENTS.seated, { entity: this.#kernel.handles.wrap(me.id), target: this.#kernel.handles.wrap(run.seat) });
  }

  #vacate(seatId: EntityId, entity: EntityId): void {
    const fields = this.#kernel.world.peek(seatId)?.components.get(SEAT);
    if (fields !== undefined && this.#kernel.handles.unwrap(fields['occupant']) === entity) fields['occupant'] = null;
  }

  leaveSeat(entity: EntityId, fields: Fields): boolean {
    const s = this.state(entity);
    const run = s.seat;
    if (run === undefined || run.phase === 'leave') return false;
    const kernel = this.#kernel;
    const me = kernel.world.require(entity);
    const seat = kernel.world.require(run.seat);
    const seatFields = seat.components.get(SEAT)!;
    const service = this.service();
    const radius = fields['radius'] as number;
    const height = fields['height'] as number;
    const exits = (seatFields['exits'] as Vec3[]).map((local) => seat.transform.worldPosition().__add__(seat.transform.worldRotation().rotate(local)));
    // A seat its host manages (a vehicle's) without its own exits: the host's (beside the seat, …, the roof).
    if (exits.length === 0) exits.push(...(kernel.tryService(SEAT_EXITS_SERVICE)?.exits(run.seat, entity) ?? []));
    if (exits.length === 0) exits.push(run.from);
    service.dismount(entity);
    const exit = exits.find((p) => capsuleFits(service, entity, p, radius, height));
    if (exit === undefined) {
      if (run.phase === 'sit') service.mount(entity, run.seat, seatFields['offset'] as Vec3, seatRotation(seatFields));
      return false;
    }
    this.#vacate(run.seat, entity);
    const here = run.phase === 'sit' ? this.#seatTarget(seat, seatFields) : { position: me.transform.worldPosition(), yaw: s.yaw ?? yawOf(me) };
    run.phase = 'leave';
    run.t = 0;
    run.from = here.position;
    run.fromYaw = here.yaw;
    run.to = exit;
    run.toYaw = here.yaw;
    if (run.duration === 0) this.#standUp(me, s);
    return true;
  }

  #standUp(me: EntityRecord, s: CharacterState): void {
    const run = s.seat!;
    this.service().teleport(me.id, run.to, undefined, false);
    s.seat = undefined;
    s.velocity = Vec3.ZERO;
    s.grounded = false;
    this.#kernel.emit(CHARACTER_EVENTS.leftSeat, { entity: this.#kernel.handles.wrap(me.id), target: this.#kernel.handles.wrap(run.seat) });
  }

  // ── The fixed step ───────────────────────────────────────────────────────────

  step(dt: number): void {
    if (this.#states.size === 0) return;
    const service = this.service();
    const frame = this.#kernel.time.frame;
    for (const [entity, s] of [...this.#states]) {
      const record = this.#kernel.world.get(entity);
      if (record === undefined) continue;
      const fields = record.components.get(CHARACTER);
      if (fields === undefined) continue;
      const before = s.motion;
      s.running = false;
      this.#stepOne(service, record, fields, s, dt, frame);
      const target = this.#stanceHeight(fields, s.motion === 'swim' ? 'stand' : s.stance) / (fields['height'] as number) * eyeHeight(fields);
      s.eye = target + (s.eye - target) * Math.exp(-EYE_RATE * dt);
      if (Math.abs(s.eye - target) < 1e-4) s.eye = target;
      if (s.motion !== before) {
        this.#kernel.emit(CHARACTER_EVENTS.motionChanged, { entity: this.#kernel.handles.wrap(entity), motion: s.motion, previous: before });
      }
      this.#animate(record, fields, s, dt);
    }
  }

  #animate(record: EntityRecord, fields: Fields, s: CharacterState, dt: number): void {
    const cues = s.cues;
    s.cues = [];
    if (fields['animate'] !== true) return;
    const animator = animatorOf(record);
    if (animator === undefined) return;
    const intent = s.intent;
    const rooted = animator['root_motion'] === 'character';
    const speed = rooted
      ? (intent === undefined ? 0 : this.#targetSpeed(fields, s, intent))
      : s.velocity.flat().length();
    const extra: Record<string, boolean> = {};
    if (s.seat?.param !== null && s.seat?.param !== undefined) extra[s.seat.param] = s.seat.phase !== 'leave';
    const velocity = this.velocity(record.id);
    const loco = this.#locomotion.step(record, fields, animator, {
      input: {
        motion: s.motion, stance: s.stance, traversal: s.traverse?.kind ?? null, grounded: s.grounded,
        velocity: { x: velocity.x, y: velocity.y, z: velocity.z }, yaw: s.yaw ?? yawOf(record), running: s.running, landed: null, dt,
      },
      walkSpeed: fields['walk_speed'] as number, runSpeed: fields['run_speed'] as number, landed: s.landed,
    });
    driveParams(record, animator, {
      speed,
      forward_speed: loco.forward_speed,
      strafe_speed: loco.strafe_speed,
      direction: loco.direction,
      turn_rate: loco.turn_rate,
      vertical_speed: s.velocity.y,
      stance: s.stance === 'stand' ? 0 : s.stance === 'crouch' ? 1 : 2,
      grounded: s.grounded,
      running: s.running,
      crouched: s.stance === 'crouch',
      prone: s.stance === 'prone',
      swimming: s.motion === 'swim',
      traversing: s.motion === 'traverse',
      seated: s.seat !== undefined && s.seat.phase !== 'leave',
      falling: s.motion === 'free_fall',
      gliding: s.motion === 'glide',
      holding: s.held !== undefined,
      carrying: s.carried !== undefined,
    }, cues, extra);
  }

  #stepOne(service: Physics3dService, record: EntityRecord, fields: Fields, s: CharacterState, dt: number, frame: number): void {
    const mode = fields['mode'] as string;
    if (mode !== '3d') {
      fail('PP3171', `${where(record)}.mode is "${mode}", which needs a 2D character controller on physics2d; this engine build moves characters in 3D only`, {
        fix: 'Use mode "3d" with physics3d(), or move a 2D body with its Rigidbody.',
      });
    }
    const intent = s.intent !== undefined && s.intent.frame >= frame - 1 ? s.intent : undefined;
    if (intent === undefined) s.intent = undefined;

    if (s.seat !== undefined) {
      this.#stepSeat(record, s, dt);
      s.motion = s.seat !== undefined && this.#vehicleOfSeat(s.seat.seat) !== undefined ? 'riding' : 'seated';
      return;
    }
    const mount = service.mountOf(record.id);
    if (mount !== undefined) {
      s.grounded = false;
      s.ground = undefined;
      s.velocity = this.#carrierVelocity(mount.carrier);
      s.intent = undefined;
      s.falling = false;
      s.glide = undefined;
      s.motion = this.carrierOf(record.id) !== undefined ? 'carried' : 'riding';
      return;
    }
    if (service.ragdollOf(record.id) !== undefined) {
      // Limp or recovering: physics poses the body; the character neither moves nor steers.
      s.velocity = Vec3.ZERO;
      s.grounded = false;
      s.ground = undefined;
      s.intent = undefined;
      s.traverse = undefined;
      s.falling = false;
      s.glide = undefined;
      s.motion = 'ragdoll';
      return;
    }
    if (s.traverse !== undefined) {
      this.#stepTraverse(service, record, s, dt);
      s.motion = 'traverse';
      return;
    }

    const swim = rec<Swimming>(fields, 'swim');
    if (swim !== null) {
      const feet = record.transform.worldPosition();
      const water = this.#kernel.service(WATER_SERVICE).sample(feet);
      const depth = water === undefined ? 0 : water.surface - feet.y;
      const swimming = s.motion === 'swim' ? depth >= swim.exit_depth && !(s.grounded && depth < swim.enter_depth) : depth >= swim.enter_depth;
      if (swimming && water !== undefined) {
        if (s.motion !== 'swim') {
          // Into the water: a splash where it went in (the water plugin draws it; it is in its snapshot).
          this.#kernel.tryService(WATER_WORLD_SERVICE)?.splash(feet.with_y(water.surface), splashStrength(s.velocity.y));
          s.falling = false;
          s.glide = undefined;
          if (s.stance !== 'stand') s.stance = 'stand';
        }
        this.#stepSwim(service, record, fields, s, swim, depth, water.flow, intent, dt);
        s.motion = 'swim';
        return;
      }
    }

    const skydive = rec<Skydive>(fields, 'skydive');
    if (skydive !== null && !s.grounded) {
      const feet = record.transform.worldPosition();
      if (!s.falling && s.glide === undefined && -s.velocity.y > skydive.enter_speed
        && airBelow(service, record.id, feet, skydive.enter_height) > skydive.enter_height) {
        s.falling = true;
        if (s.stance !== 'stand') s.stance = 'stand';
      }
      if (s.glide !== undefined || s.falling) {
        if (s.glide !== undefined) {
          this.#stepGlide(service, record, fields, s, skydive, rec<Parachute>(fields, 'parachute')!, intent, dt);
        } else {
          const chute = rec<Parachute>(fields, 'parachute');
          if (chute !== null && chute.auto_height > 0 && airBelow(service, record.id, feet, chute.auto_height) < chute.auto_height) s.glide = 0;
          this.#stepFreeFall(service, record, fields, s, skydive, intent, dt);
        }
        const flying = s.glide !== undefined ? 'glide' : 'free_fall';
        if (s.grounded) {
          s.falling = false;
          s.glide = undefined;
        }
        s.motion = s.grounded ? 'ground' : flying;
        return;
      }
    }
    if (s.grounded) {
      s.falling = false;
      s.glide = undefined;
    }
    this.#stepWalk(service, record, fields, s, intent, dt);
    s.motion = s.grounded ? 'ground' : 'air';
  }

  /** The horizontal speed `move()` asks for, after stance, carry and run rules. */
  #targetSpeed(fields: Fields, s: CharacterState, intent: Intent): number {
    const length = intent.direction.flat().length();
    const run = intent.run && s.stance === 'stand' && s.carried === undefined;
    let speed = intent.speed ?? (run ? fields['run_speed'] as number : fields['walk_speed'] as number) * Math.min(1, length);
    const stances = rec<Stances>(fields, 'stances');
    if (stances !== null && s.stance === 'crouch') speed = Math.min(speed, stances.crouch_speed);
    if (stances !== null && s.stance === 'prone') speed = Math.min(speed, stances.prone_speed);
    const carry = rec<Carry>(fields, 'carry');
    if (s.carried !== undefined && carry !== null) speed *= carry.speed_scale;
    return length > 0 ? speed : 0;
  }

  /**
   * Move by `travel` m/s (mean over the step) through the controller and keep what actually
   * happened: walls stop horizontal speed, ground and ceilings vertical. `before` is the
   * velocity at the end of the step if nothing blocks it.
   */
  #resolve(service: Physics3dService, record: EntityRecord, fields: Fields, s: CharacterState, before: Vec3, travel: Vec3, snap: boolean,
    dt: number, landEvents: boolean): void {
    const carry = s.grounded ? s.groundVelocity : Vec3.ZERO;
    // A turning deck (a ship, a carousel) turns the heading with it, as it carries the feet.
    if (s.grounded && s.ground !== undefined) {
      const spin = service.body(s.ground)?.angularVelocity.y ?? 0;
      if (spin !== 0) {
        s.yaw = (s.yaw ?? yawOf(record)) + spin * dt;
        this.#setYaw(record, s.yaw);
      }
    }
    // `lock_axes`: nothing moves the character along a locked axis (input, knockback, a
    // drifting platform, the controller sliding it round a curved wall).
    const locks = fields['lock_axes'] as readonly string[];
    const lockX = locks.includes('x');
    const lockZ = locks.includes('z');
    const unlocked = (v: Vec3): Vec3 => (lockX || lockZ ? new Vec3(lockX ? 0 : v.x, v.y, lockZ ? 0 : v.z) : v);
    const lane = record.transform.worldPosition();
    const step = service.moveCharacter(record.id, this.#shape(fields, s.stance), unlocked(travel.__mul__(dt).__add__(carry.__mul__(dt))), snap);
    if (lockX || lockZ) {
      const at = record.transform.worldPosition();
      if ((lockX && at.x !== lane.x) || (lockZ && at.z !== lane.z)) {
        record.transform.setWorldPosition(new Vec3(lockX ? lane.x : at.x, at.y, lockZ ? lane.z : at.z));
      }
    }
    const movedOwn = unlocked(step.moved.__sub__(carry.__mul__(dt)).__truediv__(dt));
    let h = unlocked(before).flat();
    const hMoved = movedOwn.flat();
    // Blocked (a wall, or sliding along one): keep only the speed that moved it. The
    // 1% tolerance absorbs the controller's contact round-off on a free move.
    if (hMoved.length() < h.length() * 0.99) h = hMoved;
    let finalVy = before.y;
    const wasGrounded = s.grounded;
    if (step.grounded && finalVy <= 0) finalVy = 0;
    if (step.blockedAbove && finalVy > 0) finalVy = 0;
    s.velocity = new Vec3(h.x, finalVy, h.z);
    s.grounded = step.grounded && before.y <= 0;
    s.ground = s.grounded ? step.ground : undefined;
    s.leaving = false;
    if (s.grounded) {
      s.airborne = 0;
      s.airJumpsUsed = 0;
      s.groundVelocity = step.groundVelocity;
    } else {
      s.airborne += dt;
      s.groundVelocity = Vec3.ZERO;
    }
    if (landEvents && s.grounded && !wasGrounded) {
      const fall = Math.max(0, -before.y);
      s.landed = { speed: fall, frame: this.#kernel.time.frame };
      s.cues.push('landed');
      this.#kernel.emit(CHARACTER_EVENTS.landed, {
        entity: this.#kernel.handles.wrap(record.id),
        fall_speed: fall,
        target: s.ground === undefined ? null : this.#kernel.handles.wrap(s.ground),
      });
    }
  }

  /** Ground traction under the weather: its friction out in the open (wet, snowed over), 1 under cover or without weather(). */
  #weatherGrip(record: EntityRecord): number {
    const weather = this.#kernel.tryService(WEATHER_SERVICE);
    if (weather === undefined) return 1;
    const friction = weather.conditions().friction;
    return friction >= 1 || weather.sheltered(record.transform.worldPosition(), [record.id]) ? 1 : friction;
  }

  #stepWalk(service: Physics3dService, record: EntityRecord, fields: Fields, s: CharacterState, intent: Intent | undefined, dt: number): void {
    const g = service.gravity * (fields['gravity_scale'] as number);

    // Horizontal: approach the target velocity at `acceleration` (air: × air_control).
    let target = Vec3.ZERO;
    if (intent !== undefined) {
      const flat = intent.direction.flat();
      const length = flat.length();
      if (length > 0) target = flat.__mul__(this.#targetSpeed(fields, s, intent) / length);
      s.running = intent.run && s.stance === 'stand' && s.carried === undefined && length > 0 && s.grounded;
    }
    const grip = s.grounded ? this.#weatherGrip(record) : fields['air_control'] as number;
    const acceleration = (fields['acceleration'] as number) * grip;
    let horizontal = moveToward(s.velocity.flat(), target, acceleration * dt);

    // Root motion: the clip's travel replaces the steered speed (gravity still applies).
    const animator = animatorOf(record);
    const root = animator === undefined ? undefined : takeRootMotion(animator);
    if (root !== undefined) {
      horizontal = root.offset.flat().__truediv__(dt);
      if (root.turn !== 0) {
        s.yaw = (s.yaw ?? yawOf(record)) + root.turn;
        this.#setYaw(record, s.yaw);
      }
    }

    // Vertical: gravity; standing on the ground cancels the fall.
    let vy0 = s.velocity.y;
    if (s.grounded && vy0 < 0) vy0 = 0;
    const vy = vy0 + g * dt;
    const before = new Vec3(horizontal.x, vy, horizontal.z);
    // The step's displacement uses the mean vertical speed, so a jump peaks at exactly
    // jump_height and a fall covers ½·g·t².
    const travel = new Vec3(horizontal.x, (vy0 + vy) / 2, horizontal.z);
    this.#resolve(service, record, fields, s, before, travel, s.grounded && !s.leaving && vy <= 0, dt, true);
    if (root === undefined) this.#faceToward(record, fields, s, target, s.velocity.flat(), dt);
    else if (target.length() > 0.01 && fields['face_movement'] === true && root.turn === 0) this.#faceToward(record, fields, s, target, Vec3.ZERO, dt);
  }

  #stepSwim(service: Physics3dService, record: EntityRecord, fields: Fields, s: CharacterState, swim: Swimming, depth: number, flow: Vec3,
    intent: Intent | undefined, dt: number): void {
    let target = Vec3.ZERO;
    let rise = 0;
    if (intent !== undefined) {
      const d = intent.direction;
      const length = d.length();
      if (length > 0) {
        const run = intent.run;
        const speed = intent.speed ?? (run ? swim.run_speed : swim.speed) * Math.min(1, length);
        target = d.flat().__mul__(speed / length);
        rise = (d.y / length) * Math.min(swim.vertical_speed, speed);
        s.running = run;
      }
    }
    // At rest the body floats toward float_depth. Diving goes down; rising stops at the
    // float line (a swimmer doesn't leave the water upward — jump() climbs out onto a ledge).
    const buoyancy = Math.max(-swim.vertical_speed, Math.min(swim.vertical_speed, (depth - swim.float_depth) * 3));
    const vyTarget = rise < 0 ? rise : rise > 0 ? Math.min(rise, Math.max(0, buoyancy)) : buoyancy;
    const acceleration = fields['acceleration'] as number;
    const horizontal = moveToward(s.velocity.flat(), target, acceleration * 0.5 * dt);
    const vy = approach(s.velocity.y, vyTarget, acceleration * 0.5 * dt);
    const before = new Vec3(horizontal.x, vy, horizontal.z);
    const wasGrounded = s.grounded;
    this.#resolve(service, record, fields, s, before, before.__add__(flow), false, dt, false);
    // Swimmers aren't "on the ground" for jumping or coyote time, except standing in the shallows.
    s.grounded = s.grounded && depth < swim.enter_depth;
    if (!wasGrounded && s.grounded) s.airborne = 0;
    this.#faceToward(record, fields, s, target, Vec3.ZERO, dt);
  }

  #stepFreeFall(service: Physics3dService, record: EntityRecord, fields: Fields, s: CharacterState, sky: Skydive, intent: Intent | undefined, dt: number): void {
    let target = Vec3.ZERO;
    let terminal = sky.terminal;
    if (intent !== undefined) {
      const flat = intent.direction.flat();
      const length = flat.length();
      if (length > 0) target = flat.__mul__(sky.steer * Math.min(1, length) / length);
      if (intent.run) terminal = sky.dive_terminal;
    }
    const horizontal = moveToward(s.velocity.flat(), target, sky.acceleration * dt);
    const g = Math.abs(service.gravity * (fields['gravity_scale'] as number));
    // Speeding up toward terminal at gravity, slowed back to it by drag at `acceleration`.
    const vy = -s.velocity.y < terminal ? Math.max(-terminal, s.velocity.y - g * dt) : approach(s.velocity.y, -terminal, sky.acceleration * dt);
    const before = new Vec3(horizontal.x, vy, horizontal.z);
    this.#resolve(service, record, fields, s, before, new Vec3(horizontal.x, (s.velocity.y + vy) / 2, horizontal.z), false, dt, true);
    this.#faceToward(record, fields, s, target, Vec3.ZERO, dt);
  }

  #stepGlide(service: Physics3dService, record: EntityRecord, fields: Fields, s: CharacterState, sky: Skydive, chute: Parachute, intent: Intent | undefined,
    dt: number): void {
    s.glide = (s.glide ?? 0) + dt;
    s.falling = false;
    let yaw = s.yaw ?? yawOf(record);
    let sink = chute.sink;
    let speed = chute.glide_speed;
    if (intent !== undefined) {
      const flat = intent.direction.flat();
      if (flat.length() > 0.1) {
        const heading = forward(yaw);
        const along = flat.normalized().dot(heading);
        if (along < -0.5) {
          sink = chute.flare_sink;
          speed *= 0.5;
        } else {
          const goal = deg(Math.atan2(flat.x, flat.z));
          const diff = wrap180(goal - yaw);
          const turn = chute.turn_speed * dt;
          yaw = Math.abs(diff) <= turn ? goal : yaw + Math.sign(diff) * turn;
        }
      }
      if (intent.run) {
        sink = chute.dive_sink;
        speed *= 1.25;
      }
    }
    s.yaw = yaw;
    this.#setYaw(record, yaw);
    const brake = (sky.terminal - chute.flare_sink) / chute.deploy_time;
    const vy = approach(s.velocity.y, -sink, brake * dt);
    const horizontal = moveToward(s.velocity.flat(), forward(yaw).__mul__(speed), sky.acceleration * dt);
    const before = new Vec3(horizontal.x, vy, horizontal.z);
    this.#resolve(service, record, fields, s, before, new Vec3(horizontal.x, (s.velocity.y + vy) / 2, horizontal.z), false, dt, true);
  }

  #ledge(record: EntityRecord, fields: Fields, s: CharacterState, traversal: Traversal, vault = true): Ledge | undefined {
    const intent = s.intent;
    const flat = intent?.direction.flat();
    const dir = flat !== undefined && flat.length() > 0.1 ? flat.normalized() : forward(s.yaw ?? yawOf(record));
    return findLedge(this.service(), record.id, record.transform.worldPosition(), dir, {
      radius: fields['radius'] as number, height: fields['height'] as number, stepHeight: fields['step_height'] as number,
    }, traversal, vault);
  }

  #startTraverse(record: EntityRecord, s: CharacterState, path: Ledge, traversal: Traversal): void {
    const feet = record.transform.worldPosition();
    const dir = path.landing.__sub__(feet).flat();
    const unit = dir.length() > 0 ? dir.normalized() : forward(s.yaw ?? yawOf(record));
    const duration = path.kind === 'vault'
      ? traversal.vault_time
      : traversal.climb_time * (0.5 + 0.5 * Math.min(1, path.height / traversal.climb_height));
    s.traverse = { kind: path.kind, from: feet, control: traversalControl(feet, path, unit), to: path.landing, t: 0, duration };
    s.velocity = Vec3.ZERO;
    s.grounded = false;
    s.ground = undefined;
    s.yaw = deg(Math.atan2(unit.x, unit.z));
    this.#setYaw(record, s.yaw);
    if (s.stance !== 'stand') s.stance = 'stand';
    s.cues.push(path.kind === 'vault' ? 'vaulted' : 'climbed');
    this.#kernel.emit(CHARACTER_EVENTS.traversed, { entity: this.#kernel.handles.wrap(record.id), kind: path.kind, height: path.height });
  }

  #stepTraverse(service: Physics3dService, record: EntityRecord, s: CharacterState, dt: number): void {
    const run = s.traverse!;
    const before = bezier(run.from, run.control, run.to, smoothstep(run.t));
    run.t = Math.min(1, run.t + dt / run.duration);
    const at = bezier(run.from, run.control, run.to, smoothstep(run.t));
    service.teleport(record.id, at, undefined, false);
    s.velocity = at.__sub__(before).__truediv__(dt);
    if (run.t >= 1) {
      s.traverse = undefined;
      s.velocity = Vec3.ZERO;
      s.grounded = true;
      s.airborne = 0;
      s.airJumpsUsed = 0;
    }
  }

  #stepSeat(record: EntityRecord, s: CharacterState, dt: number): void {
    const run = s.seat!;
    s.velocity = Vec3.ZERO;
    s.grounded = false;
    if (run.phase === 'sit') {
      // Mounted: physics3d keeps it on the seat (moving with it); the heading is the seat's.
      s.velocity = this.#carrierVelocity(run.seat);
      const seat = this.#kernel.world.require(run.seat);
      s.yaw = this.#seatTarget(seat, seat.components.get(SEAT)!).yaw;
      this.#setYaw(record, s.yaw);
      return;
    }
    if (run.phase === 'enter') {
      // A moving seat moves the goal.
      const seat = this.#kernel.world.require(run.seat);
      const target = this.#seatTarget(seat, seat.components.get(SEAT)!);
      run.to = target.position;
      run.toYaw = target.yaw;
    }
    run.t = Math.min(1, run.t + dt / run.duration);
    const e = smoothstep(run.t);
    const at = run.from.__add__(run.to.__sub__(run.from).__mul__(e));
    const yaw = run.fromYaw + wrap180(run.toYaw - run.fromYaw) * e;
    this.service().teleport(record.id, at, undefined, false);
    s.yaw = yaw;
    this.#setYaw(record, yaw);
    if (run.t >= 1) {
      if (run.phase === 'enter') this.#seatDown(record, s);
      else this.#standUp(record, s);
    }
  }

  #faceToward(record: EntityRecord, fields: Fields, s: CharacterState, target: Vec3, moving: Vec3, dt: number): void {
    if (fields['face_movement'] !== true) return;
    const look = target.length() > 0.01 ? target : moving.length() > 0.1 ? moving : undefined;
    if (look === undefined) return;
    const goal = deg(Math.atan2(look.x, look.z));
    const current = s.yaw ?? yawOf(record);
    const diff = wrap180(goal - current);
    const turn = (fields['turn_speed'] as number) * dt;
    const yaw = Math.abs(diff) <= turn ? goal : current + Math.sign(diff) * turn;
    s.yaw = yaw;
    this.#setYaw(record, yaw);
  }

  #setYaw(record: EntityRecord, yaw: number): void {
    const t = record.transform;
    const world = Quat.from_euler(new Vec3(0, yaw, 0));
    t.rotation = t.parent === null ? world : t.parent.worldRotation().inverse().__mul__(world);
  }
}
