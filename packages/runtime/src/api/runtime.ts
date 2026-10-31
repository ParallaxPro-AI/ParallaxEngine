/**
 * A running game: the declared classes turned into a kernel `GameDefinition`, the kernel
 * built with the game's plugins, and the state the facades share — the entity handle
 * cache, the current owner of new timers/tasks, the random source and the decoded
 * config and content.
 *
 * Owners. Every hook, handler, timer callback and task step runs with its owner set
 * (the behavior's entity, the system, or the game), so `ctx.time.after`, `ctx.run` and
 * `ctx.tween` started from it are cancelled with it — the context itself is shared.
 */

import { fail, SeededRandom, Vec2, Vec3 } from '../core/index.js';
import type {
  AudioOutput, BinaryFiles, EntityId, InputDevices, KeyValueStore, ProjectFiles, RandomState, RenderSurface2d, RenderSurface3d,
  UiSurface,
} from '../core/index.js';
import { componentEntity, copy, instantiate, Kernel } from '../function/kernel/index.js';
import { ACTIONS_SERVICE, DIALOGUE_INPUT_SERVICE, PLAYERS_SERVICE, TERRAIN_SERVICE } from '../function/services/index.js';
import { rayTerrain } from '../function/plugins/terrain/index.js';
import { actionsService } from './action_input.js';
import { corePersistence } from './save.js';
import { inputSeats } from './local_players.js';
import { coreStreaming } from './streaming.js';
import { dialogueInput } from './input.js';
import type {
  BehaviorDef, ComponentDef, EventDef, Fields, GameDefinition, Handler, KernelPlugin, LogicInstance, Owner, ResourceDef,
  SceneRequest, SceneScope, Snapshot, SystemDef, TaskBody,
} from '../function/kernel/index.js';
import type { ContentEntry, Json, Project } from '../resource/index.js';
import { SYSTEM_READER } from '../function/plugins/input/index.js';
import type { InputEngine, Reader } from '../function/plugins/input/index.js';
import { UiPresenter } from '../function/plugins/ui/index.js';
import type { UiEngine } from '../function/plugins/ui/index.js';
import type { VisualsPlugin } from '../function/plugins/visuals/index.js';
import { interfacePlugins } from './ui.js';
import { render2dPlugin } from './render2d.js';
import { render3dPlugin } from './render3d.js';
import type { Render3dEngine } from '../function/plugins/render3d/index.js';
import { models } from '../function/plugins/models/index.js';
import type { ModelPoseSource } from '../function/services/index.js';
import type { AudioEngine } from '../function/plugins/audio/index.js';
import type { Render2dEngine } from '../function/plugins/render2d/index.js';
import { Camera, coreVisuals } from './visuals.js';
import { coreEnvironment } from './environment.js';
import type { LookSettings } from './visuals.js';
import './builtins.js';
import { ContentList, ContentRef } from './content.js';
import { Context } from './context.js';
import {
  Behavior, behaviorOptions, contentPlugin, declarations, eventDefOf, GIVEN, HANDLERS, SIGNIFICANCE_RATES, System, systemOptions,
} from './declarations.js';
import type { BehaviorTick, HandlerMark } from './declarations.js';
import { componentIdOf, Entity } from './entity.js';
import { presentPayload } from './events.js';
import type { Game, GameSystem } from './game.js';
import { dictEntries, truthy } from './py.js';
import { audioPlugin } from './audio.js';
import { projectContentRef } from './project.js';
import { setPrintSink } from './pyrt/builtins.js';
import { str } from './pyrt/values.js';
import { PyDict } from './pyrt/collections.js';
import { setActiveRandom } from './random.js';
import type { Handle } from './time.js';
import { timeRampPlugin } from './time.js';
import {
  coerce, coerceFields, isContentClass, Localized, presentRef, RECORD, refClass, SceneRef, schemaFor, schemaOf, Tag, TextRef,
} from './types.js';
import type { AnyClass, CoerceEnv, ContentClass, FieldInfo, RefClass, Role, SchemaInfo } from './types.js';

export interface RuntimeOptions {
  /** Keyboard, gamepads, mouse and touch (the platform's, or `HeadlessInput`). */
  readonly devices: InputDevices;
  /** The speakers: the platform's `WebAudioOutput`, or `HeadlessAudio`. */
  readonly audio: AudioOutput;
  /** The project's file paths (sound files are found among them); null when the asset files aren't available. */
  readonly assets: readonly string[] | null;
  /**
   * Whether hosted asset URLs (`https://r2.parallaxpro.ai/assets/…`, core/remote_assets.ts)
   * are fetched: true in a browser. Default false (headless, servers): they load nothing,
   * as missing files in a data-only run.
   */
  readonly remoteAssets?: boolean;
  /** The project's files (2D games load images and effects from `assets/`). */
  readonly files: ProjectFiles;
  /**
   * Where a 2D game draws: the platform's canvas surface, or `RecordingSurface2d` headless.
   * Its size is the initial screen size; call `GameRuntime.resize` when it changes.
   * Required for a 2D game (PP9507); a 3D game draws on `surface3d`.
   */
  readonly surface?: RenderSurface2d;
  /**
   * Where a 3D game draws: the platform's WebGPU/WebGL2 surface, or `RecordingSurface3d`
   * headless. Its size is the initial screen size. Required for a 3D game (PP9507).
   */
  readonly surface3d?: RenderSurface3d;
  /** A 3D game's binary files (models and their buffers). Required with `surface3d`. */
  readonly binary?: BinaryFiles;
  /** Seed of the first scene load (`ctx.seed`); later loads draw a new one unless given. */
  readonly seed: number;
  /** The device store (profile, save slots): `LocalStore` in a browser; default: memory. */
  readonly store?: KeyValueStore;
  /** The platform's wall clock in Unix seconds, shown on save slots (`SaveInfo.saved_at`); none headless. Never feeds the simulation. */
  readonly wallClock?: () => number;
  readonly fixedStep?: number;
  readonly maxFixedSteps?: number;
  /**
   * Where the game's `print()` output goes, exactly as written (each call's text ends with
   * its `end=`, a newline by default). Without it, output is kept in `GameRuntime.printed`.
   */
  readonly print?: (text: string) => void;
  /** Where panels, toasts and labels are drawn (the browser's DOM surface); none: panels run undrawn, as in playtests. */
  readonly ui?: UiSurface;
}

