/**
 * `parallax.destruction` (sdk/parallax/destruction.pyi): the Breakable handle, the BreakableDamaged
 * and BreakableBroken events, and the `destruction()` factory `parallax.plugins` should re-export.
 * The behavior lives in the destruction plugin (it works through physics3d).
 */

import { BREAKABLE, DESTRUCTION_EVENTS, destruction as destructionPlugin } from '../function/plugins/destruction/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { eventHandle } from './events.js';
import { bindArgs } from './kwargs.js';

export type { DestructionNamespace as DestructionApi } from '../function/plugins/destruction/index.js';

/** `entity.get(Breakable)`: health, impact_threshold, pieces, fracture, scatter… and damage / shatter. */
export class Breakable {
  static readonly __component_id__ = BREAKABLE;
}

/** `@on(BreakableDamaged)`: entity, amount, source (Entity | None), point, force (N; 0 from code). */
export const BreakableDamaged = eventHandle(DESTRUCTION_EVENTS.damaged, 'BreakableDamaged');
/** `@on(BreakableBroken)`: entity, source (Entity | None), point, force. */
export const BreakableBroken = eventHandle(DESTRUCTION_EVENTS.broken, 'BreakableBroken');

/** `parallax.plugins.destruction()`. List it after physics3d. */
export function destruction(...args: unknown[]): KernelPlugin {
  bindArgs('destruction', args, {});
  return destructionPlugin();
}
