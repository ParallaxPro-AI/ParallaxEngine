/**
 * nav — pathfinding agents (sdk/parallax/nav.pyi): the `nav_agent` component with its
 * methods (move_to, stop, moving, destination, desired_velocity, traversing), the
 * `nav_link` (off-mesh links) and `nav_obstacle` (dynamic obstacles) components, the
 * `arrived` and `link_started` events, and the world queries behind `ctx.nav` (path,
 * reachable, random_point, can_see).
 *
 * The static world is a lazily built, multi-level grid (world.ts) of `cell_size` cells over
 * the ground plane — every walkable surface of a column is a level (internally a "layer"
 * index; not a collision layer), so bridges, storeys and roofs route on their own level —
 * read from static colliders by component id and from the terrain service when the game has
 * terrain, cached and rebuilt per tile. Searches are A* over (cell, level) nodes with automatic jump/drop links and authored off-mesh links,
 * then string pulling (search.ts; links.ts); agents steer and avoid each other (ORCA,
 * crowd.ts) in the kernel's 'physics' hook (agents.ts). All of it is deterministic: world
 * iteration is in spawn order and every tie is broken by cell or entity id.
 *
 * Scene block (optional):
 * `"navmesh": {"obstacles": ["terrain"], "from": "assets/…glb", "links": [{"start": [x, y, z],
 * "end": [x, y, z], "kind": "jump", "bidirectional": true, "cost": 0}]}`.
 * `obstacles` limits the static colliders nav avoids to those collision layers. `from`
 * names a model whose surface would be the walkable ground; it is checked to be a path
 * and not read (a scene's ground model is a mesh collider, which nav does read). `links`
 * are off-mesh links in world space (kind: jump, climb, door, teleport or custom).
 * `wade_depth` (meters, default 0) is how deep terrain may lie under the terrain's
 * `water_level` and still be walked — a fordable river; deeper water is no ground. 3D only:
 * points are Vec3; Vec2 points (2D games) are PP3242.
 *
 * Mesh and convex colliders are read through the model geometry service (render3d) when
 * one is provided; models still loading are retried each fixed step and before each query.
 *
 * Other plugins (ai) use navigation through the nav service (services/nav.ts), provided at
 * install; `bake` + jobs.ts `findPath` are the same search as pure functions over data, and
 * the service's `paths` batches searches through the `nav.paths` job (JOBS_SERVICE: workers
 * in a browser) when boot provides a runner. Agents keep searching on the calling thread:
 * a result that lands a variable number of frames later would make their motion differ
 * between a browser and a headless run.
 */

