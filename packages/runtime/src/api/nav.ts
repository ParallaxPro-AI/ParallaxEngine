/**
 * `parallax.nav` (sdk/parallax/nav.pyi): the NavAgent, NavLink and NavObstacle handles, the
 * Arrived and LinkStarted events, `NavApi` (the type of `ctx.nav`) and the `nav()` plugin factory
 * (`parallax.plugins.nav`). The behavior lives in the nav plugin; this module binds Python
 * arguments. `random_point` draws from the game's seeded `random` stream.
 */

import { fail } from '../core/index.js';
import type { Vec3 } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import {
  ARRIVED, LINK_STARTED, nav as navPlugin, NAV_AGENT, NAV_AGENT_SCHEMA, NAV_LINK, NAV_LINK_SCHEMA, NAV_OBSTACLE, NAV_OBSTACLE_SCHEMA, navPoint,
} from '../function/plugins/nav/index.js';
import type { NavQueries } from '../function/plugins/nav/index.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs } from './kwargs.js';
import { activeRandom } from './random.js';

/** `entity.get(NavAgent)`: speed, radius, stopping_distance… and move_to / stop / moving. */
export const NavAgent = componentHandle({ id: NAV_AGENT, schema: NAV_AGENT_SCHEMA }, 'NavAgent');
export const Arrived = eventHandle(ARRIVED, 'Arrived');
/** `entity.get(NavLink)`: an off-mesh link (start, end, kind, bidirectional, cost, enabled). */
export const NavLink = componentHandle({ id: NAV_LINK, schema: NAV_LINK_SCHEMA }, 'NavLink');
/** `entity.get(NavObstacle)`: the entity's collider is a dynamic obstacle (enabled, move_threshold). */
export const NavObstacle = componentHandle({ id: NAV_OBSTACLE, schema: NAV_OBSTACLE_SCHEMA }, 'NavObstacle');
export const LinkStarted = eventHandle(LINK_STARTED, 'LinkStarted');

function number(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3243', `${where} must be a number, got ${value === null || value === undefined ? 'None' : String(value)}`);
}

/** `ctx.nav`: world-level navigation questions. */
export class NavApi {
  readonly #queries: NavQueries;

  constructor(queries: NavQueries) {
    this.#queries = queries;
  }

  #ends(name: string, args: readonly unknown[]): [Vec3, Vec3, unknown] {
    const a = bindArgs(name, args, { positional: ['start', 'end'], keyword: ['agent'], required: ['start', 'end'] }).args;
    return [navPoint(a['start'], `${name}() start`), navPoint(a['end'], `${name}() end`), a['agent']];
  }

  path(...args: unknown[]): Vec3[] {
    return this.#queries.path(...this.#ends('path', args));
  }

  reachable(...args: unknown[]): boolean {
    return this.#queries.reachable(...this.#ends('reachable', args));
  }

  random_point(...args: unknown[]): Vec3 | null {
    const a = bindArgs('random_point', args, { positional: ['near', 'radius'], required: ['near', 'radius'] }).args;
    const random = activeRandom();
    return this.#queries.randomPoint(navPoint(a['near'], 'random_point() near'), number(a['radius'], 'random_point() radius'), () => random.next());
  }

  can_see(...args: unknown[]): boolean {
    const a = bindArgs('can_see', args, { positional: ['viewer', 'target'], keyword: ['fov', 'distance'], required: ['viewer', 'target'] }).args;
    const fov = a['fov'] === undefined ? 120 : number(a['fov'], 'can_see() fov');
    const distance = a['distance'] === undefined ? 30 : number(a['distance'], 'can_see() distance');
    return this.#queries.canSee(a['viewer'], a['target'], fov, distance);
  }
}

/** `parallax.plugins.nav(*, agent_radius=0.4, cell_size=0.25)`. */
export function nav(...args: unknown[]): KernelPlugin {
  const a = bindArgs('nav', args, { keyword: ['agent_radius', 'cell_size'] }).args;
  const plugin = navPlugin({
    ...(a['agent_radius'] !== undefined && { agentRadius: number(a['agent_radius'], 'nav agent_radius') }),
    ...(a['cell_size'] !== undefined && { cellSize: number(a['cell_size'], 'nav cell_size') }),
  });
  return { ...plugin, namespace: { name: 'nav', create: () => new NavApi(plugin.queries()) } };
}
