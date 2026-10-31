/**
 * `GameHarness` (sdk/parallax/test.pyi): one game, booted headless with scriptable input,
 * recorded audio, a fixed seed and a fixed timestep, driven the way a player would.
 *
 * Awaiting. Compiled playtests are generators (`await x` → `yield* await_(x)`), so every
 * async harness method returns a `Command` the driver (driver.ts) runs when the test
 * yields it, then resumes the test with the result — or throws the error into it, so a
 * Python `try/except` sees harness failures like any other exception. Calling one without
 * `await` is reported (PP3446), never silently dropped.
 *
 * Time. Every frame is exactly `FRAME` seconds (1/60, the kernel's fixed step), so each
 * frame runs exactly one fixed update. `seconds=` rounds up to whole frames.
 *
 * Input goes through the input engine's injection API (resolved per seat, muted by modals
 * like real input); pointer and text go through the headless devices; panel clicks through
 * the ui plugin's `UiDriver`.
 */

import { observe } from '@parallax/editor/session';
import { bindArgs, Camera, Entity, Game, Kwargs, netPluginOf, SceneRef } from '@parallax/runtime/api';
import type { GameRuntime } from '@parallax/runtime/api';
import { GAME_EXPORT, startGame } from '@parallax/runtime/boot';
import { fail, ParallaxError, Vec2, Vec3 } from '@parallax/runtime/core';
import { MemorySignalingHub } from '@parallax/runtime/platform';
import type { BinaryFiles, Diagnostic, ProjectFiles } from '@parallax/runtime/core';
import type { EventDef, Handler, KernelPlugin, LogicInstance } from '@parallax/runtime/kernel';
import type { Json } from '@parallax/runtime/resource';
import {
  actionDecl, call, HeadlessAudio, HeadlessInput, InputEngine, MemoryBinaryFiles, PyDict, RecordingSurface2d, RecordingSurface3d,
  truthy, UiDriver,
} from './internals.js';
import type { ActionDecl } from './internals.js';

/** Seconds per harness frame: the kernel's fixed step, so one fixed update per frame. */
export const FRAME = 1 / 60;

/** Whole frames covering `seconds` (a hair of float error doesn't add a frame). */
export function framesFor(seconds: number): number {
  return Math.max(0, Math.ceil(seconds / FRAME - 1e-6));
}

// ── Commands ───────────────────────────────────────────────────────────────────

/** What an async harness method returns; the driver runs it when the test awaits it. */
export class Command {
  readonly label: string;
  readonly #run: () => unknown;
  /** The stack where the test called the method: its traceback if the command fails. */
  readonly site: string;
  #state: 'pending' | 'run' = 'pending';

  constructor(label: string, run: () => unknown) {
    this.label = label;
    this.#run = run;
    this.site = new Error().stack ?? '';
  }

  get pending(): boolean {
    return this.#state === 'pending';
  }

  async run(): Promise<unknown> {
    this.#state = 'run';
    return this.#run();
  }

  __repr__(): string {
    return `<coroutine ${this.label}>`;
  }
}

/** Where an error came from in the test, when the harness raised it on the test's behalf. */
export const ERROR_SITE = new WeakMap<object, string>();

// ── Events ─────────────────────────────────────────────────────────────────────

interface Recorded {
  readonly def: EventDef;
  readonly payload: Record<string, unknown>;
  presented?: unknown;
}

/** Records every delivered event, in delivery order, through a plugin system that hears all of them. */
class EventRecorder {
  readonly log: Recorded[] = [];

  plugin(): KernelPlugin {
    const handlers: Handler[] = [];
    const instance: LogicInstance = {};
    return {
      id: 'playtest',
      systems: [{ id: 'playtest_events', scenes: [], runsWhileFrozen: true, handlers, create: () => instance }],
      install: (kernel) => {
        // The registry exists now; handlers are read at delivery time.
        for (const def of kernel.registry.events.values()) {
          const method = `event:${def.id}`;
          handlers.push({ event: def, method, always: true });
          instance[method] = (_ctx: unknown, payload: Record<string, unknown>) => { this.log.push({ def, payload }); };
        }
      },
    };
  }

