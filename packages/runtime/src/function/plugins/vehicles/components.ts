/**
 * The vehicles plugin's components (sdk/parallax/vehicles.pyi): `vehicle` with its methods,
 * and the optional components that deepen a vehicle when present — `drivetrain`,
 * `vehicle_damage`, `vehicle_effects`, `vehicle_rig`.
 */

import { fail, Vec3 } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, FieldType, Fields, Schema } from '../../kernel/index.js';
import { SEAT_COMPONENT } from '../../services/index.js';
import { finite, splitKeywords, vec3 } from './args.js';
import { PART_ROLES } from './damage.js';
import { CONTROL_INPUTS, VEHICLE_EFFECTS, VEHICLE_RIG } from './rig.js';
import { DRIVETRAIN, VEHICLE, VEHICLE_DAMAGE } from './state.js';
import type { Vehicles } from './state.js';

export const VEHICLE_KINDS = ['car', 'plane', 'boat', 'tracked'] as const;

const optional = (of: FieldType, extra: object = {}): Schema[string] => ({ type: { kind: 'optional', of }, default: null, ...extra });
const strings = (): Schema[string] => t.list({ kind: 'string' }, { default: [] });

export const VEHICLE_SCHEMA: Schema = {
  kind: t.enum(VEHICLE_KINDS, { default: 'car' }),
  max_speed: t.number({ default: 30, min: 0, modifiable: true }),
  reverse_speed: t.number({ default: 8, min: 0 }),
  acceleration: t.number({ default: 10, min: 0, modifiable: true }),
  braking: t.number({ default: 20, min: 0, modifiable: true }),
  steering: t.number({ default: 35, min: 0 }),
  turn_rate: t.number({ default: 60, min: 0 }),
  grip: t.number({ default: 1, min: 0, modifiable: true }),
  fuel: t.number({ default: -1, min: -1 }),
  fuel_capacity: t.number({ default: -1, min: -1 }),
  fuel_burn: t.number({ default: 0, min: 0 }),
  // Seats are Seat children (where each rider sits, its exits); see state.ts.
};

export const DRIVETRAIN_SCHEMA: Schema = {
  gears: t.list({ kind: 'number' }, { default: [3.4, 2.1, 1.5, 1.15, 0.92, 0.78] }),
  reverse_ratio: t.number({ default: 3.2, min: 0 }),
  final_drive: t.number({ default: 3.9, min: 0 }),
  idle_rpm: t.number({ default: 900, min: 1 }),
  peak_rpm: t.number({ default: 4400, min: 1 }),
  redline_rpm: t.number({ default: 6800, min: 1 }),
  peak_torque: t.number({ default: 320, min: 0, modifiable: true }),
  engine_braking: t.number({ default: 0.12, min: 0 }),
  drive: t.enum(['all', 'front', 'rear'], { default: 'rear' }),
  gearbox: t.enum(['auto'], { default: 'auto' }),
  shift_time: t.number({ default: 0.25, min: 0 }),
  upshift: t.number({ default: 0.92, min: 0, max: 1 }),
  downshift: t.number({ default: 0.4, min: 0, max: 1 }),
};

const PART_RECORD: Schema = {
  name: t.string(),
  role: t.enum(PART_ROLES, { default: 'body' }),
  at: t.vec3({ default: Vec3.ZERO }),
  radius: t.number({ default: 1, min: 0 }),
  health: t.number({ default: 100, min: 0 }),
  index: t.int({ default: -1, min: -1 }),
  wrecks: optional({ kind: 'bool' }),
  model_part: optional({ kind: 'string' }),
  damaged_part: optional({ kind: 'string' }),
};

export const VEHICLE_DAMAGE_SCHEMA: Schema = {
  parts: t.list({ kind: 'record', fields: PART_RECORD }, { default: [] }),
  impact_threshold: optional({ kind: 'number' }, { min: 0 }),
  from_health: t.bool({ default: true }),
  leak_rate: t.number({ default: 0.05, min: 0 }),
  pump_rate: t.number({ default: 0.01, min: 0 }),
  sink_at: t.number({ default: 1, min: 0, max: 1 }),
  /** Engine-kept: part → current health. */
  health: { type: { kind: 'dict', of: { kind: 'number' } }, default: {} },
  /** Engine-kept: 0..1 of a boat's hull flooded. */
  flooded: t.number({ default: 0, min: 0, max: 1 }),
  /** Engine-kept. */
  wrecked: t.bool({ default: false }),
};

