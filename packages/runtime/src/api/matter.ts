/**
 * `parallax.matter` (sdk/parallax/matter.pyi): the Sliceable, Thermal, HeatSource and
 * Liquid handles and the `matter()` factory `parallax.plugins` re-exports. The simulation
 * lives in the matter plugin (function/plugins/matter/).
 */

import type { KernelPlugin } from '../function/kernel/index.js';
import {
  HEAT_SOURCE, HEAT_SOURCE_SCHEMA, LIQUID, LIQUID_SCHEMA, matter as matterPlugin, SLICEABLE, SLICEABLE_SCHEMA, THERMAL, THERMAL_SCHEMA,
} from '../function/plugins/matter/index.js';
import { componentHandle } from './handles.js';
import { bindArgs } from './kwargs.js';

/** `entity.get(Sliceable)`: a soft solid that cuts along planes (slice, stain, paint, push…). */
export const Sliceable = componentHandle({ id: SLICEABLE, schema: SLICEABLE_SCHEMA }, 'Sliceable');
/** `entity.get(Thermal)`: surface and core temperature, moisture and melting. */
export const Thermal = componentHandle({ id: THERMAL, schema: THERMAL_SCHEMA }, 'Thermal');
/** `entity.get(HeatSource)`: a hot plate, a furnace or volumetric heating. */
export const HeatSource = componentHandle({ id: HEAT_SOURCE, schema: HEAT_SOURCE_SCHEMA }, 'HeatSource');
/** `entity.get(Liquid)`: liquid in a container (add, remove, stir, pour_into…). */
export const Liquid = componentHandle({ id: LIQUID, schema: LIQUID_SCHEMA }, 'Liquid');

/** `parallax.plugins.matter(*, ambient=21, time_scale=1)`. List it after physics3d. */
export function matter(...args: unknown[]): KernelPlugin {
  const a = bindArgs('matter', args, { keyword: ['ambient', 'time_scale'] }).args;
  const ambient = a['ambient'] === undefined ? 21 : Number(a['ambient']);
  const timeScale = a['time_scale'] === undefined ? 1 : Number(a['time_scale']);
  return matterPlugin({ ambient, timeScale });
}