  of(id: string, runtime: GameRuntime, from = 0): unknown[] {
    const out: unknown[] = [];
    for (let i = from; i < this.log.length; i++) {
      const r = this.log[i]!;
      if (r.def.id !== id) continue;
      r.presented ??= runtime.payload(r.def, r.payload);
      out.push(r.presented);
    }
    return out;
  }
}

function eventIdOf(type: unknown, where: string): string {
  const def = (typeof type === 'function' || (typeof type === 'object' && type !== null))
    ? (type as { __event_def__?: EventDef }).__event_def__
    : undefined;
  if (def === undefined) {
    const name = typeof type === 'function' ? type.name : String(type);
    fail('PP3449', `${where} takes an event class, got ${name}`, {
      fix: 'Pass a class declared with @event("id"), or an engine event such as Spawned.',
    });
  }
  return def.id;
}

// ── The harness ────────────────────────────────────────────────────────────────

/** What the session gives a harness: how to load the game, and the project's files. */
export interface HarnessHost {
  /** The entry module's exports (`game/main.py` compiled), loaded in this test's realm. */
  loadEntry(): Promise<Readonly<Record<string, unknown>>>;
  readonly files: ProjectFiles;
  /** Every file in the project (asset lookups); null when unknown. */
  readonly assets: readonly string[] | null;
  /**
   * The project's binary files (a .glb model in assets/), read the way the browser reads
   * them, so a playtest loads a project's own glTF models. Absent: none (hosted models
   * are never fetched in a playtest either way).
   */
  readonly binary?: BinaryFiles;
}

interface Started {
  readonly runtime: GameRuntime;
  readonly input: InputEngine;
  readonly ui: UiDriver;
  readonly devices: HeadlessInput;
  readonly audio: HeadlessAudio;
  readonly recorder: EventRecorder;
  readonly players: number;
}

/** Plain JSON as Python sees it: objects become dicts (lists stay lists). */
function pythonJson(value: Json): unknown {
  if (Array.isArray(value)) return value.map(pythonJson);
  if (typeof value === 'object' && value !== null) return PyDict.from(Object.entries(value).map(([k, v]) => [k, pythonJson(v as Json)]));
  return value;
}

function seat(value: unknown, players: number, where: string): number {
  const player = value ?? 0;
  if (typeof player !== 'number' || !Number.isInteger(player) || player < 0 || player >= players) {
    fail('PP3442', `${where}: player=${String(player)} is not in this game (players=${players})`, {
      fix: players === 1 ? 'Leave player= out: the game was started with one player.' : `Use 0..${players - 1}.`,
    });
  }
  return player;
}

function seconds(value: unknown, where: string, positive: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    fail('PP3443', `${where}: seconds must be a ${positive ? 'positive' : 'non-negative'} number, got ${String(value)}`);
  }
  return value;
}

const DRIVE_ACTION: Readonly<Record<ActionDecl['kind'], string>> = {
  button: 'Use press() or hold() for buttons.',
  axis1: 'Use set_axis() for axis1 actions.',
  axis2: 'Use move() for axis2 actions.',
  group: 'Use press_index() for button groups.',
};

function actionOf<K extends ActionDecl['kind']>(handle: unknown, kind: K, where: string): Extract<ActionDecl, { kind: K }> {
  const decl = actionDecl(handle);
  if (!isKind(decl, kind)) {
    const name = decl.owner === undefined ? 'this action' : `${decl.owner.set.id}.${decl.owner.name}`;
    fail('PP3449', `${where} takes a ${kind} action, but ${name} is a ${decl.kind}`, { fix: DRIVE_ACTION[decl.kind] });
  }
  return decl;
}

function isKind<K extends ActionDecl['kind']>(decl: ActionDecl, kind: K): decl is Extract<ActionDecl, { kind: K }> {
  return decl.kind === kind;
}

