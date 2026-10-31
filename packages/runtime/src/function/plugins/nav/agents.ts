/**
 * NavAgent motion. Each fixed step (the kernel's 'physics' hook) every agent with a
 * destination follows its path:
 *
 *   - waypoints are passed when within max(cell, speed·dt) of them on the ground plane and
 *     within LEVEL of their height (a waypoint on the floor above is not passed from below);
 *   - the preferred velocity is toward the next waypoint at `speed`; with `avoid_others`,
 *     agents then avoid each other reciprocally (crowd.ts, ORCA): each takes the velocity
 *     nearest its preferred one that keeps clear of its neighbours for TIME_HORIZON
 *     seconds, sharing the avoidance with neighbours that avoid too. Agents on another
 *     layer (the bridge over the road) are not neighbours;
 *   - a waypoint that starts a link (an authored NavLink or scene link, or an automatic
 *     jump/drop: search.ts) fires `LinkStarted` (entity, kind, link) when reached. With
 *     `drives_body` the agent then traverses it: "teleport" moves it to the far end at
 *     once, "jump" and "drop" follow an arc at `speed`, "climb" goes straight at half
 *     speed, "door" and "custom" walk straight through; it doesn't avoid others meanwhile.
 *     Without `drives_body` the game moves the body (Character.jump on LinkStarted) and the
 *     agent steers to the far end;
 *   - within `stopping_distance` (on the ground plane, and on the goal's level) of the goal
 *     it arrives: `Arrived` fires once, `moving` turns false and desired velocity is zero.
 *     A point destination is then done; an entity target keeps being followed — the agent
 *     sets off again (and can arrive again) once the target is farther than
 *     stopping_distance + REFOLLOW;
 *   - an entity target that moved more than max(0.5, stopping_distance) from the path's
 *     goal is re-pathed, at most every REPATH seconds; a destroyed target stops the agent;
 *   - when the static world changes where the rest of its path runs (a door closed, a
 *     NavObstacle moved in, a wall spawned), the agent re-plans, at most every REPATH seconds.
 *
 * With `drives_body` the agent moves its entity's transform by the desired velocity (never
 * past the goal), refusing steps onto no standable layer it can step to (sliding along x or
 * z instead), keeps the height it had above the surface when the path began (the implicit
 * ground plane: its height is kept as is), and turns to face where it walks (root
 * entities). Without it, only `desired_velocity` is computed and the game moves the body.
 *
 * Plugins moving agents through the nav service (an RTS group keeping pace, a squad slot)
 * may cap the speed and replace `stopping_distance` for one move (`NavMoveOptions`).
 */

import { fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, EventDef, Fields, Kernel } from '../../kernel/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { NavMoveOptions } from '../../services/index.js';
import { avoid } from './crowd.js';
import type { CrowdAgent } from './crowd.js';
import { snapDistance } from './search.js';
import type { AgentShape, Pathfinder, Waypoint } from './search.js';
import { AGENT_HEIGHT, NavGrid } from './world.js';
import type { Column, Rect } from './world.js';

export { snapDistance } from './search.js';

export const NAV_AGENT = 'nav_agent';
export const ARRIVED: EventDef = { id: 'arrived', target: 'entity' };
export const LINK_STARTED: EventDef = { id: 'link_started', target: 'entity' };
export const REPATH = 0.25;
export const REFOLLOW = 0.25;
/** Height (m) within which a waypoint or point goal counts as on the agent's level. */
export const LEVEL = 1;
/** Fastest an agent is taken to move (m/s) when its velocity is estimated from where it went (a teleport is not a velocity). */
const MAX_ESTIMATED_SPEED = 50;

type Target = { readonly kind: 'point'; readonly point: Vec3 } | { readonly kind: 'entity'; readonly id: EntityId };

interface Traverse {
  readonly kind: string;
  readonly from: Vec3;
  readonly to: Vec3;
  elapsed: number;
  readonly duration: number;
}

interface AgentState {
  target: Target;
  /** Where the current path leads. */
  goal: Vec3;
  path: Waypoint[];
  index: number;
  active: boolean;
  arrived: boolean;
  desired: Vec3;
  /** Height above the surface, kept while walking. */
  lift: number;
  repathAt: number;
  /** This move's overrides (service callers: RTS groups, squads); empty for `move_to`. */
  options: NavMoveOptions;
  /** The nav grid generation the path was planned on (NaN: unknown, so the next move_to plans). */
  planned: number;
  /** The link being traversed (drives_body agents), or null. */
  traverse: Traverse | null;
}

