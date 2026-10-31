/**
 * Everything the ai plugin runs, in one fixed-step order (the kernel's 'physics' hook):
 *
 *   1. perception   due perceivers update; their percepts go into their brains' blackboards
 *                   (and the HUD's `awareness` meter when the entity has one)
 *   2. brains       due brains tick their trees (world order, staggered by entity id)
 *   3. orders       RTS units advance their orders
 *   4. flocks       boids steer and move
 *   5. director     pacing advances
 *   6. fog of war   due every FOG_INTERVAL
 *
 * The AI clock is the sum of fixed steps since the scene loaded; the AI's own random
 * stream is reseeded from the scene load's seed. Both are part of the snapshot, so a run
 * restored mid-behavior continues exactly as it would have.
 *
 * An entity that is destroyed drops its brain without running `stop` on its tasks (the
 * entity is gone; a task's cleanup belongs in its own Destroyed handler if it needs one).
 *
 * Perception keys a brain's blackboard receives (absent when there is nothing to say):
 * `target` (entity), `target_visible`, `target_position`, `target_distance`, `awareness`,
 * `alert` ("unaware" | "suspicious" | "alert"), `heard_position`, `last_seen_age`.
 */

import { closestMatch, fail, ParallaxError, SeededRandom, Vec3 } from '../../../core/index.js';
import type { Diagnostic, EntityId } from '../../../core/index.js';
import type { EntityRecord, Fields, Kernel } from '../../kernel/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import {
  AI_SERVICE, FOG_OF_WAR_SERVICE, NAV_SERVICE, PERCEPTION_SERVICE, PHYSICS3D_SERVICE,
} from '../../services/index.js';
import type { AiService, FogOfWarService, NavService, PerceptionService } from '../../services/index.js';
import { Blackboard, EntityRef } from './blackboard.js';
import type { Value } from './blackboard.js';
import { Director, directorSettings } from './director.js';
import type { DirectorSettings } from './director.js';
import { fieldTag } from './args.js';
import { Flocks } from './flock.js';
import { FOG_INTERVAL, FogGrid } from './fog.js';
import type { FogSource } from './fog.js';
import { Orders } from './orders.js';
import { Perception } from './perception.js';
import type { Percept } from './perception.js';
import { TreeRun } from './runner.js';
import type { RunHost } from './runner.js';
import { AI_EVENTS, AWARENESS, BEHAVIOR_TREE, BRAIN, PERCEPTION, SIDE, VISION } from './schemas.js';
import { Squads } from './squads.js';
import { Tactics } from './tactics.js';
import { parseTree } from './tree.js';
import type { Node, Status, TreeDef } from './tree.js';

const GOLDEN = 0.6180339887498949;

/** A task the game registers (`ai(tasks=[Task("shoot", tick=shoot)])`). */
export interface TaskDef {
  readonly name: string;
  readonly tick: (ctx: unknown, agent: unknown) => unknown;
  readonly start?: ((ctx: unknown, agent: unknown) => unknown) | null;
  readonly stop?: ((ctx: unknown, agent: unknown) => unknown) | null;
}

/** A tree built in code (`ai(trees=[Tree("guard", root)])`): the same document shape as content. */
export interface TreeSource {
  readonly id: string;
  readonly doc: unknown;
}

export interface AiOptions {
  readonly tasks?: readonly TaskDef[];
  readonly trees?: readonly TreeSource[];
  /** Director settings by their Python names; absent: no director. */
  readonly director?: Readonly<Record<string, unknown>> | null;
  /** Fog of war cell edge (m). Default 2. */
  readonly fogCell?: number;
}

export interface BrainState {
  treeId: string | null;
  run: TreeRun | null;
  readonly bb: Blackboard;
  nextAt: number;
  lastAt: number;
}

/** What Python tasks receive as `agent` is built by the namespace (namespace.ts). */
export type AgentFactory = (state: AiState, id: EntityId, brain: BrainState, node: Extract<Node, { type: 'do' }>, elapsed: number, dt: number) => unknown;