import { closestMatch, fail, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, Fields, Kernel, KernelPlugin, Schema } from '../../kernel/index.js';
import type { Json, SceneDoc } from '../../../resource/index.js';
import { CITY_SERVICE, JOBS_SERVICE, MODEL_GEOMETRY_SERVICE, NAV_SERVICE, PROCGEN_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { GeneratedMesh, NavPathQuery, NavService, TerrainField } from '../../services/index.js';
import { Agents, ARRIVED, LINK_STARTED, NAV_AGENT, shapeOf } from './agents.js';
import { bake, findPaths, NAV_PATHS } from './jobs.js';
import { LINK_KINDS, Links, NAV_LINK, NAV_LINK_SCHEMA, NAV_OBSTACLE_SCHEMA } from './links.js';
import { MAX_EXPANSIONS, Pathfinder, snapDistance, walker } from './search.js';
import type { AgentShape, Waypoint } from './search.js';
import { segmentBlocked } from './sight.js';
import { NAV_OBSTACLE, NavGrid, Obstacles } from './world.js';
import type { NavLinkData } from './world.js';

export { ARRIVED, LINK_STARTED, NAV_AGENT } from './agents.js';
export { bake, bakedField, findPath, findPaths, MAX_BAKE_CELLS, NAV_PATHS } from './jobs.js';
export type { NavPath, NavPathsInput, PathRequest } from './jobs.js';
export { LINK_KINDS, NAV_LINK, NAV_LINK_SCHEMA, NAV_OBSTACLE_SCHEMA } from './links.js';
export { AGENT_HEIGHT, MAX_LAYERS, MAX_SLOPE, NAV_OBSTACLE, STEP_HEIGHT, TILE } from './world.js';

export const NAV_AGENT_SCHEMA: Schema = {
  speed: t.number({ default: 3.5, min: 0, modifiable: true }),
  radius: t.number({ default: 0.4, min: 0 }),
  stopping_distance: t.number({ default: 0.5, min: 0 }),
  avoid_others: t.bool({ default: true }),
  drives_body: t.bool({ default: true }),
  jump_height: t.number({ default: 0, min: 0 }),
  drop_height: t.number({ default: 0, min: 0 }),
};

/** Meters a batched search may wander outside the rectangle around its requests' ends. */
export const BATCH_MARGIN = 16;

/**
 * Searches for several (start, end, radius) queries: one bake per radius over the requests'
 * bounding rectangle (plus BATCH_MARGIN), searched in the `nav.paths` job when a job runner
 * is there, else on this thread. Results are in query order; a path that would need to
 * leave the rectangle is null.
 */
async function batchedPaths(kernel: Kernel, live: Pathfinder, queries: readonly NavPathQuery[]): Promise<(Vec3[] | null)[]> {
  const out: (Vec3[] | null)[] = queries.map(() => null);
  const byRadius = new Map<number, number[]>();
  queries.forEach((q, i) => {
    if (!(Number.isFinite(q.radius) && q.radius >= 0)) fail('PP3249', `nav paths: query ${i} radius must be 0 or more, got ${q.radius}`);
    const list = byRadius.get(q.radius) ?? [];
    list.push(i);
    byRadius.set(q.radius, list);
  });
  const jobs = kernel.tryService(JOBS_SERVICE);
  await Promise.all([...byRadius].map(async ([radius, indices]) => {
    const snap = snapDistance(radius);
    const reach = BATCH_MARGIN + snap;
    let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
    for (const i of indices) {
      for (const p of [queries[i]!.start, queries[i]!.end]) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
    }
    const data = bake(live.grid, { minX: minX - reach, minZ: minZ - reach, maxX: maxX + reach, maxZ: maxZ + reach }, radius);
    // Plain points: a Vec3 doesn't survive structured cloning into a worker.
    const requests = indices.map((i) => {
      const { start, end } = queries[i]!;
      return { start: { x: start.x, y: start.y, z: start.z }, goal: { x: end.x, y: end.y, z: end.z }, snap };
    });
    const found = jobs === undefined ? findPaths({ bake: data, requests }) : await jobs.run(NAV_PATHS, { bake: data, requests });
    indices.forEach((i, n) => {
      const route = found[n];
      const y = queries[i]!.start.y;
      out[i] = route === null || route === undefined ? null : route.map((w) => new Vec3(w.x, w.y ?? y, w.z));
    });
  }));
  return out;
}

export interface NavOptions {
  /** Radius for `ctx.nav` queries (agents use their own). Default 0.4 m. */
  readonly agentRadius?: number;
  /** Grid cell edge in meters. Default 0.25. */
  readonly cellSize?: number;
}

/** The engine side of `ctx.nav`; the api layer binds Python arguments onto it. */
export interface NavQueries {
  /** `agent`: an Entity with a NavAgent, whose radius, jump_height and drop_height the search uses. */
  path(start: Vec3, end: Vec3, agent?: unknown): Vec3[];
  reachable(start: Vec3, end: Vec3, agent?: unknown): boolean;
  /** `random`: a float in [0, 1) per call (the game's seeded stream). */
  randomPoint(near: Vec3, radius: number, random: () => number): Vec3 | null;
  canSee(viewer: unknown, target: unknown, fov: number, distance: number): boolean;
  /** Entities with static mesh/convex colliders nav could not read (no model geometry service), in this scene. */
  unsupported(): readonly EntityId[];
}

export interface NavPlugin extends KernelPlugin {
  queries(): NavQueries;
}

const RANDOM_TRIES = 30;

/** A Vec3 argument; Vec2 is a 2D game's (PP3242). */
export function navPoint(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) {
    if (![value.x, value.y, value.z].every(Number.isFinite)) fail('PP3241', `${where} must be finite, got ${value.x}, ${value.y}, ${value.z}`);
    return value;
  }
  if (value instanceof Vec2) {
    return fail('PP3242', `${where}: nav works on 3D scenes (Vec3 points); 2D grid navigation is not available`, {
      fix: 'In a 3D game pass a Vec3 (vec2.to_ground() gives one); for 2D boards use the grid plugin\'s Grid.path.',
    });
  }
  return fail('PP3241', `${where} must be a Vec3, got ${value === null ? 'None' : typeof value === 'object' ? (value.constructor?.name ?? 'object') : JSON.stringify(value)}`);
}

