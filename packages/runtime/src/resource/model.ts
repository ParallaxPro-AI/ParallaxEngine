/**
 * The loaded form of a project's data files. Everything here is read-only and plain data:
 * the kernel instantiates it, the checker inspects it, codegen names it.
 */

import type { Diagnostic } from '../core/index.js';

export type Json = null | boolean | number | string | readonly Json[] | JsonObject;
export interface JsonObject { readonly [key: string]: Json }

/** Where a value came from, for diagnostics: a project file and a JSON pointer inside it. */
export interface Origin {
  readonly path: string;
  readonly pointer: string;
}

/** The feature folder a file lives in (`features/<feature>/…`), or undefined at the root. */
export type FeatureId = string | undefined;

export interface BehaviorUse {
  readonly use: string;
  readonly params: JsonObject;
  readonly origin: Origin;
}

/** A row of identical instances laid out on a grid (bricks, coins, lane stripes). */
export interface InstanceGrid {
  readonly cols: number;
  readonly rows: number;
  readonly spacing: readonly number[];
  readonly origin: readonly number[];
}

/** Fields shared by scene placements and prefab children. */
export interface InstanceFields {
  readonly at?: readonly number[];
  readonly rotation?: number | readonly number[];
  readonly scale?: number | readonly number[];
  readonly z?: number;
  /** Component overrides, by component id. */
  readonly components: Readonly<Record<string, JsonObject>>;
  readonly tags: readonly string[];
  /** Behavior param overrides, by behavior id (same shape as `spawn(params=...)`). */
  readonly params: Readonly<Record<string, JsonObject>>;
  /** Repeat this instance on a grid instead of placing it once. */
  readonly grid?: InstanceGrid;
  /** Initial `entity.visible` (default true). */
  readonly visible?: boolean;
  readonly origin: Origin;
}

export interface Placement extends InstanceFields {
  readonly prefab: string;
  /** Stable id (`Placed.<id>`), only when something refers to this entity. */
  readonly id?: string;
  /** World layer (open worlds); undefined = always present. */
  readonly layer?: string;
  /** Region it was loaded from (open worlds); undefined = the scene file itself. */
  readonly region?: string;
  /** Stays loaded regardless of streaming (managers, backdrops, the camera). */
  readonly alwaysLoaded?: boolean;
}

export interface PrefabChild extends InstanceFields {
  /** Only needed to look the child up with `entity.child(name)`; unique within the prefab. */
  readonly name?: string;
  /** Undefined for inline children built only from `components`. */
  readonly prefab?: string;
}

export interface PrefabDoc {
  readonly id: string;
  readonly feature: FeatureId;
  readonly path: string;
  readonly extends?: string;
  readonly components: Readonly<Record<string, JsonObject>>;
  readonly tags: readonly string[];
  /** Written as `"behaviors": {"<behavior id>": {params}}` (the shape of `params` and `spawn(params=)`), in file order. */
  readonly behaviors: readonly BehaviorUse[];
  readonly children: readonly PrefabChild[];
  readonly pool?: number;
  readonly z?: number;
  /** The prefab's own scale (an instance's "scale" replaces it). */
  readonly scale?: number | readonly number[];
  readonly replicateTransform?: boolean;
}

export interface WorldLayerDoc {
  readonly id: string;
  readonly activeWhen?: JsonObject;
}

export interface WorldDoc {
  readonly path: string;
  readonly cellSize: number;
  readonly streaming?: JsonObject;
  readonly layers: ReadonlyMap<string, WorldLayerDoc>;
}

/** A region manifest (`regions/<id>/region.json`) in a streamed world. */
export interface RegionDoc {
  readonly id: string;
  readonly path: string;
  /** Ground-plane rectangle (x, z) the region covers. */
  readonly bounds?: { readonly min: readonly number[]; readonly max: readonly number[] };
  readonly budget?: { readonly entities?: number };
}

