/**
 * State-sync services: the plain-data form of a plugin's state that a net client must
 * mirror, for the net plugin's world sync (plugins/net/world_sync.ts). Each is provided by
 * the plugin that owns the state, beside its main service, and looked up by net at use.
 *
 *   environment_sync  the environment's course: time of day, sky, fog, post, cloud changes
 *   weather_sync      the weather's course: preset blends, the director's schedule, strikes
 *
 * (The wind's ramp and the water's disturbances have their own shapes: `WIND_SYNC_SERVICE`
 * in wind.ts and `WATER_SYNC_SERVICE` in water.ts.)
 */

import type { Json } from '../../resource/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface CourseSync {
  /**
   * Bumped when the state changes in a way its clock alone won't repeat on a client (a
   * script's change, a scene load, a strike) — not as it merely runs on. A server sends the
   * state again when this moves.
   */
  readonly revision: number;
  /** The state as plain data (what a server sends its clients). */
  state(): Json;
  /** Take over a server's state as it is. */
  follow(state: Json): void;
}

export const ENVIRONMENT_SYNC_SERVICE: ServiceKey<CourseSync> = serviceKey<CourseSync>(
  'environment_sync', 'The environment plugin is core: build the game through createRuntime, which includes it.',
);

export const WEATHER_SYNC_SERVICE: ServiceKey<CourseSync> = serviceKey<CourseSync>(
  'weather_sync', 'Add weather() to Game(plugins=[...]).',
);