interface NavmeshBlock {
  readonly obstacles: readonly string[] | null;
  readonly links: readonly NavLinkData[];
  readonly wadeDepth: number;
}

const NAVMESH_KEYS = ['from', 'obstacles', 'links', 'wade_depth'];
const NO_NAVMESH: NavmeshBlock = { obstacles: null, links: [], wadeDepth: 0 };
const LINK_KEYS = ['start', 'end', 'kind', 'bidirectional', 'cost'];

function readNavmesh(scene: SceneDoc): NavmeshBlock {
  const block = scene.plugins['navmesh'];
  if (block === undefined) return NO_NAVMESH;
  const at = (pointer: string, message: string, fix: string): never =>
    fail('PP3240', `Scene "${scene.id}" navmesh: ${message}`, { fix, path: scene.path, pointer: `/navmesh${pointer}` });
  for (const key of Object.keys(block)) {
    if (NAVMESH_KEYS.includes(key)) continue;
    const guess = closestMatch(key, NAVMESH_KEYS);
    at(`/${key}`, `unknown key "${key}"`, guess === undefined ? `Keys: ${NAVMESH_KEYS.join(', ')}.` : `Did you mean "${guess}"?`);
  }
  if (block['from'] !== undefined && (typeof block['from'] !== 'string' || block['from'] === '')) {
    at('/from', '"from" must be a model path', 'Write a project path, e.g. "assets/models/ground.glb".');
  }
  const obstacles = block['obstacles'];
  if (obstacles !== undefined && (!Array.isArray(obstacles) || !obstacles.every((l) => typeof l === 'string' && l !== ''))) {
    at('/obstacles', '"obstacles" must be a list of collision layer names', 'Write e.g. ["terrain", "wall"].');
  }
  const wadeDepth = block['wade_depth'] ?? 0;
  if (typeof wadeDepth !== 'number' || !Number.isFinite(wadeDepth) || wadeDepth < 0) {
    at('/wade_depth', '"wade_depth" must be a number of meters, 0 or more', 'Write how deep water agents walk through, e.g. 1 (a ford); 0: any water blocks.');
  }
  const raw = block['links'] ?? [];
  if (!Array.isArray(raw)) return at('/links', '"links" must be a list of links', 'Write e.g. [{"start": [0, 0, 0], "end": [0, 3, 1], "kind": "climb"}].');
  const point = (value: Json | undefined, pointer: string): { x: number; y: number; z: number } => {
    if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return at(pointer, 'a link end must be a point [x, y, z]', 'Write three numbers in meters, e.g. [4, 0, -2].');
    }
    const [x, y, z] = value as number[];
    return { x: x!, y: y!, z: z! };
  };
  const links = raw.map((entry, n): NavLinkData => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return at(`/links/${n}`, 'a link must be an object', 'Write {"start": [x, y, z], "end": [x, y, z]}.');
    const link = entry as Record<string, Json>;
    for (const key of Object.keys(link)) {
      if (LINK_KEYS.includes(key)) continue;
      const guess = closestMatch(key, LINK_KEYS);
      at(`/links/${n}/${key}`, `unknown link key "${key}"`, guess === undefined ? `Keys: ${LINK_KEYS.join(', ')}.` : `Did you mean "${guess}"?`);
    }
    const kind = link['kind'] ?? 'jump';
    if (typeof kind !== 'string' || !(LINK_KINDS as readonly string[]).includes(kind)) {
      const guess = typeof kind === 'string' ? closestMatch(kind, LINK_KINDS) : undefined;
      at(`/links/${n}/kind`, `unknown link kind ${JSON.stringify(kind)}`, guess === undefined ? `Kinds: ${LINK_KINDS.join(', ')}.` : `Did you mean "${guess}"?`);
    }
    const bidirectional = link['bidirectional'] ?? true;
    if (typeof bidirectional !== 'boolean') at(`/links/${n}/bidirectional`, '"bidirectional" must be true or false', 'Write true (both ways) or false (start to end only).');
    const cost = link['cost'] ?? 0;
    if (typeof cost !== 'number' || !(cost >= 0)) at(`/links/${n}/cost`, '"cost" must be a number of at least 0', 'Write the extra meters the link costs, e.g. 2.');
    return {
      entity: -1, kind: kind as string, start: point(link['start'], `/links/${n}/start`), end: point(link['end'], `/links/${n}/end`),
      bidirectional: bidirectional as boolean, cost: cost as number,
    };
  });
  return { obstacles: obstacles === undefined ? null : obstacles as readonly string[], links, wadeDepth: wadeDepth as number };
}

