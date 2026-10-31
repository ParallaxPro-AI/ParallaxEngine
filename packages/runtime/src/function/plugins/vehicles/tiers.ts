/**
 * Simulation tiers (internal: on only when the plugin is built with `tiers`): many AI
 * vehicles at the cost of a few. Each step every wheeled vehicle is placed in one tier by
 * its distance to the nearest focus (every camera; with none, every vehicle is "full"):
 *
 *   full     the whole model (raycast wheels, drivetrain). Occupied vehicles always;
 *            otherwise the nearest `maxFull` within `fullRange`.
 *   simple   a kinematic ride: speed follows throttle/brake at `acceleration`/`braking`,
 *            heading turns by the bicycle model (speed × tan(steer) / wheelbase), and one
 *            ray keeps it at its ride height over the ground. No wheel colliders, no tire
 *            forces — traffic that drives where it is told.
 *   dormant  beyond `simpleRange`, unoccupied: not stepped at all; its body rests.
 *
 * Distances get 10% hysteresis so a vehicle at a boundary doesn't flip every step.
 * Boats and aircraft are always "full" (their models are already cheap or need the
 * physics).
 */

import type { EntityId, Vec3 } from '../../../core/index.js';

export const SIM_TIERS = ['full', 'simple', 'dormant'] as const;
export type SimTier = typeof SIM_TIERS[number];
const HYSTERESIS = 1.1;

export interface TierSettings {
  readonly fullRange: number;
  readonly simpleRange: number;
  readonly maxFull: number;
}

export const DEFAULT_TIERS: TierSettings = { fullRange: 120, simpleRange: 400, maxFull: 16 };

export interface TierCandidate {
  readonly entity: EntityId;
  readonly position: Vec3;
  /** Occupied: always full. */
  readonly pinned: boolean;
  readonly current: SimTier;
}

/** Tier per candidate, in candidate order. */
export function assignTiers(settings: TierSettings, foci: readonly Vec3[], candidates: readonly TierCandidate[]): Map<EntityId, SimTier> {
  const out = new Map<EntityId, SimTier>();
  if (foci.length === 0) {
    for (const c of candidates) out.set(c.entity, 'full');
    return out;
  }
  const near = candidates.map((c) => ({
    c, d: Math.min(...foci.map((f) => f.distance_to(c.position))),
  }));
  const pinned = near.filter((n) => n.c.pinned);
  for (const n of pinned) out.set(n.c.entity, 'full');
  const free = near.filter((n) => !n.c.pinned).sort((a, b) => a.d - b.d || (a.c.entity as number) - (b.c.entity as number));
  let fullLeft = Math.max(0, settings.maxFull - pinned.length);
  for (const { c, d } of free) {
    const fullReach = settings.fullRange * (c.current === 'full' ? HYSTERESIS : 1);
    const simpleReach = settings.simpleRange * (c.current === 'dormant' ? 1 : HYSTERESIS);
    if (d <= fullReach && fullLeft > 0) {
      out.set(c.entity, 'full');
      fullLeft--;
    } else if (d <= simpleReach) {
      out.set(c.entity, 'simple');
    } else {
      out.set(c.entity, 'dormant');
    }
  }
  return out;
}
