/**
 * `parallax.save` (sdk/parallax/save.pyi): `SaveApi`, the type of `ctx.save`, and the
 * `save()` plugin factory (`parallax.plugins.save`); plus `migration` / `SaveData` (exported
 * from `parallax`) and `corePersistence`, the persistence plugin every runtime includes.
 * Saving lives in the save plugin; this module binds Python arguments and converts
 * documents to and from the Python values migrations work on.
 *
 * Migrations register when their modules (`migrations/*.py`) are imported. Hosts import
 * them before the game starts (boot's `gameModules` leaves them out); a save that needs a
 * step nobody registered fails with PP3952 naming the missing version.
 */

import { fail } from '../core/index.js';
import type { KeyValueStore } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import { persistence, save as savePlugin, SaveEngine } from '../function/plugins/save/index.js';
import type { MigrationStep, SaveDocument, SlotInfo } from '../function/services/index.js';
import type { Json, JsonObject } from '../resource/index.js';
import { bindArgs } from './kwargs.js';
import { PyDict } from './pyrt/collections.js';
import { SceneRef } from './types.js';

const DEFAULT_SLOT = 'auto';

/** `ctx.save.info(slot)` (SDK `SaveInfo`). */
export class SaveInfo {
  readonly slot: string;
  readonly scene: SceneRef;
  readonly play_time: number;
  readonly saved_at: number | null;
  readonly label: string;
  readonly order: number;

  constructor(slot: string, info: SlotInfo) {
    this.slot = slot;
    this.scene = new SceneRef(info.scene);
    this.play_time = info.play_time;
    this.saved_at = info.saved_at;
    this.label = info.label;
    this.order = info.order;
  }

  __repr__(): string {
    return `SaveInfo(slot=${JSON.stringify(this.slot)}, scene=${this.scene.id}, play_time=${this.play_time.toFixed(1)}, order=${this.order})`;
  }
}

/** `ctx.save`: slots and checkpoints. */
export class SaveApi {
  readonly #engine: SaveEngine;

  constructor(engine: SaveEngine) {
    this.#engine = engine;
  }

  #slot(name: string, args: readonly unknown[], required = false): unknown {
    const a = bindArgs(name, args, { positional: ['slot'], ...(required && { required: ['slot'] }) }).args;
    return a['slot'] ?? DEFAULT_SLOT;
  }

  save(...args: unknown[]): null {
    const a = bindArgs('save', args, { positional: ['slot'], keyword: ['label'] }).args;
    this.#engine.save(a['slot'] ?? DEFAULT_SLOT, a['label'] ?? '');
    return null;
  }

  /** What a slot shows without loading it — scene, play time, when, label, order — or None when it's empty. */
  info(...args: unknown[]): SaveInfo | null {
    const slot = this.#slot('info', args) as string;
    const info = this.#engine.info(slot);
    return info === undefined ? null : new SaveInfo(slot, info);
  }

  /** Loads the slot's scene and state (end of frame). False if the slot is empty. */
  load(...args: unknown[]): boolean {
    return this.#engine.load(this.#slot('load', args));
  }

  exists(...args: unknown[]): boolean {
    return this.#engine.exists(this.#slot('exists', args));
  }

  delete(...args: unknown[]): null {
    this.#engine.delete(this.#slot('delete', args, true));
    return null;
  }

  slots(...args: unknown[]): string[] {
    bindArgs('slots', args, {});
    return this.#engine.slots();
  }

  /** Snapshot the run so `restore_checkpoint` can return here (death/retry). */
  checkpoint(...args: unknown[]): null {
    bindArgs('checkpoint', args, {});
    this.#engine.checkpoint();
    return null;
  }

  restore_checkpoint(...args: unknown[]): boolean {
    bindArgs('restore_checkpoint', args, {});
    return this.#engine.restoreCheckpoint();
  }
}

/** `parallax.plugins.save()`. */
export function save(...args: unknown[]): KernelPlugin {
  bindArgs('save', args, {});
  const plugin = savePlugin({
    seed: (kernel: Kernel) => {
      const seed = (kernel.context as { seed?: unknown } | undefined)?.seed;
      return typeof seed === 'number' ? seed : null;
    },
  });
  return { ...plugin, namespace: { name: 'save', create: () => new SaveApi(plugin.engine) } };
}

// ── Migrations ─────────────────────────────────────────────────────────────────

/** JSON as the Python values a migration edits: dicts are `dict`, lists `list`. */
function toPython(value: Json): unknown {
  if (Array.isArray(value)) return (value as readonly Json[]).map(toPython);
  if (typeof value === 'object' && value !== null) {
    return PyDict.from(Object.entries(value as JsonObject).map(([k, v]) => [k, toPython(v)]));
  }
  return value;
}