const GAME_OWNER: Owner = { kind: 'game' };
const HOOKS = ['start', 'update', 'fixed_update', 'late_update', 'end'] as const;

interface CollectedHandler {
  readonly handler: Handler;
  /** The game method it calls. */
  readonly method: string;
  readonly event: EventDef;
}

type Condition = (ctx: unknown) => boolean;

function condition(fn: ((ctx: unknown) => unknown) | undefined): Condition | undefined {
  return fn === undefined ? undefined : (ctx) => truthy(fn(ctx));
}

function checkRoles(info: SchemaInfo, allowed: readonly Role[], label: string, fix: string): void {
  for (const f of info.fields) {
    if (!allowed.includes(f.role)) fail('PP4221', `${label}.${f.name} is declared with ${f.role}()`, { fix });
    if (f.decl?.keep !== undefined && !label.startsWith('resource')) {
      fail('PP4110', `${label}.${f.name} has keep=, which only resources take`);
    }
    if (f.live && !label.startsWith('resource') && !label.startsWith('behavior')) {
      fail('PP4109', `${label}.${f.name}: a Handle is held only in resources and behavior state() (it is never saved)`, {
        fix: 'Move the handle to a @resource field or a behavior state(None).',
      });
    }
  }
}

function isPlainOrRecord(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as { constructor?: unknown } | null;
  return Array.isArray(value) || proto === Object.prototype
    || (typeof proto?.constructor === 'function' && (proto.constructor as unknown as Record<symbol, unknown>)[RECORD] === true);
}

/** Deep-freeze containers and wrap the top level so assignment is a coded error. */
function readOnly<T extends object>(value: T, label: string): T {
  const freeze = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || Object.isFrozen(v) || !isPlainOrRecord(v)) return;
    Object.freeze(v);
    for (const child of Object.values(v)) freeze(child);
  };
  for (const child of Object.values(value)) freeze(child);
  const deny = (): never => fail('PP3018', `${label} is read-only at runtime`, {
    fix: 'Keep values that change in a @resource; config and content are tunables.',
  });
  return new Proxy(value, { set: deny, defineProperty: deny, deleteProperty: deny });
}

/** A reference field's stored form: its id (or None). */
function storedRef(value: unknown, where: string): string | null {
  if (value === null || value === undefined || typeof value === 'string') return value ?? null;
  const form = typeof value === 'object' && 'toJSON' in value ? (value as { toJSON(): unknown }).toJSON() : undefined;
  if (typeof form !== 'string') {
    fail('PP3007', `${where} must be a reference (a *Ref such as Assets.images.x) or None, got ${String(value)}`);
  }
  return form;
}

/** How an engine component's reference field reads in game code: one ref (or None), or a list of them. */
interface EngineRef {
  readonly present: (id: string) => unknown;
  readonly list: boolean;
}

/** A list-of-references field's stored form: the ids. */
function storedRefs(value: unknown, where: string): (string | null)[] {
  const items = value instanceof Array ? value : typeof value === 'object' && value !== null && Symbol.iterator in value ? [...(value as Iterable<unknown>)] : null;
  if (items === null) fail('PP3007', `${where} must be a list of references, got ${String(value)}`);
  return items.map((v, i) => storedRef(v, `${where}[${i}]`));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Game code's view of an engine component's fields: `.entity` is its entity; reference
 * fields (asset refs, content refs, and lists of either) read as *Ref / ContentRef objects
 * and store ids — a list reads as a new list each time, so change one by assigning a list;
 * dict fields read as new Python dicts and store a dict assigned to them as a JSON object;
 * everything else (and every method, run on the fields themselves, which is what
 * `componentEntity` knows) passes through.
 */
function engineView(fields: Fields, refs: ReadonlyMap<string, EngineRef>, dicts: ReadonlySet<string>, id: string, wrap: (owner: EntityId) => Entity): Fields {
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(fields, {
    get(target, key) {
      if (key === 'entity' && !('entity' in target)) return wrap(componentEntity(target));
      const ref = typeof key === 'string' ? refs.get(key) : undefined;
      const value = Reflect.get(target, key, target) as unknown;
      // A dict field (stored as a JSON object) reads as a Python dict: a new one each time,
      // like lists, so change one by assigning a dict.
      if (typeof key === 'string' && dicts.has(key) && isPlainRecord(value)) return PyDict.from(Object.entries(value));
      if (ref !== undefined) {
        if (!ref.list) return typeof value === 'string' ? ref.present(value) : value;
        return Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? ref.present(v) : v)) : value;
      }
      if (typeof value !== 'function') return value;
      let method = bound.get(key);
      if (method === undefined || (method as { __of__?: unknown }).__of__ !== value) {
        const fn = (value as (...a: unknown[]) => unknown).bind(target);
        Object.defineProperty(fn, '__of__', { value });
        bound.set(key, fn);
        method = fn;
      }
      return method;
    },
    set(target, key, value) {
      const ref = typeof key === 'string' ? refs.get(key) : undefined;
      const where = `${id}.${String(key)}`;
      const stored = ref === undefined
        ? (typeof key === 'string' && dicts.has(key) && value instanceof PyDict ? Object.fromEntries([...value.entries()].map((e) => [String(e.key), e.value])) : value)
        : ref.list ? storedRefs(value, where)
          : storedRef(value, where);
      return Reflect.set(target, key, stored, target);
    },
  });
}

/**
 * `GameRuntime.snapshot()`: the kernel's snapshot, which is the whole game — world,
 * resources, time, every plugin's state (open panels included) and, through the runtime's
 * own plugin, what the api layer owns: `ctx.seed`, the game's `random` generator and a
 * hitstop under way. Plain JSON.
 */
export type RuntimeSnapshot = Snapshot;

/** What the api layer adds to kernel snapshots (the `runtime` plugin's state). */
interface RuntimeState {
  readonly seed: number;
  readonly random: RandomState;
  /** Real time at which a hitstop ends; null: none. */
  readonly hitstopUntil: number | null;
}

/** Collider component id shared by physics2d and physics3d (SDK `Collider`). */
const COLLIDER = 'collider';
/** pointer.over's probe in 2D: a circle this small (meters) around the play-plane point. */
const POINTER_RADIUS = 1e-3;

