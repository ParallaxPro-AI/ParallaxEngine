/**
 * The vehicle models, one fixed step each. Everything goes through the physics3d service:
 * the chassis is the entity's dynamic Rigidbody with its Collider; forces are newtons,
 * velocities m/s, angles degrees. Forward is the body's +z, up +y, right +x.
 *
 *   car       Rapier's raycast vehicle: four wheels laid out under the Collider's box
 *             (radius 30% of its height, clamped to 0.2–0.5 m), all driven, front ones
 *             steered. Steering lock narrows with speed (to 35% at max_speed).
 *   tracked   the same wheels, none steered; `steer` turns the hull in place at turn_rate.
 *   boat      held at the height it floats at (y and pitch/roll locked); thrust, a rudder
 *             that bites with speed (turn_rate at a quarter of max_speed and above) and
 *             lateral water grip.
 *   plane     arcade flight: thrust along the nose with drag reaching max_speed at full
 *             throttle; lift cancels gravity in proportion to (airspeed / stall speed)²;
 *             the flight path follows the nose as lift builds; pitch/roll/yaw rates with
 *             control authority growing to full at stall speed. It rolls on its Collider.
 *
 * Numbers that aren't Vehicle fields are named constants below.
 */

import { deg, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { BodyState, LocalBounds, Physics3dService, WheelContact, WheelInput, WheelSpec } from '../../services/index.js';

/** Rolling resistance when neither throttle nor brake is applied (m/s²). */
export const ROLLING_RESISTANCE = 0.3;
/** Suspension: stiffness per kg of chassis (N/m/kg), damping, and the chassis' ground clearance at rest (m). */
export const SUSPENSION_STIFFNESS = 40;
export const SUSPENSION_DAMPING = 4;
export const GROUND_CLEARANCE = 0.05;
/** Tire grip: forward friction slip per unit of `grip`. */
export const TIRE_SLIP = 2.5;
/** Handbrake: rear lateral grip multiplier (lower slides). */
export const HANDBRAKE_SIDE_GRIP = 0.35;
/** Plane stall speed as a fraction of max_speed; flaps (0–1) lower it by up to a quarter. */
export const STALL_FRACTION = 0.2;
export const FLAPS_STALL_REDUCTION = 0.25;
/** Plane control rates at full authority (deg/s per unit of input). */
export const PITCH_RATE = 45;
export const ROLL_RATE = 90;
/** How fast angular velocity follows the controls, and the flight path the nose (1/s). */
export const CONTROL_RESPONSE = 5;
export const PATH_ALIGNMENT = 1.5;
/** Boat lateral grip (1/s per unit of `grip`). */
export const WATER_GRIP = 4;
/** A surface counts as ground under a plane when its contact normal's y is at least this. */
const GROUND_NORMAL = 0.5;

export interface DriveInput {
  throttle: number;
  steer: number;
  brake: number;
  handbrake: boolean;
}

export interface FlyInput {
  throttle: number;
  pitch: number;
  roll: number;
  yaw: number;
  flaps: number;
  airbrake: boolean;
  brake: number;
}

export interface VehicleFields {
  readonly kind: string;
  readonly max_speed: number;
  readonly reverse_speed: number;
  readonly acceleration: number;
  readonly braking: number;
  readonly steering: number;
  readonly turn_rate: number;
  readonly grip: number;
}

export interface StepResult {
  readonly grounded: boolean;
  readonly ground: EntityId | undefined;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Thrust fades to 0 as speed reaches `limit` (m/s), so top speed is `limit`. */
function taper(speed: number, limit: number): number {
  return clamp((limit - speed) / (0.05 * limit + 0.5), 0, 1);
}

/**
 * Heading in degrees about +y (0 faces +z, 90 faces +x), from where the nose points —
 * never from Euler angles, whose y folds back past ±90° when x and z flip to 180.
 */
export function headingOf(q: Quat): number {
  const f = q.rotate(Vec3.FORWARD);
  return deg(Math.atan2(f.x, f.z));
}

export function axes(rotation: Quat): { forward: Vec3; right: Vec3; up: Vec3 } {
  return { forward: rotation.rotate(Vec3.FORWARD), right: rotation.rotate(Vec3.RIGHT), up: rotation.rotate(Vec3.UP) };
}

export function stallSpeed(v: VehicleFields, flaps: number): number {
  return v.max_speed * STALL_FRACTION * (1 - FLAPS_STALL_REDUCTION * clamp(flaps, 0, 1));
}

// ── Wheels (car, tracked) ──────────────────────────────────────────────────────

export function wheelLayout(bounds: LocalBounds, gravity: number, mass: number): WheelSpec[] {
  const { center: c, halfExtents: h } = bounds;
  const radius = clamp(0.3 * 2 * h.y, 0.2, 0.5);
  const restLength = radius;
  const sag = Math.abs(gravity) / (4 * SUSPENSION_STIFFNESS);
  const y = c.y - h.y - GROUND_CLEARANCE + restLength - sag + radius;
  const x = Math.max(h.x - 0.6 * radius, 0.1);
  const z = Math.max(h.z - 1.2 * radius, 0.2);
  const maxForce = mass * Math.max(Math.abs(gravity), 1) * 3;
  // Front left, front right, rear left, rear right.
  return [[-x, z], [x, z], [-x, -z], [x, -z]].map(([dx, dz]) => ({
    connection: new Vec3(c.x + dx!, y, c.z + dz!),
    radius,
    restLength,
    maxTravel: restLength,
    stiffness: SUSPENSION_STIFFNESS,
    damping: SUSPENSION_DAMPING,
    maxForce,
  }));
}

/** What the optional components change in the wheeled model (all neutral by default). */
export interface WheelTuning {
  /** Engine force from the drivetrain (N, total) and the braking it asks for; undefined: the `acceleration` model. */
  readonly drive?: (speed: number, radius: number) => { readonly force: number; readonly brake: number };
  /** Which wheels the engine drives (front: 0, 1; rear: 2, 3). */
  readonly driven: 'all' | 'front' | 'rear';
  /** Damage: engine force and steering lock multipliers, and per-wheel grip. */
  readonly engine: number;
  readonly steer: number;
  readonly wheelGrip: readonly number[];
  /** The weather's ground friction (WEATHER_SERVICE `friction`: 1 dry, lower wet, lowest on snow). */
  readonly weather: number;
}

export const NEUTRAL_TUNING: WheelTuning = { driven: 'all', engine: 1, steer: 1, wheelGrip: [1, 1, 1, 1], weather: 1 };

export interface WheeledResult extends StepResult {
  readonly contacts: readonly WheelContact[];
  /** Per wheel: skidding (the handbrake sliding a rear wheel). */
  readonly skids: readonly boolean[];
  readonly radius: number;
  /** Total engine force requested this step (N). */
  readonly engineForce: number;
}

export function stepWheeled(
  service: Physics3dService, entity: EntityId, v: VehicleFields, body: BodyState, bounds: LocalBounds,
  input: DriveInput, dt: number, tuning: WheelTuning = NEUTRAL_TUNING,
): WheeledResult {
  const tracked = v.kind === 'tracked';
  const { forward, up } = axes(body.rotation);
  const speed = body.velocity.dot(forward);
  const m = body.mass;
  const layout = wheelLayout(bounds, service.gravity, m);
  const radius = layout[0]!.radius;
  let engine = 0;
  let brake = clamp(input.brake, 0, 1);
  const t = clamp(input.throttle, -1, 1);
  if (tuning.drive !== undefined) {
    const out = tuning.drive(speed, radius);
    brake = Math.max(brake, out.brake);
    // The governor: modifiable max_speed (status effects, upgrades) still caps the car.
    const pushing = out.force * speed >= 0;
    const limit = out.force >= 0 ? v.max_speed : v.reverse_speed;
    engine = pushing ? out.force * taper(Math.abs(speed), limit) : out.force;
  } else if (t > 0) {
    if (speed < -0.5) brake = Math.max(brake, t);
    else engine = m * v.acceleration * t * taper(speed, v.max_speed);
  } else if (t < 0) {
    if (speed > 0.5) brake = Math.max(brake, -t);
    else engine = m * v.acceleration * t * taper(-speed, v.reverse_speed);
  }
  engine *= tuning.engine;
  if (brake > 0) engine = 0;
  // Rapier's wheel brake only caps a rolling-friction impulse; braking and rolling
  // resistance are applied to the forward speed below, exactly. Wheel brakes hold a
  // stopped vehicle still and lock the rear wheels for the handbrake.
  const hold = Math.abs(speed) < 0.5 && engine === 0 ? m * v.braking : 0;
  const lock = v.steering * tuning.steer * (1 - 0.65 * clamp(Math.abs(speed) / v.max_speed, 0, 1));
  const drivenWheels = tuning.driven === 'front' ? [0, 1] : tuning.driven === 'rear' ? [2, 3] : [0, 1, 2, 3];
  const steering = [0, 1, 2, 3].map((i) => (tracked || i >= 2 ? 0 : clamp(input.steer, -1, 1) * lock));
  const skids: boolean[] = [];
  const inputs: WheelInput[] = [0, 1, 2, 3].map((i) => {
    const rear = i >= 2;
    const handbrake = input.handbrake && rear;
    const driven = drivenWheels.includes(i);
    const traction = (tuning.wheelGrip[i] ?? 1) * tuning.weather;
    skids.push(handbrake && Math.abs(speed) > 2);
    return {
      engineForce: handbrake || !driven ? 0 : engine / drivenWheels.length,
      brake: hold / 4 + (handbrake ? m * v.braking / 2 : 0),
      steering: steering[i]!,
      frictionSlip: TIRE_SLIP * v.grip * traction,
      sideStiffness: v.grip * traction * (handbrake ? HANDBRAKE_SIDE_GRIP : 1),
    };
  });
  const contacts = service.driveWheels(entity, layout, inputs, dt);
  const grounded = contacts.some((c) => c.inContact);
  const decel = brake * v.braking + (engine === 0 && brake === 0 ? ROLLING_RESISTANCE : 0);
  if (grounded && decel > 0 && speed !== 0) {
    const now = service.body(entity)!;
    const along = now.velocity.dot(forward);
    service.setVelocity(entity, now.velocity.__sub__(forward.__mul__(Math.sign(along) * Math.min(Math.abs(along), decel * dt))));
  }
  if (tracked && input.steer !== 0) {
    // Turn in place about the hull's up axis; the tracks' grip carries the velocity round.
    const half = (clamp(input.steer, -1, 1) * v.turn_rate * dt * Math.PI) / 360;
    const spin = new Quat(up.x * Math.sin(half), up.y * Math.sin(half), up.z * Math.sin(half), Math.cos(half));
    service.teleport(entity, undefined, spin.__mul__(body.rotation), true);
  }
  return {
    grounded, ground: contacts.find((c) => c.inContact)?.ground, contacts,
    skids: skids.map((s, i) => s && contacts[i]!.inContact), radius, engineForce: engine,
  };
}

// ── Boat ───────────────────────────────────────────────────────────────────────

/**
 * A boat floats on its Buoyancy (the water plugin) and is driven from the stern: thrust,
 * the keel's grip against sideslip and the rudder all bite as far as the hull is in the
 * water — `bite` 0 (beached, or flying off a wave) to 1 (afloat: BOAT_FULL_BITE or more of
 * its volume under). Height, pitch and roll are the water's: the step leaves the vertical
 * velocity and the pitch/roll spin alone. Along the keel the boat's own model (thrust
 * tapering to `max_speed`) is its hull drag, so Buoyancy's drag along the keel, relative
 * to the water, is given back; across the keel the keel's grip holds.
 */
export const BOAT_FULL_BITE = 0.05;

/** 0..1: how far a hull with this submerged fraction (Buoyancy's `submerged`) bites. */
export function boatBite(submerged: number): number {
  return clamp(submerged / BOAT_FULL_BITE, 0, 1);
}

/** The water under a boat this step. */
export interface BoatWater {
  /** 0..1: `boatBite(submerged)`. */
  readonly bite: number;
  /** 1/s: Buoyancy's drag × the submerged fraction (how fast the water takes up the hull's motion). */
  readonly drag: number;
  /** The water's own velocity at the hull (currents, rivers). */
  readonly flow: Vec3;
}

/** Damage and flooding: thrust and top-speed multipliers, and the rudder's steering multiplier. */
export interface BoatScale {
  readonly engine: number;
  readonly speed: number;
  readonly steer: number;
}

export function stepBoat(
  service: Physics3dService, entity: EntityId, v: VehicleFields, body: BodyState, input: DriveInput, dt: number,
  water: BoatWater, scale: BoatScale = { engine: 1, speed: 1, steer: 1 },
): StepResult {
  const bite = water.bite;
  if (bite <= 0) return { grounded: false, ground: undefined };
  const { forward } = axes(body.rotation);
  const flatForward = forward.flat().normalized();
  const right = new Vec3(flatForward.z, 0, -flatForward.x);
  const vel = body.velocity.flat();
  const along = vel.dot(flatForward);
  const lateral = vel.dot(right);
  const t = clamp(input.throttle, -1, 1);
  let thrust = 0;
  const top = v.max_speed * scale.speed;
  if (t > 0) thrust = v.acceleration * scale.engine * t * taper(along, top);
  else if (t < 0) thrust = v.acceleration * scale.engine * t * taper(-along, v.reverse_speed * scale.speed);
  // Buoyancy's drag took (along - flow) · drag · dt off the keel's speed this step: give it back.
  const keelDrag = (along - water.flow.dot(flatForward)) * (1 - Math.exp(-water.drag * dt));
  let newAlong = along + keelDrag + thrust * bite * dt;
  // Water drag pulls a boat above its (damaged, flooded) top speed back down to it.
  if (Math.abs(newAlong) > top) newAlong -= Math.sign(newAlong) * Math.min(Math.abs(newAlong) - top, v.acceleration * bite * dt);
  const brake = clamp(input.brake, 0, 1);
  if (brake > 0) newAlong -= Math.sign(newAlong) * Math.min(Math.abs(newAlong), v.braking * brake * bite * dt);
  const newLateral = lateral * Math.exp(-WATER_GRIP * v.grip * bite * dt);
  service.setVelocity(entity, flatForward.__mul__(newAlong).__add__(right.__mul__(newLateral)).with_y(body.velocity.y));
  const rudder = clamp(Math.abs(newAlong) / (0.25 * v.max_speed), 0, 1) * Math.sign(newAlong || 1);
  const w = body.angularVelocity;
  service.setAngularVelocity(entity, new Vec3(w.x, clamp(input.steer, -1, 1) * v.turn_rate * scale.steer * rudder * bite, w.z));
  return { grounded: true, ground: undefined };
}

// ── Aircraft ───────────────────────────────────────────────────────────────────

function onGround(service: Physics3dService, entity: EntityId): StepResult {
  const ground = service.contacts(entity).find((c) => c.normal.y >= GROUND_NORMAL);
  return { grounded: ground !== undefined, ground: ground?.entity };
}

/** Blend the body's angular velocity towards `target` (world space, deg/s). */
function steerRates(service: Physics3dService, entity: EntityId, current: Vec3, target: Vec3, dt: number): void {
  const k = 1 - Math.exp(-CONTROL_RESPONSE * dt);
  service.setAngularVelocity(entity, current.__add__(target.__sub__(current).__mul__(k)));
}

export function stepPlane(service: Physics3dService, entity: EntityId, v: VehicleFields, body: BodyState, input: FlyInput, dt: number): StepResult & { stall: number } {
  const contact = onGround(service, entity);
  const { forward, right, up } = axes(body.rotation);
  const g = Math.abs(service.gravity);
  const stall = stallSpeed(v, input.flaps);
  let vel = body.velocity;
  const airspeed = vel.dot(forward);
  const t = clamp(input.throttle, -1, 1);

  // Thrust and drag along the nose: full throttle settles at max_speed.
  const drag = v.acceleration * (airspeed / v.max_speed) * Math.abs(airspeed / v.max_speed);
  let dv = forward.__mul__((v.acceleration * t - drag) * dt);
  // Lift cancels gravity as airspeed approaches stall speed.
  const lift = airspeed > 0 ? clamp((airspeed / stall) ** 2, 0, 1) : 0;
  dv = dv.__add__(new Vec3(0, g * lift * dt, 0));
  vel = vel.__add__(dv);
  // The flight path swings onto the nose as the wings bite.
  const along = vel.dot(forward);
  const across = vel.__sub__(forward.__mul__(along));
  vel = vel.__sub__(across.__mul__(1 - Math.exp(-PATH_ALIGNMENT * lift * dt)));
  if (contact.grounded && input.brake > 0) {
    const a = vel.dot(forward);
    vel = vel.__sub__(forward.__mul__(Math.sign(a) * Math.min(Math.abs(a), v.braking * clamp(input.brake, 0, 1) * dt)));
  }
  if (input.airbrake && !contact.grounded) {
    const s = vel.length();
    if (s > 0) vel = vel.__mul__(Math.max(0, s - v.braking * dt) / s);
  }
  service.setVelocity(entity, vel);

  const w = body.angularVelocity;
  if (contact.grounded) {
    // Nose-wheel steering and rotation near take-off speed; the ground holds roll.
    const rotate = clamp((airspeed - 0.7 * stall) / (0.3 * stall), 0, 1);
    const yawRate = v.steering * clamp(input.yaw, -1, 1) * clamp(Math.abs(airspeed) / 5, 0, 1);
    const pitchRate = PITCH_RATE * clamp(input.pitch, -1, 1) * rotate;
    const keep = w.__sub__(up.__mul__(w.dot(up))).__sub__(right.__mul__(w.dot(right)));
    steerRates(service, entity, w, keep.__add__(up.__mul__(yawRate)).__add__(right.__mul__(-pitchRate)), dt);
  } else {
    const authority = clamp(airspeed / stall, 0, 1);
    const target = right.__mul__(-PITCH_RATE * clamp(input.pitch, -1, 1))
      .__add__(forward.__mul__(-ROLL_RATE * clamp(input.roll, -1, 1)))
      .__add__(up.__mul__(v.steering * clamp(input.yaw, -1, 1)))
      .__mul__(authority);
    steerRates(service, entity, w, target, dt);
  }
  return { ...contact, stall };
}

/** Sideways slide angle in degrees (positive: sliding right), 0 below 1 m/s. */
export function slipAngle(body: BodyState): number {
  const { forward, right } = axes(body.rotation);
  const flat = body.velocity.flat();
  if (flat.length() < 1) return 0;
  return deg(Math.atan2(flat.dot(right), Math.abs(flat.dot(forward))));
}


// ── Simple tier (distant AI traffic) ────────────────────────────────────────────

/**
 * The kinematic ride of the "simple" tier (tiers.ts): speed follows the controls, heading
 * the bicycle model, height one ray to the ground. Returns grounded when the ray hits.
 */
export function stepSimple(
  service: Physics3dService, entity: EntityId, v: VehicleFields, body: BodyState, bounds: LocalBounds, input: DriveInput,
  engine: number, dt: number,
): StepResult {
  const { forward } = axes(body.rotation);
  const yaw = headingOf(body.rotation);
  let along = body.velocity.dot(forward);
  const t = clamp(input.throttle, -1, 1) * engine;
  if (t > 0 && along > -0.5) along += v.acceleration * t * taper(along, v.max_speed) * dt;
  else if (t < 0 && along < 0.5) along += v.acceleration * t * taper(-along, v.reverse_speed) * dt;
  const brake = Math.max(clamp(input.brake, 0, 1), t > 0 && along < -0.5 ? t : t < 0 && along > 0.5 ? -t : 0);
  const decel = brake * v.braking + (t === 0 && brake === 0 ? ROLLING_RESISTANCE : 0);
  along -= Math.sign(along) * Math.min(Math.abs(along), decel * dt);
  const layout = wheelLayout(bounds, service.gravity, body.mass);
  const wheelbase = Math.max(layout[0]!.connection.z - layout[2]!.connection.z, 0.5);
  const lock = v.steering * (1 - 0.65 * clamp(Math.abs(along) / v.max_speed, 0, 1));
  const yawRate = v.kind === 'tracked'
    ? clamp(input.steer, -1, 1) * v.turn_rate
    : deg((along * Math.tan((clamp(input.steer, -1, 1) * lock * Math.PI) / 180)) / wheelbase);
  const newYaw = yaw + yawRate * dt;
  const rideHeight = -(bounds.center.y - bounds.halfExtents.y) + GROUND_CLEARANCE;
  const hit = service.raycast(body.position.__add__(new Vec3(0, 2, 0)), Vec3.DOWN, 6, { ignore: [entity] });
  const y = hit === undefined ? body.position.y : hit.point.y + rideHeight;
  service.teleport(entity, body.position.with_y(y), Quat.from_euler(new Vec3(0, newYaw, 0)), false);
  service.setVelocity(entity, Vec3.from_yaw_pitch(newYaw).__mul__(along).with_y(0));
  service.setAngularVelocity(entity, Vec3.ZERO);
  return { grounded: hit !== undefined, ground: hit?.entity };
}