/** A migrated Python value back as JSON; PP3959 for anything a save can't hold. */
function fromPython(value: unknown, where: string): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PP3959', `${where} is ${String(value)}, which a save can't hold`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => fromPython(v, `${where}[${i}]`));
  if (value instanceof PyDict) {
    const out: Record<string, Json> = {};
    for (const key of value) {
      if (typeof key !== 'string') fail('PP3959', `${where} has the key ${String(key)}; saved dict keys are str`);
      out[key] = fromPython(value.__getitem__(key), `${where}["${key}"]`);
    }
    return out;
  }
  const name = (value as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? typeof value;
  return fail('PP3959', `${where} holds a ${name}, which a save can't hold`, {
    fix: 'Migrations write the JSON forms: dict, list, str, int, float, bool, None (a Timer is {"duration", "remaining", "repeat"}).',
  });
}

const SECTION_KEYS = ['facts', 'quests', 'environment'] as const;

/** What a migration sees (SDK `SaveData`): the JSON forms of the saved parts, as Python values. */
export class SaveData {
  readonly version: number;
  resources: PyDict;
  entities: PyDict;
  facts: PyDict;
  quests: PyDict;
  environment: PyDict;

  constructor(save: SaveDocument) {
    this.version = save.version;
    this.resources = toPython(save.resources) as PyDict;
    this.entities = toPython(save.entities) as PyDict;
    this.facts = toPython(save['facts'] ?? {}) as PyDict;
    this.quests = toPython(save['quests'] ?? {}) as PyDict;
    this.environment = toPython(save['environment'] ?? {}) as PyDict;
  }

  /** Write the edited parts back into the document. */
  writeTo(save: SaveDocument, where: string): void {
    const dict = (value: unknown, part: string): JsonObject => {
      if (!(value instanceof PyDict)) fail('PP3959', `${where}: save.${part} must stay a dict`);
      return fromPython(value, `save.${part}`) as JsonObject;
    };
    const resources = dict(this.resources, 'resources');
    for (const [id, fields] of Object.entries(resources)) {
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) fail('PP3959', `${where}: save.resources["${id}"] must be a dict of fields`);
    }
    save.resources = resources as Record<string, JsonObject>;
    // Modifiers of fields the migration removed go with them.
    for (const [id, byField] of Object.entries(save.modifiers)) {
      const kept = Object.fromEntries(Object.entries(byField).filter(([name]) => (resources[id] as JsonObject | undefined)?.[name] !== undefined));
      if (Object.keys(kept).length > 0) save.modifiers[id] = kept;
      else delete save.modifiers[id];
    }
    save.entities = dict(this.entities, 'entities') as Record<string, JsonObject>;
    for (const key of SECTION_KEYS) {
      const value = dict(this[key], key);
      if (save[key] !== undefined || Object.keys(value).length > 0) save[key] = value;
    }
  }
}

const MIGRATIONS: MigrationStep[] = [];

function version(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail('PP3951', `@migration ${name} must be an int, got ${String(value)}`);
  return value;
}

/** `@migration(from_version=N, to_version=M)`: one step of the game's save versions. */
export function migration(...args: unknown[]): (fn: unknown) => unknown {
  const a = bindArgs('migration', args, { keyword: ['from_version', 'to_version'], required: ['from_version', 'to_version'] }).args;
  const from = version(a['from_version'], 'from_version');
  const to = version(a['to_version'], 'to_version');
  return (fn) => {
    if (typeof fn !== 'function') fail('PP3951', '@migration decorates a function `def name(save: SaveData) -> None`');
    const name = (fn as { name?: string }).name || '(migration)';
    MIGRATIONS.push({
      from,
      to,
      name,
      run: (save) => {
        const data = new SaveData(save);
        (fn as (save: SaveData) => unknown)(data);
        data.writeTo(save, `Migration ${name}`);
      },
    });
    return fn;
  };
}

/** The migrations registered so far (the game's `migrations/` modules, once imported). */
export function registeredMigrations(): readonly MigrationStep[] {
  return [...MIGRATIONS];
}

/** Forget registered migrations (a fresh module realm; part of `resetDeclarations`). */
export function resetMigrations(): void {
  MIGRATIONS.length = 0;
}

export interface CorePersistenceOptions {
  /** The platform's store (`LocalStore` in a browser); default: memory, nothing outlives the run. */
  readonly store?: KeyValueStore;
  /** `Game(save_version=)`. */
  readonly saveVersion: number;
  /** The platform's wall clock, Unix seconds (`SaveInfo.saved_at`); none headless. */
  readonly wallClock?: () => number;
}

/** The persistence plugin a runtime includes for every game (profile fields, the store, migrations). */
export function corePersistence(options: CorePersistenceOptions): KernelPlugin {
  return persistence({
    ...(options.store !== undefined && { store: options.store }), ...(options.wallClock !== undefined && { wallClock: options.wallClock }),
    saveVersion: options.saveVersion, migrations: registeredMigrations,
  });
}
