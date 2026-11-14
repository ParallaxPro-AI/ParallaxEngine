/**
 * The `conveyors` service: items riding conveyor lanes, provided by the conveyors plugin
 * (function/plugins/conveyors) and drawn by render3d as instanced copies of each item
 * kind's model — thousands of moving items cost no entities and no game code per frame.
 */

import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

/** Numbers per drawn item in `ConveyorDraw.items`: x, y, z (world), yaw (radians about +y). */
export const CONVEYOR_ITEM_STRIDE = 4;

/** Every visible item of one kind this frame, drawn with that kind's look. */
export interface ConveyorDraw {
  /** The model reference the kind's look names (`models/<name>`). */
  readonly model: string;
  /** Uniform scale of the model. */
  readonly scale: number;
  readonly count: number;
  /** `CONVEYOR_ITEM_STRIDE` numbers per item. */
  readonly items: Float32Array;
}

export interface ConveyorSource {
  /**
   * The items to draw, one entry per kind with a look; `alpha` (0..1) places each item
   * between its last two fixed steps (the kernel's `time.alpha`).
   */
  draws(alpha: number): readonly ConveyorDraw[];
}

export const CONVEYOR_SERVICE: ServiceKey<ConveyorSource> = serviceKey<ConveyorSource>(
  'conveyors', 'Conveyor lanes come from the conveyors plugin: add plugins.conveyors() to Game(plugins=[...]).',
);