export class GameRuntime {
  readonly game: Game;
  readonly project: Project;
  readonly kernel: Kernel;
  readonly ctx: Context;
  readonly mode: '2d' | '3d';
  /** Running transform tweens by `<entity>:<channel>`, so a new one replaces the old. */
  readonly tweens = new Map<string, Handle>();
  /** Cameras, rigs and the shared engine components. */
  readonly visuals: VisualsPlugin;
  /** The engine behind `ctx.input` (the test harness injects through it; platforms wire to it). */
  readonly inputEngine: InputEngine;
  /** The engine behind `ctx.ui` (panel renderers and the test harness's driver). */
  readonly uiEngine: UiEngine;
  /** A 3D game's renderer (boot preloads its models before `start()`); undefined in 2D. */
  /** The models plugin's posed models (boot preloads through it, renderer or not). */
  readonly models: ModelPoseSource;
  readonly render3d: Render3dEngine | undefined;
  /** A 2D game's renderer (`ctx.vfx` in 2D); undefined in 3D. Hosts reach its one-shot effects through it. */
  readonly render2d: Render2dEngine | undefined;
  /** The engine behind `ctx.audio` (hosts that forward sounds, e.g. a net server, reach it here). */
  readonly audio: AudioEngine;
  /** What the game printed, one entry per `print()` call — when no `print` option was given. */
  readonly printed: string[] = [];
  readonly #print: (text: string) => void;

  #owner: Owner = GAME_OWNER;
  #seed: number;
  #random: SeededRandom;
  #hitstopUntil: number | undefined;
  readonly #entities = new Map<EntityId, Entity>();
  readonly #componentInfo = new Map<string, SchemaInfo>();
  readonly #resourceInfo = new Map<string, SchemaInfo>();
  /** Resources with live (Handle) fields, which the kernel doesn't hold. */
  readonly #liveResources = new Map<string, SchemaInfo>();
  readonly #configClasses = new Map<string, AnyClass>();
  readonly #configs = new Map<string, object>();
  /** The writable fields behind each read-only config (for `overrideConfig`). */
  readonly #configFields = new Map<string, Record<string, unknown>>();
  readonly #contentClasses = new Map<string, AnyClass>();
  readonly #contentLists = new Map<string, ContentList<unknown>>();
  readonly #env: CoerceEnv = { content: (target, id) => this.contentList(target).get(id) };
  readonly #engineRefFields = new Map<string, ReadonlyMap<string, EngineRef>>();
  readonly #engineDictFields = new Map<string, ReadonlySet<string>>();
  readonly #engineViews = new WeakMap<Fields, Fields>();
  readonly #gameComponents = new Set<string>();

