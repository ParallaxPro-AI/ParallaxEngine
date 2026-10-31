/**
 * `parallax.vehicles` (sdk/parallax/vehicles.pyi): the Vehicle handle and its depth
 * components (Drivetrain, VehicleDamage, VehicleEffects, VehicleRig), their record
 * (VehiclePart), the vehicle events, and the `vehicles()` factory `parallax.plugins`
 * re-exports. The behavior lives in the vehicles plugin.
 */

import { Vec3 } from '../core/index.js';
import {
  DRIVETRAIN, DRIVETRAIN_SCHEMA, VEHICLE, VEHICLE_DAMAGE, VEHICLE_DAMAGE_SCHEMA, VEHICLE_EFFECTS, VEHICLE_EFFECTS_SCHEMA,
  VEHICLE_EVENTS, VEHICLE_RIG, VEHICLE_RIG_SCHEMA, VEHICLE_SCHEMA, vehicles as vehiclesPlugin,
} from '../function/plugins/vehicles/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { record } from './declarations.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs } from './kwargs.js';
import { rt } from './types.js';

/** `entity.get(Vehicle)`: drive / fly / enter / exit / refuel, driver, speed, grounded, slip, skidding… */
export const Vehicle = componentHandle({ id: VEHICLE, schema: VEHICLE_SCHEMA }, 'Vehicle');
/** Gears, clutch, torque curve (automatic gearbox): gear, rpm, clutch. */
export const Drivetrain = componentHandle({ id: DRIVETRAIN, schema: DRIVETRAIN_SCHEMA }, 'Drivetrain');
/** Parts, impacts, flooding: damage(amount, at=, part=), repair(), fraction(part). */
export const VehicleDamage = componentHandle({ id: VEHICLE_DAMAGE, schema: VEHICLE_DAMAGE_SCHEMA }, 'VehicleDamage');
export const VehicleEffects = componentHandle({ id: VEHICLE_EFFECTS, schema: VEHICLE_EFFECTS_SCHEMA }, 'VehicleEffects');
export const VehicleRig = componentHandle({ id: VEHICLE_RIG, schema: VEHICLE_RIG_SCHEMA }, 'VehicleRig');

export const VehicleEntered = eventHandle(VEHICLE_EVENTS.entered, 'VehicleEntered');
export const VehicleExited = eventHandle(VEHICLE_EVENTS.exited, 'VehicleExited');
/** After at least 0.3 s airborne: entity, fall_speed (m/s down, ≥ 0), target (what it touched down on: Entity | None). */
export const VehicleLanded = eventHandle(VEHICLE_EVENTS.landed, 'VehicleLanded');
export const VehiclePartDamaged = eventHandle(VEHICLE_EVENTS.partDamaged, 'VehiclePartDamaged');
export const VehiclePartDestroyed = eventHandle(VEHICLE_EVENTS.partDestroyed, 'VehiclePartDestroyed');
/** reason: "destroyed" | "sunk". */
export const VehicleDisabled = eventHandle(VEHICLE_EVENTS.wrecked, 'VehicleDisabled');

const ZERO = new Vec3(0, 0, 0);

class VehiclePartFields {
  static readonly __annotations__ = {
    name: () => rt.str, role: () => rt.str, at: () => Vec3, radius: () => rt.float, health: () => rt.float, index: () => rt.int,
    wrecks: () => rt.optional(rt.bool), model_part: () => rt.optional(rt.str), damaged_part: () => rt.optional(rt.str),
  };
  static readonly role = 'body';
  static readonly at = ZERO;
  static readonly radius = 1;
  static readonly health = 100;
  static readonly index = -1;
  static readonly wrecks = null;
  static readonly model_part = null;
  static readonly damaged_part = null;
}
/** One part of VehicleDamage: `VehiclePart(name="engine", role="engine", at=vec3(0, 0.6, 1.3))`. */
export const VehiclePart = record(VehiclePartFields);

/** `parallax.plugins.vehicles()`: every vehicle runs the full model. */
export function vehicles(...args: unknown[]): KernelPlugin {
  bindArgs('vehicles', args, {});
  return vehiclesPlugin();
}