function raise(d: Diagnostic): never {
  throw new ParallaxError(d);
}

/** A Brain's `tree` field: an id string, or a content handle carrying one. */
export function treeRef(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  const id = (value as { id?: unknown }).id;
  if (typeof id === 'string') return id;
  const json = typeof (value as { toJSON?: unknown }).toJSON === 'function' ? (value as { toJSON(): unknown }).toJSON() : undefined;
  if (typeof json === 'string') return json;
  return fail('PP3255', `Brain.tree must name a behavior tree, got ${String(value)}`, { fix: 'Write the tree id, e.g. "guard".' });
}

export class AiState {
  readonly kernel: Kernel;
  clock = 0;
  random = new SeededRandom(0);
  readonly trees = new Map<string, TreeDef>();
  readonly tasks = new Map<string, TaskDef>();
  readonly brains = new Map<EntityId, BrainState>();
  readonly perception: Perception;
  readonly tactics: Tactics;
  readonly squads: Squads;
  readonly orders: Orders;
  readonly flocks: Flocks;
  directorSettings: DirectorSettings | null;
  director: Director | null;
  readonly fog: FogGrid;
  agent: AgentFactory | undefined;
  readonly #sources: readonly TreeSource[];

  constructor(kernel: Kernel, options: AiOptions) {
    this.kernel = kernel;
    const senses = { clear: (a: Vec3, b: Vec3, ignore: readonly EntityId[]) => this.clear(a, b, ignore) };
    this.perception = new Perception(kernel, senses);
    this.tactics = new Tactics(kernel, { clear: senses.clear, nav: () => kernel.tryService(NAV_SERVICE) });
    this.squads = new Squads(kernel);
    this.orders = new Orders(kernel, {
      nav: () => this.nav(),
      seen: (unit) => {
        if (!kernel.world.get(unit)?.components.has(PERCEPTION)) return null;
        const p = this.perception.current(unit, this.clock);
        return p.visible ? p.target : null;
      },
      emit: (payload) => kernel.emit(AI_EVENTS.orderDone, payload),
    });
    this.flocks = new Flocks(kernel);
    this.directorSettings = options.director === undefined || options.director === null ? null : directorSettings(options.director);
    this.director = this.directorSettings === null ? null : new Director(this.directorSettings);
    this.fog = new FogGrid(options.fogCell ?? 2);
    for (const task of options.tasks ?? []) {
      if (this.tasks.has(task.name)) fail('PP3253', `Two tasks are named "${task.name}"`, { fix: 'Give each Task a unique name.' });
      this.tasks.set(task.name, task);
    }
    this.#sources = options.trees ?? [];
  }

  nav(): NavService {
    return this.kernel.service(NAV_SERVICE);
  }

  /** Occlusion between two points: physics3d raycasts, else nav's static world, else none. */
  clear(a: Vec3, b: Vec3, ignore: readonly EntityId[]): boolean {
    const d = b.__sub__(a);
    const length = d.length();
    if (length < 1e-9) return true;
    const physics = this.kernel.tryService(PHYSICS3D_SERVICE);
    if (physics !== undefined) {
      const hit = physics.raycast(a, d.__mul__(1 / length), length, { ignore });
      return hit === undefined || hit.distance >= length - 1e-6;
    }
    const nav = this.kernel.tryService(NAV_SERVICE);
    return nav === undefined ? true : nav.lineClear(a, b, ignore);
  }

