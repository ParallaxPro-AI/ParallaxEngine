/**
 * The kernel: one running game. It owns the world, resources, active systems, time,
 * timers and events, and drives them through the documented frame:
 *
 *   input → fixed steps (fixed_update, physics) → update → late_update → ui → render
 *
 * (events emitted in the ui and render hooks are delivered before the frame ends)
 *
 * Events emitted in a phase are delivered at its end, in emission order: to systems in
 * run order, then to behaviors in spawn order. Entities destroyed in a phase are torn
 * down at its end. Timers fire, then waiting tasks resume, right before `update`. A
 * requested scene change happens at the end of the frame.
 *
 * Between frames the whole game can be captured and put back (`snapshot` / `restore`,
 * see snapshot.ts), and resource fields of chosen lifetimes saved and loaded
 * (`saveResources` / `loadResources`).
 *
 * Logic can be switched off (`setLogic(false)`: an editor's edit mode, a paused play
 * session): frames then run only the input, ui and render hooks — renderers and camera
 * views keep updating — while no system or behavior hook, event handler, timer, task or
 * physics step runs, events are dropped, and scene loads and spawns start nothing.
 * A probe (`setProbe`, probe.ts) times every phase, unit and hook of a frame.
 */

import { closestMatch, EventQueue, fail } from '../../core/index.js';
import type { EntityId } from '../../core/index.js';
import type { Json, JsonObject, Project, SceneDoc } from '../../resource/index.js';
import type {
  BehaviorDef, Context, EventDef, GameDefinition, GameEvent, KernelPlugin, LogicInstance, SceneScope, SystemDef,
} from './definitions.js';
import { Registry } from './registry.js';
import { decode, decodeFields, encodeFields, instantiate, instantiateValues, resetFields } from './schema.js';
import type { EntityCodec, Fields, FieldSpec, Keep, Schema } from './schema.js';
import { baseValue, clearModifiers, modifierStates, modify, restoreModifiers, unmodify } from './modifiers.js';
import type { ModifierInit, ModifierState } from './modifiers.js';
import { restoreEntities, restoreFieldsInto, SNAPSHOT_FORMAT, snapshotEntity, snapshotFields } from './snapshot.js';
import type { ResourceSave, SavedModifier, Snapshot } from './snapshot.js';
import { bindComponent, gridPositions, resolvePlacedReferences, spawnPrefab } from './spawner.js';
import type { Overrides, SpawnOptions, SpawnTarget } from './spawner.js';
import { Tasks } from './tasks.js';
import type { TaskBody } from './tasks.js';
import { FrameRecorder } from './probe.js';
import type { FramePhase, HookSample, KernelProbe } from './probe.js';
import { Timers } from './timers.js';
import type { Handle, Owner } from './timers.js';
import { World } from './world.js';
import type { EntityRecord } from './world.js';

/** Events the kernel itself emits. The api layer exposes them as `Spawned`, `Destroyed`, `SceneLoaded`. */
export const KERNEL_EVENTS = {
  spawned: { id: 'spawned', target: 'entity' },
  destroyed: { id: 'destroyed', target: 'entity' },
  sceneLoaded: { id: 'scene_loaded' },
  // Physics events: shared by every physics plugin (events match by identity), emitted
  // once per participant so each side's behaviors hear it.
  collided: { id: 'collided', target: 'entity' },
  collisionEnded: { id: 'collision_ended', target: 'entity' },
  triggerEntered: { id: 'trigger_entered', target: 'entity' },
  triggerExited: { id: 'trigger_exited', target: 'entity' },
} as const satisfies Record<string, EventDef>;

/** Points in the frame where plugins run (physics steps inside the fixed loop). */
export type HookPoint = 'input' | 'physics' | 'ui' | 'render';

export interface EntityHandles {
  /** id → the game-facing handle (an `Entity`), stored on behaviors and in payloads. */
  wrap(id: EntityId): unknown;
  /** A handle (or id) back to its id. */
  unwrap(handle: unknown): EntityId | undefined;
}

export interface EntityLifecycle {
  /** A spawn batch, created and about to start (scene loads included). */
  added?(records: readonly EntityRecord[]): void;
  /** Entities being torn down, before they leave the world. */
  removed?(records: readonly EntityRecord[]): void;
  /** A component was attached or removed at runtime. */
  changed?(record: EntityRecord): void;
}

export interface KernelOptions {
  readonly project: Project;
  readonly game: GameDefinition;
  /** Loaded before the game: their definitions come first, their systems run first. */
  readonly plugins?: readonly KernelPlugin[];
  readonly context?: Context;
  readonly entities?: EntityHandles;
  /**
   * The game's dimension (default "2d"): how a single-number `rotation` reads — a 2D
   * angle about +z, or a 3D yaw about +y.
   */
  readonly mode?: '2d' | '3d';
  /** Seconds per fixed step (default 1/60). */
  readonly fixedStep?: number;
  /** Fixed steps allowed per frame before the backlog is dropped (default 5). */
  readonly maxFixedSteps?: number;
}

export interface SceneRequest {
  /** Start a new run (retry, New Game): keep="scene" and keep="run" resource fields reset. */
  readonly newRun?: boolean;
  /** Resource values applied after the reset: resource id → fields (runtime values). */
  readonly init?: Readonly<Record<string, Fields>>;
  /** The load's random seed (`ctx.seed`); the api layer draws one when not given. */
  readonly seed?: number;
}

/** What `kernel.spawn` takes beyond authored overrides (runtime form). */
/** `placedId` is for streaming: re-creating a placed entity that streams back in. */
export interface SpawnRequest extends Omit<SpawnOptions, 'parent' | 'childName'> {
  readonly parent?: EntityId;
}

