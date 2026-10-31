/** The physics3d service (function/services/physics3d.ts) over one kernel's simulation. */

import { Quat } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Physics3dService, WorldFilter } from '../../services/index.js';
import { rapier } from './rapier.js';
import { rapierShape } from './sim.js';
import type { Physics3dSim, QueryFilter } from './sim.js';

export function physicsService(sim: () => Physics3dSim): Physics3dService {
  const filter = (f: WorldFilter | undefined): QueryFilter => ({
    layers: f?.layers === undefined ? 0 : sim().layers.mask(f.layers, 'physics3d query'),
    ignore: new Set<EntityId>(f?.ignore ?? []),
  });
  return {
    get gravity() {
      return sim().gravity;
    },
    raycast: (origin, direction, maxDistance, f) => sim().raycast(origin, direction.normalized(), maxDistance, filter(f)),
    shapecast: (shape, origin, rotation, direction, maxDistance, f) =>
      sim().shapecast(rapierShape(shape), origin, rotation, direction.normalized(), maxDistance, filter(f)),
    overlapSphere: (center, radius, f) => sim().overlap(center, Quat.IDENTITY, new (rapier().Ball)(radius), filter(f)),
    explode: (center, radius, strength, f) => {
      const hit = sim().overlap(center, Quat.IDENTITY, new (rapier().Ball)(radius), filter(f));
      sim().explode(center, radius, strength, hit);
      return hit;
    },
    watchContactForces: (entity, owner, threshold) => sim().watchContactForces(entity, owner, threshold),
    contactForces: () => sim().contactForces(),
    ragdollOf: (entity) => sim().ragdolls.modeOf(entity),
    setDriven: (entity, driven) => sim().setDriven(entity, driven),
    layerOf: (entity) => sim().layerOf(entity),
    body: (entity) => sim().state(entity),
    bounds: (entity) => sim().bounds(entity),
    contacts: (entity) => sim().contacts(entity),
    setVelocity: (entity, v) => sim().setVelocity(entity, v),
    setAngularVelocity: (entity, w) => sim().setAngularVelocity(entity, w),
    applyForce: (entity, force, at) => sim().applyForce(entity, force, at),
    applyImpulse: (entity, impulse, at) => sim().applyImpulse(entity, impulse, at),
    teleport: (entity, position, rotation, keep) => sim().teleport(entity, position, rotation, keep),
    constrain: (entity, owner, locks) => sim().constrain(entity, owner, locks),
    moveCharacter: (entity, shape, delta, snap) => sim().moveCharacter(entity, shape, delta, snap),
    releaseCharacter: (entity) => sim().releaseCharacter(entity),
    driveWheels: (entity, wheels, inputs, dt) => sim().driveWheels(entity, wheels, inputs, dt),
    releaseWheels: (entity) => sim().releaseWheels(entity),
    mount: (rider, carrier, seat, rotation) => sim().mount(rider, carrier, seat, rotation),
    dismount: (rider) => sim().dismount(rider),
    mountOf: (rider) => sim().mountOf(rider),
  };
}
