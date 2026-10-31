/**
 * Definitions: what a game (compiled from `@component`, `@behavior`, …) and the plugins
 * hand the kernel. The kernel treats the logic objects opaquely: it calls the hooks
 * they have, with the context it was given, and never looks further inside.
 */

import type { EntityId } from '../../core/index.js';
import type { Json } from '../../resource/index.js';
import type { Kernel } from './kernel.js';
import type { Fields, Keep, Schema } from './schema.js';

/** The game-facing context (`ctx`). Built by the api layer; opaque to the kernel. */
export type Context = unknown;

export type Condition = (ctx: Context) => boolean;

export interface ComponentDef {
  readonly id: string;
  readonly schema: Schema;
  /**
   * Engine components only: an object whose methods become the component's methods
   * (`e.get(Rigidbody).impulse(v)`). They run with `this` = the component's fields; the
   * owning entity is `componentEntity(this)`. Components a game defines are data only.
   */
  readonly methods?: object;
}

/** The entity a component's fields belong to (set by the kernel, not enumerable). */
export const COMPONENT_ENTITY: unique symbol = Symbol('parallax.component.entity');

export function componentEntity(fields: Fields): EntityId {
  return (fields as { [COMPONENT_ENTITY]: EntityId })[COMPONENT_ENTITY];
}

export interface ResourceDef {
  readonly id: string;
  readonly schema: Schema;
  /** Default lifetime for fields without their own `keep`. */
  readonly keep?: Keep;
}

export interface EventDef {
  readonly id: string;
  /** Field naming the entity a targeted event is about; behaviors only hear their own. */
  readonly target?: string;
}

/** An emitted event: its definition and payload fields. */
export interface GameEvent {
  readonly type: EventDef;
  readonly payload: Fields;
}

export interface Handler {
  readonly event: EventDef;
  /** Name of the method to call on the behavior/system instance: `method(ctx, event)`. */
  readonly method: string;
  readonly when?: Condition;
  readonly where?: (event: Fields, ctx: Context) => boolean;
  /** Run even while the unit's `when` is false. */
  readonly always?: boolean;
}

/** Hook methods a behavior or system instance may have (all optional). */
export interface LogicInstance {
  start?(ctx: Context): void;
  update?(ctx: Context, dt: number): void;
  fixed_update?(ctx: Context, dt: number): void;
  late_update?(ctx: Context, dt: number): void;
  end?(ctx: Context): void;
  [method: string]: unknown;
}

export interface BehaviorDef {
  readonly id: string;
  readonly params: Schema;
  readonly state: Schema;
  /** Component ids the entity must have when it spawns. */
  readonly requires: readonly string[];
  readonly when?: Condition;
  readonly handlers: readonly Handler[];
  /** A fresh instance; the kernel assigns params, state and `entity` onto it. */
  create(): LogicInstance;
}

export type SceneScope = { readonly scene: string } | { readonly tag: string };

export interface SystemDef {
  readonly id: string;
  /** Empty: exists in every scene, for the whole game. */
  readonly scenes: readonly SceneScope[];
  readonly when?: Condition;
  readonly runsWhileFrozen?: boolean;
  /** `@system(runs_on=)`: where it runs in a networked game (the net plugin filters by role). Absent: "server". */
  readonly runsOn?: 'server' | 'client' | 'everywhere';
  readonly handlers: readonly Handler[];
  create(): LogicInstance;
}

/**
 * A plugin: a vertical slice the kernel loads before the game (physics, rendering, input,
 * combat…). It contributes definitions like a game does, and `install` wires anything
 * else — hook points, internal state — against the kernel it is given. Plugins never
 * import each other; the kernel never imports a plugin.
 */
export interface KernelPlugin {
  readonly id: string;
  readonly components?: readonly ComponentDef[];
  readonly resources?: readonly ResourceDef[];
  readonly events?: readonly EventDef[];
  /** Run before the game's systems, in plugin order. */
  readonly systems?: readonly SystemDef[];
  /** Called once, after the kernel is built and before `start`. */
  install?(kernel: Kernel): void;
  /** After every frame, between frames (snapshots are allowed here). */
  afterFrame?(kernel: Kernel): void;
  /**
   * The kernel is done (`kernel.dispose()`, a host replacing the game on hot reload):
   * free what the plugin holds outside JavaScript (physics worlds, GPU buffers).
   */
  dispose?(kernel: Kernel): void;
  /**
   * Before the registry is built: transform the GAME's own definition (e.g. the net plugin
   * keeps only the systems that run in this role). Plugins' own definitions are untouched.
   */
  define?(game: GameDefinition): GameDefinition;
  /**
   * The plugin's world-level `ctx` namespace (`ctx.physics`, `ctx.ui`), built once per
   * kernel. The api layer mounts it on the game's context under `name`.
   */
  readonly namespace?: { readonly name: string; create(kernel: Kernel): object };
  /**
   * State the plugin keeps outside components and resources (physics bodies and contacts,
   * the random generator, open panels…), as plain JSON. Define both or neither: a plugin
   * holding such state must define them, or snapshots silently lose it.
   *
   * `snapshot` runs inside `kernel.snapshot()`, between frames. `restore` runs at the end
   * of `kernel.restore()`, after the world, resources and time are back — so it can
   * rebuild per-entity state (bodies) from the restored components and its saved data.
   * Entities it knew before the restore may be gone; drop anything keyed by them.
   */
  snapshot?(kernel: Kernel): Json;
  restore?(kernel: Kernel, state: Json): void;
}

/** Everything a game declares, as the kernel needs it. Systems are in run order. */
export interface GameDefinition {
  readonly components: readonly ComponentDef[];
  readonly resources: readonly ResourceDef[];
  readonly events: readonly EventDef[];
  readonly behaviors: readonly BehaviorDef[];
  readonly systems: readonly SystemDef[];
}