function flatDistance(a: Vec3, b: { x: number; z: number }): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** The agent shape a NavAgent's fields describe (search.ts). */
export function shapeOf(fields: Fields): AgentShape {
  const n = (key: string): number => (typeof fields[key] === 'number' ? fields[key] as number : 0);
  return { radius: n('radius'), jump: n('jump_height'), drop: n('drop_height') };
}

function traverseTime(kind: string, from: Vec3, to: Vec3, speed: number): number {
  if (kind === 'teleport') return 0;
  if (!(speed > 0)) return Infinity;
  const flat = Math.hypot(to.x - from.x, to.z - from.z);
  const rise = Math.abs(to.y - from.y);
  if (kind === 'jump' || kind === 'drop') return Math.max(0.3, flat / speed);
  if (kind === 'climb') return (flat + rise) / (speed * 0.5);
  return Math.hypot(flat, rise) / speed;
}

export class Agents {
  readonly #kernel: Kernel;
  readonly #paths: () => Pathfinder;
  readonly #states = new Map<EntityId, AgentState>();
  /** Each agent's velocity over the last step (ORCA reads its neighbours'). */
  readonly #velocity = new Map<EntityId, { x: number; z: number }>();

  constructor(kernel: Kernel, paths: () => Pathfinder) {
    this.#kernel = kernel;
    this.#paths = paths;
  }

