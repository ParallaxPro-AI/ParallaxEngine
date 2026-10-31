/**
 * The `weather` service: what the sky is doing, as other plugins need it — the environment
 * greys the sky, thickens fog and flashes with lightning; render3d draws rain, snow, hail
 * and bolts and wets surfaces; gameplay plugins read grip and visibility (a character's
 * traction, a vehicle's tires, an NPC's sight range). Provided by the weather plugin
 * (`kernel.service(WEATHER_SERVICE)`, looked up at use); this file is the interface.
 *
 * Everything is game state: a pure function of the weather's snapshot-able state and game
 * time, so a server and its clients (and a replay) see the same storm.
 */

import type { EntityId, Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface WeatherConditions {
  /** The preset being blended toward (or holding). */
  readonly preset: string;
  /** 0..1 strength of what falls. */
  readonly rain: number;
  readonly snow: number;
  readonly hail: number;
  /** 0..1 of the sky covered by cloud. */
  readonly clouds: number;
  /** 0..1: how far the sky and sunlight are greyed out (overcast). */
  readonly overcast: number;
  /** Exponential fog density per meter the weather adds. */
  readonly fog: number;
  /** Mean wind speed the weather asks for, m/s (the wind plugin blows it when present). */
  readonly wind: number;
  /** Lightning strikes per minute. */
  readonly lightning: number;
  /** 0..1: exposed surfaces' wetness (rises while it rains, dries after). */
  readonly wetness: number;
  /** 0..1: snow lying on exposed ground. */
  readonly snowCover: number;
  /** Meters one can see (fog and what falls), at most 10 km. */
  readonly visibility: number;
  /** Multiplier on ground grip: 1 dry, lower when wet, lowest on snow. */
  readonly friction: number;
  /** Lightning's flash right now, 0 (none) and up. */
  readonly flash: number;
}

export interface LightningStrike {
  /** Game time of the strike. */
  readonly time: number;
  /** Where it hit the ground. */
  readonly point: Vec3;
  /** World y of the cloud base it came from. */
  readonly cloud: number;
  /** 0..1. */
  readonly strength: number;
  /** Seeds the bolt's shape (the same bolt everywhere). */
  readonly seed: number;
}

export interface WeatherService {
  conditions(): WeatherConditions;
  /**
   * Whether a weather is running (the scene names one, or the game set one). While active
   * the weather owns wind speed and gusts, cloud cover, fog density and the sky's mood;
   * inactive, the environment ignores it. Absent: always active.
   */
  active?(): boolean;
  /** Strikes within the last `seconds` of game time, oldest first (bolts to draw). */
  recentStrikes(seconds: number): readonly LightningStrike[];
  /** Whether something solid is above the point (rain and snow don't reach it), not counting `ignore` (the asker's own body). Needs physics3d to know. */
  sheltered(point: Vec3, ignore?: readonly EntityId[]): boolean;
}

export const WEATHER_SERVICE: ServiceKey<WeatherService> = serviceKey<WeatherService>(
  'weather', 'Add weather() to Game(plugins=[...]); a scene\'s environment "weather" key sets its weather.',
);