function positive(value: number, where: string): number {
  if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) fail('PP3243', `${where} must be a number greater than 0, got ${String(value)}`);
  return value;
}

export function nav(options: NavOptions = {}): NavPlugin {
  const defaultRadius = options.agentRadius ?? 0.4;
  if (!(Number.isFinite(defaultRadius) && defaultRadius >= 0)) fail('PP3243', `nav agent_radius must be at least 0, got ${defaultRadius}`);
  const cellSize = positive(options.cellSize ?? 0.25, 'nav cell_size');

  let kernel: Kernel | undefined;
  let agents: Agents | undefined;
  let paths: Pathfinder | undefined;
  let grid: NavGrid | undefined;
  const obstacles = new Obstacles(() => kernel?.tryService(MODEL_GEOMETRY_SERVICE));
  const links = new Links();
  /** Bring the world in line with live entities: loaded models, moved NavObstacles and NavLinks, generated scenery. */
  const sync = (k: Kernel): void => {
    const get = (id: EntityId) => k.world.get(id);
    if (obstacles.pending.size > 0) obstacles.settle(get);
    if (obstacles.tracking) obstacles.track(get);
    if (links.tracking) links.poll(get);
    syncGenerated(k);
  };
  const installed = (): { kernel: Kernel; agents: Agents; paths: Pathfinder } => {
    if (kernel === undefined) fail('PP9240', 'nav is used before its kernel was built');
    sync(kernel);
    return { kernel, agents: agents!, paths: paths! };
  };
  /** The agents, for reads of their own state (moving, destination, …): no world sync, which only searches need. */
  const agentState = (): Agents => {
    if (kernel === undefined) fail('PP9240', 'nav is used before its kernel was built');
    return agents!;
  };
  /** The mesh lists last indexed: procgen (and city) hand back the same array while nothing changed, so a query skips the walk. */
  let generated: readonly [readonly GeneratedMesh[] | undefined, readonly GeneratedMesh[] | undefined] = [undefined, undefined];
  const syncGenerated = (k: Kernel): void => {
    const procgen = k.tryService(PROCGEN_SERVICE)?.meshes();
    const city = k.tryService(CITY_SERVICE)?.meshes();
    const same = (a: readonly GeneratedMesh[] | undefined, b: readonly GeneratedMesh[] | undefined): boolean => a === b || (a?.length === 0 && b?.length === 0);
    if (same(procgen, generated[0]) && same(city, generated[1])) return;
    generated = [procgen, city];
    const meshes = [...procgen ?? [], ...city ?? []];
    obstacles.syncGenerated(meshes);
    links.setGenerated(meshes.flatMap((m) => (m.links ?? []).map((l): NavLinkData => ({
      entity: m.entity ?? -1, kind: 'stairs', start: { x: l.start[0], y: l.start[1], z: l.start[2] }, end: { x: l.end[0], y: l.end[1], z: l.end[2] },
      bidirectional: true, cost: 0,
    }))));
  };
  // Read per grid column, so it must not settle/sync (callers ran `installed()` once per query).
  const terrainField = (): TerrainField | null => kernel?.tryService(TERRAIN_SERVICE)?.current() ?? null;
  const loadScene = (scene: SceneDoc | undefined): void => {
    const block = scene === undefined ? NO_NAVMESH : readNavmesh(scene);
    obstacles.clear();
    generated = [undefined, undefined];
    obstacles.layers = block.obstacles;
    links.clear();
    links.setScene(block.links);
    if (grid !== undefined) grid.wadeDepth = block.wadeDepth;
  };
  const reindex = (k: Kernel): void => {
    loadScene(k.scene);
    for (const record of k.world.live()) {
      obstacles.update(record);
      links.update(record);
    }
  };
  /** The search shape for a query: the default radius, or an agent entity's NavAgent. */
  const shapeFor = (k: Kernel, agent: unknown): AgentShape => {
    if (agent === undefined || agent === null) return walker(defaultRadius);
    const id = k.handles.unwrap(agent);
    const fields = id === undefined ? undefined : k.world.get(id)?.components.get(NAV_AGENT);
    if (fields === undefined) return fail('PP3244', 'ctx.nav agent= must be an Entity with a NavAgent', { fix: 'Pass the walking entity (its radius, jump_height and drop_height shape the path), or leave agent out.' });
    return shapeOf(fields);
  };
  const toPoints = (route: readonly Waypoint[], y: number): Vec3[] => route.map((w) => new Vec3(w.x, w.y ?? y, w.z));

  const self = (fields: Fields): EntityId => componentEntity(fields);
  const methods = {
    move_to(this: Fields, target: unknown): boolean {
      const { kernel: k, agents: a } = installed();
      if (target instanceof Vec3 || target instanceof Vec2) return a.moveTo(self(this), { kind: 'point', point: navPoint(target, 'move_to(target)') });
      const id = target === null || target === undefined ? undefined : k.handles.unwrap(target);
      if (id === undefined) return fail('PP3241', `move_to(target) takes a Vec3 or an Entity, got ${target === null || target === undefined ? 'None' : String(target)}`);
      if (!k.world.isAlive(id)) fail('PP3244', 'move_to(target): the target entity was destroyed', { fix: 'Check `target.alive` first.' });
      return a.moveTo(self(this), { kind: 'entity', id });
    },
    stop(this: Fields): void {
      agentState().stop(self(this));
    },
    get moving(): boolean {
      return agentState().moving(self(this as unknown as Fields));
    },
    get destination(): Vec3 | null {
      return agentState().destination(self(this as unknown as Fields));
    },
    get desired_velocity(): Vec3 {
      return agentState().desired(self(this as unknown as Fields));
    },
    get traversing(): string | null {
      return agentState().traversing(self(this as unknown as Fields));
    },
  };
  const component: ComponentDef = { id: NAV_AGENT, schema: NAV_AGENT_SCHEMA, methods };
  const linkComponent: ComponentDef = { id: NAV_LINK, schema: NAV_LINK_SCHEMA };
  const obstacleComponent: ComponentDef = { id: NAV_OBSTACLE, schema: NAV_OBSTACLE_SCHEMA };

  const eye = (k: Kernel, handle: unknown, where: string): { id: EntityId; at: Vec3; forward: Vec3 } => {
    const id = handle === null || handle === undefined ? undefined : k.handles.unwrap(handle);
    if (id === undefined) return fail('PP3245', `${where} must be an Entity`);
    const record = k.world.get(id);
    if (record === undefined) return fail('PP3244', `${where}: this entity was destroyed`, { fix: 'Check `entity.alive` first.' });
    const collider = record.components.get('collider');
    const at = collider === undefined ? record.transform.worldPosition() : record.transform.toWorld(collider['offset'] as Vec3);
    return { id, at, forward: record.transform.worldRotation().rotate(Vec3.FORWARD) };
  };

  const queries: NavQueries = {
    path(start, end, agent) {
      const { kernel: k, paths: p } = installed();
      const shape = shapeFor(k, agent);
      const route = p.route(start, end, shape, snapDistance(shape.radius));
      return route === null ? [] : toPoints(route, start.y);
    },
    reachable(start, end, agent) {
      const { kernel: k, paths: p } = installed();
      const shape = shapeFor(k, agent);
      return p.route(start, end, shape, snapDistance(shape.radius)) !== null;
    },
    randomPoint(near, radius, random) {
      positive(radius, 'random_point radius');
      const { paths: p } = installed();
      const shape = walker(defaultRadius);
      const from = p.nearest(near.x, near.y, near.z, defaultRadius, snapDistance(defaultRadius));
      if (from === null) return null;
      const limit = Math.min(MAX_EXPANSIONS, Math.ceil(Math.PI * ((3 * radius) / cellSize + 2) ** 2));
      for (let attempt = 0; attempt < RANDOM_TRIES; attempt++) {
        const angle = random() * 2 * Math.PI;
        const distance = radius * Math.sqrt(random());
        const x = near.x + Math.cos(angle) * distance;
        const z = near.z + Math.sin(angle) * distance;
        const cell = p.cellOf(x, z);
        const columns = p.grid.columns(cell.i, cell.k);
        // The cell's layers nearest `near` in height first: a wander on the second floor stays up there when it can.
        const order = columns.map((c, l) => ({ l, dy: c.implicit ? 0 : Math.abs(c.h - near.y) })).sort((a, b) => a.dy - b.dy || a.l - b.l);
        for (const { l } of order) {
          if (!p.grid.standable(cell.i, cell.k, l, defaultRadius)) continue;
          const goal = { ...cell, l };
          // Regions answer most tries at once (an island, the far side of a wall); a search settles the rest.
          const linked = p.connected(from, goal, shape);
          if (linked === false) continue;
          if (linked === null && p.cells(from, goal, shape, limit) === null) continue;
          const column = columns[l]!;
          return new Vec3(x, column.implicit ? near.y : column.h, z);
        }
      }
      return null;
    },
    canSee(viewer, target, fov, distance) {
      const { kernel: k } = installed();
      if (!(Number.isFinite(fov) && fov > 0 && fov <= 360)) fail('PP3243', `can_see fov must be in (0, 360] degrees, got ${fov}`);
      if (!(Number.isFinite(distance) && distance >= 0)) fail('PP3243', `can_see distance must be at least 0, got ${distance}`);
      const a = eye(k, viewer, 'can_see(viewer)');
      const b = eye(k, target, 'can_see(target)');
      const to = b.at.__sub__(a.at);
      if (to.length() > distance) return false;
      const flat = new Vec3(to.x, 0, to.z);
      const facing = new Vec3(a.forward.x, 0, a.forward.z);
      if (fov < 360 && flat.length() > 1e-9 && facing.length() > 1e-9) {
        const cos = flat.normalized().dot(facing.normalized());
        if (cos < Math.cos(((fov / 2) * Math.PI) / 180) - 1e-12) return false;
      }
      return !segmentBlocked(obstacles, terrainField(), a.at, b.at, new Set([a.id, b.id]));
    },
    unsupported: () => [...obstacles.unsupported],
  };

  const service: NavService = {
    cellSize,
    path(start, end, radius, reach) {
      const shape = { radius, jump: reach?.jumpHeight ?? 0, drop: reach?.dropHeight ?? 0 };
      const route = installed().paths.route(start, end, shape, snapDistance(radius));
      return route === null ? null : toPoints(route, start.y);
    },
    standable(at, radius) {
      const { paths: p } = installed();
      const cell = p.cellOf(at.x, at.z);
      // On the cell's layer nearest the point's height.
      const columns = p.grid.columns(cell.i, cell.k);
      let layer = -1;
      columns.forEach((c, l) => {
        if (layer < 0 || Math.abs(c.h - at.y) < Math.abs(columns[layer]!.h - at.y)) layer = l;
      });
      return layer >= 0 && p.grid.standable(cell.i, cell.k, layer, radius);
    },
    nearest(at, radius, range) {
      const { paths: p } = installed();
      const node = p.nearest(at.x, at.y, at.z, radius, range);
      if (node === null) return null;
      const here = p.cellOf(at.x, at.z);
      const column = p.column(node);
      const y = column.implicit ? at.y : column.h;
      return here.i === node.i && here.k === node.k ? new Vec3(at.x, y, at.z) : new Vec3(p.grid.center(node.i), y, p.grid.center(node.k));
    },
    lineClear(a, b, ignore) {
      installed();
      return !segmentBlocked(obstacles, terrainField(), a, b, new Set(ignore));
    },
    opaque(x, z, y, reach) {
      installed();
      const terrain = terrainField();
      if (terrain !== null && terrain.contains(x, z) && terrain.heightAt(x, z) > y) return true;
      return obstacles.opaque(x, z, y, Math.max(0, reach));
    },
    hasAgent: (id) => installed().kernel.world.get(id)?.components.has(NAV_AGENT) === true,
    moveAgent(id, target, options) {
      const { kernel: k, agents: a } = installed();
      if (!k.world.get(id)?.components.has(NAV_AGENT)) fail('PP3244', `entity ${id} has no NavAgent`, { fix: 'Add a NavAgent to units the AI moves.' });
      if (target instanceof Vec3) return a.moveTo(id, { kind: 'point', point: navPoint(target, 'nav move target') }, options);
      if (!k.world.isAlive(target)) fail('PP3244', 'nav move: the target entity was destroyed', { fix: 'Check `target.alive` first.' });
      return a.moveTo(id, { kind: 'entity', id: target }, options);
    },
    stopAgent: (id) => installed().agents.stop(id),
    agentMoving: (id) => installed().agents.moving(id),
    agentDestination: (id) => installed().agents.destination(id),
    bake: (bounds, radius) => bake(installed().paths.grid, bounds, radius),
    paths: (queries) => batchedPaths(installed().kernel, installed().paths, queries),
  };

  return {
    id: 'nav',
    components: [component, linkComponent, obstacleComponent],
    events: [ARRIVED, LINK_STARTED],
    install(k) {
      if (kernel !== undefined) fail('PP3247', 'This nav plugin is already installed in another kernel', { fix: 'Call nav() once per game.' });
      kernel = k;
      grid = new NavGrid(cellSize, obstacles, terrainField, links);
      paths = new Pathfinder(grid);
      agents = new Agents(k, () => paths!);
      k.provide(NAV_SERVICE, service);
      k.observeScenes({
        loading: (scene) => {
          loadScene(scene);
          agents!.clear();
        },
      });
      k.observeEntities({
        added: (records) => {
          for (const record of records) {
            obstacles.update(record);
            links.update(record);
          }
        },
        removed: (records) => {
          for (const record of records) {
            obstacles.remove(record.id);
            links.remove(record.id);
          }
          agents!.removed(records);
        },
        changed: (record) => {
          obstacles.update(record);
          links.update(record);
        },
      });
      k.addHook('physics', (dt) => {
        sync(k);
        agents!.step(dt);
      });
    },
    queries: () => queries,
    snapshot: () => installed().agents.snapshot(),
    restore: (k, state: Json) => {
      reindex(k);
      installed().agents.restore(state);
    },
  };
}
