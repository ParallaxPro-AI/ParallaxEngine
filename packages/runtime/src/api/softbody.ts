/**
 * `parallax.softbody` (sdk/parallax/softbody.pyi): the Cloth and SoftBody handles and the
 * `softbody()` factory `parallax.plugins` re-exports. The simulation lives in the softbody
 * plugin (function/plugins/softbody/).
 */

import type { KernelPlugin } from '../function/kernel/index.js';
import { CLOTH, CLOTH_SCHEMA, SOFT_BODY, SOFT_BODY_SCHEMA, softbody as softbodyPlugin } from '../function/plugins/softbody/index.js';
import { componentHandle } from './handles.js';
import { bindArgs } from './kwargs.js';

/** `entity.get(Cloth)`: a sheet hanging from the entity (size, cols, rows, pin…), with push / reset. */
export const Cloth = componentHandle({ id: CLOTH, schema: CLOTH_SCHEMA }, 'Cloth');
/** `entity.get(SoftBody)`: a jelly body the entity follows (shape, size, stiffness, pressure…), with push / reset. */
export const SoftBody = componentHandle({ id: SOFT_BODY, schema: SOFT_BODY_SCHEMA }, 'SoftBody');

/** `parallax.plugins.softbody()`. List it after physics3d (it reads its gravity and colliders). */
export function softbody(...args: unknown[]): KernelPlugin {
  bindArgs('softbody', args, {});
  return softbodyPlugin();
}
