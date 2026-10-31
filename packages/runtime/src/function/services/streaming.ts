/**
 * The `streaming` service: the open world of the current scene (`scenes/<id>/world.json`),
 * provided by the core streaming plugin (`kernel.service(STREAMING_SERVICE).current()`).
 * Consumers: the api's `ctx.world.layer(...)`, the save plugin (layer states and the held
 * state of placed entities that are streamed out), tools that show what is loaded.
 *
 * Streaming. A placement from `regions/<r>/entities/` is *streamed*: it is in the world
 * only while its world layer is active and its cell (`cell_size` squares on x/z, from its
 * current position — its authored one until it first loads) is within `streaming.radius`
 * of a streaming source: every camera, each entity a camera follows, and every
 * player-owned entity. It leaves once its cell is farther than radius + cell_size / 2
 * (so an entity on a boundary doesn't flicker). Placements in scene.json, `always_loaded`
 * ones, player-owned entities and the sources themselves never stream out.
 *
 * Leaving the world is an *unload*: the entity ends (`end` hooks run), `destroyed` is
 * emitted with `unloaded: true`, and its state is held under its placed id — transform,
 * visibility, tags, every component's base field values and every behavior's `state()`.
 * When it streams back in, its prefab is spawned again with the held transform and
 * components (behaviors `start` as on any spawn), then the held behavior state is put
 * back. Modifiers, physics velocities and prefab children's own state are not held. A
 * streamed entity destroyed by game code stays destroyed for the rest of the scene.
 *
 * Layers (world.json `"layers"`). A placement's `"layer"` names one; no layer means
 * always present. A layer is `active` (its placements stream normally), `loaded` (none of
 * its placements are in the world; held state is kept) or `unloaded` (not in the world,
 * and held state is dropped, so they come back as authored). A layer with `active_when`
 * follows its condition every frame: active while it holds, else loaded. Every other
 * layer starts active and changes only through `setLayerState` (`ctx.world.layer`).
 * Imperative states are run-level: they survive scene changes and `new_run=True` clears them.
 *
 * `active_when` is an object whose keys must all hold:
 *   {"quest_active": id}  {"quest_completed": id}  {"quest_failed": id}  {"fact": key (truthy)}
 * Quests and facts come from the story service (`story()`; function/services/story.ts).
 */

import type { EntityId, Quat, Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { Fields, ServiceKey } from '../kernel/index.js';

export type LayerState = 'unloaded' | 'loaded' | 'active';

/** The state of a streamed-out placed entity, in runtime form (entity fields hold handles). */
export interface HeldEntity {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
  readonly visible: boolean;
  readonly tags: readonly string[];
  /** Component id → base field values. */
  readonly components: Readonly<Record<string, Fields>>;
  /** Behavior `state()` values, in the entity's behavior order. */
  readonly behaviors: readonly { readonly use: string; readonly state: Fields }[];
}

export interface WorldLayerInfo {
  readonly id: string;
  readonly state: LayerState;
  /** Follows `active_when` (setLayerState refuses it). */
  readonly declarative: boolean;
}

export interface StreamedWorld {
  readonly scene: string;
  readonly cellSize: number;
  readonly radius: number;
  /** Declared layers, in world.json order. */
  layers(): readonly WorldLayerInfo[];
  /** PP3630 for an undeclared layer. */
  layerState(id: string): LayerState;
  /**
   * Change a layer without `active_when` (PP3631 for one that has it). Takes effect now:
   * placements stream in or out before this returns.
   */
  setLayerState(id: string, state: LayerState): void;
  /** Whether a streamed placement is in the world now; undefined for ids that don't stream. */
  isLoaded(placedId: string): boolean | undefined;
  /** Streamed-out placements' held state, by placed id. */
  held(): ReadonlyMap<string, HeldEntity>;
  /** Streamed placements destroyed by game code (they never come back this scene). */
  destroyed(): ReadonlySet<string>;
}

export interface StreamingService {
  /** The current scene's open world, or null when the scene has no world.json. */
  current(): StreamedWorld | null;
  /** Where the world is looked at from (cameras, followed entities, player-owned entities), in spawn order. */
  sources(): readonly { readonly entity: EntityId; readonly position: Vec3 }[];
}

export const STREAMING_SERVICE: ServiceKey<StreamingService> = serviceKey<StreamingService>(
  'streaming', 'Streaming is core: build the game through createRuntime, which includes it for scenes with a world.json.',
);