/** Names a service and its interface type (`serviceKey<TerrainService>('terrain', ...)`). */
export interface ServiceKey<T> {
  readonly id: string;
  /** How to get a provider, shown when none is present. */
  readonly fix: string;
  /** Type-only: carries T. */
  readonly __service?: T;
}

export function serviceKey<T>(id: string, fix: string): ServiceKey<T> {
  return { id, fix };
}

export interface SceneLifecycle {
  /**
   * A scene is loading: the old one is gone and resources are reset and initialized;
   * no system has started and no entity exists yet. Seed per-load state here.
   */
  loading?(scene: SceneDoc, request: SceneRequest): void;
}

export interface Time {
  /**
   * Game seconds since the session began; stops while frozen. Monotonic: scene loads
   * don't reset it, so deadlines kept across loads stay valid.
   */
  now: number;
  /** `now` when the current scene loaded (`ctx.time.scene_time` = now − sceneStart). */
  sceneStart: number;
  /** Seconds of game time this frame. */
  dt: number;
  realNow: number;
  frame: number;
  scale: number;
  frozen: boolean;
  /**
   * How far the frame is between the last fixed step and the next one, 0..1 (leftover
   * accumulator / fixed step). Renderers interpolate physics-driven transforms with it so
   * motion is smooth when frames don't line up with fixed steps (90–144 Hz screens).
   */
  alpha: number;
  /** Seconds per fixed step. */
  readonly fixedStep: number;
}

interface SystemSlot {
  readonly def: SystemDef;
  readonly instance: LogicInstance;
}

interface HookSlot {
  readonly fn: (dt: number) => void;
  readonly owner: string;
}

interface ResourceSlot {
  readonly def: { readonly schema: Schema; readonly keep?: Keep };
  readonly fields: Fields;
}

const IDENTITY_HANDLES: EntityHandles = {
  wrap: (id) => id,
  unwrap: (handle) => (typeof handle === 'number' ? (handle as EntityId) : undefined),
};

function callHook(instance: LogicInstance, hook: string, ...args: unknown[]): void {
  const fn = instance[hook];
  if (typeof fn === 'function') (fn as (...a: unknown[]) => void).apply(instance, args);
}

function inScope(scopes: readonly SceneScope[], scene: SceneDoc): boolean {
  return scopes.some((s) => ('scene' in s ? s.scene === scene.id : scene.tags.includes(s.tag)));
}

export class Kernel {
  readonly world = new World();
  readonly registry: Registry;
  readonly time: Time;
  context: Context;

  #project: Project;
  readonly #handles: EntityHandles;
  readonly #mode: '2d' | '3d';
  readonly #lifecycle: EntityLifecycle[] = [];
  readonly #sceneObservers: SceneLifecycle[] = [];
  readonly #services = new Map<string, unknown>();
  readonly #fixedStep: number;
  readonly #maxFixedSteps: number;
  readonly #plugins: readonly KernelPlugin[];
  #events = new EventQueue<GameEvent>();
  readonly #timers = new Timers();
  readonly #tasks = new Tasks();
  readonly #resources = new Map<string, ResourceSlot>();
  readonly #hooks = new Map<HookPoint, HookSlot[]>();
  readonly #lastHooks = new Map<HookPoint, HookSlot[]>();
  #systems: SystemSlot[] = [];
  #scene: SceneDoc | undefined;
  #pendingScene: { readonly id: string; readonly request: SceneRequest } | undefined;
  #accumulator = 0;
  #started = false;
  /** Inside `start` or `step`: snapshots and restores must wait for the frame to end. */
  #running = false;
  /** False: frames run only input, ui and render hooks (see setLogic). */
  #logic = true;
  /** The plugin whose `install` is running: hooks it adds are its (probe attribution). */
  #installing: string | undefined;
  #recorder: FrameRecorder | null = null;
  #disposed = false;

