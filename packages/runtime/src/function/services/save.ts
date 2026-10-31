/**
 * Persistence services (sdk/parallax/save.pyi), provided by the save
 * plugin folder (function/plugins/save/):
 *
 *   `persistence`  the device store, the game's save version and its migrations. Provided
 *                  by the core `persistence` plugin every game has (profile-tier fields
 *                  persist without the save plugin), used by the save plugin.
 *   `save`         slot saves, provided by the `save()` plugin. Other plugins whose state
 *                  belongs in a slot save (story: facts and quests; voxels: edits; world
 *                  layers) register a `SaveSection` with it — at use, e.g. in their first
 *                  `observeScenes.loading`, never at install (the provider may install later).
 *                  `kernel.tryService(SAVE_SERVICE)` is undefined in a game without saves.
 *
 * A section's JSON sits at the top level of the saved document under its `key`, which is
 * exactly what migrations see: section "facts" is `SaveData.facts`, "quests" is
 * `SaveData.quests`. Keys the save plugin owns are reserved (RESERVED_SAVE_KEYS).
 */

import type { KeyValueStore } from '../../core/index.js';
import type { Json, JsonObject } from '../../resource/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

/** The JSON document a slot holds, as migrations see it (SDK `SaveData`). */
export interface SaveDocument {
  /** The game's `save_version` when written. */
  version: number;
  /** The scene that was current. */
  scene: string;
  /** `ctx.seed` of that scene's load; null when the load had none of its own. */
  seed: number | null;
  /** keep="run" resource fields: resource id → field → JSON (`SaveData.resources`). */
  resources: Record<string, JsonObject>;
  /** Modifiers on saved resource fields: resource id → field → modifier list. */
  modifiers: Record<string, Record<string, Json[]>>;
  /**
   * Placed entities that differ from the authored scene, by save key (a placed id, or
   * `<placed id>/<child name>` for prefab children): component id or behavior id → changed
   * fields (a component mapped to null was removed), plus `transform`, `tags`, `visible`
   * when they changed, or `{"destroyed": true}`. `SaveData.entities`.
   */
  entities: Record<string, JsonObject>;
  /** Contributed sections (`environment`, `facts`, `quests`, …) by key. */
  [section: string]: Json;
}

/** What a slot shows without loading it (SDK `SaveInfo`): kept beside the document, not in it. */
export interface SlotInfo {
  /** The scene that was current. */
  readonly scene: string;
  /** Seconds of game time played in the run (pauses and menus with time frozen don't count). */
  readonly play_time: number;
  /** Wall-clock Unix seconds it was written; null on a platform without a clock. */
  readonly saved_at: number | null;
  /** `ctx.save.save(slot, label=...)`; "" when none. */
  readonly label: string;
  /** Which save this was on the device: each one is higher than every slot it found, so the newest slot has the highest. */
  readonly order: number;
}

/** Top-level keys of a SaveDocument that sections may not use. */
export const RESERVED_SAVE_KEYS: readonly string[] = ['version', 'scene', 'seed', 'resources', 'modifiers', 'entities'];

/** One step of the game's `migrations/` (`@migration(from_version=, to_version=)`). */
export interface MigrationStep {
  readonly from: number;
  readonly to: number;
  /** Where it is declared, for diagnostics (`migrations/0002_bag_by_item.py: bag_by_item`). */
  readonly name: string;
  /** Rewrites the document in place (resources, entities, sections); `version` is set by the caller. */
  run(save: SaveDocument): void;
}

export interface PersistenceService {
  /** The device store: localStorage in a browser, memory headless. */
  readonly store: KeyValueStore;
  /** `Game(save_version=)`. */
  readonly saveVersion: number;
  /**
   * Bring a document of an older version up to `saveVersion` through the migrations, in
   * order. PP3952 when a step is missing, PP3953 when the document is newer than the game.
   */
  migrate(save: SaveDocument, where: string): SaveDocument;
  /** The platform's wall clock in Unix seconds; null where there is none (headless runs). Shown on save slots only — never simulation. */
  wallClock(): number | null;
}

export const PERSISTENCE_SERVICE: ServiceKey<PersistenceService> = serviceKey<PersistenceService>(
  'persistence', 'The persistence plugin is core: build the game through createRuntime, which includes it.',
);

/** State another plugin keeps in slot saves. */
export interface SaveSection {
  /** Top-level key in the saved document (`facts`, `quests`, `voxels`, …). */
  readonly key: string;
  /** The run-lifetime state, as JSON. Called whenever a slot or checkpoint is written. */
  save(): Json;
  /**
   * Put a saved state back. Called once the loaded scene's entities exist and before any
   * system or behavior starts; `data` is undefined when the save has no such section.
   */
  load(data: Json | undefined): void;
}

export interface SaveService {
  /** Add a section (once per key). */
  register(section: SaveSection): void;
}

export const SAVE_SERVICE: ServiceKey<SaveService> = serviceKey<SaveService>(
  'save', 'Add save() to Game(plugins=[...]) (from parallax.plugins import save).',
);