export const VEHICLE_EFFECTS_SCHEMA: Schema = {
  exhaust: optional({ kind: 'string' }),
  engine_sound: optional({ kind: 'string' }),
  engine_volume: t.number({ default: 1, min: 0 }),
  tire_smoke: optional({ kind: 'string' }),
  skid_sound: optional({ kind: 'string' }),
  damage_smoke: optional({ kind: 'string' }),
};

export const VEHICLE_RIG_SCHEMA: Schema = {
  wheels: strings(),
  steer: strings(),
  propellers: strings(),
  propeller_rpm: t.number({ default: 1800, min: 0 }),
  controls: { type: { kind: 'dict', of: { kind: 'enum', values: CONTROL_INPUTS } }, default: {} },
  control_angle: t.number({ default: 25 }),
};

type State = () => Vehicles;

function own(fields: unknown): ReturnType<typeof componentEntity> {
  return componentEntity(fields as Fields);
}

function control(k: Readonly<Record<string, unknown>>, name: string, where: string, lo: number, hi: number): number {
  const value = k[name];
  if (value === undefined) return 0;
  const n = finite(value, `${where}(${name}=)`);
  if (n < lo || n > hi) fail('PP7307', `${where}(${name}=${n}) is out of range`, { fix: `Pass ${lo} to ${hi}.` });
  return n;
}

function entityGetter(state: State): PropertyDescriptor {
  return { get(this: Fields): unknown { return state().kernel.handles.wrap(own(this)); }, enumerable: false };
}

function vehicleMethods(state: State): object {
  return {
    get entity(): unknown {
      return state().kernel.handles.wrap(own(this));
    },
    drive(this: Fields, ...args: unknown[]): void {
      const { positional, keywords: k } = splitKeywords(args, 'drive', ['throttle', 'steer', 'brake', 'handbrake']);
      if (positional.length > 0) fail('PP3030', 'drive() takes keyword arguments only', { fix: 'vehicle.drive(throttle=1, steer=0.5)' });
      state().drive(own(this), this, {
        throttle: control(k, 'throttle', 'drive', -1, 1),
        steer: control(k, 'steer', 'drive', -1, 1),
        brake: control(k, 'brake', 'drive', 0, 1),
        handbrake: k['handbrake'] === true,
      });
    },
    fly(this: Fields, ...args: unknown[]): void {
      const { positional, keywords: k } = splitKeywords(args, 'fly', ['throttle', 'pitch', 'roll', 'yaw', 'flaps', 'airbrake', 'brake']);
      if (positional.length > 0) fail('PP3030', 'fly() takes keyword arguments only', { fix: 'vehicle.fly(throttle=1, pitch=0.3)' });
      state().fly(own(this), this, {
        throttle: control(k, 'throttle', 'fly', -1, 1),
        pitch: control(k, 'pitch', 'fly', -1, 1),
        roll: control(k, 'roll', 'fly', -1, 1),
        yaw: control(k, 'yaw', 'fly', -1, 1),
        flaps: control(k, 'flaps', 'fly', 0, 1),
        airbrake: k['airbrake'] === true,
        brake: control(k, 'brake', 'fly', 0, 1),
      });
    },
    enter(this: Fields, ...args: unknown[]): boolean {
      const { positional: p, keywords: k } = splitKeywords(args, 'enter', ['driver', 'seat']);
      const s = state();
      const driver = s.kernel.handles.unwrap(p[0] ?? k['driver']);
      if (driver === undefined) fail('PP7309', 'enter() needs the entity getting in', { fix: 'vehicle.enter(player)' });
      const seat = k['seat'] ?? 0;
      return s.enter(own(this), driver, finite(seat, 'enter(seat=)'));
    },
    exit(this: Fields, ...args: unknown[]): boolean {
      const { positional: p, keywords: k } = splitKeywords(args, 'exit', ['driver']);
      const s = state();
      const driver = s.kernel.handles.unwrap(p[0] ?? k['driver']);
      if (driver === undefined) fail('PP3188', 'exit() needs the entity getting out', { fix: 'vehicle.exit(player)' });
      return s.exit(own(this), driver);
    },
    refuel(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'refuel', ['liters']);
      state().refuel(this, finite(p[0] ?? k['liters'], 'refuel liters'));
    },
    get driver(): unknown {
      const driver = state().driver(own(this));
      return driver === null ? null : state().kernel.handles.wrap(driver);
    },
    get riders(): unknown[] {
      return state().riders(own(this)).map((r) => state().kernel.handles.wrap(r));
    },
    /** The Seat children, in seat order (seat 0 is the driver's). */
    get seats(): unknown[] {
      return state().seatsOf(own(this)).map((seat) => state().kernel.handles.wrap(seat));
    },
    get speed(): number {
      return state().speed(own(this));
    },
    get grounded(): boolean {
      return state().state(own(this)).grounded;
    },
    get airborne(): boolean {
      return !state().state(own(this)).grounded;
    },
    get slip(): number {
      return state().state(own(this)).slip;
    },
    get drifting(): boolean {
      return state().drifting(own(this));
    },
    get skidding(): boolean {
      return state().state(own(this)).skids.some(Boolean);
    },
    get surfaces(): Array<string | null> {
      return state().state(own(this)).surfaces.map((s) => s ?? null);
    },
    get stalled(): boolean {
      return state().stalled(own(this), this as unknown as Fields);
    },
  };
}