  /** Parse every tree (content and code) and check the tasks they use; raises the first problem. */
  loadTrees(): void {
    this.trees.clear();
    const docs = new Map<string, { doc: unknown; path?: string }>();
    for (const t of this.#sources) {
      if (docs.has(t.id)) fail('PP3255', `Two behavior trees are named "${t.id}"`, { fix: 'Give each Tree a unique id.' });
      docs.set(t.id, { doc: t.doc });
    }
    for (const entry of this.kernel.project.content.get(BEHAVIOR_TREE)?.values() ?? []) {
      if (docs.has(entry.id)) {
        fail('PP3255', `Behavior tree "${entry.id}" is both a content entry and a Tree in ai(trees=...)`, { path: entry.path, fix: 'Rename one of them.' });
      }
      docs.set(entry.id, { doc: entry.values, path: entry.path });
    }
    for (const [id, d] of docs) {
      const { tree, diagnostics } = parseTree(id, d.doc, {
        ...(d.path !== undefined && { path: d.path }),
        tree: (other) => docs.get(other)?.doc,
        treeIds: () => [...docs.keys()],
      });
      if (tree === undefined) raise(diagnostics[0]!);
      for (const task of tree.tasks) {
        if (this.tasks.has(task)) continue;
        const guess = closestMatch(task, [...this.tasks.keys()]);
        fail('PP3253', `Behavior tree "${id}" runs task "${task}", which isn't registered`, {
          ...(d.path !== undefined && { path: d.path }),
          fix: guess !== undefined ? `Did you mean "${guess}"?` : `Register it: ai(tasks=[Task("${task}", tick=...)]).`,
        });
      }
      this.trees.set(id, tree);
    }
  }

  tree(id: string): TreeDef {
    const tree = this.trees.get(id);
    if (tree !== undefined) return tree;
    const guess = closestMatch(id, [...this.trees.keys()]);
    return fail('PP3255', `No behavior tree "${id}"`, {
      fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Add content/behavior_tree/<id>.json, or a Tree in ai(trees=[...]).',
    });
  }

  // ── Scene and entity lifecycle ─────────────────────────────────────────────

  reset(seed: number): void {
    this.clock = 0;
    this.random = new SeededRandom((seed ^ 0x41495f31) >>> 0);
    this.brains.clear();
    this.perception.clear();
    this.tactics.clear();
    this.squads.clear();
    this.orders.clear();
    this.flocks.clear();
    this.director = this.directorSettings === null ? null : new Director(this.directorSettings);
    this.fog.clear();
  }

  removed(records: readonly EntityRecord[]): void {
    for (const r of records) {
      this.brains.delete(r.id);
      this.perception.removed(r.id);
      this.tactics.removed(r.id);
      this.orders.removed(r.id);
      this.flocks.removed(r.id);
      this.director?.alive.delete(r.id);
    }
  }

  // ── Brains ──────────────────────────────────────────────────────────────────

  brain(id: EntityId): BrainState {
    let b = this.brains.get(id);
    if (b === undefined) {
      b = { treeId: null, run: null, bb: new Blackboard((e) => this.kernel.world.isAlive(e)), nextAt: this.clock, lastAt: this.clock };
      this.brains.set(id, b);
    }
    return b;
  }

