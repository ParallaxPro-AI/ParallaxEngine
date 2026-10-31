/**
 * `parallax.water` (sdk/parallax/water.pyi): the WaterBody and Buoyancy handles, the
 * WaterEntered event, `ctx.water` and the `water()` factory `parallax.plugins` re-exports.
 * Oceans, lakes, pools and rivers live in the water plugin; this module binds Python
 * arguments.
 *
 *     game = Game(..., plugins=[plugins.physics3d(), plugins.water(), ...])
 *     # prefabs: sea {"water_body": {"kind": "ocean", "waves": "rough"}},
 *     #          crate {"rigidbody": {"mass": 200}, "collider": {...}, "buoyancy": {}}
 *     y = ctx.water.height_at(boat.transform.position)
 */

import { fail, Vec3 } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import {
  BUOYANCY, BUOYANCY_SCHEMA, water as waterPlugin, WATER_BODY, WATER_BODY_SCHEMA, WATER_EVENTS,
} from '../function/plugins/water/index.js';
import type { WaterControl } from '../function/plugins/water/index.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs } from './kwargs.js';

/** A body of water on its entity: kind (ocean, lake, pool, river), area (a footprint), depth, waves, color, clarity… */
export const WaterBody = componentHandle({ id: WATER_BODY, schema: WATER_BODY_SCHEMA }, 'WaterBody');
/** Floats a Rigidbody: volume, samples, drag, angular_drag; `submerged` is kept by the engine. */
export const Buoyancy = componentHandle({ id: BUOYANCY, schema: BUOYANCY_SCHEMA }, 'Buoyancy');
/** `@on(WaterEntered)`: entity, point, speed (m/s down when it hit the surface). */
export const WaterEntered = eventHandle(WATER_EVENTS.entered, 'WaterEntered');

function point(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  return fail('PP3373', `${where} must be a Vec3`, { fix: 'Pass a position, e.g. entity.transform.position.' });
}

function finite(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3373', `${where} must be a number, got ${String(value)}`);
}

/** `ctx.water`. */
export class WaterApi {
  readonly #control: WaterControl;
  readonly #kernel: Kernel;

  constructor(control: WaterControl, kernel: Kernel) {
    this.#control = control;
    this.#kernel = kernel;
  }

  /** height_at(point): the surface height over the point (its y ignored), waves included; None over dry land. */
  height_at(...args: unknown[]): number | null {
    const a = bindArgs('height_at', args, { positional: ['point'], required: ['point'] }).args;
    const p = point(a['point'], 'height_at() point');
    return this.#control.heightAt(p.x, p.z) ?? null;
  }

  /** depth_at(point): meters below the surface (negative above it); None outside any water. */
  depth_at(...args: unknown[]): number | null {
    const a = bindArgs('depth_at', args, { positional: ['point'], required: ['point'] }).args;
    return this.#control.depthAt(point(a['point'], 'depth_at() point')) ?? null;
  }

  /** flow_at(point): the water's own velocity there (rivers), Vec3 m/s. */
  flow_at(...args: unknown[]): Vec3 {
    const a = bindArgs('flow_at', args, { positional: ['point'], required: ['point'] }).args;
    return this.#control.flowAt(point(a['point'], 'flow_at() point'));
  }

  in_water(...args: unknown[]): boolean {
    const a = bindArgs('in_water', args, { positional: ['point'], required: ['point'] }).args;
    return this.#control.inWater(point(a['point'], 'in_water() point'));
  }

  /** body_at(point): the WaterBody entity the point is under the surface of, or None. */
  body_at(...args: unknown[]): unknown {
    const a = bindArgs('body_at', args, { positional: ['point'], required: ['point'] }).args;
    const id = this.#control.bodyAt(point(a['point'], 'body_at() point'));
    return id === undefined ? null : this.#kernel.handles.wrap(id);
  }

  /** splash(point, *, strength=1): a ring of foam and spray at the surface there. */
  splash(...args: unknown[]): void {
    const a = bindArgs('splash', args, { positional: ['point'], keyword: ['strength'], required: ['point'] }).args;
    this.#control.splash(point(a['point'], 'splash() point'), a['strength'] === undefined ? 1 : finite(a['strength'], 'splash() strength'));
  }
}

/** `parallax.plugins.water()`. List it after physics3d when bodies float. */
export function water(...args: unknown[]): KernelPlugin {
  bindArgs('water', args, {});
  const plugin = waterPlugin();
  return { ...plugin, namespace: { name: 'water', create: (kernel) => new WaterApi(plugin.control(), kernel) } };
}