function drivetrainMethods(state: State): object {
  const methods = {};
  Object.defineProperties(methods, {
    entity: entityGetter(state),
    gear: { get(this: Fields): number { return state().drivetrain(own(this), this).gear; }, enumerable: false },
    rpm: { get(this: Fields): number { return state().drivetrain(own(this), this).rpm; }, enumerable: false },
    clutch: { get(this: Fields): number { return state().drivetrain(own(this), this).clutch; }, enumerable: false },
  });
  return methods;
}

function damageMethods(state: State): object {
  const methods = {
    damage(this: Fields, ...args: unknown[]): number {
      const { positional: p, keywords: k } = splitKeywords(args, 'damage', ['amount', 'at', 'part', 'source']);
      const amount = finite(p[0] ?? k['amount'], 'damage() amount');
      if (amount < 0) fail('PP7301', `damage(${amount}) can't be negative`, { fix: 'Use repair() to restore parts.' });
      const at = k['at'] === undefined || k['at'] === null ? undefined : vec3(k['at'], 'damage(at=)');
      const part = k['part'] === undefined || k['part'] === null ? undefined : String(k['part']);
      const source = state().kernel.handles.unwrap(k['source'] ?? null) ?? null;
      return state().damage(own(this), this as never, amount, at, part, source);
    },
    repair(this: Fields, ...args: unknown[]): void {
      const { positional: p, keywords: k } = splitKeywords(args, 'repair', ['amount', 'part']);
      const raw = p[0] ?? k['amount'];
      const amount = raw === undefined || raw === null ? undefined : finite(raw, 'repair() amount');
      const part = k['part'] === undefined || k['part'] === null ? undefined : String(k['part']);
      state().repair(own(this), this as never, amount, part);
    },
    fraction(this: Fields, ...args: unknown[]): number {
      const { positional: p, keywords: k } = splitKeywords(args, 'fraction', ['part']);
      return state().partFraction(this as never, String(p[0] ?? k['part']));
    },
  };
  Object.defineProperty(methods, 'entity', entityGetter(state));
  return methods;
}

function withEntity(state: State): object {
  return Object.defineProperty({}, 'entity', entityGetter(state));
}

export function vehicleComponents(state: State): ComponentDef[] {
  return [
    { id: VEHICLE, schema: VEHICLE_SCHEMA, methods: vehicleMethods(state) },
    { id: DRIVETRAIN, schema: DRIVETRAIN_SCHEMA, methods: drivetrainMethods(state) },
    { id: VEHICLE_DAMAGE, schema: VEHICLE_DAMAGE_SCHEMA, methods: damageMethods(state) },
    { id: VEHICLE_EFFECTS, schema: VEHICLE_EFFECTS_SCHEMA, methods: withEntity(state) },
    { id: VEHICLE_RIG, schema: VEHICLE_RIG_SCHEMA, methods: withEntity(state) },
    // A vehicle's seats are Seat children; the definition is shared with characters().
    SEAT_COMPONENT,
  ];
}