export interface SceneDoc {
  readonly id: string;
  readonly path: string;
  readonly tags: readonly string[];
  /** Panel ids opened when the scene loads. */
  readonly ui: readonly string[];
  readonly music?: string;
  /** × the scene music's audio.json volume (one track, a different level per scene). */
  readonly musicVolume?: number;
  readonly environment?: JsonObject;
  /** Resource values applied when the scene is opened directly: resource id → fields. */
  readonly init: Readonly<Record<string, JsonObject>>;
  /** Placements from scene.json and every region, in file order. */
  readonly entities: readonly Placement[];
  readonly world?: WorldDoc;
  /** Region manifests by region id (open worlds). */
  readonly regions: ReadonlyMap<string, RegionDoc>;
  /** Plugin-owned blocks (terrain, voxels, navmesh), validated by their plugins. */
  readonly plugins: Readonly<Record<string, JsonObject>>;
  /** The base scene this one extends (`"extends"`), already resolved into the fields above. */
  readonly extends?: string;
  /**
   * For a derived scene: the file each top-level key was read from (an inherited key names
   * the base's scene.json). Inherited placements keep their base file in `origin`.
   */
  readonly keyPaths?: Readonly<Record<string, string>>;
}

export interface ConfigDoc {
  readonly id: string;
  readonly feature: FeatureId;
  readonly path: string;
  readonly values: JsonObject;
}

export interface ContentEntry {
  readonly kind: string;
  readonly id: string;
  readonly feature: FeatureId;
  readonly path: string;
  readonly values: JsonObject;
}

export interface LocaleDoc {
  readonly language: string;
  readonly path: string;
  readonly strings: Readonly<Record<string, string>>;
}

/** A fixed value, or a [lo, hi] range picked from on every play (variation). */
export type AudioLevel = number | readonly [number, number];

export interface AudioDefaults {
  readonly volume?: AudioLevel;
  readonly pitch?: AudioLevel;
  /** Dip the music while it plays (a voice line); `play(duck=)` overrides it. */
  readonly duck?: boolean;
  /** The bank it belongs to: `ctx.audio.preload(bank=...)` / `unload(bank=...)` load or free it as a group. */
  readonly bank?: string;
  /** Voice budget rank (default 64; higher is kept when too many sounds play at once). */
  readonly priority?: number;
  /** At most this many of it at once: another one stops the oldest (ten bricks breaking in a frame). */
  readonly limit?: number;
  /**
   * Music: held where it is while the game is paused (a modal panel froze time) and resumed
   * after (default true). `false` keeps the track playing through the pause menu.
   */
  readonly pauses?: boolean;
  /** The mix group it plays in (`ctx.audio.set_group("voice", volume=0.5)` / `mute=True`). */
  readonly group?: string;
}

/** A dialogue script (`story/<id>.yarn`), kept as text: the story plugin parses it. */
export interface DialogueFile {
  readonly id: string;
  readonly feature: FeatureId;
  readonly path: string;
  readonly text: string;
}

export interface Project {
  readonly prefabs: ReadonlyMap<string, PrefabDoc>;
  readonly scenes: ReadonlyMap<string, SceneDoc>;
  readonly config: ReadonlyMap<string, ConfigDoc>;
  /** kind → id → entry. */
  readonly content: ReadonlyMap<string, ReadonlyMap<string, ContentEntry>>;
  readonly locales: ReadonlyMap<string, LocaleDoc>;
  /** `folder/name` (as in assets/audio.json) → defaults. */
  readonly audio: ReadonlyMap<string, AudioDefaults>;
  /** id → dialogue script. */
  readonly dialogues: ReadonlyMap<string, DialogueFile>;
  /** Project-relative path → text of every `.plan` floor-plan file (procgen Structure.plan). */
  readonly plans?: ReadonlyMap<string, string>;
  /** Every problem found while loading, in file order. Empty means the data is sound. */
  readonly diagnostics: readonly Diagnostic[];
}