  constructor(options: KernelOptions) {
    this.#project = options.project;
    const plugins = options.plugins ?? [];
    const own = plugins.reduce((g, p) => p.define?.(g) ?? g, options.game);
    const game: GameDefinition = {
      components: [...plugins.flatMap((p) => p.components ?? []), ...own.components],
      resources: [...plugins.flatMap((p) => p.resources ?? []), ...own.resources],
      events: [...plugins.flatMap((p) => p.events ?? []), ...own.events],
      behaviors: own.behaviors,
      systems: [...plugins.flatMap((p) => p.systems ?? []), ...own.systems],
    };
    this.registry = new Registry(game, Object.values(KERNEL_EVENTS));
    this.context = options.context;
    this.#handles = options.entities ?? IDENTITY_HANDLES;
    this.#mode = options.mode ?? '2d';
    this.#fixedStep = options.fixedStep ?? 1 / 60;
    this.time = { now: 0, sceneStart: 0, dt: 0, realNow: 0, frame: 0, scale: 1, frozen: false, alpha: 0, fixedStep: this.#fixedStep };
    this.#maxFixedSteps = options.maxFixedSteps ?? 5;
    for (const def of game.resources) {
      this.#resources.set(def.id, { def, fields: instantiate(def.schema, undefined, `resource "${def.id}"`) });
    }
    for (const plugin of plugins) {
      if ((plugin.snapshot === undefined) !== (plugin.restore === undefined)) {
        fail('PP9003', `Plugin "${plugin.id}" defines only one of snapshot() and restore()`, {
          fix: 'Define both (state saved must be restorable), or neither.',
        });
      }
    }
    this.#plugins = plugins;
    for (const plugin of plugins) {
      this.#installing = plugin.id;
      try {
        plugin.install?.(this);
      } finally {
        this.#installing = undefined;
      }
    }
  }

  /** id ↔ game-facing handle conversion, for plugins that put entities in payloads or results. */
  get handles(): EntityHandles {
    return this.#handles;
  }

  /**
   * Hear about entities as they arrive (spawn, scene load), leave (teardown) and change
   * components — so plugins keep their own structures (physics bodies, render lists) in
   * step without scanning the world. Restores go through `KernelPlugin.restore` instead.
   */
  observeEntities(observer: EntityLifecycle): () => void {
    this.#lifecycle.push(observer);
    return () => { this.#lifecycle.splice(this.#lifecycle.indexOf(observer), 1); };
  }

  /** Hear about scene loads (`loading` runs before anything of the new scene exists). */
  observeScenes(observer: SceneLifecycle): () => void {
    this.#sceneObservers.push(observer);
    return () => { this.#sceneObservers.splice(this.#sceneObservers.indexOf(observer), 1); };
  }

  /**
   * Offer a service other plugins use (`function/services/` declares the interfaces), so
   * plugins cooperate without importing each other. One provider per service.
   */
  provide<T>(key: ServiceKey<T>, service: T): void {
    if (this.#services.has(key.id)) fail('PP9006', `Two plugins provide the "${key.id}" service`, { fix: 'Use only one of them.' });
    this.#services.set(key.id, service);
  }

  /** A provided service; PP9005 naming who provides it when absent. Look it up at use, not at install. */
  service<T>(key: ServiceKey<T>): T {
    if (!this.#services.has(key.id)) {
      fail('PP9005', `This needs the "${key.id}" service, which no plugin in this game provides`, { fix: key.fix });
    }
    return this.#services.get(key.id) as T;
  }

  /** A provided service, or undefined (for optional cooperation). */
  tryService<T>(key: ServiceKey<T>): T | undefined {
    return this.#services.get(key.id) as T | undefined;
  }

  /** The loaded project (data documents), for plugins that read their own files. */
  get project(): Project {
    return this.#project;
  }

  get scene(): SceneDoc | undefined {
    return this.#scene;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** Load the first scene (its systems start with it). */
  start(sceneId: string, request: SceneRequest = {}): void {
    if (this.#started) fail('PP9001', 'The kernel was already started');
    this.#requireLive('start');
    this.#started = true;
    this.#whileRunning(() => this.#loadScene(sceneId, request));
  }

  /**
   * Load a scene now, between frames (a host's restart: an editor entering play mode
   * loads the edited scene fresh). Like a scene change at the end of a frame; a pending
   * `requestScene` is dropped. Starts the kernel if it wasn't.
   */
  loadScene(sceneId: string, request: SceneRequest = {}): void {
    this.#requireIdle('loadScene');
    this.#requireLive('loadScene');
    this.#started = true;
    this.#pendingScene = undefined;
    this.#whileRunning(() => this.#loadScene(sceneId, request));
  }

  /** Whether systems, behaviors, events, timers, tasks and physics run (see setLogic). */
  get logic(): boolean {
    return this.#logic;
  }

  /**
   * Switch game logic off or on. Off: `step` runs the input, ui and render hooks only
   * (renderers keep drawing, camera views resolve), `time.dt` is 0 and `time.now` stands
   * still; no system or behavior hook or handler, timer, task or physics step runs;
   * `emit` drops events; scene loads and spawns create entities without starting
   * anything (no `start`, no `scene_loaded`). Switching it on starts nothing by itself —
   * behaviors spawned while it was off stay unstarted; load a scene to begin play.
   */
  setLogic(on: boolean): void {
    this.#logic = on;
  }

  /** Deliver pending events and tear down destroyed entities now, between frames. */
  settle(): void {
    this.#requireIdle('settle');
    this.#whileRunning(() => this.#flush());
  }

  /**
   * Use new project data (edited prefabs and scenes) for every later spawn and scene
   * load. What exists stays as it is; load a scene to rebuild it from the new data.
   * The game definition (components, behaviors, systems) cannot change this way.
   */
  replaceProject(project: Project): void {
    this.#requireIdle('replaceProject');
    this.#project = project;
  }

  /** Time every frame (probe.ts); null stops. */
  setProbe(probe: KernelProbe | null): void {
    this.#recorder = probe === null ? null : new FrameRecorder(probe);
  }

  /**
   * Done with this kernel (a host replacing the game on hot reload): every plugin's
   * `dispose` runs, last installed first, so engines free what they hold outside
   * JavaScript (physics worlds). The kernel can't start or step afterwards.
   */
  dispose(): void {
    this.#requireIdle('dispose');
    if (this.#disposed) return;
    this.#disposed = true;
    for (const plugin of [...this.#plugins].reverse()) plugin.dispose?.(this);
  }

  /** Change scene at the end of this frame. */
  requestScene(sceneId: string, request: SceneRequest = {}): void {
    this.#pendingScene = { id: sceneId, request };
  }

  /** Advance one frame by `realDt` seconds of wall time. */
  step(realDt: number): void {
    this.#requireLive('step');
    const recorder = this.#recorder;
    recorder?.begin();
    let steps = 0;
    this.#whileRunning(() => { steps = this.#step(realDt); });
    // Between frames, where snapshots are allowed.
    for (const plugin of this.#plugins) {
      if (plugin.afterFrame === undefined) continue;
      const t0 = recorder?.now() ?? 0;
      plugin.afterFrame(this);
      if (recorder !== null) recorder.hook('after_frame', plugin.id, recorder.now() - t0);
    }
    if (recorder !== null) {
      recorder.lap('after_frame');
      recorder.finish(this.time.frame, steps, this.#logic);
    }
  }

  /** One frame; returns the fixed steps it ran. */
  #step(realDt: number): number {
    const time = this.time;
    const lap = (phase: FramePhase): void => this.#recorder?.lap(phase);
    time.realNow += realDt;
    time.frame++;
    time.dt = time.frozen || !this.#logic ? 0 : realDt * time.scale;

    this.#runHooks('input', realDt);
    this.#flush();
    lap('input');

    let steps = 0;
    if (!this.#logic) {
      // Edit mode or paused: nothing of the game runs; the frame is drawn as it stands.
    } else if (time.frozen) {
      this.#runFrozenSystems(realDt);
      lap('update');
    } else {
      this.#accumulator += time.dt;
      while (this.#accumulator >= this.#fixedStep && steps < this.#maxFixedSteps) {
        this.#runUnits('fixed_update', this.#fixedStep);
        lap('fixed_update');
        this.#runHooks('physics', this.#fixedStep);
        this.#flush();
        lap('physics');
        this.#accumulator -= this.#fixedStep;
        steps++;
      }
      if (steps === this.#maxFixedSteps) this.#accumulator = Math.min(this.#accumulator, this.#fixedStep);
      time.alpha = Math.min(1, this.#accumulator / this.#fixedStep);

      time.now += time.dt;
      this.#timers.tick(time.now, (owner) => this.#ownerAlive(owner));
      this.#flush();
      this.#tasks.resume(time, (owner) => this.#ownerAlive(owner));
      this.#flush();
      lap('timers');
      this.#runUnits('update', time.dt);
      this.#flush();
      lap('update');
      this.#runUnits('late_update', time.dt);
      this.#flush();
      lap('late_update');
    }

    this.#runHooks('ui', realDt);
    // Events the ui emits (panel_opened/closed) are delivered this frame, before drawing.
    this.#flush();
    lap('ui');
    this.#runHooks('render', realDt);
    this.#flush();
    lap('render');

    const pending = this.#pendingScene;
    if (pending !== undefined) {
      this.#pendingScene = undefined;
      this.#loadScene(pending.id, pending.request);
      lap('scene_load');
    }
    return steps;
  }

  setFrozen(frozen: boolean): void {
    this.time.frozen = frozen;
  }

  /**
   * Run `fn` at a point of every frame. Hooks run in the order added; `last: true` ones run
   * after every ordinary hook at that point (e.g. recording where a physics step left
   * things after every plugin's physics work).
   */
  addHook(point: HookPoint, fn: (dt: number) => void, options: { readonly last?: boolean; readonly owner?: string } = {}): () => void {
    const hooks = options.last === true ? this.#lastHooks : this.#hooks;
    const list = hooks.get(point) ?? [];
    const slot: HookSlot = { fn, owner: options.owner ?? this.#installing ?? 'host' };
    list.push(slot);
    hooks.set(point, list);
    return () => { const at = list.indexOf(slot); if (at >= 0) list.splice(at, 1); };
  }

  // ── Entities ─────────────────────────────────────────────────────────────────

  /**
   * Spawn a prefab now; its behaviors start before this returns, with name, owner and
   * runtime values already set. Emits `spawned`. `over` is authored-JSON overrides
   * (placement shape); `request` carries runtime-form values.
   */
  spawn(prefabId: string, over: Overrides = {}, request: SpawnRequest = {}): EntityRecord {
    const { parent, ...rest } = request;
    const batch = spawnPrefab(this.#spawnTarget(), prefabId, over, {
      ...rest,
      ...(parent !== undefined && { parent: this.world.require(parent) }),
    });
    resolvePlacedReferences(this.#spawnTarget(), batch);
    for (const observer of this.#lifecycle) observer.added?.(batch);
    if (this.#logic) this.#startBehaviors(batch);
    for (const record of batch) this.emit(KERNEL_EVENTS.spawned, { entity: this.#handles.wrap(record.id) });
    return batch[0]!;
  }

  /** Attach a component (replacing one of the same type). `fields` are runtime values; missing ones default. */
  addComponent(id: EntityId, componentId: string, fields: Fields = {}): Fields {
    const record = this.world.require(id);
    const def = this.registry.component(componentId, 'entity.add');
    const bound = bindComponent(def, instantiateValues(def.schema, fields, componentId), id);
    record.components.set(componentId, bound);
    for (const observer of this.#lifecycle) observer.changed?.(record);
    return bound;
  }

  /**
   * `entity.add(C(...))`: the given runtime values merge into the entity's component of
   * that type, field by field, as `spawn(components=)` merges over a prefab's (other fields
   * and their modifiers stay). An entity without one gets it, missing fields defaulted.
   */
  mergeComponent(id: EntityId, componentId: string, fields: Fields): Fields {
    const record = this.world.require(id);
    const existing = record.components.get(componentId);
    if (existing === undefined) return this.addComponent(id, componentId, fields);
    const def = this.registry.component(componentId, 'entity.add');
    for (const name of Object.keys(fields)) {
      if (!(name in def.schema)) {
        fail('PP4104', `entity.add: ${componentId} has no field "${name}"`, { fix: `Fields: ${Object.keys(def.schema).join(', ') || '(none)'}.` });
      }
    }
    for (const [name, value] of Object.entries(instantiateValues(def.schema, { ...existing, ...fields }, componentId))) {
      if (name in fields) existing[name] = value;
    }
    for (const observer of this.#lifecycle) observer.changed?.(record);
    return existing;
  }

  removeComponent(id: EntityId, componentId: string): void {
    const record = this.world.require(id);
    record.components.delete(componentId);
    for (const observer of this.#lifecycle) observer.changed?.(record);
  }

  /** Destroy an entity and its children now (see World); emits `destroyed` for each. */
  destroy(id: EntityId): void {
    for (const record of this.world.destroy(id)) {
      this.emit(KERNEL_EVENTS.destroyed, { entity: this.#handles.wrap(record.id), unloaded: false });
    }
  }

  // ── Resources, events, timers ────────────────────────────────────────────────

  resource(id: string): Fields {
    const slot = this.#resources.get(id);
    if (slot === undefined) this.registry.resource(id, 'ctx.get');
    return slot!.fields;
  }

  /** Every field of a resource back to its default, modifiers removed (`ctx.reset(R)`). */
  resetResource(id: string): void {
    this.resource(id);
    this.#resetSlot(this.#resources.get(id)!, () => true);
  }

  /** Queue an event for delivery at the end of the phase (dropped while logic is off). */
  emit(type: EventDef, payload: Fields): void {
    if (!this.#logic) return;
    this.#events.emit({ type, payload });
  }

  after(owner: Owner, seconds: number, fn: () => void): Handle {
    return this.#timers.schedule(this.time.now, seconds, fn, owner);
  }

  every(owner: Owner, seconds: number, fn: () => void): Handle {
    if (!(seconds > 0)) fail('PP3050', `every() needs a positive interval, got ${seconds}`);
    return this.#timers.schedule(this.time.now, seconds, fn, owner, seconds);
  }

  /** Start a task (a compiled `async def`): it runs now, up to its first wait. */
  run(owner: Owner, body: TaskBody): Handle {
    return this.#tasks.run(body, owner, this.time);
  }

  // ── Modifiers ────────────────────────────────────────────────────────────────

  /** A modifier on an entity's component field (`entity.modify(Component, "field", ...)`). */
  modify(id: EntityId, componentId: string, field: string, init: ModifierInit): void {
    const fields = this.#componentFields(id, componentId);
    const spec = this.registry.components.get(componentId)?.schema[field];
    modify(fields, field, spec, init, () => this.time.now, `${componentId}.${field}`);
  }

  /** Remove every modifier with `key` from every field of the entity. */
  unmodify(id: EntityId, key: string): void {
    unmodify(this.world.require(id).components.values(), key);
  }

  base(id: EntityId, componentId: string, field: string): unknown {
    return baseValue(this.#componentFields(id, componentId), field);
  }

  /** A modifier on a resource field (`ctx.modify(Resource, "field", ...)`). */
  modifyResource(resourceId: string, field: string, init: ModifierInit): void {
    const spec = this.registry.resources.get(resourceId)?.schema[field];
    modify(this.resource(resourceId), field, spec, init, () => this.time.now, `${resourceId}.${field}`);
  }

  unmodifyResource(resourceId: string, key: string): void {
    unmodify([this.resource(resourceId)], key);
  }

  resourceBase(resourceId: string, field: string): unknown {
    return baseValue(this.resource(resourceId), field);
  }

  // ── Snapshots and saves ──────────────────────────────────────────────────────

  /**
   * The whole game, as plain JSON (see snapshot.ts for what is and isn't in it). Only
   * between frames, with nothing pending: no undelivered event, no entity awaiting
   * teardown, no requested scene change — or PP3061.
   */
  snapshot(): Snapshot {
    this.#requireIdle('snapshot');
    if (this.#events.size > 0 || !this.world.settled || this.#pendingScene !== undefined) {
      fail('PP3061', 'snapshot() needs a settled kernel, but events, a teardown or a scene change are pending', {
        fix: 'Step one more frame before taking the snapshot.',
      });
    }
    const scene = this.#scene;
    if (scene === undefined) fail('PP3061', 'snapshot() needs a started kernel', { fix: 'Call start() first.' });
    const entities = this.#entityCodec();
    const resources: Record<string, ReturnType<typeof snapshotFields>> = {};
    for (const [id, slot] of this.#resources) resources[id] = snapshotFields(slot.def.schema, slot.fields, `resource "${id}"`, entities);
    const plugins: Record<string, Json> = {};
    for (const plugin of this.#plugins) if (plugin.snapshot !== undefined) plugins[plugin.id] = plugin.snapshot(this);
    const { now, sceneStart, dt, realNow, frame, scale, frozen } = this.time;
    return {
      format: SNAPSHOT_FORMAT,
      scene: scene.id,
      time: { now, sceneStart, dt, realNow, frame, scale, frozen, accumulator: this.#accumulator },
      resources,
      ids: this.world.idState(),
      entities: [...this.world.live()].map((record) => snapshotEntity(record, this.registry, entities)),
      plugins,
    };
  }

  /**
   * Put the game back exactly as `snapshot` found it. Running timers and tasks are
   * dropped; behaviors are recreated with their params and state and do not `start`
   * again; no `end`, `destroyed` or `scene_loaded` runs. Resource fields objects keep
   * their identity. Works on a kernel that was never started (the snapshot's scene
   * becomes current without loading it). The snapshot is checked and decoded before
   * anything changes, so a bad one fails without damage.
   */
  restore(snapshot: Snapshot): void {
    this.#requireIdle('restore');
    if (snapshot.format !== SNAPSHOT_FORMAT) {
      fail('PP9002', `This snapshot has format ${snapshot.format}; this engine reads format ${SNAPSHOT_FORMAT}`);
    }
    const scene = this.#project.scenes.get(snapshot.scene);
    if (scene === undefined) fail('PP2045', `The snapshot's scene "${snapshot.scene}" is not in this project`);
    const restoring = this.#plugins.filter((p) => p.restore !== undefined);
    for (const id of Object.keys(snapshot.plugins)) {
      if (!restoring.some((p) => p.id === id)) fail('PP9002', `The snapshot has state for plugin "${id}", which this kernel doesn't restore`);
    }
    for (const plugin of restoring) {
      if (!(plugin.id in snapshot.plugins)) fail('PP9002', `The snapshot has no state for plugin "${plugin.id}"`);
    }
    for (const id of Object.keys(snapshot.resources)) this.registry.resource(id, 'snapshot');

    const entities = this.#entityCodec();
    const now = (): number => this.time.now;
    const resources = [...this.#resources].map(([id, slot]) => {
      const saved = snapshot.resources[id];
      if (saved === undefined) fail('PP9002', `The snapshot has no resource "${id}"`);
      return { slot, saved, decoded: decodeFields(slot.def.schema, saved.fields, `resource "${id}"`, entities), id };
    });
    const records = restoreEntities(snapshot.entities, this.registry, entities, (id) => this.#handles.wrap(id), now);

    this.#timers.cancelWhere(() => true);
    this.#tasks.cancelWhere(() => true);
    this.#events = new EventQueue<GameEvent>();
    this.#pendingScene = undefined;
    const { time } = snapshot;
    Object.assign(this.time, {
      now: time.now, sceneStart: time.sceneStart, dt: time.dt, realNow: time.realNow, frame: time.frame, scale: time.scale, frozen: time.frozen,
    });
    this.#accumulator = time.accumulator;
    this.time.alpha = Math.min(1, time.accumulator / this.#fixedStep);
    this.#scene = scene;
    const current = new Map(this.#systems.map((slot) => [slot.def, slot]));
    this.#systems = this.registry.systems
      .filter((def) => def.scenes.length === 0 || inScope(def.scenes, scene))
      .map((def) => current.get(def) ?? { def, instance: def.create() });
    this.#started = true;
    for (const { slot, saved, decoded, id } of resources) {
      restoreFieldsInto(slot.fields, slot.def.schema, decoded, saved, now, `resource "${id}"`);
    }
    this.world.replace(snapshot.ids, records);
    for (const plugin of restoring) plugin.restore!(this, snapshot.plugins[plugin.id]!);
  }

  /**
   * The resource fields whose lifetime is in `levels`, in the JSON shape migrations see
   * (`SaveData.resources`): `["run"]` for a slot save, `["profile"]` for the profile store.
   * Entity references must name placed entities (a save outlives entity ids); a reference
   * to a destroyed entity is saved as null. Unlike snapshots, saves and loads may happen
   * during a frame (a panel's Save button, a scene loading a slot): they touch only
   * resource fields.
   */
  saveResources(levels: readonly Keep[]): ResourceSave {
    const entities = this.#placedCodec();
    const resources: Record<string, JsonObject> = {};
    const modifiers: Record<string, Record<string, SavedModifier[]>> = {};
    for (const [id, slot] of this.#resources) {
      const names = Object.keys(slot.def.schema).filter((name) => levels.includes(this.#keepOf(slot, name)));
      if (names.length === 0) continue;
      const schema = Object.fromEntries(names.map((name) => [name, slot.def.schema[name]!]));
      const base = Object.fromEntries(names.map((name) => [name, baseValue(slot.fields, name)]));
      resources[id] = encodeFields(schema, base, `resource "${id}"`, entities);
      const saved = Object.entries(modifierStates(slot.fields)).filter(([name]) => names.includes(name));
      if (saved.length > 0) {
        modifiers[id] = Object.fromEntries(saved.map(([name, list]) => [name, list.map((m) => this.#saveModifier(m))]));
      }
    }
    return { resources, modifiers };
  }

  /**
   * Apply a `saveResources` result (after any migrations): each saved field is set, and
   * its modifiers replaced. Fields the save doesn't mention are left as they are.
   */
  loadResources(save: ResourceSave): void {
    const entities = this.#placedCodec();
    const now = (): number => this.time.now;
    const decoded = Object.entries(save.resources).map(([id, data]) => {
      const def = this.registry.resource(id, 'save');
      const schema = Object.fromEntries(Object.keys(data).map((name) => {
        const spec = def.schema[name];
        if (spec === undefined) fail('PP4104', `resource "${id}" has no field "${name}" (in a save)`, { fix: 'Add a migration for this save.' });
        return [name, spec];
      }));
      return { id, schema, fields: decodeFields(schema, data, `saved resource "${id}"`, entities) };
    });
    for (const id of Object.keys(save.modifiers)) {
      if (!(id in save.resources)) fail('PP9002', `A save has modifiers for resource "${id}" but none of its fields`);
    }
    for (const { id, schema, fields } of decoded) {
      const target = this.resource(id);
      clearModifiers(target, (name) => name in schema);
      Object.assign(target, fields);
      const states: Record<string, ModifierState[]> = {};
      for (const [name, list] of Object.entries(save.modifiers[id] ?? {})) {
        if (!(name in schema)) fail('PP9002', `A save has modifiers for "${id}.${name}" but not its value`);
        states[name] = list.map((m) => ({
          ...(m.key !== undefined && { key: m.key }),
          add: m.add,
          multiply: m.multiply,
          ...(m.seconds !== undefined && { expires: this.time.now + m.seconds }),
        }));
      }
      restoreModifiers(target, schema, states, now, `resource "${id}"`);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  #whileRunning(body: () => void): void {
    this.#running = true;
    try {
      body();
    } finally {
      this.#running = false;
    }
  }

  #requireLive(what: string): void {
    if (this.#disposed) fail('PP9007', `${what}() on a disposed kernel`, { fix: 'Build a new game; a disposed one is done.' });
  }

  #requireIdle(what: string): void {
    if (this.#running) {
      fail('PP3061', `${what}() can't run during a frame`, {
        fix: 'Call it between kernel.step() calls (carry a save or checkpoint request out after the frame).',
      });
    }
  }

  #keepOf(slot: ResourceSlot, name: string): Keep {
    return slot.def.schema[name]!.keep ?? slot.def.keep ?? 'run';
  }

  #saveModifier(m: ModifierState): SavedModifier {
    return {
      ...(m.key !== undefined && { key: m.key }),
      add: m.add,
      multiply: m.multiply,
      ...(m.expires !== undefined && { seconds: m.expires - this.time.now }),
    };
  }

  /** Snapshots: entity handles as their ids (stale ids stay stale); marker strings as-is. */
  #entityCodec(): EntityCodec {
    return {
      encode: (handle, where) => {
        if (handle === null) return null;
        const id = this.#handles.unwrap(handle);
        if (id === undefined) fail('PP4108', `${where} must hold an entity to be saved`);
        return id;
      },
      decode: (value, where) => {
        if (value === null || typeof value === 'string') return value;
        if (typeof value === 'number') return this.#handles.wrap(value as EntityId);
        return fail('PP4102', `${where} must be an entity id, got ${JSON.stringify(value)}`);
      },
    };
  }

  /** Saves: entity handles as placed ids, resolved against the world at load. */
  #placedCodec(): EntityCodec {
    return {
      encode: (handle, where) => {
        if (handle === null) return null;
        const id = this.#handles.unwrap(handle);
        if (id === undefined) fail('PP4108', `${where} must hold an entity to be saved`);
        const record = this.world.get(id);
        if (record === undefined) return null;
        if (record.placedId === undefined) {
          fail('PP4108', `${where} refers to a spawned entity, which a save can't hold`, {
            fix: 'Refer to placed entities only (they have a scene id), or save something that identifies it (a tag, a content id).',
          });
        }
        return record.placedId;
      },
      decode: (value, where) => {
        if (value === null || value === 'local_player') return value;
        if (typeof value !== 'string') return fail('PP4102', `${where} must be a placed entity id, got ${JSON.stringify(value)}`);
        for (const record of this.world.live()) if (record.placedId === value) return this.#handles.wrap(record.id);
        return fail('PP2046', `${where} names "${value}", but no entity is placed with that id`);
      },
    };
  }

  #componentFields(id: EntityId, componentId: string): Fields {
    const fields = this.world.require(id).components.get(componentId);
    if (fields === undefined) {
      fail('PP3001', `This entity has no "${componentId}" component`, { fix: `Add "${componentId}" to its prefab.` });
    }
    return fields;
  }

  #spawnTarget(): SpawnTarget {
    return { world: this.world, registry: this.registry, project: this.#project, wrap: (id) => this.#handles.wrap(id), mode: this.#mode };
  }

  #ownerAlive(owner: Owner): boolean {
    if (owner.kind === 'entity') return this.world.isAlive(owner.id);
    if (owner.kind === 'system') return this.#systems.some((slot) => slot.def === owner.system);
    return true;
  }

  #runHooks(point: HookPoint, dt: number): void {
    const recorder = this.#recorder;
    for (const list of [this.#hooks.get(point), this.#lastHooks.get(point)]) {
      for (const slot of [...(list ?? [])]) {
        if (recorder === null) { slot.fn(dt); continue; }
        const t0 = recorder.now();
        slot.fn(dt);
        recorder.hook(point as HookSample['point'], slot.owner, recorder.now() - t0);
      }
    }
  }

  /** A unit's hook or handler, timed when a probe listens. */
  #call(kind: 'system' | 'behavior', id: string, run: () => void): void {
    const recorder = this.#recorder;
    if (recorder === null) { run(); return; }
    const t0 = recorder.now();
    try {
      run();
    } finally {
      recorder.unit(kind, id, recorder.now() - t0);
    }
  }

  #runUnits(hook: 'update' | 'fixed_update' | 'late_update', dt: number): void {
    const timed = this.#recorder !== null;
    for (const slot of [...this.#systems]) {
      if (slot.def.when?.(this.context) === false) continue;
      if (timed && typeof slot.instance[hook] === 'function') this.#call('system', slot.def.id, () => callHook(slot.instance, hook, this.context, dt));
      else callHook(slot.instance, hook, this.context, dt);
    }
    for (const record of this.world.live()) {
      for (const slot of record.behaviors) {
        // A behavior earlier on this entity may have destroyed it this frame.
        if (!record.alive) break;
        if (!slot.started || slot.def.when?.(this.context) === false) continue;
        if (timed && typeof slot.instance[hook] === 'function') this.#call('behavior', slot.def.id, () => callHook(slot.instance, hook, this.context, dt));
        else callHook(slot.instance, hook, this.context, dt);
      }
    }
  }

  #runFrozenSystems(realDt: number): void {
    for (const slot of [...this.#systems]) {
      if (slot.def.runsWhileFrozen !== true || slot.def.when?.(this.context) === false) continue;
      this.#call('system', slot.def.id, () => callHook(slot.instance, 'update', this.context, realDt));
    }
    this.#flush();
  }

  #startBehaviors(batch: readonly EntityRecord[]): void {
    for (const record of batch) {
      for (const slot of record.behaviors) {
        if (!record.alive || slot.started) continue;
        slot.started = true;
        this.#call('behavior', slot.def.id, () => callHook(slot.instance, 'start', this.context));
      }
    }
  }

  /** Deliver queued events and tear down destroyed entities, until both are quiet. */
  #flush(): void {
    for (;;) {
      this.#events.flush((event) => this.#deliver(event));
      const doomed = this.world.takeDoomed();
      if (doomed.length === 0) break;
      for (const record of doomed) {
        for (const slot of record.behaviors) {
          if (slot.started) this.#call('behavior', slot.def.id, () => callHook(slot.instance, 'end', this.context));
        }
      }
      const ownedByDoomed = (owner: Owner): boolean => owner.kind === 'entity' && doomed.some((r) => r.id === owner.id);
      this.#timers.cancelWhere(ownedByDoomed);
      this.#tasks.cancelWhere(ownedByDoomed);
      for (const observer of this.#lifecycle) observer.removed?.(doomed);
      this.world.remove(doomed);
    }
  }

  #deliver(event: GameEvent): void {
    const { type, payload } = event;
    this.#tasks.notify(type, payload);
    const handle = (instance: LogicInstance, def: SystemDef | BehaviorDef, kind: 'system' | 'behavior'): void => {
      for (const handler of def.handlers) {
        if (handler.event !== type) continue;
        if (handler.always !== true && def.when?.(this.context) === false) continue;
        if (handler.when?.(this.context) === false) continue;
        if (handler.where?.(payload, this.context) === false) continue;
        const method = instance[handler.method];
        if (typeof method !== 'function') {
          fail('PP4211', `"${def.id}" has no method "${handler.method}" for event "${type.id}"`);
        }
        this.#call(kind, def.id, () => (method as (ctx: Context, e: Fields) => void).call(instance, this.context, payload));
      }
    };

    for (const slot of [...this.#systems]) handle(slot.instance, slot.def, 'system');

    if (type.target !== undefined) {
      const id = this.#handles.unwrap(payload[type.target]);
      const record = id === undefined ? undefined : this.world.get(id);
      if (record !== undefined) for (const slot of record.behaviors) if (slot.started) handle(slot.instance, slot.def, 'behavior');
      return;
    }
    for (const record of this.world.live()) {
      for (const slot of record.behaviors) if (record.alive && slot.started) handle(slot.instance, slot.def, 'behavior');
    }
  }

  #resetResources(levels: readonly Keep[]): void {
    for (const slot of this.#resources.values()) {
      this.#resetSlot(slot, (spec) => levels.includes(spec.keep ?? slot.def.keep ?? 'run'));
    }
  }

  /** Reset fields to their defaults; their modifiers go too (a reset field is a fresh field). */
  #resetSlot(slot: ResourceSlot, which: (spec: FieldSpec) => boolean): void {
    clearModifiers(slot.fields, (name) => which(slot.def.schema[name]!));
    resetFields(slot.def.schema, slot.fields, which);
  }

  #applyInit(scene: SceneDoc, request: SceneRequest): void {
    if (request.init !== undefined) {
      for (const [id, values] of Object.entries(request.init)) {
        const fields = this.resource(id);
        const schema = this.registry.resources.get(id)!.schema;
        for (const [name, value] of Object.entries(values)) {
          if (!(name in schema)) fail('PP4104', `resource "${id}" has no field "${name}"`);
          fields[name] = value;
        }
      }
      return;
    }
    // Opened directly (no init passed): the scene's own "init" block applies.
    for (const [id, values] of Object.entries(scene.init)) {
      const fields = this.resource(id);
      const schema = this.registry.resources.get(id)!.schema;
      for (const [name, value] of Object.entries(values)) {
        const spec = schema[name];
        if (spec === undefined) fail('PP4104', `scene "${scene.id}" init: resource "${id}" has no field "${name}"`);
        fields[name] = decode(spec.type, value, `scene "${scene.id}" init ${id}.${name}`);
      }
    }
  }

  #loadScene(sceneId: string, request: SceneRequest): void {
    const scene = this.#project.scenes.get(sceneId);
    if (scene === undefined) {
      const guess = closestMatch(sceneId, this.#project.scenes.keys());
      fail('PP2045', `Unknown scene "${sceneId}"`, guess === undefined ? {} : { fix: `Did you mean "${guess}"?` });
    }

    // Unload: every entity ends (no `destroyed` events for an unload). Every system's
    // timers and tasks end with the scene; systems in scope of the new one (unscoped
    // systems always) are created fresh and start again — systems hold no fields.
    for (const record of [...this.world.live()]) this.world.destroy(record.id);
    this.#flush();
    this.#timers.cancelWhere((owner) => owner.kind === 'system');
    this.#tasks.cancelWhere((owner) => owner.kind === 'system');

    this.#resetResources(request.newRun === true ? ['scene', 'run'] : ['scene']);
    this.#applyInit(scene, request);
    this.#scene = scene;
    // `now` keeps counting across loads (deadlines stored in kept resources stay valid);
    // the scene's own clock is `now - sceneStart`.
    this.time.sceneStart = this.time.now;
    this.#accumulator = 0;
    for (const observer of this.#sceneObservers) observer.loading?.(scene, request);

    this.#systems = this.registry.systems
      .filter((def) => def.scenes.length === 0 || inScope(def.scenes, scene))
      .map((def) => ({ def, instance: def.create() }));

    const target = this.#spawnTarget();
    const batch: EntityRecord[] = [];
    for (const placement of scene.entities) {
      const positions = placement.grid === undefined ? [placement.at] : gridPositions(placement.grid);
      for (const at of positions) {
        batch.push(...spawnPrefab(target, placement.prefab, { ...placement, ...(at !== undefined && { at }) },
          placement.id === undefined ? {} : { placedId: placement.id }));
      }
    }
    resolvePlacedReferences(target, batch);

    // Plugins file the scene's entities first, so systems' `start` sees them indexed.
    for (const observer of this.#lifecycle) observer.added?.(batch);
    if (this.#logic) {
      for (const slot of this.#systems) this.#call('system', slot.def.id, () => callHook(slot.instance, 'start', this.context));
      this.#startBehaviors(batch);
    }
    this.emit(KERNEL_EVENTS.sceneLoaded, { scene: scene.id, new_run: request.newRun === true });
    this.#flush();
  }
}