  /** Bind the brain to the tree its Brain.tree names (aborting the old one). */
  #bind(id: EntityId, b: BrainState, f: Fields): void {
    const wanted = treeRef(f['tree']);
    if (wanted === b.treeId) return;
    if (b.run !== null) b.run.abortAll(this.host(id, b, 0));
    b.treeId = wanted;
    b.run = wanted === null ? null : new TreeRun(this.tree(wanted));
    if (b.run === null) return;
    for (const [key, value] of Object.entries(b.run.tree.blackboard)) if (!b.bb.has(key, this.clock)) b.bb.set(key, value, this.clock);
    const interval = (f['tick'] as number | null) ?? b.run.tree.tick;
    b.lastAt = this.clock;
    b.nextAt = this.clock + ((id * GOLDEN) % 1) * interval;
  }

  restartBrain(id: EntityId): void {
    const b = this.brain(id);
    if (b.run !== null) {
      b.run.abortAll(this.host(id, b, 0));
      b.run = new TreeRun(b.run.tree);
    }
    b.nextAt = this.clock;
  }

  #tickBrain(id: EntityId, f: Fields): void {
    const b = this.brain(id);
    if (f['enabled'] !== true) {
      if (b.run !== null && b.run.status !== 'idle') b.run.abortAll(this.host(id, b, 0));
      return;
    }
    this.#bind(id, b, f);
    if (b.run === null || this.clock + 1e-9 < b.nextAt) return;
    const interval = (f['tick'] as number | null) ?? b.run.tree.tick;
    const dt = this.clock - b.lastAt;
    b.lastAt = this.clock;
    b.nextAt = this.clock + interval;
    b.run.tick(this.host(id, b, dt));
  }

  host(id: EntityId, b: BrainState, dt: number): RunHost {
    const now = this.clock;
    return {
      now,
      dt,
      random: () => this.random.next(),
      read: (key) => b.bb.get(key, now),
      write: (key, value, ttl) => b.bb.set(key, value, now, ttl),
      remove: (key) => b.bb.delete(key),
      task: (node, hook, elapsed) => this.#runTask(id, b, node, hook, elapsed, dt),
      move: (target, stoppingDistance, speed) => {
        const nav = this.nav();
        const options = { ...(stoppingDistance !== null && { stoppingDistance }), ...(speed !== null && { maxSpeed: speed }) };
        if (target instanceof Vec3) return nav.moveAgent(id, target, options);
        if (target instanceof EntityRef) return this.kernel.world.isAlive(target.id) && target.id !== id && nav.moveAgent(id, target.id, options);
        return fail('PP3254', `move_to: the blackboard value is ${JSON.stringify(target)}, not a Vec3 or an entity`, { fix: 'Store a Vec3 or an Entity under that key.' });
      },
      moving: () => this.nav().agentMoving(id),
      stopMove: () => {
        const nav = this.kernel.tryService(NAV_SERVICE);
        if (nav !== undefined && this.kernel.world.isAlive(id) && nav.hasAgent(id)) nav.stopAgent(id);
      },
    };
  }

  #runTask(id: EntityId, b: BrainState, node: Extract<Node, { type: 'do' }>, hook: 'start' | 'tick' | 'stop', elapsed: number, dt: number): Status {
    const def = this.tasks.get(node.task)!;
    const fn = hook === 'tick' ? def.tick : def[hook];
    if (fn === undefined || fn === null) return 'success';
    const agent = this.agent!(this, id, b, node, elapsed, dt);
    const result = fn(this.kernel.context, agent);
    if (hook !== 'tick') return 'success';
    if (result === true || result === 'success') return 'success';
    if (result === false || result === 'failure') return 'failure';
    if (result === 'running') return 'running';
    return fail('PP3253', `Task "${node.task}" returned ${result === null || result === undefined ? 'None' : JSON.stringify(result) ?? String(result)}`, {
      fix: 'Return SUCCESS, FAILURE or RUNNING (from parallax.ai), or True / False.',
    });
  }

  // ── Perception into blackboards ────────────────────────────────────────────

  publish(id: EntityId, p: Percept): void {
    const record = this.kernel.world.require(id);
    const meter = record.components.get(AWARENESS);
    if (meter !== undefined) meter['level'] = Math.min(1, Math.max(0, p.awareness));
    if (!record.components.has(BRAIN)) return;
    const b = this.brain(id);
    const now = this.clock;
    const put = (key: string, value: Value | undefined): void => {
      if (value === undefined) b.bb.delete(key);
      else b.bb.set(key, value, now);
    };
    put('target', p.target === null ? undefined : new EntityRef(p.target));
    put('target_visible', p.visible);
    put('target_position', p.position ?? undefined);
    put('target_distance', p.distance ?? undefined);
    put('awareness', p.awareness);
    put('alert', p.alert);
    put('heard_position', p.heard ?? undefined);
    put('last_seen_age', p.lastSeenAge ?? undefined);
  }

  share(perceiver: EntityId, target: EntityId, position: Vec3): void {
    const squad = this.squads.squadOf(perceiver);
    if (squad === null) return;
    const s = this.squads.state(squad);
    if (!s.shareTargets) return;
    s.blackboard.set('target', new EntityRef(target), this.clock);
    s.blackboard.set('target_position', position, this.clock);
    for (const member of this.squads.members(squad)) {
      if (member === perceiver || !this.kernel.world.get(member)?.components.has(PERCEPTION)) continue;
      this.perception.alarm(member, target, position, this.clock);
    }
  }

  // ── The fixed step ──────────────────────────────────────────────────────────

  step(dt: number): void {
    this.clock += dt;
    const world = this.kernel.world;
    const percepts = this.perception.step(this.clock, (type, payload) => this.kernel.emit(type, payload),
      (perceiver, target, position) => this.share(perceiver, target, position));
    for (const [id, p] of percepts) this.publish(id, p);
    for (const [id, f] of world.query([BRAIN])) this.#tickBrain(id, f!);
    this.orders.step();
    this.flocks.step(dt, () => this.random.next());
    const phase = this.director?.step(dt) ?? null;
    if (phase !== null) this.kernel.emit(AI_EVENTS.directorPhase, { phase, intensity: this.director!.intensity });
    if (this.clock + 1e-9 >= this.fog.nextAt) {
      this.fog.nextAt = this.clock + FOG_INTERVAL;
      this.#updateFog();
    }
  }

  #updateFog(): void {
    const world = this.kernel.world;
    const visions = world.query([VISION]);
    this.fog.reveals = this.fog.reveals.filter((r) => r.until > this.clock);
    if (visions.length === 0 && this.fog.reveals.length === 0 && this.fog.teams().length === 0) return;
    const sources: FogSource[] = [];
    for (const [id, f] of visions) {
      const record = world.require(id);
      const team = fieldTag(f!['team']) ?? fieldTag(record.components.get(SIDE)?.['side']);
      if (team === null) {
        fail('PP3286', `The Vision on "${record.placedId ?? record.prefab ?? `entity ${id}`}" has no team and no Side`, {
          fix: 'Set Vision(team=SomeTeam) or give the entity a Side.',
        });
      }
      const at = record.transform.worldPosition();
      sources.push({ team, x: at.x, z: at.z, y: at.y, range: f!['range'] as number, occluded: true });
    }
    for (const r of this.fog.reveals) sources.push({ team: r.team, x: r.x, z: r.z, y: 0, range: r.radius, occluded: false });
    const nav = this.kernel.tryService(NAV_SERVICE);
    const reach = this.fog.cell / 2;
    this.fog.update(sources, nav === undefined ? () => false : (x, z, y) => nav.opaque(x, z, y, reach));
  }

  // ── Services ────────────────────────────────────────────────────────────────

  aiService(): AiService {
    return {
      brain: (id) => {
        if (!this.kernel.world.get(id)?.components.has(BRAIN)) return undefined;
        const b = this.brain(id);
        return {
          tree: b.treeId, status: b.run?.status ?? 'idle', running: b.run?.running() ?? [], blackboard: b.bb.view(this.clock),
          trace: b.run?.describe() ?? 'no tree',
        };
      },
      squads: () => this.squads.names().map((name) => ({
        name, members: this.squads.members(name), leader: this.squads.leader(name), formation: this.squads.state(name).formation,
      })),
      director: () => {
        const d = this.director;
        return d === null ? undefined : { phase: d.phase, intensity: d.intensity, budget: d.budget, alive: d.alive.size };
      },
    };
  }

  perceptionService(): PerceptionService {
    return {
      noise: (at, loudness, source, kind) => this.noise(at, loudness, source ?? null, kind ?? null),
      recentNoises: () => this.perception.noises.map(({ checked: _c, ...n }) => n),
      awareness: (id) => (this.kernel.world.get(id)?.components.has(PERCEPTION) ? Math.max(0, ...this.perception.known(id).map((k) => k.awareness)) : 0),
      alert: (id) => (this.kernel.world.get(id)?.components.has(PERCEPTION) ? this.perception.current(id, this.clock).alert : 'unaware'),
      known: (id) => this.perception.known(id),
    };
  }

  fogService(): FogOfWarService {
    const fog = this.fog;
    return {
      cell: fog.cell,
      get version() { return fog.version; },
      teams: () => fog.teams(),
      visible: (team, x, z) => (fog.bits(team, x, z) & 1) !== 0,
      explored: (team, x, z) => (fog.bits(team, x, z) & 2) !== 0,
      sees: (team, id) => {
        const at = this.kernel.world.require(id).transform.worldPosition();
        return (fog.bits(team, at.x, at.z) & 1) !== 0;
      },
      field: (team, minX, minZ, maxX, maxZ) => fog.field(team, minX, minZ, maxX, maxZ),
    };
  }

  noise(at: Vec3, loudness: number, source: EntityId | null, kind: string | null): void {
    if (!(Number.isFinite(loudness) && loudness >= 0)) fail('PP3261', `noise loudness must be meters of at least 0, got ${loudness}`);
    this.perception.noises.push({
      at, loudness, time: this.clock, ...(source !== null && { source }), ...(kind !== null && { kind }), checked: new Set(),
    });
  }

  configureDirector(given: Readonly<Record<string, unknown>>): Director {
    this.directorSettings = directorSettings(given, this.directorSettings ?? undefined);
    if (this.director === null) this.director = new Director(this.directorSettings);
    else this.director.settings = this.directorSettings;
    return this.director;
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  snapshot(): Json {
    return {
      clock: this.clock,
      random: [...this.random.state()],
      brains: [...this.brains].map(([id, b]) => ({
        id, tree: b.treeId, bb: b.bb.encode(), run: b.run?.snapshot() ?? null, next_at: b.nextAt, last_at: b.lastAt,
      })),
      perception: this.perception.snapshot(),
      tactics: this.tactics.snapshot(),
      squads: this.squads.snapshot(),
      orders: this.orders.snapshot(),
      flocks: this.flocks.snapshot(),
      director_settings: this.directorSettings === null ? null : { ...this.directorSettings },
      director: this.director?.snapshot() ?? null,
      fog: this.fog.snapshot(),
    };
  }

  restore(json: Json): void {
    const o = json as JsonObject;
    const alive = (id: EntityId): boolean => this.kernel.world.isAlive(id);
    this.clock = o['clock'] as number;
    this.random.restore(o['random'] as unknown as [number, number, number, number]);
    this.brains.clear();
    for (const entry of o['brains'] as JsonObject[]) {
      const id = entry['id'] as EntityId;
      if (!alive(id)) continue;
      const b = this.brain(id);
      b.bb.restore(entry['bb'] as Json);
      const treeId = entry['tree'] as string | null;
      const tree = treeId === null ? undefined : this.trees.get(treeId);
      b.treeId = tree === undefined ? null : treeId;
      b.run = tree === undefined ? null : new TreeRun(tree);
      if (b.run !== null && entry['run'] !== null) b.run.restore(entry['run'] as Json);
      b.nextAt = entry['next_at'] as number;
      b.lastAt = entry['last_at'] as number;
    }
    this.perception.restore(o['perception'] as Json, alive);
    this.tactics.restore(o['tactics'] as Json, alive);
    this.squads.restore(o['squads'] as Json);
    this.orders.restore(o['orders'] as Json, alive);
    this.flocks.restore(o['flocks'] as Json, alive);
    const settings = o['director_settings'] as JsonObject | null;
    this.directorSettings = settings === null ? null : settings as unknown as DirectorSettings;
    this.director = this.directorSettings === null ? null : new Director(this.directorSettings);
    if (this.director !== null && o['director'] !== null) this.director.restore(o['director'] as Json, alive);
    this.fog.restore(o['fog'] as Json);
  }
}
