/**
 * plugins/save — persistence (sdk/parallax/save.pyi).
 *
 *   persistence()  core, in every game: the device store, save version and migrations
 *                  (the `persistence` service), and the profile (keep="profile" fields,
 *                  Settings included), loaded at install and written when it changes.
 *   save()         the game's `save()` plugin: slots and checkpoints (`ctx.save`), and the
 *                  `save` service other plugins add sections to.
 *
 * A slot save holds: keep="run" resource fields (and their modifiers), the current scene
 * and its seed, the placed-entity diff (entities.ts), the environment's run state (time of
 * day, day, fog/sky overrides) and every registered section (facts, quests, …). Running
 * timers and tasks, entities spawned at runtime, keep="session" and keep="scene" fields are
 * not saved. Documents carry `Game(save_version=)`; older ones are migrated on load.
 *
 * Loading a slot is a scene load with new_run=True (New Game semantics: every keep="run" and
 * keep="scene" field back to its default, run-level sections reset by their plugins) and
 * the saved seed; once the scene's entities exist, and before any system or behavior
 * starts, the saved resources, entity diff, environment and sections are applied.
 * `ctx.save.load` returns at once (True if the slot exists); the load happens at the end of
 * the frame, like `ctx.scenes.load`. Saving writes the store at once.
 *
 * A checkpoint is the same document kept in memory (death/retry within a session).
 *
 * Each slot also stores its `SlotInfo` beside the document (`ctx.save.info(slot)`): the
 * scene, the run's play time (game time since the run began — a new_run=True load starts a
 * new run, loading a slot continues its play time, restoring a checkpoint keeps counting),
 * the wall-clock time where the platform has a clock, the save's label and its order.
 *
 * Open worlds: a saved entry of a streamed placement that isn't in the world when the save
 * loads (out of range, or its layer inactive) waits, and is applied when the placement
 * streams in — at its authored cell, so an entity saved far from where it was authored
 * comes back once a player nears its authored place.
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { EntityRecord, Kernel, KernelPlugin } from '../../kernel/index.js';
import { ENVIRONMENT_SERVICE, PERSISTENCE_SERVICE, RESERVED_SAVE_KEYS, SAVE_SERVICE } from '../../services/index.js';
import type { SaveDocument, SaveSection, SlotInfo } from '../../services/index.js';
import { applyEntities, baseline, diffEntities, encodeEntity, isStreamedKey, keyCodec, keyedEntities, streamedWorld } from './entities.js';
import type { EntityStates } from './entities.js';
import { documentResources, resourceSave } from './persistence.js';
import { isObject, parseInfo, parseStored, stringify } from './stored.js';

export { applyEntities, baseline, diffEntities, encodeEntity, encodeHeld, keyOf } from './entities.js';
export type { EntityStates } from './entities.js';
export { memoryStore, migrateDocument, persistence, PROFILE_KEY, UNREADABLE_PROFILE_KEY } from './persistence.js';
export type { PersistenceOptions } from './persistence.js';
export { parseInfo, parseStored, STORED_FORMAT, stringify } from './stored.js';

/** Store key prefix of slots. */
export const SLOT_PREFIX = 'slot:';
const ENVIRONMENT_KEY = 'environment';

export interface SaveOptions {
  /** `ctx.seed`: the seed of the current scene load (saved so a load replays it). */
  readonly seed: (kernel: Kernel) => number | null;
}

interface SaveState {
  readonly scene: string | null;
  readonly authored: EntityStates;
  readonly pending: EntityStates;
  readonly checkpoint: SaveDocument | null;
  readonly playBase: number;
  readonly playSince: number;
}

function slotName(slot: unknown, where: string): string {
  if (typeof slot !== 'string' || slot === '') {
    fail('PP3950', `${where}: a slot is a non-empty str, got ${JSON.stringify(slot) ?? String(slot)}`, { fix: 'Name slots with strings: "auto", "career", "slot1".' });
  }
  return slot;
}

/** The engine behind `ctx.save` (the api layer binds Python arguments onto it). */
export class SaveEngine {
  readonly #options: SaveOptions;
  #kernel: Kernel | undefined;
  readonly #sections = new Map<string, SaveSection>();
  /** The current scene's keyed entities as authored, and which scene that is. */
  #authored: EntityStates = {};
  #authoredScene: string | null = null;
  /** Loaded entries of streamed placements not in the world yet, by key (applied as they stream in). */
  #pendingEntities: EntityStates = {};
  #checkpoint: SaveDocument | null = null;
  /** A load waiting for its scene to be built. */
  #pending: SaveDocument | undefined;
  /** The next spawn batch is a scene's. */
  #sceneBatch = false;
  /** Play time of the run: `#playBase` seconds, plus game time since `#playSince`. */
  #playBase = 0;
  #playSince = 0;
  /** The play time a load waiting for its scene continues from. */
  #pendingPlay: number | undefined;

  constructor(options: SaveOptions) {
    this.#options = options;
  }

