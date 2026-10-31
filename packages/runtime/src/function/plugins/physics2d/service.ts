/** The physics2d service (function/services/physics2d.ts) over one kernel's simulation. */

import type { EntityId } from '../../../core/index.js';
import type { Physics2dService, WorldFilter } from '../../services/index.js';
import { rapier } from './rapier.js';
import type { Physics2dSim, QueryFilter } from './sim.js';

export function physicsService(sim: () => Physics2dSim, layers: { mask(names: readonly string[], where: string): number }): Physics2dService {
  const filter = (f: WorldFilter | undefined): QueryFilter => ({
    layers: f?.layers === undefined ? 0 : layers.mask(f.layers, 'physics2d query'),
    ignore: new Set<EntityId>(f?.ignore ?? []),
  });
  const id = (handle: unknown): EntityId => sim().handles.unwrap(handle)!;
  return {
    get gravity() {
      return sim().gravity;
    },
    raycast: (origin, direction, maxDistance, f) => {
      const length = Math.hypot(direction.x, direction.y);
      const hit = sim().raycast(origin, { x: direction.x / length, y: direction.y / length }, maxDistance, filter(f));
      return hit === undefined ? undefined : { ...hit, entity: id(hit.entity) };
    },
    overlapCircle: (center, radius, f) => sim().overlap(center, new (rapier().Ball)(radius), filter(f)),
    body: (entity) => sim().state(entity),
    bounds: (entity) => sim().bounds(entity),
    teleport: (entity, position, angle, keep) => sim().teleport(entity, position, angle, keep),
    layerOf: (entity) => sim().layerOf(entity),
    setDriven: (entity, driven) => sim().setDriven(entity, driven),
  };
}