  #record(id: EntityId): EntityRecord {
    return this.#kernel.world.require(id);
  }

  #fields(id: EntityId): Fields {
    return this.#record(id).components.get(NAV_AGENT)!;
  }

  #checkBody(record: EntityRecord, fields: Fields): void {
    if (fields['drives_body'] !== true) return;
    const name = record.placedId ?? record.prefab ?? `entity ${record.id}`;
    if (record.components.has('character')) {
      fail('PP3248', `The NavAgent on "${name}" drives its body, but the entity has a Character`, {
        fix: 'Set "drives_body": false and call character.move(agent.desired_velocity) yourself.',
      });
    }
    const body = record.components.get('rigidbody');
    if (body !== undefined && body['kind'] !== 'kinematic') {
      fail('PP3248', `The NavAgent on "${name}" drives a ${String(body['kind'])} Rigidbody, which physics moves`, {
        fix: 'Make the Rigidbody "kinematic", or set "drives_body": false and steer it with desired_velocity.',
      });
    }
  }

  #generation(): number {
    const grid = this.#paths().grid;
    return grid instanceof NavGrid ? grid.generation : Number.NaN;
  }

  /** Whether the world changed, since the path was planned, anywhere the rest of it runs. */
  #stale(state: AgentState, position: Vec3): boolean {
    const grid = this.#paths().grid;
    if (!(grid instanceof NavGrid)) return false;
    if (state.planned === grid.generation) return false;
    let rect: Rect = { minX: position.x, maxX: position.x, minZ: position.z, maxZ: position.z };
    for (let n = Math.max(0, state.index - 1); n < state.path.length; n++) {
      const w = state.path[n]!;
      rect = { minX: Math.min(rect.minX, w.x), maxX: Math.max(rect.maxX, w.x), minZ: Math.min(rect.minZ, w.z), maxZ: Math.max(rect.maxZ, w.z) };
    }
    if (grid.dirtySince(state.planned, rect)) return true;
    state.planned = grid.generation;
    return false;
  }

  /**
   * Whether a move_to may keep the current path: the agent is still walking to the same
   * entity, or to a point within half a cell (and half its stopping distance) of its goal,
   * with the same options, and the static world hasn't changed where the path runs since it
   * was planned. Games call move_to every frame with the same goal; replanning each time is
   * an A* search per agent per frame.
   */
  #same(id: EntityId, state: AgentState | undefined, target: Target, options: NavMoveOptions): boolean {
    if (state === undefined || !state.active || state.arrived) return false;
    if (state.options.maxSpeed !== options.maxSpeed || state.options.stoppingDistance !== options.stoppingDistance) return false;
    if (target.kind === 'entity') {
      if (state.target.kind !== 'entity' || state.target.id !== target.id) return false;
    } else {
      if (state.target.kind !== 'point') return false;
      const a = state.target.point;
      const b = target.point;
      if (a.x !== b.x || a.y !== b.y || a.z !== b.z) {
        const stopping = options.stoppingDistance ?? this.#fields(id)['stopping_distance'] as number;
        const near = 0.5 * Math.min(this.#paths().grid.cell, stopping);
        if (flatDistance(a, b) > near || Math.abs(a.y - b.y) > near) return false;
      }
    }
    if (Number.isNaN(state.planned)) return false;
    return state.traverse !== null || !this.#stale(state, this.#record(id).transform.worldPosition());
  }

  /** The layer under an agent at `position` standing `lift` above its surface (any layer, standable or not), or null. */
  #ground(position: Vec3, lift: number): Column | null {
    const grid = this.#paths().grid;
    const columns = grid.columns(grid.index(position.x), grid.index(position.z));
    const feet = position.y - lift;
    let best: Column | null = null;
    for (const c of columns) if (best === null || Math.abs(c.h - feet) < Math.abs(best.h - feet)) best = c;
    return best;
  }

  /** A path from the agent to `goal` (the state is updated), or false. */
  #plan(id: EntityId, state: AgentState, goal: Vec3): boolean {
    const fields = this.#fields(id);
    const shape = shapeOf(fields);
    // Mid-link, the new path starts where the link lands.
    const position = state.traverse?.to ?? this.#record(id).transform.worldPosition();
    const feet = { x: position.x, y: position.y - state.lift, z: position.z };
    const path = this.#paths().route(feet, goal, shape, snapDistance(shape.radius));
    state.repathAt = this.#kernel.time.now + REPATH;
    if (path === null) return false;
    state.planned = this.#generation();
    state.path = path;
    state.index = Math.min(1, path.length - 1);
    state.goal = goal;
    const ground = path[0]!.y;
    state.lift = ground === null ? 0 : position.y - ground;
    return true;
  }

  moveTo(id: EntityId, target: Target, options: NavMoveOptions = {}): boolean {
    const record = this.#record(id);
    this.#checkBody(record, this.#fields(id));
    if (target.kind === 'entity' && target.id === id) fail('PP3246', 'A NavAgent can\'t follow its own entity', { fix: 'Pass another entity or a point.' });
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
        fail('PP3243', `nav move ${key} must be a number of at least 0, got ${String(value)}`);
      }
    }
    const had = this.#states.get(id);
    if (this.#same(id, had, target, options)) {
      if (target.kind === 'point') had!.target = target;
      return true;
    }
    const goal = target.kind === 'point' ? target.point : this.#record(target.id).transform.worldPosition();
    const state: AgentState = {
      target, goal, path: [], index: 0, active: false, arrived: false, desired: Vec3.ZERO, lift: 0, repathAt: 0, options,
      planned: Number.NaN, traverse: had?.traverse ?? null,
    };
    if (state.traverse !== null) state.lift = had!.lift;
    this.#states.set(id, state);
    if (!this.#plan(id, state, goal)) return false;
    state.active = true;
    return true;
  }

  stop(id: EntityId): void {
    this.#record(id);
    this.#states.delete(id);
  }

  moving(id: EntityId): boolean {
    this.#record(id);
    const state = this.#states.get(id);
    return state !== undefined && state.active && !state.arrived;
  }

  destination(id: EntityId): Vec3 | null {
    this.#record(id);
    const state = this.#states.get(id);
    if (state === undefined || !state.active) return null;
    return state.target.kind === 'point' ? state.target.point : state.goal;
  }

  desired(id: EntityId): Vec3 {
    this.#record(id);
    return this.#states.get(id)?.desired ?? Vec3.ZERO;
  }

  /** The kind of link the agent is on ("jump", "climb", …), or null when it walks. */
  traversing(id: EntityId): string | null {
    this.#record(id);
    const state = this.#states.get(id);
    if (state === undefined || !state.active || state.arrived) return null;
    if (state.traverse !== null) return state.traverse.kind;
    return state.path[state.index - 1]?.link?.kind ?? null;
  }

  removed(records: readonly EntityRecord[]): void {
    for (const record of records) {
      this.#states.delete(record.id);
      this.#velocity.delete(record.id);
    }
  }

  clear(): void {
    this.#states.clear();
    this.#velocity.clear();
  }

  // ── The fixed step ──────────────────────────────────────────────────────────

  step(dt: number): void {
    const world = this.#kernel.world;
    const agents = world.query([NAV_AGENT]);
    const positions = new Map<EntityId, Vec3>(agents.map(([id]) => [id, world.require(id).transform.worldPosition()]));
    const walking: Array<{ id: EntityId; fields: Fields; state: AgentState; vx: number; vz: number; speed: number }> = [];
    for (const [id, fields] of agents) {
      const state = this.#states.get(id);
      if (state === undefined || !state.active) continue;
      const wants = this.#advance(id, fields!, state, positions.get(id)!, dt);
      if (wants !== null) walking.push({ id, fields: fields!, state, ...wants });
    }
    const avoiding = walking.filter((w) => w.fields['avoid_others'] === true);
    let chosen = new Map<number, { x: number; z: number }>();
    if (avoiding.length > 0 && agents.length > 1) {
      const wants = new Map(avoiding.map((w) => [w.id as number, w]));
      const crowd: CrowdAgent[] = agents.map(([id, fields]) => {
        const p = positions.get(id)!;
        const v = this.#velocity.get(id) ?? { x: 0, z: 0 };
        const w = wants.get(id);
        return {
          id, x: p.x, z: p.z, y: p.y - (this.#states.get(id)?.lift ?? 0), vx: v.x, vz: v.z, radius: fields!['radius'] as number,
          avoids: w !== undefined, prefVx: w?.vx ?? 0, prefVz: w?.vz ?? 0, maxSpeed: w?.speed ?? 0,
        };
      });
      chosen = avoid(crowd, dt, AGENT_HEIGHT);
    }
    for (const w of walking) {
      const v = chosen.get(w.id) ?? { x: w.vx, z: w.vz };
      w.state.desired = new Vec3(v.x, 0, v.z);
      if (w.fields['drives_body'] === true) this.#move(world.require(w.id), w.state, positions.get(w.id)!, w.fields['radius'] as number, dt);
    }
    for (const [id] of agents) {
      const was = positions.get(id)!;
      const now = world.require(id).transform.worldPosition();
      let vx = (now.x - was.x) / dt;
      let vz = (now.z - was.z) / dt;
      const speed = Math.hypot(vx, vz);
      if (!(speed <= MAX_ESTIMATED_SPEED)) {
        vx = 0;
        vz = 0;
      }
      if (vx === 0 && vz === 0) this.#velocity.delete(id);
      else this.#velocity.set(id, { x: vx, z: vz });
    }
  }

  #arrive(id: EntityId, state: AgentState): void {
    state.desired = Vec3.ZERO;
    if (state.arrived) return;
    state.arrived = true;
    if (state.target.kind === 'point') state.active = false;
    this.#kernel.emit(ARRIVED, { entity: this.#kernel.handles.wrap(id) });
  }

  /** Whether the agent is on the level of a path point (always, on the implicit ground plane). */
  #level(state: AgentState, position: Vec3, y: number | null): boolean {
    return y === null || Math.abs(position.y - state.lift - y) <= LEVEL;
  }

  /**
   * One agent's step before avoidance: arrival, re-paths, waypoints and links. Returns the
   * velocity its path wants (and its speed) while it walks; null when it arrived, stopped
   * or is on a link.
   */
  #advance(id: EntityId, fields: Fields, state: AgentState, position: Vec3, dt: number): { vx: number; vz: number; speed: number } | null {
    const stopping = state.options.stoppingDistance ?? fields['stopping_distance'] as number;
    const speed = Math.min(fields['speed'] as number, state.options.maxSpeed ?? Infinity);
    const now = this.#kernel.time.now;

    if (state.traverse !== null) {
      this.#traverse(this.#kernel.world.require(id), state, dt);
      return null;
    }

    if (state.target.kind === 'entity') {
      const target = this.#kernel.world.get(state.target.id);
      if (target === undefined) {
        this.#states.delete(id);
        return null;
      }
      const at = target.transform.worldPosition();
      const distance = flatDistance(position, at);
      const level = Math.abs(at.y - position.y) <= AGENT_HEIGHT;
      if (distance <= stopping && level) {
        this.#arrive(id, state);
        return null;
      }
      if (state.arrived && distance <= stopping + REFOLLOW && level) {
        state.desired = Vec3.ZERO;
        return null;
      }
      const drift = flatDistance(state.goal, at);
      if ((state.arrived || drift > Math.max(0.5, stopping)) && now >= state.repathAt) {
        if (this.#plan(id, state, at)) state.arrived = false;
      }
      if (state.arrived) {
        state.desired = Vec3.ZERO;
        return null;
      }
    } else if (flatDistance(position, state.goal) <= stopping && this.#level(state, position, state.path[state.path.length - 1]?.y ?? null)) {
      this.#arrive(id, state);
      return null;
    }

    if (now >= state.repathAt && this.#stale(state, position)) this.#plan(id, state, state.goal);

    const path = state.path;
    const reach = Math.max(this.#paths().grid.cell, speed * dt);
    while (state.index < path.length - 1) {
      const w = path[state.index]!;
      if (flatDistance(position, w) > reach || !this.#level(state, position, w.y)) break;
      state.index++;
      if (w.link === undefined) continue;
      this.#kernel.emit(LINK_STARTED, {
        entity: this.#kernel.handles.wrap(id),
        kind: w.link.kind,
        target: w.link.entity >= 0 && this.#kernel.world.isAlive(w.link.entity as EntityId) ? this.#kernel.handles.wrap(w.link.entity as EntityId) : null,
      });
      if (fields['drives_body'] !== true) break;
      const end = path[state.index]!;
      const to = new Vec3(end.x, end.y === null ? position.y : end.y + state.lift, end.z);
      state.traverse = { kind: w.link.kind, from: position, to, elapsed: 0, duration: traverseTime(w.link.kind, position, to, speed) };
      this.#traverse(this.#kernel.world.require(id), state, dt);
      return null;
    }
    const next = path[state.index]!;
    const toNext = flatDistance(position, next);
    if (toNext <= 1e-9) return { vx: 0, vz: 0, speed };
    return { vx: ((next.x - position.x) / toNext) * speed, vz: ((next.z - position.z) / toNext) * speed, speed };
  }

  /** One step along the link being traversed (drives_body). */
  #traverse(record: EntityRecord, state: AgentState, dt: number): void {
    const t = state.traverse!;
    t.elapsed += dt;
    const u = t.duration <= 0 ? 1 : Math.min(1, t.elapsed / t.duration);
    let x = t.from.x + (t.to.x - t.from.x) * u;
    let y = t.from.y + (t.to.y - t.from.y) * u;
    let z = t.from.z + (t.to.z - t.from.z) * u;
    if (t.kind === 'jump' || t.kind === 'drop') {
      const arc = t.kind === 'jump' ? 0.5 + Math.max(0, t.to.y - t.from.y) * 0.5 : 0.25;
      y += 4 * arc * u * (1 - u);
    }
    if (u >= 1) {
      x = t.to.x;
      y = t.to.y;
      z = t.to.z;
      state.traverse = null;
    }
    const flat = Math.hypot(t.to.x - t.from.x, t.to.z - t.from.z);
    state.desired = t.duration > 0 && Number.isFinite(t.duration) && state.traverse !== null
      ? new Vec3((t.to.x - t.from.x) / t.duration, 0, (t.to.z - t.from.z) / t.duration)
      : Vec3.ZERO;
    record.transform.setWorldPosition(new Vec3(x, y, z));
    if (flat > 1e-6 && record.parent === null && t.kind !== 'teleport') {
      record.transform.rotation = Quat.from_euler(new Vec3(0, (Math.atan2(t.to.x - t.from.x, t.to.z - t.from.z) * 180) / Math.PI, 0));
    }
  }

  #move(record: EntityRecord, state: AgentState, position: Vec3, radius: number, dt: number): void {
    let dx = state.desired.x * dt;
    let dz = state.desired.z * dt;
    const final = state.path[state.path.length - 1]!;
    const remaining = flatDistance(position, final);
    const step = Math.hypot(dx, dz);
    if (state.index === state.path.length - 1 && step > remaining && step > 0) {
      dx *= remaining / step;
      dz *= remaining / step;
    }
    const paths = this.#paths();
    const grid = paths.grid;
    const here = this.#ground(position, state.lift);
    const feet = position.y - state.lift;
    const fits = (x: number, z: number): Column | null => paths.layerAt(grid.index(x), grid.index(z), here, feet, radius);
    let x = position.x + dx;
    let z = position.z + dz;
    let column = fits(x, z);
    if (column === null) {
      if ((column = fits(position.x + dx, position.z)) !== null) z = position.z;
      else if ((column = fits(position.x, position.z + dz)) !== null) x = position.x;
      else return;
    }
    const y = column.implicit ? position.y : column.h + state.lift;
    record.transform.setWorldPosition(new Vec3(x, y, z));
    const moved = Math.hypot(x - position.x, z - position.z);
    if (moved > 1e-6 && record.parent === null) {
      record.transform.rotation = Quat.from_euler(new Vec3(0, (Math.atan2(x - position.x, z - position.z) * 180) / Math.PI, 0));
    }
  }

  // ── Snapshots ───────────────────────────────────────────────────────────────

  snapshot(): Json {
    const v = (p: Vec3): Json => [p.x, p.y, p.z];
    const agents = [...this.#states].map(([id, s]): JsonObject => ({
      id,
      target: s.target.kind === 'point' ? { point: v(s.target.point) } : { entity: s.target.id },
      goal: v(s.goal),
      path: s.path.map((w) => (w.link === undefined ? [w.x, w.y, w.z] : [w.x, w.y, w.z, w.link.kind, w.link.entity])),
      index: s.index,
      active: s.active,
      arrived: s.arrived,
      desired: v(s.desired),
      lift: s.lift,
      repath_at: s.repathAt,
      ...(s.options.maxSpeed !== undefined && { max_speed: s.options.maxSpeed }),
      ...(s.options.stoppingDistance !== undefined && { stopping_distance: s.options.stoppingDistance }),
      ...(s.traverse !== null && {
        traverse: { kind: s.traverse.kind, from: v(s.traverse.from), to: v(s.traverse.to), elapsed: s.traverse.elapsed, duration: Number.isFinite(s.traverse.duration) ? s.traverse.duration : -1 },
      }),
    }));
    const velocities = [...this.#velocity].map(([id, w]): Json => [id, w.x, w.z]);
    return { agents, velocities };
  }

  restore(saved: Json): void {
    this.#states.clear();
    this.#velocity.clear();
    const vec = (j: Json | undefined): Vec3 => {
      const [x, y, z] = j as readonly number[];
      return new Vec3(x, y, z);
    };
    // Snapshots from before velocities were kept are a bare list of agents.
    const doc = Array.isArray(saved) ? { agents: saved, velocities: [] } : saved as JsonObject;
    for (const entry of doc['agents'] as readonly JsonObject[]) {
      const id = entry['id'] as EntityId;
      if (!this.#kernel.world.isAlive(id)) continue;
      const target = entry['target'] as JsonObject;
      const traverse = entry['traverse'] as JsonObject | undefined;
      this.#states.set(id, {
        target: 'point' in target ? { kind: 'point', point: vec(target['point']) } : { kind: 'entity', id: target['entity'] as EntityId },
        goal: vec(entry['goal']),
        path: (entry['path'] as ReadonlyArray<readonly Json[]>).map(([x, y, z, kind, entity]) => ({
          x: x as number, y: y as number | null, z: z as number,
          ...(typeof kind === 'string' && { link: { kind, entity: entity as number } }),
        })),
        index: entry['index'] as number,
        active: entry['active'] === true,
        arrived: entry['arrived'] === true,
        desired: vec(entry['desired']),
        lift: entry['lift'] as number,
        repathAt: entry['repath_at'] as number,
        // Restored paths were planned on this same static world (nav re-indexed it before restoring).
        planned: this.#generation(),
        options: {
          ...(typeof entry['max_speed'] === 'number' && { maxSpeed: entry['max_speed'] }),
          ...(typeof entry['stopping_distance'] === 'number' && { stoppingDistance: entry['stopping_distance'] }),
        },
        traverse: traverse === undefined ? null : {
          kind: traverse['kind'] as string, from: vec(traverse['from']), to: vec(traverse['to']),
          elapsed: traverse['elapsed'] as number, duration: (traverse['duration'] as number) < 0 ? Infinity : traverse['duration'] as number,
        },
      });
    }
    for (const entry of doc['velocities'] as ReadonlyArray<readonly number[]>) {
      const [id, x, z] = entry;
      if (this.#kernel.world.isAlive(id as EntityId)) this.#velocity.set(id as EntityId, { x: x!, z: z! });
    }
  }
}