  constructor(game: Game, project: Project, options: RuntimeOptions) {
    this.game = game;
    this.project = project;
    this.mode = game.mode;
    this.#seed = options.seed;
    this.#random = new SeededRandom(options.seed);
    setActiveRandom(this.#random);
    this.#print = options.print ?? ((text) => { this.printed.push(text); });
    setPrintSink(this.#print);

    const definition = this.#define();
    this.ctx = new Context(this);
    const ui = interfacePlugins({
      devices: options.devices,
      content: this.#env,
      scope: { current: () => this.#reader() },
      players: () => this.ctx.players,
      // A networked game never pauses for one player's menu.
      freezeTime: !game.plugins.some((p) => p.id === 'net'),
      touchLabel: (label) => this.#touchLabel(label),
      overrides: () => this.#controlOverrides(),
    });
    this.inputEngine = ui.input.engine;
    this.uiEngine = ui.ui.engine;
    const renderTarget = (): { surface2d?: RenderSurface2d; surface3d?: RenderSurface3d; binary?: BinaryFiles } => {
      if (game.mode === '2d') {
        if (options.surface === undefined) fail('PP9507', 'A 2D game needs a 2D surface to draw on (RuntimeOptions.surface)');
        return { surface2d: options.surface };
      }
      if (options.surface3d === undefined || options.binary === undefined) {
        fail('PP9507', 'A 3D game needs a 3D surface and its binary files (RuntimeOptions.surface3d and binary)', {
          fix: 'Boot passes the platform\'s: RecordingSurface3d + MemoryBinaryFiles headless, the browser surface + HttpBinaryFiles in a page.',
        });
      }
      return { surface3d: options.surface3d, binary: options.binary };
    };
    const target = renderTarget();
    const screen = (target.surface2d ?? target.surface3d)!.size();
    // Model data (loading, poses, clips, sockets, rigs) is in every game, renderer or not (servers, headless).
    const modelData = models({
      files: options.files, ...(options.binary !== undefined && { binary: options.binary }), assetFiles: options.assets !== null,
      remoteAssets: options.remoteAssets ?? false,
    });
    const r3 = target.surface3d === undefined ? undefined : render3dPlugin({
      surface: target.surface3d, files: options.files, assetFiles: options.assets !== null, remoteAssets: options.remoteAssets ?? false,
    });
    const vis = coreVisuals({
      mode: game.mode,
      input: ui.input.engine,
      settings: () => this.kernel.resource('settings') as unknown as LookSettings,
      currentSeat: () => this.#reader().seat,
      seatEntity: (seat) => this.kernel.tryService(PLAYERS_SERVICE)?.entity(seat) ?? null,
      screen: { width: screen.width, height: screen.height },
    });
    this.visuals = vis;
    const r2 = target.surface2d === undefined ? undefined : render2dPlugin({
      surface: target.surface2d, files: options.files, assetFiles: options.assets !== null, remoteAssets: options.remoteAssets ?? false, rig: () => vis.rig,
    });
    const renderers = r2 !== undefined ? [r2] : [r3!];
    // Variation draws its own stream, so playing a sound never shifts the game's `random`.
    const sound = audioPlugin({
      output: options.audio, project, assets: options.assets, files: options.files, remoteAssets: options.remoteAssets ?? false, seed: (options.seed ^ 0x5bd1e995) >>> 0, mode: game.mode,
      listener: () => vis.listener(),
      // Paused = time frozen by a modal panel; a hitstop's freeze never holds the music.
      paused: (kernel) => kernel.time.frozen && this.#hitstopUntil === undefined,
    });
    const persistence = corePersistence({
      ...(options.store !== undefined && { store: options.store }), ...(options.wallClock !== undefined && { wallClock: options.wallClock }),
      saveVersion: game.save_version,
    });
    // Streaming comes last: its first pass over a scene's batch unloads what is out of range, and every
    // other plugin has filed those entities by then, so they leave through the ordinary teardown.
    // The api layer's own state rides in kernel snapshots, so every snapshot (checkpoints,
    // net rollback) is the whole game.
    const runtimeState: KernelPlugin = {
      id: 'runtime',
      snapshot: (): Json => ({ seed: this.#seed, random: this.#random.state(), hitstopUntil: this.#hitstopUntil ?? null } satisfies RuntimeState as unknown as Json),
      restore: (_kernel, saved) => {
        const state = saved as unknown as RuntimeState;
        const random = new SeededRandom(state.seed);
        random.restore(state.random);
        this.#seed = state.seed;
        this.#random = random;
        this.#hitstopUntil = state.hitstopUntil ?? undefined;
      },
    };
    const plugins = [runtimeState, timeRampPlugin(), ui.input, ui.ui, vis, coreEnvironment(), modelData, ...renderers, sound, persistence, ...game.plugins, coreStreaming()];
    this.kernel = new Kernel({
      project,
      game: definition,
      // Input samples first; panels follow; visuals and the environment before the renderer they feed;
      // audio; persistence (profile, store); the game's plugins; streaming.
      plugins,
      context: this.ctx,
      entities: { wrap: (id) => this.wrap(id), unwrap: (handle) => this.unwrap(handle) },
      mode: game.mode,
      ...(options.fixedStep !== undefined && { fixedStep: options.fixedStep }),
      ...(options.maxFixedSteps !== undefined && { maxFixedSteps: options.maxFixedSteps }),
    });
    this.models = modelData.source;
    this.render3d = r3?.engine;
    this.render2d = r2?.engine;
    this.audio = sound.engine;
    this.#mountNamespaces(plugins);
    const players = this.kernel.tryService(PLAYERS_SERVICE);
    // A dedicated server has no seats until players join (net sets them at attach).
    if (players !== undefined && players.seats().length > 0) this.inputEngine.setSeats(inputSeats(players));
    this.kernel.provide(DIALOGUE_INPUT_SERVICE, dialogueInput(this.inputEngine));
    this.kernel.provide(ACTIONS_SERVICE, actionsService(this.inputEngine, (id) => this.wrap(id)));
    // Bind the project module's refs (`Content.stage.dawn`) to this game now, so `.data`
    // reads anywhere in game code (not only after something listed the kind).
    for (const cls of this.#contentClasses.values()) this.contentList(cls);
    this.inputEngine.setPointerResolver({ world: (at) => this.#pointerWorld(at), over: (at) => this.#pointerOver(at) });
    this.kernel.addHook('input', () => this.#endHitstop(), { owner: 'runtime' });
    this.kernel.observeScenes({ loading: (_scene, request) => this.#reseed(request.seed) });
    if (options.ui !== undefined) this.#presentUi(options.ui);
  }

  /**
   * Draw panels on `surface`. Its hooks are added after every plugin's, so clicks are queued
   * before the ui hook runs them, and drawing drains the frame's requests only after the
   * net plugin has forwarded them to its clients.
   */
  #presentUi(surface: UiSurface): void {
    const presenter = new UiPresenter({
      engine: this.uiEngine,
      kernel: this.kernel,
      surface,
      screen: () => this.visuals.screen,
      locale: () => {
        const language = (this.resource('settings') as { language: string }).language;
        return { language, strings: this.project.locales.get(language)?.strings ?? {} };
      },
      values: {
        text: (value) => (value === null || value === undefined ? '' : value instanceof TextRef ? this.localize(value) : str(value)),
        truthy,
      },
      capturing: () => this.inputEngine.capturing !== null,
      cursor: this.game.cursor,
    });
    this.kernel.addHook('input', () => presenter.takeClicks(), { owner: 'runtime' });
    this.kernel.addHook('render', () => presenter.present(), { owner: 'runtime' });
  }

  get seed(): number { return this.#seed; }

  /** `random` and `print` are module-level in game code: point them at this game. */
  #activate(): void {
    setActiveRandom(this.#random);
    setPrintSink(this.#print);
  }

  /** The screen (canvas) changed size, in pixels: camera views re-resolve next frame. */
  resize(width: number, height: number): void {
    this.visuals.resize(width, height);
  }

  /** Who reads input now: the running behavior's entity and its seat, else a system on seat 0. */
  #reader(): Reader {
    const owner = this.#owner;
    if (owner.kind !== 'entity') return SYSTEM_READER;
    const record = this.kernel.world.get(owner.id);
    return record === undefined ? SYSTEM_READER : { seat: record.owner ?? 0, owner: this.wrap(owner.id) };
  }
  get owner(): Owner { return this.#owner; }

  /** Load the start scene. */
  start(): void {
    this.#activate();
    this.kernel.start(this.game.start_scene.id);
  }

  /** Advance one frame by `realDt` seconds. */
  step(realDt: number): void {
    this.#activate();
    this.kernel.step(realDt);
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  /** The whole game between frames (see `RuntimeSnapshot`); running timers and tasks are not in it. */
  snapshot(): RuntimeSnapshot {
    return this.kernel.snapshot();
  }

  /** Put the game back as `snapshot()` found it (the kernel checks it before changing anything). */
  restore(snapshot: RuntimeSnapshot): void {
    this.kernel.restore(snapshot);
    this.#activate();
  }

  // ── Pointer ──────────────────────────────────────────────────────────────────

  /** The active camera's lens (the current seat's), or PP3405 when the scene has none. */
  #lens(what: string): { screen_to_world(at: Vec2): Vec3; ray(at: Vec2): readonly [Vec3, Vec3] } {
    const camera = this.visuals.rig.active();
    if (camera === undefined) {
      fail('PP3405', `${what} needs an active camera to see the world through, and the scene has none`, {
        fix: 'Place an entity with a camera component in the scene.',
      });
    }
    return this.wrap(camera).get(Camera) as never;
  }

  /**
   * `pointer.world`: the point under the pointer on the play plane (2D) or the ground (3D):
   * the terrain's surface where the ray meets it, else the y = 0 plane.
   */
  #pointerWorld(screen: Vec2): Vec3 {
    const lens = this.#lens('pointer.world');
    const field = this.mode === '3d' ? this.kernel.tryService(TERRAIN_SERVICE)?.current() ?? null : null;
    if (field !== null) {
      const [origin, direction] = lens.ray(screen);
      const hit = rayTerrain(field, origin, direction, 1e4);
      if (hit !== null) return hit;
    }
    return lens.screen_to_world(screen);
  }

  /**
   * `pointer.over`: the topmost entity whose collider is under the pointer. 2D: colliders
   * (triggers included) containing the play-plane point; topmost is what renders on top —
   * the highest world z, then the latest spawned. 3D: the nearest collider along the
   * camera ray.
   */
  #pointerOver(screen: Vec2): unknown {
    if (!this.kernel.registry.components.has(COLLIDER)) {
      fail('PP3405', 'pointer.over finds entities by their collider, and this game has no physics plugin', {
        fix: 'Add physics2d (2D) or physics3d (3D) to Game(plugins=[...]) and give clickable entities a collider.',
      });
    }
    const physics = (this.ctx as unknown as Record<string, unknown>)['physics'] as {
      overlap(center: Vec2, radius: number): unknown[];
      raycast(origin: Vec3, direction: Vec3, maxDistance: number): { entity: unknown } | null;
    };
    const lens = this.#lens('pointer.over');
    if (this.mode === '3d') {
      const [origin, direction] = lens.ray(screen);
      return physics.raycast(origin, direction, 1e4)?.entity ?? null;
    }
    const at = lens.screen_to_world(screen);
    let top: Entity | null = null;
    let topZ = -Infinity;
    for (const hit of physics.overlap(new Vec2(at.x, at.y), POINTER_RADIUS)) {
      const entity = hit as Entity;
      const z = entity.transform.position.z;
      if (z >= topZ) { top = entity; topZ = z; }
    }
    return top;
  }

  // ── Entities ─────────────────────────────────────────────────────────────────

  wrap(id: EntityId): Entity {
    let entity = this.#entities.get(id);
    if (entity === undefined) {
      if (this.#entities.size > 2 * this.kernel.world.count + 256) {
        for (const known of this.#entities.keys()) {
          if (!this.kernel.world.isAlive(known)) {
            this.#entities.delete(known);
          }
        }
      }
      entity = new Entity(this, id);
      this.#entities.set(id, entity);
    }
    return entity;
  }

  unwrap(handle: unknown): EntityId | undefined {
    if (handle instanceof Entity) return handle.__entity_id__;
    return typeof handle === 'number' ? (handle as EntityId) : undefined;
  }

  /**
   * A component's fields as game code sees them. A game component's fields are converted in
   * place (refs, enums, records, dicts…: only game code reads them). An engine component's
   * fields are read by its plugin in stored form, so game code gets a view that presents
   * its reference fields as *Ref objects, stores what it assigns as ids, and has `.entity`
   * (SDK `EngineComponent.entity`).
   */
  presentComponent(id: string, fields: Fields): Fields {
    if (this.#gameComponents.has(id)) {
      const info = this.#componentInfo.get(id);
      if (info !== undefined) coerceFields(info, fields, this.#env, id);
      return fields;
    }
    let view = this.#engineViews.get(fields);
    if (view === undefined) {
      view = engineView(fields, this.#engineRefs(id), this.#engineDicts(id), id, (owner) => this.wrap(owner));
      this.#engineViews.set(fields, view);
    }
    return view;
  }

  /**
   * An engine component's reference fields (`ref`, `ref | None`, `list[ref]`) and how each
   * reads: a *Ref class, or a ContentRef of the game's content of that kind.
   */
  #engineRefs(id: string): ReadonlyMap<string, EngineRef> {
    let refs = this.#engineRefFields.get(id);
    if (refs === undefined) {
      const found = new Map<string, EngineRef>();
      for (const [name, spec] of Object.entries(this.kernel.registry.component(id, 'component').schema)) {
        const list = spec.type.kind === 'list';
        const type = spec.type.kind === 'optional' || spec.type.kind === 'list' ? spec.type.of : spec.type;
        if (type.kind !== 'ref') continue;
        const present = this.#refPresenter(type.to);
        if (present !== undefined) found.set(name, { present, list });
      }
      refs = found;
      this.#engineRefFields.set(id, refs);
    }
    return refs;
  }

  /** An engine component's dict fields (`Model.colors`, `joints`…): game code reads them as dicts. */
  #engineDicts(id: string): ReadonlySet<string> {
    let dicts = this.#engineDictFields.get(id);
    if (dicts === undefined) {
      const schema = this.kernel.registry.component(id, 'component').schema;
      dicts = new Set(Object.entries(schema).filter(([, spec]) => spec.type.kind === 'dict').map(([name]) => name));
      this.#engineDictFields.set(id, dicts);
    }
    return dicts;
  }

  /** How a stored id under a kernel ref target reads in game code; undefined: it stays an id. */
  #refPresenter(to: string): ((id: string) => unknown) | undefined {
    const cls = refClass(to);
    if (cls !== undefined) return (id) => presentRef(cls, id);
    const content = /^content\/(.+)$/.exec(to)?.[1];
    const declared = content === undefined ? undefined : this.#contentClasses.get(content);
    if (declared === undefined) return undefined;
    return (id) => this.contentList(declared).get(id);
  }

  /** Field values of a component instance: every field, or only those passed to its constructor. */
  componentValues(id: string, instance: object, which: 'all' | 'given'): Fields {
    const given = (instance as Record<symbol, Set<string> | undefined>)[GIVEN];
    const names = which === 'given' && given !== undefined ? [...given] : Object.keys(instance);
    const schema = this.kernel.registry.component(id, 'component instance').schema;
    const values: Fields = {};
    const refs = this.#gameComponents.has(id) ? undefined : this.#engineRefs(id);
    for (const name of names) {
      if (!(name in schema)) fail('PP4104', `${id} has no field "${name}"`);
      const value = (instance as Fields)[name];
      // Engine plugins read reference fields as ids.
      const ref = refs?.get(name);
      values[name] = ref === undefined ? value : ref.list ? storedRefs(value, `${id}.${name}`) : storedRef(value, `${id}.${name}`);
    }
    return values;
  }

  // ── Owners ───────────────────────────────────────────────────────────────────

  withOwner<T>(owner: Owner, fn: () => T): T {
    const previous = this.#owner;
    this.#owner = owner;
    try { return fn(); } finally { this.#owner = previous; }
  }

  /** `fn`, run later with the owner current now. */
  owned(fn: () => unknown): () => void {
    if (typeof fn !== 'function') fail('PP3019', 'Expected a function to call later');
    const owner = this.#owner;
    return () => { this.withOwner(owner, fn); };
  }

  /** A task body whose every step runs with `owner`, receiving events as game code sees them. */
  ownedTask(owner: Owner, body: TaskBody): TaskBody {
    const withOwner = <T>(fn: () => T): T => this.withOwner(owner, fn);
    const present = (def: EventDef, payload: Fields): Fields => presentPayload(def, payload);
    return (function* (): TaskBody {
      let input: unknown;
      for (;;) {
        const step = withOwner(() => body.next(input));
        if (step.done === true) return;
        const wait = step.value;
        input = yield wait;
        if (wait.kind === 'event') input = present(wait.event, input as Fields);
      }
    })();
  }

  payload(def: EventDef, payload: Fields): Fields {
    return presentPayload(def, payload);
  }

  // ── Resources, config, content, text ─────────────────────────────────────────

  resource(id: string): Fields {
    const fields = this.kernel.resource(id);
    const live = this.#liveResources.get(id);
    if (live !== undefined) this.#liveDefaults(live, fields);
    const info = this.#resourceInfo.get(id);
    if (info !== undefined) coerceFields(info, fields, this.#env, id);
    return fields;
  }

  /** Live (Handle) fields are outside the kernel schema: start them at None on fields objects that lack them. */
  #liveDefaults(info: SchemaInfo, fields: Record<string, unknown>): void {
    for (const f of info.fields) if (f.live && !(f.name in fields)) fields[f.name] = null;
  }

  resetResource(id: string): void {
    const fields = this.kernel.resource(id);
    for (const [name, spec] of Object.entries(this.kernel.registry.resources.get(id)!.schema)) {
      if ('default' in spec) fields[name] = copy(spec.default);
    }
  }

  config(kind: unknown): object {
    const id = typeof kind === 'function' ? (kind as { __config_id__?: unknown }).__config_id__ : undefined;
    if (typeof id !== 'string') fail('PP3013', `config(): ${String((kind as { name?: string } | null)?.name ?? kind)} is not a @config class`);
    const cached = this.#configs.get(id);
    if (cached !== undefined) return cached;
    const cls = this.#configClasses.get(id)!;
    const info = schemaOf(cls, `config ${cls.name}`);
    const doc = this.project.config.get(id);
    if (doc === undefined && info.fields.some((f) => f.apiDefault === undefined)) {
      fail('PP2054', `config/${id}.json is missing`, { fix: `Create it with the fields of ${cls.name}.` });
    }
    const fields = instantiate(info.schema, doc?.values, `config/${id}.json`);
    coerceFields(info, fields, this.#env, `config.${id}`);
    Object.setPrototypeOf(fields, cls.prototype as object);
    const config = readOnly(fields, `Config ${cls.name}`);
    this.#configs.set(id, config);
    this.#configFields.set(id, fields);
    return config;
  }

  /**
   * Tests only (the harness's `h.config(Kind, field=value)`): change config fields for this
   * game. Game code keeps seeing the one read-only config object, now with these values.
   */
  overrideConfig(kind: unknown, values: Readonly<Record<string, unknown>>): object {
    const config = this.config(kind);
    const id = (kind as { __config_id__: string }).__config_id__;
    const cls = this.#configClasses.get(id)!;
    const info = schemaOf(cls, `config ${cls.name}`);
    const fields = this.#configFields.get(id)!;
    for (const [name, value] of Object.entries(values)) {
      if (!(name in info.schema)) {
        fail('PP3023', `config ${cls.name} has no field "${name}"`, { fix: `Fields: ${Object.keys(info.schema).join(', ')}.` });
      }
      fields[name] = value;
    }
    coerceFields(info, fields, this.#env, `config.${id}`);
    return config;
  }

  contentList(kind: unknown): ContentList<unknown> {
    if (!isContentClass(kind)) fail('PP3013', `content(): ${String((kind as { name?: string } | null)?.name ?? kind)} is not a @content class`);
    const k = kind.__content_kind__;
    const cached = this.#contentLists.get(k);
    if (cached !== undefined) return cached;
    const cls = this.#contentClasses.get(k)!;
    const info = schemaOf(cls, `content ${cls.name}`);
    const order = (cls as unknown as { __content_order__: string | null }).__content_order__;
    if (order !== null) {
      const f = info.fields.find((x) => x.name === order);
      if (f === undefined || f.type.kind !== 'value' || (f.type.field.kind !== 'int' && f.type.field.kind !== 'number')) {
        fail('PP4115', `@content("${k}", order="${order}") needs an int or float field "${order}"`);
      }
    }
    const entries = [...(this.project.content.get(k)?.values() ?? [])];
    const key = (e: ContentEntry): number => (order === null ? 0 : Number(e.values[order] ?? info.schema[order]!.default));
    entries.sort((a, b) => key(a) - key(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const source = { list: (c: ContentClass) => this.contentList(c) };
    const list = new ContentList(k, entries.map((entry) => {
      // The project module's ref for this entry when it exists, so refs compare by identity.
      const ref = projectContentRef(k, entry.id) ?? new ContentRef(k, entry.id);
      ref.__bind__(() => {
        const fields = instantiate(info.schema, entry.values, entry.path);
        coerceFields(info, fields, this.#env, `${k}.${entry.id}`);
        Object.setPrototypeOf(fields, cls.prototype as object);
        return readOnly(fields, `Content ${k}/${entry.id}`);
      }, source);
      return ref;
    }));
    this.#contentLists.set(k, list);
    return list;
  }

  /** A touch button's label: a locale key's text when the player's language has it, else as written. */
  #touchLabel(label: string): string {
    const language = (this.resource('settings') as { language: string }).language;
    return this.project.locales.get(language)?.strings[label] ?? label;
  }

  /** `Settings.controls` (the player's remaps) as a plain map; read every input frame. */
  #controlOverrides(): Record<string, string> {
    const controls = (this.resource('settings') as { controls: unknown }).controls;
    return Object.fromEntries(dictEntries(controls, 'Settings.controls').map(([k, v]) => [k, String(v)]));
  }

  /** The text for a Text key or Localized value in the player's language. */
  localize(key: TextRef): string {
    const language = (this.resource('settings') as { language: string }).language;
    if (key instanceof Localized && (language === this.game.languages[0] || key.key === '')) return key.text;
    const locale = this.project.locales.get(language);
    if (locale === undefined) fail('PP2063', `There is no locale/${language}.json`, { fix: `Add it, or use one of: ${this.game.languages.join(', ')}.` });
    const text = locale.strings[key.key];
    if (text === undefined) fail('PP2060', `"${key.key}" is missing in ${language}`, { fix: `Add it to locale/${language}.json.` });
    return text;
  }

  // ── Scenes and time ──────────────────────────────────────────────────────────

  /** Change scene at the end of this frame; the new load uses `seed` (or a fresh one). */
  requestScene(sceneId: string, request: SceneRequest, seed: number | null): void {
    this.kernel.requestScene(sceneId, { ...request, seed: seed ?? this.#random.int(0, 0x7fffffff) });
  }

  hitstop(seconds: number): void {
    this.#hitstopUntil = Math.max(this.#hitstopUntil ?? 0, this.kernel.time.realNow + seconds);
    this.kernel.setFrozen(true);
  }

  #endHitstop(): void {
    if (this.#hitstopUntil !== undefined && this.kernel.time.realNow >= this.#hitstopUntil) {
      this.#hitstopUntil = undefined;
      this.kernel.setFrozen(false);
    }
  }

  /** A scene is loading: `random` restarts from its seed (the first load keeps the game's). */
  #reseed(seed: number | undefined): void {
    if (seed === undefined) return;
    this.#seed = seed;
    this.#random = new SeededRandom(seed);
    setActiveRandom(this.#random);
  }

  // ── Building the definition ──────────────────────────────────────────────────

  #define(): GameDefinition {
    const declared = declarations();
    const components: ComponentDef[] = declared.components.map((cls) => {
      const id = (cls as unknown as { __component_id__: string }).__component_id__;
      const info = schemaOf(cls, `component ${cls.name}`);
      checkRoles(info, ['field'], `component ${cls.name}`, 'Components declare field()s.');
      if (info.coerced.length > 0) this.#componentInfo.set(id, info);
      this.#gameComponents.add(id);
      return { id, schema: info.schema };
    });
    const resources: ResourceDef[] = declared.resources.map((cls) => {
      const statics = cls as unknown as { __resource_id__: string; __resource_keep__: ResourceDef['keep'] };
      const info = schemaOf(cls, `resource ${cls.name}`);
      checkRoles(info, ['field'], `resource ${cls.name}`, 'Resources declare field()s.');
      for (const f of info.fields) {
        if (f.apiDefault === undefined) fail('PP4105', `resource ${cls.name}.${f.name} needs a default`);
      }
      if (info.fields.some((f) => f.live)) this.#liveResources.set(statics.__resource_id__, info);
      if (info.coerced.length > 0) this.#resourceInfo.set(statics.__resource_id__, info);
      return { id: statics.__resource_id__, schema: info.schema, ...(statics.__resource_keep__ !== undefined && { keep: statics.__resource_keep__ }) };
    });
    const events: EventDef[] = declared.events.map((cls) => {
      checkRoles(schemaOf(cls, `event ${cls.name}`), ['field'], `event ${cls.name}`, 'Events declare plain fields.');
      return (cls as unknown as { __event_def__: EventDef }).__event_def__;
    });
    for (const cls of declared.configs) {
      const id = (cls as unknown as { __config_id__: string }).__config_id__;
      if (this.#configClasses.has(id)) fail('PP2010', `Two configs are named "${id}"`);
      checkRoles(schemaOf(cls, `config ${cls.name}`), ['field'], `config ${cls.name}`, 'Config declares field()s.');
      this.#configClasses.set(id, cls);
    }
    // A plugin's built-in content kinds exist only in games that include the plugin.
    const plugins = new Set(this.game.plugins.map((p) => p.id));
    for (const cls of declared.contents) {
      const owner = contentPlugin(cls);
      if (owner === undefined || plugins.has(owner)) this.#registerContent(cls);
    }
    const behaviors = declared.behaviors.map((cls) => this.#behaviorDef(cls));
    const systems = this.game.orderedSystems().map((s) => this.#systemDef(s));
    return { components, resources, events, behaviors, systems };
  }

  #registerContent(cls: AnyClass): void {
    const kind = (cls as unknown as ContentClass).__content_kind__;
    checkRoles(schemaOf(cls, `content ${cls.name}`), ['field'], `content ${cls.name}`, 'Content declares field()s.');
    const existing = this.#contentClasses.get(kind);
    if (existing === undefined || cls.prototype instanceof existing) { this.#contentClasses.set(kind, cls); return; }
    if (existing.prototype instanceof cls) return;
    fail('PP2010', `${existing.name} and ${cls.name} both declare content "${kind}"`, {
      fix: `To extend a kind, subclass it: class ${cls.name}(${existing.name}).`,
    });
  }

  #behaviorDef(cls: AnyClass): BehaviorDef {
    const options = behaviorOptions(cls);
    const label = `behavior ${cls.name}`;
    const info = schemaOf(cls, label);
    checkRoles(info, ['param', 'state'], label, 'Declare behavior fields with param() (per prefab) or state() (runtime).');
    const params = info.fields.filter((f) => f.role === 'param');
    const state = info.fields.filter((f) => f.role === 'state');
    const requires = options.requires.map((c) => componentIdOf(c, `behavior "${options.id}" requires=`));
    const handlers = this.#collectHandlers(cls, Behavior.prototype);
    const Cls = cls as unknown as new () => LogicInstance;
    return {
      id: options.id,
      params: schemaFor(params),
      state: schemaFor(state),
      requires,
      ...(options.when !== undefined && { when: condition(options.when)! }),
      handlers: handlers.map((h) => h.handler),
      create: () => {
        const instance = new Cls();
        this.#liveDefaults(info, instance);
        this.#coerceOnAssign(instance, info.coerced, options.id);
        this.#instrument(instance, () => ({ kind: 'entity', id: this.unwrap(instance['entity'])! }), handlers, options.tick);
        return instance;
      },
    };
  }

  #systemDef(s: GameSystem): SystemDef {
    const options = systemOptions(s.cls);
    const cls = s.cls as AnyClass;
    if (schemaOf(cls, `system ${cls.name}`).fields.length > 0) {
      fail('PP4222', `System ${cls.name} declares fields`, { fix: 'Systems have no fields: keep state in a @resource, tunables in @config.' });
    }
    const scenes: SceneScope[] = s.scenes.map((x) => {
      if (x instanceof SceneRef) return { scene: x.id };
      if (x instanceof Tag) return { tag: x.id };
      return fail('PP4110', `System ${options.id} scenes= takes scenes (Scenes.<id>) or scene Tags, got ${String(x)}`);
    });
    const handlers = this.#collectHandlers(cls, System.prototype);
    const Cls = cls as unknown as new () => LogicInstance;
    const def: SystemDef = {
      id: options.id,
      scenes,
      ...(options.when !== undefined && { when: condition(options.when)! }),
      ...(options.runsWhileFrozen && { runsWhileFrozen: true }),
      runsOn: options.runsOn,
      handlers: handlers.map((h) => h.handler),
      create: () => {
        const instance = new Cls();
        this.#instrument(instance, () => ({ kind: 'system', system: def }), handlers, 'frame');
        return instance;
      },
    };
    return def;
  }

  /** `@on` methods of a class and its bases (an override without `@on` drops the base's). */
  #collectHandlers(cls: AnyClass, stop: object): CollectedHandler[] {
    const chain: object[] = [];
    for (let p = cls.prototype as object | null; p !== null && p !== stop && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
      chain.unshift(p);
    }
    const marked = new Map<string, HandlerMark[]>();
    for (const proto of chain) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        const value = Object.getOwnPropertyDescriptor(proto, name)?.value as unknown;
        if (typeof value !== 'function' || name === 'constructor') continue;
        const marks = (value as unknown as Record<symbol, HandlerMark[] | undefined>)[HANDLERS];
        if (marks !== undefined) marked.set(name, marks);
        else marked.delete(name);
      }
    }
    const collected: CollectedHandler[] = [];
    for (const [method, marks] of marked) {
      for (const mark of marks) {
        const event = eventDefOf(mark.event, `@on on ${cls.name}.${method}`);
        const where = mark.where;
        const handler: Handler = {
          event,
          method: `__on_${collected.length}__`,
          ...(mark.when !== undefined && { when: condition(mark.when)! }),
          ...(where !== undefined && {
            where: (payload: Fields, ctx: unknown) => {
              const e = presentPayload(event, payload);
              return truthy(where.length >= 2 ? where(ctx, e) : where(e));
            },
          }),
          ...(mark.always && { always: true }),
        };
        collected.push({ handler, method, event });
      }
    }
    return collected;
  }

  /**
   * `tick="significance"`: the rate `update` runs at now for this entity — every frame on
   * screen (or without a camera), else by its distance from the camera.
   */
  #significanceRate(owner: Owner): number | undefined {
    if (owner.kind !== 'entity') return undefined;
    const record = this.kernel.world.get(owner.id);
    const camera = this.visuals.rig.active();
    if (record === undefined || camera === undefined) return undefined;
    const at = record.transform.worldPosition();
    const lens = this.wrap(camera).get(Camera) as unknown as { world_to_screen(point: Vec3): Vec2 | null };
    if (lens.world_to_screen(at) !== null) return undefined;
    const eye = this.kernel.world.require(camera).transform.worldPosition();
    const far = at.__sub__(eye).length() > SIGNIFICANCE_RATES.near;
    return far ? SIGNIFICANCE_RATES.offScreenFar : SIGNIFICANCE_RATES.offScreenNear;
  }

  /** Hooks and handlers run with the unit's owner; `tick=` throttles `update` (a rate in Hz, or by significance). */
  #instrument(instance: LogicInstance, ownerOf: () => Owner, handlers: readonly CollectedHandler[], tick: BehaviorTick): void {
    const define = (name: string, fn: (...args: unknown[]) => void): void => {
      Object.defineProperty(instance, name, { value: fn, writable: true, configurable: true, enumerable: false });
    };
    for (const hook of HOOKS) {
      const fn = instance[hook];
      if (typeof fn !== 'function') continue;
      const call = (...args: unknown[]): void => { this.withOwner(ownerOf(), () => (fn as (...a: unknown[]) => unknown).apply(instance, args)); };
      if (hook === 'update' && tick !== 'frame') {
        let elapsed = 0;
        define(hook, (ctx, dt) => {
          elapsed += dt as number;
          const rate = tick === 'significance' ? this.#significanceRate(ownerOf()) : tick;
          if (rate !== undefined && elapsed + 1e-9 < 1 / rate) return;
          const step = elapsed;
          elapsed = 0;
          call(ctx, step);
        });
      } else {
        define(hook, call);
      }
    }
    for (const h of handlers) {
      const fn = instance[h.method];
      if (typeof fn !== 'function') fail('PP4211', `No method "${h.method}" for event "${h.event.id}"`);
      define(h.handler.method, (ctx, payload) => {
        this.withOwner(ownerOf(), () => (fn as (...a: unknown[]) => unknown).call(instance, ctx, presentPayload(h.event, payload as Fields)));
      });
    }
  }

  /** Params/state the kernel assigns in stored form are converted on that first assignment. */
  #coerceOnAssign(instance: LogicInstance, coerced: readonly FieldInfo[], label: string): void {
    for (const f of coerced) {
      Object.defineProperty(instance, f.name, {
        configurable: true,
        enumerable: true,
        get: () => undefined,
        set: (value: unknown) => {
          Object.defineProperty(instance, f.name, {
            value: coerce(f.type, value, this.#env, `${label}.${f.name}`), writable: true, enumerable: true, configurable: true,
          });
        },
      });
    }
  }

  #mountNamespaces(plugins: readonly KernelPlugin[]): void {
    for (const plugin of plugins) {
      const namespace = plugin.namespace;
      if (namespace === undefined) continue;
      if (namespace.name in this.ctx) {
        fail('PP2011', `Plugin "${plugin.id}" mounts ctx.${namespace.name}, which already exists`);
      }
      Object.defineProperty(this.ctx, namespace.name, { value: namespace.create(this.kernel), enumerable: true });
    }
  }
}

/** Build a running game from its `Game(...)` and loaded project. Call `start()`, then `step(dt)` per frame. */
export function createRuntime(game: Game, project: Project, options: RuntimeOptions): GameRuntime {
  return new GameRuntime(game, project, options);
}