export class GameHarness {
  readonly #host: HarnessHost;
  #started: Started | undefined;
  #starting = false;
  #printed = '';
  readonly #commands: Command[] = [];
  /** Actions held (or moved, or set) without seconds=, by seat: release() lets go of them. */
  readonly #held = new Map<ActionDecl, Set<number>>();
  /** Warnings from loading the project (data warnings), for the report. */
  readonly warnings: Diagnostic[] = [];

  constructor(host: HarnessHost) {
    this.#host = host;
  }

  /** Commands created but never run, oldest first (the driver reports them). */
  strays(before?: Command): Command[] {
    const out: Command[] = [];
    for (const c of this.#commands) {
      if (c === before) break;
      if (c.pending) out.push(c);
    }
    return out;
  }

  /** Forget commands that have run (the driver calls this as it goes). */
  settle(): void {
    for (let i = this.#commands.length - 1; i >= 0; i--) if (!this.#commands[i]!.pending) this.#commands.splice(i, 1);
  }

  #command(label: string, run: () => unknown): Command {
    const c = new Command(label, run);
    this.#commands.push(c);
    return c;
  }

  #game(where: string): Started {
    if (this.#started === undefined) {
      fail('PP3440', `game.${where} needs a running game`, { fix: 'Call `await game.start(...)` first.' });
    }
    return this.#started;
  }

  // ── Stepping ──────────────────────────────────────────────────────────────────

  #frames(count: number): void {
    const runtime = this.#game('advance()').runtime;
    for (let i = 0; i < count; i++) runtime.step(FRAME);
  }

  /** The game-facing ctx, read-write between frames. */
  get ctx(): GameRuntime['ctx'] {
    return this.#game('ctx').runtime.ctx;
  }

  get world(): GameRuntime['ctx']['world'] {
    return this.#game('world').runtime.ctx.world;
  }

  /** The running game, for engine-side tests (not part of the SDK). */
  get runtime(): GameRuntime {
    return this.#game('runtime').runtime;
  }

  /** What the game and the test printed once the game started. */
  get printed(): string {
    return this.#printed;
  }

  /** The headless audio adapter: every frame of sound the game sent. */
  get audio(): HeadlessAudio {
    return this.#game('audio').audio;
  }

  // ── Starting ──────────────────────────────────────────────────────────────────

  start(...args: unknown[]): Command {
    const a = bindArgs('start', args, { keyword: ['scene', 'seed', 'players'] }).args;
    return this.#command('start()', async () => {
      if (this.#started !== undefined || this.#starting) {
        fail('PP3441', 'game.start() was called twice', { fix: 'Start once per playtest; use reload or scene changes inside it.' });
      }
      const scene = a['scene'] ?? null;
      if (scene !== null && !(scene instanceof SceneRef)) {
        fail('PP3449', `start(scene=) takes a scene handle (Scenes.<id>), got ${String(scene)}`);
      }
      const seed = a['seed'] ?? 1;
      if (typeof seed !== 'number' || !Number.isInteger(seed)) fail('PP3449', `start(seed=) takes an int, got ${String(seed)}`);
      const players = a['players'] ?? 1;
      if (typeof players !== 'number' || !Number.isInteger(players) || players < 1) {
        fail('PP3449', `start(players=) takes an int of 1 or more, got ${String(players)}`);
      }
      this.#starting = true;
      const entry = await this.#host.loadEntry();
      const game = entry[GAME_EXPORT];
      const recorder = new EventRecorder();
      // A view of the game with the recorder plugin and the requested scene; everything else is the game's own.
      const view = game instanceof Game
        ? Object.create(game, {
          plugins: { value: [...game.plugins, recorder.plugin()] },
          start_scene: { value: scene ?? game.start_scene },
        }) as Game
        : game;
      const devices = new HeadlessInput();
      const audio = new HeadlessAudio();
      const { runtime, warnings } = await startGame({
        entry: { ...entry, [GAME_EXPORT]: view },
        files: this.#host.files,
        devices,
        audio,
        // The 3D renderer records frames; models are read from the project's own files.
        ...(game instanceof Game && game.mode === '3d'
          ? { surface3d: new RecordingSurface3d(), binary: this.#host.binary ?? new MemoryBinaryFiles(new Map()) }
          : { surface: new RecordingSurface2d() }),
        print: (text) => { this.#printed += text; },
        assets: this.#host.assets,
        seed,
        fixedStep: FRAME,
        // A net game in a playtest is a host with players= seats on this machine; its
        // ctx.net.lobby is an in-memory lobby (hosting a room, then starting, works here).
        ...(game instanceof Game && netPluginOf(game) !== undefined && {
          net: { role: 'host' as const, seats: players, lobby: new MemorySignalingHub().platform() },
        }),
      });
      this.warnings.push(...warnings);
      // The game decides its seats (local_players(seats=N), net): players= states how many the test drives.
      const seats = runtime.ctx.players.length;
      if (players !== seats) {
        fail('PP3442', `start(players=${players}), but the game has ${seats} player${seats === 1 ? '' : 's'}`, {
          fix: seats === 1
            ? 'Several local players need the local_players plugin: Game(plugins=[local_players(seats=N, ...)]).'
            : `Start with players=${seats} (the game's local_players(seats=${seats})).`,
        });
      }
      this.#started = {
        runtime, input: runtime.inputEngine, ui: new UiDriver(runtime.uiEngine), devices, audio, recorder, players,
      };
      return null;
    });
  }

  // ── Input ─────────────────────────────────────────────────────────────────────

  press(...args: unknown[]): Command {
    const last = args[args.length - 1];
    if (last instanceof Kwargs && 'index' in last.values) {
      fail('PP3449', 'press() has no index=: a slot of a button_group is pressed with press_index()', {
        fix: 'Use await game.press_index(group, index).',
      });
    }
    const a = bindArgs('press', args, { positional: ['action'], keyword: ['player'], required: ['action'] }).args;
    return this.#command('press()', () => {
      const g = this.#game('press()');
      const decl = actionOf(a['action'], 'button', 'press()');
      g.input.inject(decl, seat(a['player'], g.players, 'press()'));
      this.#frames(1);
      return null;
    });
  }

  press_index(...args: unknown[]): Command {
    const a = bindArgs('press_index', args, { positional: ['group', 'index'], keyword: ['player'], required: ['group', 'index'] }).args;
    return this.#command('press_index()', () => {
      const g = this.#game('press_index()');
      const decl = actionOf(a['group'], 'group', 'press_index()');
      const index = a['index'];
      if (typeof index !== 'number' || !Number.isInteger(index)) fail('PP3449', `press_index() index must be an int, got ${String(index)}`);
      g.input.injectIndex(decl, index, seat(a['player'], g.players, 'press_index()'));
      this.#frames(1);
      return null;
    });
  }

  // hold / move / set_axis with seconds= drive the action for that long, advancing the game,
  // then let go. Without seconds they only set it — down (or at that value) through every
  // later command until release(), advancing nothing — so a test can hold one action while
  // it moves, presses or reads panels with others.

  hold(...args: unknown[]): Command {
    const a = bindArgs('hold', args, { positional: ['action', 'seconds'], keyword: ['player'], required: ['action'] }).args;
    return this.#command('hold()', () => {
      const g = this.#game('hold()');
      const decl = actionOf(a['action'], 'button', 'hold()');
      const s = seat(a['player'], g.players, 'hold()');
      const frames = this.#driveFrames(a['seconds'], 'hold()');
      g.input.injectHold(decl, null, s);
      this.#drive(g, decl, s, frames);
      return null;
    });
  }

  move(...args: unknown[]): Command {
    const a = bindArgs('move', args, {
      positional: ['action', 'direction', 'seconds'], keyword: ['player'], required: ['action', 'direction'],
    }).args;
    return this.#command('move()', () => {
      const g = this.#game('move()');
      const decl = actionOf(a['action'], 'axis2', 'move()');
      const direction = a['direction'];
      if (!(direction instanceof Vec2)) fail('PP3449', `move() direction must be a Vec2, got ${String(direction)}`, { fix: 'Pass vec2(x, y).' });
      const s = seat(a['player'], g.players, 'move()');
      const frames = this.#driveFrames(a['seconds'], 'move()');
      g.input.injectVector(decl, direction, null, s);
      this.#drive(g, decl, s, frames);
      return null;
    });
  }

  set_axis(...args: unknown[]): Command {
    const a = bindArgs('set_axis', args, {
      positional: ['action', 'value', 'seconds'], keyword: ['player'], required: ['action', 'value'],
    }).args;
    return this.#command('set_axis()', () => {
      const g = this.#game('set_axis()');
      const decl = actionOf(a['action'], 'axis1', 'set_axis()');
      const value = a['value'];
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('PP3449', `set_axis() value must be a number, got ${String(value)}`);
      const s = seat(a['player'], g.players, 'set_axis()');
      const frames = this.#driveFrames(a['seconds'], 'set_axis()');
      g.input.injectValue(decl, value, null, s);
      this.#drive(g, decl, s, frames);
      return null;
    });
  }

  /** Let go of an action held, moved or set without seconds=; advances one frame, the one that sees it released. */
  release(...args: unknown[]): Command {
    const a = bindArgs('release', args, { positional: ['action'], keyword: ['player'], required: ['action'] }).args;
    return this.#command('release()', () => {
      const g = this.#game('release()');
      const decl = actionDecl(a['action']);
      const s = seat(a['player'], g.players, 'release()');
      const held = this.#held.get(decl);
      if (held?.has(s) !== true) {
        fail('PP3449', `release(): ${decl.owner === undefined ? 'this action' : `${decl.owner.set.id}.${decl.owner.name}`} isn't being held`, {
          fix: 'release() lets go of hold(), move() or set_axis() called without seconds=; the timed forms let go by themselves.',
        });
      }
      held.delete(s);
      g.input.injectRelease(decl, s);
      this.#frames(1);
      return null;
    });
  }

  /** Frames a drive lasts; null: until release(). */
  #driveFrames(value: unknown, where: string): number | null {
    return value === undefined || value === null ? null : framesFor(seconds(value, where, true));
  }

  /** Advance `frames` with the action driven, then let go; null: leave it driven until release(). */
  #drive(g: Started, decl: ActionDecl, s: number, frames: number | null): void {
    let held = this.#held.get(decl);
    if (frames === null) {
      if (held === undefined) this.#held.set(decl, (held = new Set()));
      held.add(s);
      return;
    }
    held?.delete(s);
    try { this.#frames(frames); } finally { g.input.injectRelease(decl, s); }
  }

  tap(...args: unknown[]): Command {
    const a = bindArgs('tap', args, { positional: ['screen'], required: ['screen'] }).args;
    return this.#command('tap()', () => {
      const screen = a['screen'];
      if (!(screen instanceof Vec2)) fail('PP3449', `tap() takes a screen point (Vec2), got ${String(screen)}`);
      this.#tapScreen(screen);
      return null;
    });
  }

  tap_world(...args: unknown[]): Command {
    const a = bindArgs('tap_world', args, { positional: ['point'], required: ['point'] }).args;
    return this.#command('tap_world()', () => {
      const point = a['point'];
      if (!(point instanceof Vec2) && !(point instanceof Vec3)) fail('PP3449', `tap_world() takes a Vec2 or Vec3, got ${String(point)}`);
      this.#tapScreen(this.#screenOf(point instanceof Vec2 ? this.#groundPoint(point) : point, 'tap_world()'));
      return null;
    });
  }

  tap_entity(...args: unknown[]): Command {
    const a = bindArgs('tap_entity', args, { positional: ['entity'], required: ['entity'] }).args;
    return this.#command('tap_entity()', () => {
      const entity = a['entity'];
      if (!(entity instanceof Entity)) fail('PP3449', `tap_entity() takes an entity, got ${String(entity)}`);
      this.#tapScreen(this.#screenOf(entity.transform.position, 'tap_entity()'));
      return null;
    });
  }

  /**
   * A Vec2 tap point in the world: (x, y) on the play plane in 2D; in 3D the ground point
   * (x, z), on the terrain's surface when the scene has terrain there (else y = 0).
   */
  #groundPoint(point: Vec2): Vec3 {
    const runtime = this.#game('tap_world()').runtime;
    if (runtime.mode === '2d') return new Vec3(point.x, point.y, 0);
    const terrain = (runtime.ctx as unknown as { terrain?: { contains(point: Vec3): boolean; height_at(point: Vec3): number } }).terrain;
    const flat = new Vec3(point.x, 0, point.y);
    let y = 0;
    try {
      if (terrain !== undefined && terrain.contains(flat)) y = terrain.height_at(flat);
    } catch (e) {
      // PP3204: this scene has no terrain; the ground is the y = 0 plane.
      if (!(e instanceof ParallaxError && e.diagnostic.code === 'PP3204')) throw e;
    }
    return new Vec3(point.x, y, point.y);
  }

  /** Where `point` is on the screen, through the active camera (what the player sees). */
  #screenOf(point: Vec3, where: string): Vec2 {
    const runtime = this.#game(where).runtime;
    const camera = runtime.visuals.rig.active();
    if (camera === undefined) {
      fail('PP3448', `${where} needs an active camera to find the point on screen, and the scene has none`, {
        fix: 'Place an entity with a camera component in the scene (or tap a screen point with game.tap).',
      });
    }
    const lens = runtime.wrap(camera).get(Camera) as { world_to_screen(point: Vec3): Vec2 | null };
    const screen = lens.world_to_screen(point);
    if (screen === null) {
      fail('PP3448', `${where}: (${point.x}, ${point.y}, ${point.z}) is not on screen (behind the camera or outside its view)`, {
        fix: 'Tap a point the camera shows, or move the camera first.',
      });
    }
    return screen;
  }

  /** Press and release the left button over a screen point; one frame. */
  #tapScreen(screen: Vec2): void {
    const g = this.#game('tap()');
    g.devices.pointerMove(screen.x, screen.y);
    g.devices.click('left');
    this.#frames(1);
  }

  type_text(...args: unknown[]): Command {
    const a = bindArgs('type_text', args, { positional: ['text'], required: ['text'] }).args;
    return this.#command('type_text()', () => {
      const g = this.#game('type_text()');
      const text = a['text'];
      if (typeof text !== 'string') fail('PP3449', `type_text() takes a str, got ${String(text)}`);
      g.devices.type(text);
      this.#frames(1);
      return null;
    });
  }

  click(...args: unknown[]): Command {
    const b = bindArgs('click', args, { positional: ['panel', 'action'], keyword: ['player'], required: ['panel', 'action'], restKeywords: true });
    const a = b.args;
    return this.#command('click()', () => {
      const g = this.#game('click()');
      const action = a['action'];
      if (typeof action !== 'string') fail('PP3449', `click() action must be the action's name (a str), got ${String(action)}`);
      g.ui.click(a['panel'] as object, action, b.restKeywords, seat(a['player'], g.players, 'click()'));
      this.#frames(1);
      return null;
    });
  }

  // ── Time ──────────────────────────────────────────────────────────────────────

  advance(...args: unknown[]): Command {
    const a = bindArgs('advance', args, { keyword: ['seconds', 'frames'] }).args;
    return this.#command('advance()', () => {
      this.#game('advance()');
      const s = seconds(a['seconds'] ?? 0, 'advance()', false);
      const frames = a['frames'] ?? 0;
      if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 0) {
        fail('PP3443', `advance(frames=) must be a non-negative int, got ${String(frames)}`);
      }
      const total = framesFor(s) + frames;
      if (total === 0) fail('PP3443', 'advance() needs seconds= or frames=', { fix: 'advance(seconds=1) or advance(frames=1).' });
      this.#frames(total);
      return null;
    });
  }

  advance_until(...args: unknown[]): Command {
    const a = bindArgs('advance_until', args, { positional: ['condition'], keyword: ['timeout'], required: ['condition'] }).args;
    return this.#command('advance_until()', () => {
      this.#game('advance_until()');
      const timeout = seconds(a['timeout'] ?? 10, 'advance_until(timeout=)', true);
      const check = (): boolean => truthy(call(a['condition']));
      const limit = framesFor(timeout);
      for (let i = 0; !check(); i++) {
        if (i === limit) {
          fail('PP3444', `advance_until(): the condition was still false after ${timeout}s of game time (${limit} frames)`, {
            fix: 'Check what the condition waits for (the state may never get there), or raise timeout=.',
          });
        }
        this.#frames(1);
      }
      return null;
    });
  }

  until(...args: unknown[]): Command {
    const a = bindArgs('until', args, { positional: ['event_type'], keyword: ['timeout'], required: ['event_type'] }).args;
    return this.#command('until()', () => {
      const g = this.#game('until()');
      const id = eventIdOf(a['event_type'], 'until()');
      const timeout = seconds(a['timeout'] ?? 10, 'until(timeout=)', true);
      const from = g.recorder.log.length;
      const limit = framesFor(timeout);
      for (let i = 0; i < limit; i++) {
        this.#frames(1);
        const seen = g.recorder.of(id, g.runtime, from);
        if (seen.length > 0) return seen[0];
      }
      return fail('PP3445', `until(): no "${id}" event within ${timeout}s of game time (${limit} frames)`, {
        fix: 'Make sure something in the test triggers it, or raise timeout=.',
      });
    });
  }

  // ── Reading ───────────────────────────────────────────────────────────────────

  get(...args: unknown[]): unknown {
    return this.#game('get()').runtime.ctx.get(...args);
  }

  /** `h.config(Rules)` reads a config; `h.config(Rules, result_delay_seconds=0)` changes it for this test's game. */
  config(...args: unknown[]): unknown {
    const b = bindArgs('config', args, { positional: ['kind'], required: ['kind'], restKeywords: true });
    const runtime = this.#game('config()').runtime;
    if (Object.keys(b.restKeywords).length > 0) return runtime.overrideConfig(b.args['kind'], b.restKeywords);
    return runtime.ctx.config(b.args['kind']);
  }

  is_open(...args: unknown[]): boolean {
    const a = bindArgs('is_open', args, { positional: ['panel'], keyword: ['player'], required: ['panel'] }).args;
    const g = this.#game('is_open()');
    seat(a['player'], g.players, 'is_open()');
    return g.ui.isOpen(a['panel'] as object);
  }

  panel_state(...args: unknown[]): unknown {
    const a = bindArgs('panel_state', args, { positional: ['panel'], keyword: ['player'], required: ['panel'] }).args;
    const g = this.#game('panel_state()');
    const state = g.ui.stateOf(a['panel'] as object, seat(a['player'], g.players, 'panel_state()'));
    return state instanceof PyDict ? state : PyDict.from(Object.entries(state));
  }

  /**
   * What the game shows now, as `parallax test --observe` and the editor service report it
   * (the "parallax.observation" format: camera, entities with their boxes on screen, open
   * panels with their actions and state), as Python dicts and lists.
   */
  observe(...args: unknown[]): unknown {
    const a = bindArgs('observe', args, { keyword: ['entities'] }).args;
    const entities = a['entities'] ?? 'all';
    if (entities !== 'all' && entities !== 'drawn') {
      fail('PP3004', `observe(entities=) is "all" or "drawn", got ${String(entities)}`, { fix: 'Pass entities="drawn" for only what was drawn last frame.' });
    }
    return pythonJson(observe(this.#game('observe()').runtime, { entities }) as unknown as Json);
  }

  emitted(...args: unknown[]): unknown[] {
    const a = bindArgs('emitted', args, { positional: ['event_type'], required: ['event_type'] }).args;
    const g = this.#game('emitted()');
    return g.recorder.of(eventIdOf(a['event_type'], 'emitted()'), g.runtime);
  }

  __repr__(): string {
    return this.#started === undefined ? '<GameHarness (not started)>' : `<GameHarness frame ${this.#started.runtime.kernel.time.frame}>`;
  }
}
