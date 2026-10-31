/**
 * The Python-facing side of the ai plugin (sdk/parallax/ai.pyi): `ctx.ai` (AiApi) and the
 * objects it hands out — blackboards, squads, the director, fog of war — the `agent` a
 * task receives, and the engine components' methods. Arguments bind as CPython would
 * (core bindArgs); every misuse is a coded diagnostic.
 */

import { bindArgs, fail, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { Fields } from '../../kernel/index.js';
import { bool, describe, entity, list, number, optionalNumber, place, point, string, tagId } from './args.js';
import { checkKey, EntityRef, toValue } from './blackboard.js';
import type { Blackboard, Value } from './blackboard.js';
import type { Director } from './director.js';
import { assignSlots, facingOf, formationOffsets, FORMATIONS, isFormation, placeSlots } from './formations.js';
import type { Formation } from './formations.js';
import type { Order } from './orders.js';
import { NAV_SERVICE } from '../../services/index.js';
import { BRAIN, PERCEPTION } from './schemas.js';
import type { AiState, BrainState } from './state.js';
import type { Node } from './tree.js';

const NAV_AGENT = 'nav_agent';
const EYE = 1.6;

function toPython(state: AiState, value: Value | undefined): unknown {
  if (value === undefined) return undefined;
  if (value instanceof EntityRef) return state.kernel.handles.wrap(value.id);
  if (Array.isArray(value)) return value.map((v) => toPython(state, v));
  return value;
}

function fromPython(state: AiState, raw: unknown, where: string): Value {
  return toValue(raw, where, (r) => (typeof r === 'object' && r !== null ? state.kernel.handles.unwrap(r) : undefined));
}

/** `brain.blackboard`, `squad.blackboard`: get / set / has / clear / keys. */
export class BlackboardView {
  readonly #state: AiState;
  readonly #bb: Blackboard;

  constructor(state: AiState, bb: Blackboard) {
    this.#state = state;
    this.#bb = bb;
  }

  get(...args: unknown[]): unknown {
    const a = bindArgs('get', args, { positional: ['key', 'default'], required: ['key'] }).args;
    const value = this.#bb.get(checkKey(a['key'], 'blackboard.get()'), this.#state.clock);
    return value === undefined ? (a['default'] ?? null) : toPython(this.#state, value);
  }

  set(...args: unknown[]): null {
    const a = bindArgs('set', args, { positional: ['key', 'value'], keyword: ['ttl'], required: ['key', 'value'] }).args;
    const key = checkKey(a['key'], 'blackboard.set()');
    const ttl = optionalNumber(a['ttl'], 'blackboard.set() ttl', 0);
    this.#bb.set(key, fromPython(this.#state, a['value'], `blackboard.set("${key}")`), this.#state.clock, ttl);
    return null;
  }

  has(...args: unknown[]): boolean {
    const a = bindArgs('has', args, { positional: ['key'], required: ['key'] }).args;
    return this.#bb.has(checkKey(a['key'], 'blackboard.has()'), this.#state.clock);
  }

  clear(...args: unknown[]): null {
    const a = bindArgs('clear', args, { positional: ['key'] }).args;
    if (a['key'] === undefined || a['key'] === null) this.#bb.clear();
    else this.#bb.delete(checkKey(a['key'], 'blackboard.clear()'));
    return null;
  }

  keys(...args: unknown[]): string[] {
    bindArgs('keys', args, {});
    return this.#bb.keys(this.#state.clock);
  }
}

/** What a task function receives: `def shoot(ctx, agent) -> Status`. */
export class TaskAgent {
  readonly entity: unknown;
  readonly blackboard: BlackboardView;
  /** Seconds since this task started running. */
  readonly elapsed: number;
  /** Seconds since the brain's last tick. */
  readonly dt: number;
  /** The `do` node's name (or the task name). */
  readonly node: string;
  readonly #args: Readonly<Record<string, Value>>;
  readonly #state: AiState;

  constructor(state: AiState, id: EntityId, brain: BrainState, node: Extract<Node, { type: 'do' }>, elapsed: number, dt: number) {
    this.#state = state;
    this.entity = state.kernel.handles.wrap(id);
    this.blackboard = new BlackboardView(state, brain.bb);
    this.elapsed = elapsed;
    this.dt = dt;
    this.node = node.label;
    this.#args = node.args;
  }

  /** `agent.arg("range", 20)`: the node's argument, or the default (an absent one without a default is PP3253). */
  arg(...args: unknown[]): unknown {
    const a = bindArgs('arg', args, { positional: ['name', 'default'], required: ['name'] }).args;
    const name = string(a['name'], 'agent.arg() name');
    if (name in this.#args) return toPython(this.#state, this.#args[name]);
    if ('default' in a) return a['default'];
    return fail('PP3253', `Task "${this.node}" reads argument "${name}", which its "do" node doesn't give`, {
      fix: `Add "args": {"${name}": ...} to the node, or pass a default: agent.arg("${name}", 0).`,
    });
  }
}

export class SquadHandle {
  readonly name: string;
  readonly #state: AiState;

  constructor(state: AiState, name: string) {
    this.#state = state;
    this.name = name;
  }

  get members(): unknown[] {
    return this.#state.squads.members(this.name).map((id) => this.#state.kernel.handles.wrap(id));
  }

  get leader(): unknown {
    const id = this.#state.squads.leader(this.name);
    return id === null ? null : this.#state.kernel.handles.wrap(id);
  }

  get blackboard(): BlackboardView {
    return new BlackboardView(this.#state, this.#state.squads.state(this.name).blackboard);
  }

  get formation(): string {
    return this.#state.squads.state(this.name).formation;
  }

  get spacing(): number {
    return this.#state.squads.state(this.name).spacing;
  }

  get share_targets(): boolean {
    return this.#state.squads.state(this.name).shareTargets;
  }

  set share_targets(value: unknown) {
    this.#state.squads.state(this.name).shareTargets = bool(value, 'squad.share_targets');
  }

  set_formation(...args: unknown[]): null {
    const a = bindArgs('set_formation', args, { positional: ['shape'], keyword: ['spacing'], required: ['shape'] }).args;
    const s = this.#state.squads.state(this.name);
    s.formation = formation(a['shape'], 'set_formation() shape');
    if (a['spacing'] !== undefined) s.spacing = number(a['spacing'], 'set_formation() spacing', 0.01);
    return null;
  }

  /** The member's place in the formation around the leader (the leader's own position for the leader), or None. */
  slot(...args: unknown[]): Vec3 | null {
    const a = bindArgs('slot', args, { positional: ['member'], required: ['member'] }).args;
    const id = entity(this.#state.kernel.handles, a['member'], 'slot() member');
    const leader = this.#state.squads.leader(this.name);
    const members = this.#state.squads.members(this.name);
    if (leader === null || !members.includes(id)) return null;
    const order = [leader, ...members.filter((m) => m !== leader)];
    const s = this.#state.squads.state(this.name);
    const record = this.#state.kernel.world.require(leader);
    const forward = record.transform.worldRotation().rotate(Vec3.FORWARD);
    const fl = Math.hypot(forward.x, forward.z);
    const facing = fl < 1e-9 ? { x: 0, z: 1 } : { x: forward.x / fl, z: forward.z / fl };
    const slots = placeSlots(record.transform.worldPosition(), facing, formationOffsets(s.formation, order.length, s.spacing), false);
    return slots[order.indexOf(id)]!;
  }

  move(...args: unknown[]): null {
    const a = bindArgs('move', args, { positional: ['point'], keyword: ['formation', 'spacing', 'queue'], required: ['point'] }).args;
    const s = this.#state.squads.state(this.name);
    const shape = a['formation'] === undefined ? s.formation : a['formation'] === null ? null : formation(a['formation'], 'move() formation');
    const spacing = a['spacing'] === undefined ? s.spacing : number(a['spacing'], 'move() spacing', 0.01);
    groupCommand(this.#state, this.#state.squads.members(this.name), 'move', point(a['point'], 'move() point'), shape, spacing,
      a['queue'] === undefined ? false : bool(a['queue'], 'move() queue'));
    return null;
  }

  /** Find and reserve cover for each member with a Brain; writes it under `key`. Returns how many got cover. */
  assign_cover(...args: unknown[]): number {
    const a = bindArgs('assign_cover', args, { positional: ['threat'], keyword: ['radius', 'key'], required: ['threat'] }).args;
    const st = this.#state;
    const threat = placeOf(st, a['threat'], 'assign_cover() threat');
    const radius = a['radius'] === undefined ? 15 : number(a['radius'], 'assign_cover() radius', 0);
    const key = a['key'] === undefined ? 'cover' : checkKey(a['key'], 'assign_cover() key');
    let n = 0;
    for (const id of st.squads.members(this.name)) {
      if (!st.kernel.world.require(id).components.has(BRAIN)) continue;
      const at = st.tactics.findCover(id, threat.at, threat.ignore, { radius, minDistance: 3, peek: false, reserve: true });
      const bb = st.brain(id).bb;
      if (at === null) bb.delete(key);
      else {
        bb.set(key, at, st.clock);
        n++;
      }
    }
    return n;
  }

  /** Flanking points for members whose role is in `roles`, alternating right and left; written under `key`. */
  flank(...args: unknown[]): number {
    const a = bindArgs('flank', args, { positional: ['threat'], keyword: ['distance', 'roles', 'key'], required: ['threat'] }).args;
    const st = this.#state;
    const threat = placeOf(st, a['threat'], 'flank() threat');
    const distance = a['distance'] === undefined ? 8 : number(a['distance'], 'flank() distance', 0);
    const roles = a['roles'] === undefined ? ['flanker'] : list(a['roles'], 'flank() roles').map((r) => string(r, 'flank() roles'));
    const key = a['key'] === undefined ? 'flank' : checkKey(a['key'], 'flank() key');
    let n = 0;
    let side: 'right' | 'left' = 'right';
    for (const id of st.squads.members(this.name)) {
      const record = st.kernel.world.require(id);
      if (!roles.includes(record.components.get('squad_member')!['role'] as string) || !record.components.has(BRAIN)) continue;
      const at = st.tactics.flankPosition(id, threat.at, threat.ignore, distance, side);
      side = side === 'right' ? 'left' : 'right';
      const bb = st.brain(id).bb;
      if (at === null) bb.delete(key);
      else {
        bb.set(key, at, st.clock);
        n++;
      }
    }
    return n;
  }

  /** Alert every member with Perception to `target` (at `position`, default where it is now). */
  alarm(...args: unknown[]): null {
    const a = bindArgs('alarm', args, { positional: ['target', 'position'], required: ['target'] }).args;
    const st = this.#state;
    const target = entity(st.kernel.handles, a['target'], 'alarm() target');
    const at = a['position'] === undefined || a['position'] === null ? st.kernel.world.require(target).transform.worldPosition() : point(a['position'], 'alarm() position');
    for (const id of st.squads.members(this.name)) {
      if (st.kernel.world.require(id).components.has(PERCEPTION)) st.perception.alarm(id, target, at, st.clock);
    }
    return null;
  }
}

export class DirectorHandle {
  readonly #state: AiState;

  constructor(state: AiState) {
    this.#state = state;
  }

  get #d(): Director {
    return this.#state.director ?? fail('PP3281', 'This game has no combat director', {
      fix: 'Configure one: ai(director=Director(...)), or ctx.ai.director.configure(...) at runtime.',
    });
  }

  get phase(): string { return this.#d.phase; }
  get intensity(): number { return this.#d.intensity; }
  get budget(): number { return this.#d.budget; }
  get alive(): number { return this.#d.alive.size; }

  report(...args: unknown[]): null {
    const a = bindArgs('report', args, { positional: ['amount'], required: ['amount'] }).args;
    this.#d.report(number(a['amount'], 'director.report() amount'));
    return null;
  }

  can_spawn(...args: unknown[]): boolean {
    const a = bindArgs('can_spawn', args, { positional: ['cost'] }).args;
    return this.#d.canSpawn(a['cost'] === undefined ? 1 : number(a['cost'], 'can_spawn() cost', 0));
  }

  spawned(...args: unknown[]): null {
    const a = bindArgs('spawned', args, { positional: ['entity', 'cost'], required: ['entity'] }).args;
    this.#d.spawned(entity(this.#state.kernel.handles, a['entity'], 'spawned() entity'), a['cost'] === undefined ? 1 : number(a['cost'], 'spawned() cost', 0));
    return null;
  }

  configure(...args: unknown[]): null {
    const { restKeywords } = bindArgs('configure', args, { restKeywords: true });
    this.#state.configureDirector(restKeywords);
    return null;
  }
}

export class FogHandle {
  readonly #state: AiState;

  constructor(state: AiState) {
    this.#state = state;
  }

  get teams(): string[] {
    return this.#state.fog.teams();
  }

  visible(...args: unknown[]): boolean {
    const a = bindArgs('visible', args, { positional: ['team', 'point'], required: ['team', 'point'] }).args;
    const p = point(a['point'], 'fog.visible() point');
    return (this.#state.fog.bits(tagId(a['team'], 'fog.visible() team'), p.x, p.z) & 1) !== 0;
  }

  explored(...args: unknown[]): boolean {
    const a = bindArgs('explored', args, { positional: ['team', 'point'], required: ['team', 'point'] }).args;
    const p = point(a['point'], 'fog.explored() point');
    return (this.#state.fog.bits(tagId(a['team'], 'fog.explored() team'), p.x, p.z) & 2) !== 0;
  }

  sees(...args: unknown[]): boolean {
    const a = bindArgs('sees', args, { positional: ['team', 'entity'], required: ['team', 'entity'] }).args;
    const id = entity(this.#state.kernel.handles, a['entity'], 'fog.sees() entity');
    const at = this.#state.kernel.world.require(id).transform.worldPosition();
    return (this.#state.fog.bits(tagId(a['team'], 'fog.sees() team'), at.x, at.z) & 1) !== 0;
  }

  reveal(...args: unknown[]): null {
    const a = bindArgs('reveal', args, { positional: ['team', 'center', 'radius', 'seconds'], required: ['team', 'center', 'radius', 'seconds'] }).args;
    const c = point(a['center'], 'fog.reveal() center');
    const st = this.#state;
    st.fog.reveals.push({
      team: tagId(a['team'], 'fog.reveal() team'), x: c.x, z: c.z, radius: number(a['radius'], 'fog.reveal() radius', 0),
      until: st.clock + number(a['seconds'], 'fog.reveal() seconds', 0),
    });
    st.fog.nextAt = st.clock;
    return null;
  }
}

function formation(value: unknown, where: string): Formation {
  if (isFormation(value)) return value;
  return fail('PP3270', `${where} must be one of ${FORMATIONS.map((f) => `"${f}"`).join(', ')}, got ${describe(value)}`);
}

/** A threat as a point plus the entities to ignore when testing lines to it. */
function placeOf(state: AiState, value: unknown, where: string): { at: Vec3; ignore: EntityId[] } {
  const p = place(state.kernel.handles, value, where);
  if ('at' in p) return { at: p.at, ignore: [] };
  return { at: state.kernel.world.require(p.id).transform.worldPosition(), ignore: [p.id] };
}

/** An entity's eye for line-of-sight questions: Perception.eye_height, else 1.6 m. */
function eyeOf(state: AiState, id: EntityId): Vec3 {
  const record = state.kernel.world.require(id);
  const f = record.components.get(PERCEPTION);
  return state.perception.eye(record, f ?? { eye_height: EYE });
}

const ORDER_KINDS = ['move', 'attack', 'attack_move', 'patrol', 'hold', 'stop'] as const;

/** `ctx.ai.command` and `squad.move`: one order for a group, in formation for moves. */
export function groupCommand(state: AiState, units: readonly EntityId[], kind: string, target: unknown, shape: Formation | null, spacing: number, queue: boolean): void {
  if (!(ORDER_KINDS as readonly string[]).includes(kind)) {
    fail('PP3275', `Unknown order "${kind}"`, { fix: `Orders: ${ORDER_KINDS.join(', ')}.` });
  }
  if (units.length === 0) return;
  const world = state.kernel.world;
  if (kind === 'stop') {
    for (const id of units) state.orders.stop(id);
    return;
  }
  if (kind === 'hold') {
    for (const id of units) state.orders.give(id, { kind: 'hold' }, queue);
    return;
  }
  if (kind === 'attack') {
    const t = entity(state.kernel.handles, target, 'command("attack") target');
    for (const id of units) state.orders.give(id, { kind: 'attack', target: t }, queue);
    return;
  }
  const speeds = units.map((id) => world.require(id).components.get(NAV_AGENT)?.['speed']).filter((s): s is number => typeof s === 'number');
  const pace = shape === null || speeds.length === 0 ? undefined : Math.min(...speeds);
  const positions = units.map((id) => world.require(id).transform.worldPosition());
  const centroid = positions.reduce((s, p) => s.__add__(p), Vec3.ZERO).__mul__(1 / positions.length);
  const slotsFor = (dest: Vec3, from: Vec3): Vec3[] => {
    if (shape === null) return units.map(() => dest);
    const slots = placeSlots(dest, facingOf(from, dest), formationOffsets(shape, units.length, spacing), true);
    const nav = state.kernel.tryService(NAV_SERVICE);
    return nav === undefined ? slots : slots.map((s) => nav.nearest(s, 0.4, spacing) ?? s);
  };
  const withPace = <T extends object>(o: T): T => (pace === undefined ? o : { ...o, maxSpeed: pace });
  if (kind === 'patrol') {
    const points = list(target, 'command("patrol") points').map((p, i) => point(p, `command("patrol") points[${i}]`));
    if (points.length === 0) fail('PP3275', 'command("patrol") needs at least one point');
    const perPoint = points.map((p, i) => slotsFor(p, i === 0 ? centroid : points[i - 1]!));
    const assigned = assignSlots(positions, perPoint[0]!);
    units.forEach((id, u) => state.orders.give(id, withPace({ kind: 'patrol', points: perPoint.map((slots) => slots[assigned[u]!]!), index: 0 }) as Order, queue));
    return;
  }
  const dest = point(target, `command("${kind}") point`);
  const slots = slotsFor(dest, centroid);
  const assigned = assignSlots(positions, slots);
  units.forEach((id, u) => state.orders.give(id, withPace({ kind: kind as 'move' | 'attack_move', point: slots[assigned[u]!]! }) as Order, queue));
}

/** `ctx.ai`: world-level AI questions and commands (AiApi in sdk/parallax/ai.pyi). */
export class AiApi {
  readonly #state: () => AiState;

  constructor(state: () => AiState) {
    this.#state = state;
  }

  get director(): DirectorHandle {
    return new DirectorHandle(this.#state());
  }

  get fog(): FogHandle {
    return new FogHandle(this.#state());
  }

  squad(...args: unknown[]): SquadHandle {
    const a = bindArgs('squad', args, { positional: ['name'], required: ['name'] }).args;
    return new SquadHandle(this.#state(), string(a['name'], 'squad() name'));
  }

  noise(...args: unknown[]): null {
    const a = bindArgs('noise', args, { positional: ['at', 'loudness'], keyword: ['source', 'kind'], required: ['at'] }).args;
    const st = this.#state();
    st.noise(point(a['at'], 'noise() at'), a['loudness'] === undefined ? 10 : number(a['loudness'], 'noise() loudness', 0),
      a['source'] === undefined || a['source'] === null ? null : entity(st.kernel.handles, a['source'], 'noise() source'),
      a['kind'] === undefined || a['kind'] === null ? null : tagId(a['kind'], 'noise() kind'));
    return null;
  }

  block_sight(...args: unknown[]): null {
    const a = bindArgs('block_sight', args, { positional: ['center', 'radius', 'seconds'], keyword: ['density', 'grow', 'fade'], required: ['center', 'radius', 'seconds'] }).args;
    const st = this.#state();
    const seconds = number(a['seconds'], 'block_sight() seconds', 0);
    const fade = Math.min(seconds, a['fade'] === undefined ? 1 : number(a['fade'], 'block_sight() fade', 0));
    st.perception.blockers.push({
      center: point(a['center'], 'block_sight() center'), radius: number(a['radius'], 'block_sight() radius', 0),
      density: a['density'] === undefined ? 1 : number(a['density'], 'block_sight() density', 0),
      born: st.clock, grow: a['grow'] === undefined ? 0.5 : number(a['grow'], 'block_sight() grow', 0),
      fadeAt: st.clock + seconds - fade, until: st.clock + seconds,
    });
    return null;
  }

  line_of_sight(...args: unknown[]): boolean {
    const a = bindArgs('line_of_sight', args, { positional: ['a', 'b'], required: ['a', 'b'] }).args;
    const st = this.#state();
    const end = (v: unknown, where: string): { at: Vec3; ignore: EntityId[] } => {
      const p = place(st.kernel.handles, v, where);
      return 'at' in p ? { at: p.at, ignore: [] } : { at: eyeOf(st, p.id), ignore: [p.id] };
    };
    const from = end(a['a'], 'line_of_sight() a');
    const to = end(a['b'], 'line_of_sight() b');
    return st.clear(from.at, to.at, [...from.ignore, ...to.ignore]) && st.perception.transmittance(from.at, to.at, st.clock) >= 0.05;
  }

  find_cover(...args: unknown[]): Vec3 | null {
    const a = bindArgs('find_cover', args, { positional: ['agent', 'threat'], keyword: ['radius', 'min_distance', 'peek', 'reserve'], required: ['agent', 'threat'] }).args;
    const st = this.#state();
    const agent = entity(st.kernel.handles, a['agent'], 'find_cover() agent');
    const threat = placeOf(st, a['threat'], 'find_cover() threat');
    return st.tactics.findCover(agent, threat.at, threat.ignore, {
      radius: a['radius'] === undefined ? 15 : number(a['radius'], 'find_cover() radius', 0),
      minDistance: a['min_distance'] === undefined ? 3 : number(a['min_distance'], 'find_cover() min_distance', 0),
      peek: a['peek'] === undefined ? false : bool(a['peek'], 'find_cover() peek'),
      reserve: a['reserve'] === undefined ? true : bool(a['reserve'], 'find_cover() reserve'),
    });
  }

  release_cover(...args: unknown[]): null {
    const a = bindArgs('release_cover', args, { positional: ['agent'], required: ['agent'] }).args;
    const st = this.#state();
    st.tactics.release(entity(st.kernel.handles, a['agent'], 'release_cover() agent'));
    return null;
  }

  flank_position(...args: unknown[]): Vec3 | null {
    const a = bindArgs('flank_position', args, { positional: ['agent', 'threat'], keyword: ['distance', 'side'], required: ['agent', 'threat'] }).args;
    const st = this.#state();
    const side = a['side'] ?? null;
    if (side !== null && side !== 'left' && side !== 'right') fail('PP3290', `flank_position() side must be "left", "right" or None, got ${describe(side)}`);
    const threat = placeOf(st, a['threat'], 'flank_position() threat');
    return st.tactics.flankPosition(entity(st.kernel.handles, a['agent'], 'flank_position() agent'), threat.at, threat.ignore,
      a['distance'] === undefined ? 8 : number(a['distance'], 'flank_position() distance', 0), side as 'left' | 'right' | null);
  }

  safe_spot(...args: unknown[]): Vec3 | null {
    const a = bindArgs('safe_spot', args, { positional: ['agent', 'threats'], keyword: ['radius'], required: ['agent', 'threats'] }).args;
    const st = this.#state();
    const threats = list(a['threats'], 'safe_spot() threats').map((t, i) => placeOf(st, t, `safe_spot() threats[${i}]`));
    if (threats.length === 0) fail('PP3290', 'safe_spot() needs at least one threat');
    return st.tactics.safeSpot(entity(st.kernel.handles, a['agent'], 'safe_spot() agent'), threats.map((t) => t.at), threats.flatMap((t) => t.ignore),
      a['radius'] === undefined ? 12 : number(a['radius'], 'safe_spot() radius', 0.01));
  }

  formation(...args: unknown[]): Vec3[] {
    const a = bindArgs('formation', args, { positional: ['center', 'facing', 'count'], keyword: ['shape', 'spacing'], required: ['center', 'facing', 'count'] }).args;
    const center = point(a['center'], 'formation() center');
    const facing = point(a['facing'], 'formation() facing');
    const count = a['count'];
    if (!(typeof count === 'number' && Number.isInteger(count) && count >= 0)) fail('PP3270', `formation() count must be a whole number, got ${describe(count)}`);
    const fl = Math.hypot(facing.x, facing.z);
    return placeSlots(center, fl < 1e-9 ? { x: 0, z: 1 } : { x: facing.x / fl, z: facing.z / fl },
      formationOffsets(a['shape'] === undefined ? 'line' : formation(a['shape'], 'formation() shape'), count,
        a['spacing'] === undefined ? 2 : number(a['spacing'], 'formation() spacing', 0.01)), true);
  }

  command(...args: unknown[]): null {
    const a = bindArgs('command', args, { positional: ['units', 'order', 'target'], keyword: ['formation', 'spacing', 'queue'], required: ['units', 'order'] }).args;
    const st = this.#state();
    const units = list(a['units'], 'command() units').map((u, i) => entity(st.kernel.handles, u, `command() units[${i}]`));
    const shape = a['formation'] === undefined ? 'box' : a['formation'] === null ? null : formation(a['formation'], 'command() formation');
    groupCommand(st, units, string(a['order'], 'command() order'), a['target'] ?? null, shape,
      a['spacing'] === undefined ? 2 : number(a['spacing'], 'command() spacing', 0.01), a['queue'] === undefined ? false : bool(a['queue'], 'command() queue'));
    return null;
  }
}

// ── Engine component methods ──────────────────────────────────────────────────

export function componentMethods(state: () => AiState): Readonly<Record<string, object>> {
  const self = (fields: Fields): EntityId => componentEntity(fields);
  const handles = (): AiState['kernel']['handles'] => state().kernel.handles;
  const wrap = (id: EntityId | null): unknown => (id === null ? null : handles().wrap(id));
  const queueArg = (a: Record<string, unknown>, where: string): boolean => (a['queue'] === undefined ? false : bool(a['queue'], where));

  const brain = {
    get blackboard(): BlackboardView {
      const st = state();
      return new BlackboardView(st, st.brain(self(this as unknown as Fields)).bb);
    },
    get status(): string {
      return state().brain(self(this as unknown as Fields)).run?.status ?? 'idle';
    },
    get running(): string[] {
      return state().brain(self(this as unknown as Fields)).run?.running() ?? [];
    },
    describe(this: Fields, ...args: unknown[]): string {
      bindArgs('describe', args, {});
      const b = state().brain(self(this));
      return b.run?.describe() ?? 'no tree';
    },
    restart(this: Fields, ...args: unknown[]): null {
      bindArgs('restart', args, {});
      state().restartBrain(self(this));
      return null;
    },
  };

  const percept = (fields: Fields): ReturnType<AiState['perception']['current']> => state().perception.current(self(fields), state().clock);
  const perception = {
    get target(): unknown { return wrap(percept(this as unknown as Fields).target); },
    get alert(): string { return percept(this as unknown as Fields).alert; },
    get awareness(): number { return percept(this as unknown as Fields).awareness; },
    get known(): unknown[] { return state().perception.known(self(this as unknown as Fields)).map((k) => handles().wrap(k.target)); },
    sees(this: Fields, ...args: unknown[]): boolean {
      const a = bindArgs('sees', args, { positional: ['target'], required: ['target'] }).args;
      return state().perception.sees(self(this), entity(handles(), a['target'], 'sees() target'));
    },
    aware_of(this: Fields, ...args: unknown[]): number {
      const a = bindArgs('aware_of', args, { positional: ['target'], required: ['target'] }).args;
      return state().perception.awarenessOf(self(this), entity(handles(), a['target'], 'aware_of() target'));
    },
    last_seen(this: Fields, ...args: unknown[]): Vec3 | null {
      const a = bindArgs('last_seen', args, { positional: ['target'], required: ['target'] }).args;
      return state().perception.lastSeen(self(this), entity(handles(), a['target'], 'last_seen() target'));
    },
    alarm(this: Fields, ...args: unknown[]): null {
      const a = bindArgs('alarm', args, { positional: ['position'], keyword: ['target'], required: ['position'] }).args;
      const st = state();
      const target = a['target'] === undefined || a['target'] === null ? null : entity(handles(), a['target'], 'alarm() target');
      st.perception.alarm(self(this), target, point(a['position'], 'alarm() position'), st.clock);
      return null;
    },
    forget(this: Fields, ...args: unknown[]): null {
      const a = bindArgs('forget', args, { positional: ['target'] }).args;
      state().perception.forget(self(this), a['target'] === undefined || a['target'] === null ? null : entity(handles(), a['target'], 'forget() target'));
      return null;
    },
  };

  const orders = {
    get order(): string { return state().orders.order(self(this as unknown as Fields)); },
    get target(): unknown { return wrap(state().orders.target(self(this as unknown as Fields))); },
    get engaging(): boolean { return state().orders.engaging(self(this as unknown as Fields)); },
    get queued(): number { return state().orders.queued(self(this as unknown as Fields)); },
    move(this: Fields, ...args: unknown[]): null {
      const a = bindArgs('move', args, { positional: ['point'], keyword: ['queue'], required: ['point'] }).args;
      state().orders.give(self(this), { kind: 'move', point: point(a['point'], 'move() point') }, queueArg(a, 'move() queue'));
      return null;
    },
    attack(this: Fields, ...args: unknown[]): null {
      const a = bindArgs('attack', args, { positional: ['target'], keyword: ['queue'], required: ['target'] }).args;
      state().orders.give(self(this), { kind: 'attack', target: entity(handles(), a['target'], 'attack() target') }, queueArg(a, 'attack() queue'));
      return null;
    },
    attack_move(this: Fields, ...args: unknown[]): null {
      const a = bindArgs('attack_move', args, { positional: ['point'], keyword: ['queue'], required: ['point'] }).args;
      state().orders.give(self(this), { kind: 'attack_move', point: point(a['point'], 'attack_move() point') }, queueArg(a, 'attack_move() queue'));
      return null;
    },
    patrol(this: Fields, ...args: unknown[]): null {
      const a = bindArgs('patrol', args, { positional: ['points'], keyword: ['queue'], required: ['points'] }).args;
      const points = list(a['points'], 'patrol() points').map((p, i) => point(p, `patrol() points[${i}]`));
      if (points.length === 0) fail('PP3275', 'patrol() needs at least one point');
      state().orders.give(self(this), { kind: 'patrol', points, index: 0 }, queueArg(a, 'patrol() queue'));
      return null;
    },
    hold(this: Fields, ...args: unknown[]): null {
      const a = bindArgs('hold', args, { keyword: ['queue'] }).args;
      state().orders.give(self(this), { kind: 'hold' }, queueArg(a, 'hold() queue'));
      return null;
    },
    stop(this: Fields, ...args: unknown[]): null {
      bindArgs('stop', args, {});
      state().orders.stop(self(this));
      return null;
    },
  };

  const flock = {
    get velocity(): Vec3 { return state().flocks.velocity(self(this as unknown as Fields)); },
    push(this: Fields, ...args: unknown[]): null {
      const a = bindArgs('push', args, { positional: ['impulse'], required: ['impulse'] }).args;
      state().flocks.push(self(this), point(a['impulse'], 'push() impulse'));
      return null;
    },
  };

  return { brain, perception, orders, flock };
}
