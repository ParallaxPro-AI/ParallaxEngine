/**
 * Path searches as pure functions over plain data, so a worker can run them: `bake` copies
 * a rectangle of the live nav world for one agent radius into typed arrays (a `NavBake`,
 * structured-clone friendly), and `findPath(bake, request)` runs the very search the main
 * thread runs (search.ts) over it. Nothing here touches the kernel. `NAV_PATHS` is the job
 * (boot/jobs.ts serves it; the nav service's `paths` runs it through JOBS_SERVICE).
 *
 * A bake is a snapshot: static colliders spawned after it was taken are not in it. Cells
 * outside its rectangle have no column (paths can't leave it). It keeps every walkable
 * layer of each cell (bridges, storeys) and the off-mesh links with both ends inside it.
 */

import { fail, jobKey } from '../../../core/index.js';
import type { JobKey } from '../../../core/index.js';
import type { NavBake, NavBounds } from '../../services/index.js';
import { Pathfinder } from './search.js';
import type { Waypoint } from './search.js';
import { canStep } from './world.js';
import type { Column, NavField, Point3 } from './world.js';

/** Most cells a bake may hold (4096² at the default 0.25 m cell = 1 km²). */
export const MAX_BAKE_CELLS = 16_777_216;

export function bake(field: NavField, bounds: NavBounds, radius: number): NavBake {
  if (!(bounds.maxX >= bounds.minX && bounds.maxZ >= bounds.minZ)) {
    fail('PP3249', `nav bake bounds are empty: x ${bounds.minX}..${bounds.maxX}, z ${bounds.minZ}..${bounds.maxZ}`);
  }
  const i0 = field.index(bounds.minX);
  const k0 = field.index(bounds.minZ);
  const cols = field.index(bounds.maxX) - i0 + 1;
  const rows = field.index(bounds.maxZ) - k0 + 1;
  if (cols * rows > MAX_BAKE_CELLS) {
    fail('PP3249', `nav bake of ${cols}×${rows} cells is over the ${MAX_BAKE_CELLS}-cell limit`, { fix: 'Bake a smaller rectangle (or several).' });
  }
  let layers = 1;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) layers = Math.max(layers, field.columns(i0 + c, k0 + r).length);
  const heights = new Float64Array(cols * rows * layers).fill(Number.NaN);
  const implicit = new Uint8Array(cols * rows * layers);
  const standable = new Uint8Array(cols * rows * layers);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const columns = field.columns(i0 + c, k0 + r);
      for (let l = 0; l < columns.length; l++) {
        const at = (r * cols + c) * layers + l;
        heights[at] = columns[l]!.h;
        implicit[at] = columns[l]!.implicit ? 1 : 0;
        standable[at] = field.standable(i0 + c, k0 + r, l, radius) ? 1 : 0;
      }
    }
  }
  // Links with both ends in the rectangle (plain copies: they cross the thread).
  const inside = (p: Point3): boolean => p.x >= bounds.minX && p.x <= bounds.maxX && p.z >= bounds.minZ && p.z <= bounds.maxZ;
  const links = field.links().filter((l) => inside(l.start) && inside(l.end)).map((l) => ({ ...l, start: { ...l.start }, end: { ...l.end } }));
  return { cell: field.cell, radius, i0, k0, cols, rows, layers, heights, implicit, standable, links };
}

/**
 * A NavField over a bake (read-only; answers only for the bake's radius). A bake can't see
 * thin walls over a ledge, so its automatic jump/drop links take every clear-looking arc
 * (`passable` is always true).
 */
export function bakedField(data: NavBake): NavField {
  const layers = data.layers ?? 1;
  const links = data.links ?? [];
  const cache = new Map<number, Column[]>();
  const at = (i: number, k: number): number => {
    const c = i - data.i0;
    const r = k - data.k0;
    return c < 0 || r < 0 || c >= data.cols || r >= data.rows ? -1 : r * data.cols + c;
  };
  return {
    cell: data.cell,
    version: 0,
    index: (v) => Math.floor(v / data.cell),
    center: (i) => (i + 0.5) * data.cell,
    columns(i, k): readonly Column[] {
      const n = at(i, k);
      if (n < 0) return [];
      const cached = cache.get(n);
      if (cached !== undefined) return cached;
      const out: Column[] = [];
      for (let l = 0; l < layers; l++) {
        const h = data.heights[n * layers + l]!;
        if (!Number.isNaN(h)) out.push({ h, implicit: data.implicit[n * layers + l] === 1 });
      }
      cache.set(n, out);
      return out;
    },
    standable(i, k, layer, radius) {
      if (radius !== data.radius) fail('PP3249', `This nav bake is for agents of radius ${data.radius}, not ${radius}`, { fix: 'Bake once per agent radius.' });
      const n = at(i, k);
      return n >= 0 && layer >= 0 && layer < layers && data.standable[n * layers + layer] === 1;
    },
    step: canStep,
    links: () => links,
    passable: () => true,
  };
}

export interface PathRequest {
  /** y picks the layer each end is on (default 0: the lowest walkable surface near the ground). */
  readonly start: { readonly x: number; readonly y?: number; readonly z: number };
  readonly goal: { readonly x: number; readonly y?: number; readonly z: number };
  /** How far (m) either end may snap to the nearest standable cell. */
  readonly snap: number;
  /** Most A* expansions (default: search.ts MAX_EXPANSIONS). */
  readonly limit?: number;
  /** Highest ledge the agent jumps up and lowest it drops down (m; default 0: never). */
  readonly jump?: number;
  readonly drop?: number;
}

/** The path a live search would give over the same world, or null. */
export function findPath(data: NavBake, request: PathRequest): Waypoint[] | null {
  const search = new Pathfinder(bakedField(data));
  const { start, goal } = request;
  return search.route(
    { x: start.x, y: start.y ?? 0, z: start.z }, { x: goal.x, y: goal.y ?? 0, z: goal.z },
    { radius: data.radius, jump: request.jump ?? 0, drop: request.drop ?? 0 }, request.snap, request.limit,
  );
}

/** Several searches over one bake (the bake crosses the thread once). */
export interface NavPathsInput {
  readonly bake: NavBake;
  readonly requests: readonly PathRequest[];
}
export type NavPath = Waypoint[] | null;
export const NAV_PATHS: JobKey<NavPathsInput, NavPath[]> = jobKey('nav.paths');

/** The `nav.paths` job body: each request's path, in request order. */
export function findPaths(input: NavPathsInput): NavPath[] {
  return input.requests.map((r) => findPath(input.bake, r));
}