  get #k(): Kernel {
    if (this.#kernel === undefined) fail('PP3950', 'ctx.save is used before the game started', { fix: 'Use ctx.save from systems, behaviors and panel actions.' });
    return this.#kernel;
  }

  install(kernel: Kernel): void {
    if (this.#kernel !== undefined) {
      fail('PP3950', 'This save plugin is already installed in another kernel', { fix: 'Call save() once per game.' });
    }
    this.#kernel = kernel;
    kernel.provide(SAVE_SERVICE, { register: (section) => this.#register(section) });
    kernel.observeScenes({ loading: (scene, request) => this.#loading(scene.id, request.newRun === true) });
    // Registered at the first scene load, after every plugin installed: a scene's batch reaches this
    // observer after the others (streaming unloads what is out of range first), so the baseline and a
    // loaded save see the entities that stay.
    let observing = false;
    kernel.observeScenes({
      loading: () => {
        if (observing) return;
        observing = true;
        kernel.observeEntities({ added: (batch) => this.#added(batch) });
      },
    });
  }

  #register(section: SaveSection): void {
    if (RESERVED_SAVE_KEYS.includes(section.key) || section.key === ENVIRONMENT_KEY) {
      fail('PP3958', `A save section can't be named "${section.key}": the save plugin uses that key`, { fix: 'Pick another key for the section.' });
    }
    if (this.#sections.has(section.key)) fail('PP3958', `Two save sections are named "${section.key}"`, { fix: 'Register each section once.' });
    this.#sections.set(section.key, section);
  }

  #loading(sceneId: string, newRun: boolean): void {
    this.#sceneBatch = true;
    // The game loaded another scene after asking for a slot in the same frame: its choice wins.
    if (this.#pending !== undefined && this.#pending.scene !== sceneId) {
      this.#pending = undefined;
      this.#pendingPlay = undefined;
    }
    if (newRun || this.#pending !== undefined) {
      this.#playBase = this.#pending !== undefined ? this.#pendingPlay ?? 0 : 0;
      this.#playSince = this.#k.time.now;
      this.#pendingPlay = undefined;
    }
  }

  /** Seconds of game time played in this run. */
  playTime(): number {
    return this.#playBase + (this.#k.time.now - this.#playSince);
  }

  #added(batch: readonly EntityRecord[]): void {
    if (!this.#sceneBatch) {
      this.#streamedIn(batch);
      return;
    }
    this.#sceneBatch = false;
    const kernel = this.#k;
    this.#authored = baseline(kernel, batch);
    this.#authoredScene = kernel.scene?.id ?? null;
    this.#pendingEntities = {};
    const save = this.#pending;
    if (save === undefined) return;
    this.#pending = undefined;
    const where = `The save of scene "${save.scene}"`;
    kernel.loadResources(resourceSave(save, where));
    const present = keyedEntities(kernel, batch);
    const world = streamedWorld(kernel);
    const now: Record<string, Json> = {};
    for (const [key, entry] of Object.entries(save.entities)) {
      if (!present.has(key) && isStreamedKey(world, key) && isObject(entry)) this.#pendingEntities[key] = entry;
      else now[key] = entry;
    }
    applyEntities(kernel, batch, now);
    const environment = kernel.tryService(ENVIRONMENT_SERVICE);
    if (environment !== undefined && save[ENVIRONMENT_KEY] !== undefined) environment.load(save[ENVIRONMENT_KEY]);
    for (const [key, section] of this.#sections) section.load(save[key]);
  }

  /**
   * Streamed placements entering the world: the first time, their state is the authored
   * baseline; a loaded entry waiting for them applies now, before they start.
   */
  #streamedIn(batch: readonly EntityRecord[]): void {
    const kernel = this.#k;
    const world = streamedWorld(kernel);
    if (world === null || this.#authoredScene !== kernel.scene?.id) return;
    const codec = keyCodec(kernel);
    const waiting: Record<string, Json> = {};
    for (const [key, record] of keyedEntities(kernel, batch)) {
      if (!isStreamedKey(world, key)) continue;
      this.#authored[key] ??= encodeEntity(kernel, record, codec, `entity "${key}"`);
      const entry = this.#pendingEntities[key];
      if (entry === undefined) continue;
      waiting[key] = entry;
      delete this.#pendingEntities[key];
    }
    if (Object.keys(waiting).length > 0) applyEntities(kernel, batch, waiting);
  }

  /** The run as a document (what a slot or checkpoint holds). */
  capture(): SaveDocument {
    const kernel = this.#k;
    const scene = kernel.scene;
    if (scene === undefined || this.#authoredScene !== scene.id) {
      fail('PP3950', 'ctx.save needs a loaded scene', { fix: 'Save from systems, behaviors or panel actions once the game runs.' });
    }
    const save: SaveDocument = {
      version: kernel.service(PERSISTENCE_SERVICE).saveVersion,
      scene: scene.id,
      seed: this.#options.seed(kernel),
      ...documentResources(kernel.saveResources(['run'])),
      entities: diffEntities(kernel, this.#authored, this.#pendingEntities),
    };
    const environment = kernel.tryService(ENVIRONMENT_SERVICE);
    if (environment !== undefined) save[ENVIRONMENT_KEY] = environment.persist();
    for (const [key, section] of this.#sections) save[key] = section.save();
    return save;
  }

  /** Load a document: its scene at the end of this frame, then its state; the run's play time continues from `play`. */
  #begin(save: SaveDocument, where: string, play: number): void {
    const kernel = this.#k;
    if (!kernel.project.scenes.has(save.scene)) {
      fail('PP3957', `${where} is in scene "${save.scene}", which this project no longer has`, {
        fix: 'Add a migration that moves the save to a scene that exists.',
      });
    }
    if (!isObject(save.entities)) fail('PP3954', `${where}: "entities" must be a dict`);
    this.#pending = save;
    this.#pendingPlay = play;
    kernel.requestScene(save.scene, { newRun: true, ...(save.seed !== null && { seed: save.seed }) });
  }

  #read(slot: string): SaveDocument | undefined {
    const persistence = this.#k.service(PERSISTENCE_SERVICE);
    const text = persistence.store.get(SLOT_PREFIX + slot);
    if (text === undefined) return undefined;
    const where = `Save slot "${slot}"`;
    return persistence.migrate(parseStored(text, where, `Delete it (ctx.save.delete("${slot}")) to start over.`), where);
  }

  save(slot: unknown, label: unknown = ''): void {
    const name = slotName(slot, 'save()');
    if (typeof label !== 'string') fail('PP3950', `save("${name}"): label must be a str, got ${JSON.stringify(label) ?? String(label)}`);
    const persistence = this.#k.service(PERSISTENCE_SERVICE);
    const document = this.capture();
    const order = 1 + Math.max(0, ...this.slots().map((other) => this.info(other)?.order ?? 0));
    const info: SlotInfo = {
      scene: document.scene, play_time: this.playTime(), saved_at: persistence.wallClock(), label, order,
    };
    persistence.store.set(SLOT_PREFIX + name, stringify(document, info));
  }

  /** What a slot shows (scene, play time, when, label, order) without loading it; undefined when it's empty. */
  info(slot: unknown): SlotInfo | undefined {
    const name = slotName(slot, 'info()');
    const text = this.#k.service(PERSISTENCE_SERVICE).store.get(SLOT_PREFIX + name);
    if (text === undefined) return undefined;
    return parseInfo(text, `Save slot "${name}"`, `Delete it (ctx.save.delete("${name}")) to start over.`);
  }

  load(slot: unknown): boolean {
    const name = slotName(slot, 'load()');
    const save = this.#read(name);
    if (save === undefined) return false;
    this.#begin(save, `Save slot "${name}"`, this.info(name)!.play_time);
    return true;
  }

  exists(slot: unknown): boolean {
    return this.#k.service(PERSISTENCE_SERVICE).store.get(SLOT_PREFIX + slotName(slot, 'exists()')) !== undefined;
  }

  delete(slot: unknown): void {
    this.#k.service(PERSISTENCE_SERVICE).store.delete(SLOT_PREFIX + slotName(slot, 'delete()'));
  }

  slots(): string[] {
    return this.#k.service(PERSISTENCE_SERVICE).store.keys()
      .filter((key) => key.startsWith(SLOT_PREFIX))
      .map((key) => key.slice(SLOT_PREFIX.length))
      .sort();
  }

  checkpoint(): void {
    this.#checkpoint = this.capture();
  }

  restoreCheckpoint(): boolean {
    if (this.#checkpoint === null) return false;
    // Play time keeps counting: a retry is still time played.
    this.#begin(structuredClone(this.#checkpoint), 'The checkpoint', this.playTime());
    return true;
  }

  snapshot(): Json {
    const state: SaveState = {
      scene: this.#authoredScene, authored: this.#authored, pending: this.#pendingEntities, checkpoint: this.#checkpoint,
      playBase: this.#playBase, playSince: this.#playSince,
    };
    return structuredClone(state) as unknown as Json;
  }

  restore(state: Json): void {
    if (!isObject(state) || !isObject(state['authored']) || !isObject(state['pending'])
      || typeof state['playBase'] !== 'number' || typeof state['playSince'] !== 'number') fail('PP9002', 'The snapshot has no save plugin state');
    const saved = state as unknown as SaveState;
    this.#authoredScene = saved.scene;
    this.#authored = structuredClone(saved.authored);
    this.#pendingEntities = structuredClone(saved.pending);
    this.#checkpoint = saved.checkpoint === null ? null : structuredClone(saved.checkpoint);
    this.#playBase = saved.playBase;
    this.#playSince = saved.playSince;
    this.#pending = undefined;
    this.#pendingPlay = undefined;
    this.#sceneBatch = false;
  }
}

export interface SavePlugin extends KernelPlugin {
  readonly engine: SaveEngine;
}

export function save(options: SaveOptions): SavePlugin {
  const engine = new SaveEngine(options);
  return {
    id: 'save',
    engine,
    install: (kernel) => engine.install(kernel),
    snapshot: () => engine.snapshot(),
    restore: (_kernel, state) => engine.restore(state),
  };
}
