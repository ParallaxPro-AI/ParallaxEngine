/**
 * The `nav` service: navigation as other plugins use it, provided by the nav plugin
 * (`kernel.service(NAV_SERVICE)`, looked up at use). The ai plugin moves units and squads
 * through it, perception asks it about static occlusion, fog of war about opaque cells.
 * Points are world-space `Vec3` meters on the ground plane (x, z); entities `EntityId`s.
 *
 * Off-main-thread shape. `bake` copies a rectangle of the walkable world into plain typed
 * arrays (`NavBake`), and the nav plugin's `findPath(bake, request)` (nav/jobs.ts) is a pure
 * function over it: a worker can receive the bake by structured clone and answer path
 * requests with exactly the search the main thread runs. The service itself answers on the
 * calling thread.
 */

import type { EntityId, Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

/** Per-move overrides of the agent's own NavAgent fields (an RTS group keeping pace, a squad slot). */
export interface NavMoveOptions {
  /** Cap on the agent's speed for this move (m/s); the agent's own `speed` still applies when lower. */
  readonly maxSpeed?: number;
  /** Replaces `stopping_distance` for this move (m). */
  readonly stoppingDistance?: number;
}

/** How far an agent can jump up and drop down between ledges (m; 0 or absent: never). */
export interface NavReach {
  readonly jumpHeight?: number;
  readonly dropHeight?: number;
}

/** A rectangle of cells copied out of the nav world for one agent radius. */
export interface NavBake {
  /** Cell edge (m). */
  readonly cell: number;
  /** The agent radius standability was computed for. */
  readonly radius: number;
  /** Index of the first column (x) and row (z). */
  readonly i0: number;
  readonly k0: number;
  readonly cols: number;
  readonly rows: number;
  /**
   * Walkable layers kept per cell (bridges, storeys; default 1). The arrays below hold
   * `layers` entries per cell, lowest first: index `(row · cols + col) · layers + layer`.
   */
  readonly layers?: number;
  /** Surface height per cell layer, row-major (k major); NaN where there is no such layer. */
  readonly heights: Float64Array;
  /** 1 where the layer is the implicit ground plane (agents keep their own height). */
  readonly implicit: Uint8Array;
  /** 1 where an agent of `radius` can stand on the layer. */
  readonly standable: Uint8Array;
  /** Off-mesh links with both ends inside the bake (NavLink components, scene links). */
  readonly links?: readonly NavBakeLink[];
}

/** An off-mesh link in a bake (world space). */
export interface NavBakeLink {
  /** The NavLink entity, or -1 for a scene link. */
  readonly entity: number;
  /** "jump", "climb", "door", "teleport" or "custom". */
  readonly kind: string;
  readonly start: { readonly x: number; readonly y: number; readonly z: number };
  readonly end: { readonly x: number; readonly y: number; readonly z: number };
  readonly bidirectional: boolean;
  /** Extra cost (m) on top of its length. */
  readonly cost: number;
}

export interface NavBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** One search for `NavService.paths`. */
export interface NavPathQuery {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly radius: number;
}

export interface NavService {
  /** Grid cell edge (m). */
  readonly cellSize: number;
  /**
   * A string-pulled path for an agent of `radius` (start, corners, link ends, goal), or null
   * when unreachable. Each end is on the walkable layer nearest its y (the road or the
   * bridge over it); `reach` lets the agent take automatic jump-up / drop-down links.
   */
  path(start: Vec3, end: Vec3, radius: number, reach?: NavReach): Vec3[] | null;
  /** Whether an agent of `radius` can stand at the point. */
  standable(point: Vec3, radius: number): boolean;
  /** The standable point nearest `point` within `range` meters (a cell center, or the point itself), or null. */
  nearest(point: Vec3, radius: number, range: number): Vec3 | null;
  /** Whether a segment crosses no static collider (nor terrain); entities in `ignore` don't count. */
  lineClear(a: Vec3, b: Vec3, ignore: readonly EntityId[]): boolean;
  /**
   * Whether static geometry (or terrain) fills the ground point (x, z) at height y: a wall or
   * rock whose footprint comes within `reach` m of the point (floors under it don't count).
   * A coarse grid passes half its cell so thin walls between sample points still count.
   */
  opaque(x: number, z: number, y: number, reach: number): boolean;

  /** Whether the entity has a NavAgent. */
  hasAgent(entity: EntityId): boolean;
  /** Path the agent to a point or keep following an entity; false when unreachable. Raises like `NavAgent.move_to`. */
  moveAgent(entity: EntityId, target: Vec3 | EntityId, options?: NavMoveOptions): boolean;
  stopAgent(entity: EntityId): void;
  agentMoving(entity: EntityId): boolean;
  agentDestination(entity: EntityId): Vec3 | null;

  /** Copy the walkable world inside `bounds` for agents of `radius` (see the header). */
  bake(bounds: NavBounds, radius: number): NavBake;
  /**
   * Many searches at once, off the main thread when boot provides a job runner (the
   * `nav.paths` job over one bake per radius; inline otherwise). Results in query order,
   * each a path like `path` gives or null; resolves after the calling frame, so use it for
   * work that tolerates latency (planning, tools), not for per-step motion.
   */
  paths(queries: readonly NavPathQuery[]): Promise<(Vec3[] | null)[]>;
}

export const NAV_SERVICE: ServiceKey<NavService> = serviceKey<NavService>(
  'nav', 'Add nav() to Game(plugins=[...]): AI movement, cover and sight lines use the navigation world.',
);
