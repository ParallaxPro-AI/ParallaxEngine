/**
 * vehicles — cars, tracked vehicles, boats and planes on Rapier (sdk/parallax/vehicles.pyi):
 * the Vehicle component with drive/fly controls, seats (Seat children, shared with the
 * characters plugin: a Character rider sits through Character.sit) and fuel; the optional depth
 * components (drivetrain, vehicle_damage, vehicle_effects, vehicle_rig); internal
 * simulation tiers for many AI vehicles (off unless a host passes `tiers`); and the vehicle
 * events. The chassis is the entity's dynamic Rigidbody and Collider; wheels, flight and
 * water models run through the physics3d service at use time (models.ts documents each).
 * Never imports physics3d or combat: a vehicle with
 * `vehicle_damage.from_health` hears the combat plugin's `damaged` event by id.
 *
 * One `vehicles()` value serves one kernel.
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { EventDef, Fields, Handler, Kernel, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { SEAT_EXITS_SERVICE } from '../../services/index.js';
import { vehicleComponents } from './components.js';
import { COMBAT_DAMAGED, VEHICLE_EVENTS, Vehicles } from './state.js';
import type { SavedVehicle } from './state.js';
import type { TierSettings } from './tiers.js';

export {
  DRIVETRAIN_SCHEMA, VEHICLE_DAMAGE_SCHEMA, VEHICLE_EFFECTS_SCHEMA, VEHICLE_KINDS, VEHICLE_RIG_SCHEMA, VEHICLE_SCHEMA,
} from './components.js';
export {
  DRIFT_ANGLE, DRIFT_SPEED, DRIVETRAIN, LANDING_AIRTIME, VEHICLE, VEHICLE_DAMAGE, VEHICLE_EVENTS,
} from './state.js';
export { VEHICLE_EFFECTS, VEHICLE_RIG } from './rig.js';
export { stallSpeed, wheelLayout } from './models.js';
export { engagedRpm, torqueAt } from './drivetrain.js';
export { assignTiers, DEFAULT_TIERS } from './tiers.js';
export type { TierSettings } from './tiers.js';

export interface VehiclesOptions {
  /** Internal simulation tiers (tiers.ts), not author-facing; undefined: every vehicle runs the full model. */
  readonly tiers?: TierSettings;
}

export function vehicles(options: VehiclesOptions = {}): KernelPlugin {
  const tiers = options.tiers;
  if (tiers !== undefined) {
    if (!(tiers.fullRange >= 0) || !(tiers.simpleRange >= tiers.fullRange) || !Number.isInteger(tiers.maxFull) || tiers.maxFull < 0) {
      fail('PP7306', `vehicles tiers (fullRange=${tiers.fullRange}, simpleRange=${tiers.simpleRange}, maxFull=${tiers.maxFull}) are inconsistent`);
    }
  }
  let state: Vehicles | undefined;
  const current = (): Vehicles => {
    if (state === undefined) fail('PP9170', 'The vehicles plugin is used before its kernel was built');
    return state;
  };
  let installedOn: Kernel | undefined;
  let handlers: Handler[] | undefined;
  const system: SystemDef = {
    id: 'vehicles.weapon_damage',
    scenes: [],
    // Resolved on first delivery: `damaged` exists only when combat is in the game.
    get handlers(): readonly Handler[] {
      if (handlers === undefined) {
        const damaged: EventDef | undefined = installedOn?.registry.events.get(COMBAT_DAMAGED);
        handlers = damaged === undefined ? [] : [{ event: damaged, method: 'damaged', always: true }];
      }
      return handlers;
    },
    create: () => ({ damaged: (_ctx: unknown, payload: Fields) => current().combatDamaged(payload) }),
  };
  return {
    id: 'vehicles',
    components: vehicleComponents(current),
    events: Object.values(VEHICLE_EVENTS),
    systems: [system],
    install(kernel) {
      if (installedOn !== undefined) {
        fail('PP9171', 'This vehicles plugin is already installed in another kernel', { fix: 'Call vehicles() once per kernel.' });
      }
      installedOn = kernel;
      const created = new Vehicles(kernel, { tiers });
      state = created;
      kernel.observeEntities({
        added: (records) => created.added(records),
        removed: (records) => created.removed(records),
        changed: (record) => created.changed(record),
      });
      kernel.provide(SEAT_EXITS_SERVICE, { exits: (seat, rider) => created.seatExits(seat, rider) });
      kernel.addHook('physics', (dt) => created.step(dt));
    },
    snapshot: () => current().snapshot() as unknown as Json,
    restore: (_kernel, saved) => current().restore(saved as unknown as SavedVehicle[]),
  };
}
