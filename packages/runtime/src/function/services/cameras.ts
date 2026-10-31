/**
 * The `cameras` service: which camera is live for each seat, provided by the visuals plugin
 * (the camera rigs). A seat's live camera is the one `ctx.camera.use()` chose while it
 * lives, else the seat's first camera (owner = the seat; unowned cameras serve seat 0):
 * exactly the view the renderers draw. Consumers: cinematics (the camera it directs when a
 * track names none), vehicles (simulation tiers around what players see), audio-style
 * listeners and anything that needs "where is the player looking from".
 */

import type { EntityId, Quat, Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface LiveCamera {
  readonly seat: number;
  readonly entity: EntityId;
  /** World pose as last resolved (shake and kick included). */
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface CamerasService {
  /** The seat's live camera entity, or null when the seat has none. */
  active(seat: number): EntityId | null;
  /** Every seat's live camera, by seat. */
  live(): readonly LiveCamera[];
}

export const CAMERAS_SERVICE: ServiceKey<CamerasService> = serviceKey<CamerasService>(
  'cameras', 'Cameras come from the visuals plugin, which the runtime always installs; build the kernel through the api layer.',
);
