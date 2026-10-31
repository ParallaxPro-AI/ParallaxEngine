/**
 * The `wind` service: one wind field for the whole scene, provided by the wind plugin and
 * read by everything that moves with the air — foliage and grass sway (render3d), wind
 * streaks and blown debris, and gameplay (sails, drift, projectiles) through `ctx.wind`.
 * A weather plugin changes it with `set`.
 *
 * The field is a deterministic function of position and game time (`kernel.time.now`):
 * the same everywhere at the same moment, so a server and its clients agree on it and a
 * replay blows the same way. Gust fronts travel downwind; `gusts` scales how much the
 * speed varies (0: steady).
 */

import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface WindSettings {
  /** Unit direction the wind blows toward, on the ground plane. */
  readonly dirX: number;
  readonly dirZ: number;
  /** Mean speed, m/s. */
  readonly speed: number;
  /** 0..1: how much gusts vary the speed (and turn it a little). */
  readonly gusts: number;
  /** Meters across one gust (the field's spatial scale). */
  readonly scale: number;
  /** Seconds between gusts at one spot. */
  readonly period: number;
  /** Visuals the scene asks for: drifting streaks, and how many leaves blow past the camera. */
  readonly streaks: boolean;
  readonly debris: number;
}

/** A change to the wind, eased in over `seconds` of game time (0: at once). */
export interface WindChange {
  readonly dirX?: number;
  readonly dirZ?: number;
  readonly speed?: number;
  readonly gusts?: number;
  readonly seconds?: number;
}

/** The wind's state: the settings eased `from` → `to` over `seconds` of game time from `start`. */
export interface WindRamp {
  readonly from: WindSettings;
  readonly to: WindSettings;
  readonly start: number;
  readonly seconds: number;
}

export interface WindService {
  /** The settings now (mid-change: the eased values). */
  settings(): WindSettings;
  /** Wind velocity (m/s) at (x, z) now, written as [x, z] into `out` (returned). */
  sample(x: number, z: number, out?: Float64Array): Float64Array;
  /** The wind's mean velocity now, without gusts, as [x, z]. */
  mean(out?: Float64Array): Float64Array;
  set(change: WindChange): void;
}

/** The wind's state as plain data, for replication (net): also provided by the wind plugin. */
export interface WindSync {
  /** The current ramp (what a server sends its clients). */
  ramp(): WindRamp;
  /** Take over a ramp as it is (a client following its server). */
  follow(ramp: WindRamp): void;
}

export const WIND_SERVICE: ServiceKey<WindService> = serviceKey<WindService>(
  'wind', 'Add wind() to Game(plugins=[...]); a scene\'s "wind" block sets its wind.',
);

export const WIND_SYNC_SERVICE: ServiceKey<WindSync> = serviceKey<WindSync>(
  'wind_sync', 'Add wind() to Game(plugins=[...]).',
);
