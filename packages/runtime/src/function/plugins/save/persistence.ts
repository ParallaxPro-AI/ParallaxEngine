/**
 * The core `persistence` plugin, in every game (profile-tier fields persist without the save
 * plugin). It provides the `persistence` service — the device store, the
 * game's save version and its migrations — and keeps the profile:
 *
 *   - At install (before the first scene), every `keep="profile"` resource field (the
 *     built-in Settings included) is loaded from the store's `profile` document, migrated
 *     to the current save version first.
 *   - At the end of every frame (the kernel's `render` hook) the profile fields are written
 *     back when they changed since the last write.
 *
 * A device has one profile; per-player profiles on a server (`ctx.get(R, player=)`) belong
 * to the net plugin. Migrations see a profile as a SaveData whose `resources` are the
 * profile fields and whose other parts are empty.
 */

import { ParallaxError, fail } from '../../../core/index.js';
import type { KeyValueStore } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { Kernel, KernelPlugin, ResourceSave, SavedModifier } from '../../kernel/index.js';
import { PERSISTENCE_SERVICE } from '../../services/index.js';
import type { MigrationStep, PersistenceService, SaveDocument } from '../../services/index.js';
import { isObject, parseStored, stringify } from './stored.js';

/** Store key of the profile document. */
export const PROFILE_KEY = 'profile';
/** Where a stored profile this build could not read is set aside (see loadProfile). */
export const UNREADABLE_PROFILE_KEY = 'profile.unreadable';

export interface PersistenceOptions {
  /** The platform's store (`LocalStore` in a browser); default: memory, so nothing outlives the run. */
  readonly store?: KeyValueStore;
  /** `Game(save_version=)`. */
  readonly saveVersion: number;
  /** The game's `@migration` steps, read when a document needs migrating (modules load after the plugin is built). */
  readonly migrations: () => readonly MigrationStep[];
  /** The platform's wall clock, Unix seconds (save slot times); none headless. */
  readonly wallClock?: () => number;
}

function checkVersion(version: unknown, where: string): number {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fail('PP3951', `${where}: save_version must be an int of 1 or more, got ${JSON.stringify(version)}`, {
      fix: 'Set Game(save_version=N) to a whole number; it starts at 1.',
    });
  }
  return version;
}

/** The steps by `from`, checked: each goes up, none past the game's version, one per `from`. */
function chain(steps: readonly MigrationStep[], saveVersion: number): Map<number, MigrationStep> {
  const byFrom = new Map<number, MigrationStep>();
  for (const step of steps) {
    if (!Number.isInteger(step.from) || !Number.isInteger(step.to) || step.from < 1 || step.to <= step.from) {
      fail('PP3951', `Migration ${step.name} goes from version ${step.from} to ${step.to}`, {
        fix: 'A migration moves a save up: @migration(from_version=N, to_version=N + 1), with N >= 1.',
      });
    }
    if (step.to > saveVersion) {
      fail('PP3951', `Migration ${step.name} migrates to version ${step.to}, but the game's save_version is ${saveVersion}`, {
        fix: `Raise Game(save_version=${step.to}) along with the change the migration is for.`,
      });
    }
    const other = byFrom.get(step.from);
    if (other !== undefined) {
      fail('PP3951', `Two migrations start at version ${step.from}: ${other.name} and ${step.name}`, {
        fix: 'Keep one migration per version step; merge the two functions.',
      });
    }
    byFrom.set(step.from, step);
  }
  return byFrom;
}

export function migrateDocument(
  save: SaveDocument, saveVersion: number, steps: readonly MigrationStep[], where: string,
): SaveDocument {
  const from = checkVersion(save.version, where);
  if (from > saveVersion) {
    fail('PP3953', `${where} was written by save version ${from}, newer than this game's ${saveVersion}`, {
      fix: 'Run the newer game build, or delete the save.',
    });
  }
  if (from === saveVersion) return save;
  const byFrom = chain(steps, saveVersion);
  let version = from;
  while (version < saveVersion) {
    const step = byFrom.get(version);
    if (step === undefined) {
      fail('PP3952', `${where} is at save version ${version}, and no migration starts there (the game is at ${saveVersion})`, {
        fix: `Add migrations/<nnnn>_<name>.py with @migration(from_version=${version}, to_version=${version + 1}), and make sure the host loads migrations/ (boot's migration modules).`,
      });
    }
    step.run(save);
    version = step.to;
    save.version = version;
  }
  return save;
}

/** A modifier list as stored (the kernel's `SavedModifier`), checked. */
function savedModifiers(value: Json, where: string): SavedModifier[] {
  if (!Array.isArray(value)) fail('PP3954', `${where} must be a list of modifiers`);
  return (value as readonly Json[]).map((m, i) => {
    if (!isObject(m) || typeof m['add'] !== 'number' || typeof m['multiply'] !== 'number'
      || (m['key'] !== undefined && typeof m['key'] !== 'string') || (m['seconds'] !== undefined && typeof m['seconds'] !== 'number')) {
      return fail('PP3954', `${where}[${i}] is not a modifier`);
    }
    return {
      add: m['add'],
      multiply: m['multiply'],
      ...(typeof m['key'] === 'string' && { key: m['key'] }),
      ...(typeof m['seconds'] === 'number' && { seconds: m['seconds'] }),
    };
  });
}

/** A document's resources and modifiers as the kernel's `ResourceSave`. */
export function resourceSave(save: SaveDocument, where: string): ResourceSave {
  if (!isObject(save.resources)) fail('PP3954', `${where}: "resources" must be a dict`);
  if (!isObject(save.modifiers)) fail('PP3954', `${where}: "modifiers" must be a dict`);
  const resources: Record<string, JsonObject> = {};
  for (const [id, fields] of Object.entries(save.resources)) {
    if (!isObject(fields)) fail('PP3954', `${where}: resources["${id}"] must be a dict of fields`);
    resources[id] = fields;
  }
  const modifiers: Record<string, Record<string, SavedModifier[]>> = {};
  for (const [id, byField] of Object.entries(save.modifiers)) {
    if (!isObject(byField)) fail('PP3954', `${where}: modifiers["${id}"] must be a dict`);
    modifiers[id] = Object.fromEntries(Object.entries(byField).map(([name, list]) => [name, savedModifiers(list, `${where}: modifiers["${id}"]["${name}"]`)]));
  }
  return { resources, modifiers };
}

/** The kernel's `ResourceSave` as a document's `resources` / `modifiers` (JSON). */
export function documentResources(save: ResourceSave): Pick<SaveDocument, 'resources' | 'modifiers'> {
  const modifiers: Record<string, Record<string, Json[]>> = {};
  for (const [id, byField] of Object.entries(save.modifiers)) {
    modifiers[id] = Object.fromEntries(Object.entries(byField).map(([name, list]) => [name, list.map((m) => ({ ...m }) as JsonObject)]));
  }
  return { resources: { ...save.resources }, modifiers };
}

/** A store that keeps nothing past the run (tests, and runtimes built without a platform store). */
export function memoryStore(): KeyValueStore {
  const entries = new Map<string, string>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, value); },
    delete: (key) => { entries.delete(key); },
    keys: () => [...entries.keys()].sort(),
  };
}

export function persistence(options: PersistenceOptions): KernelPlugin {
  const saveVersion = checkVersion(options.saveVersion, 'Game');
  const store = options.store ?? memoryStore();
  let installed: Kernel | undefined;
  let written: string | undefined;

  const service: PersistenceService = {
    store,
    saveVersion,
    migrate: (save, where) => migrateDocument(save, saveVersion, options.migrations(), where),
    wallClock: () => (options.wallClock === undefined ? null : options.wallClock()),
  };

  const profileDocument = (kernel: Kernel): SaveDocument => ({
    version: saveVersion, scene: '', seed: null, entities: {}, ...documentResources(kernel.saveResources(['profile'])),
  });

  // A stored profile this build can't read (written by an older build of the game, with no
  // migration for it) must not stop the game from starting: it is set aside under
  // UNREADABLE_PROFILE_KEY and the game starts with a fresh profile.
  const loadProfile = (kernel: Kernel): void => {
    const text = store.get(PROFILE_KEY);
    if (text === undefined) return;
    const where = 'The saved profile';
    try {
      const save = service.migrate(parseStored(text, where, 'Clear this game\'s site data to start a fresh profile.'), where);
      kernel.loadResources(resourceSave(save, where));
    } catch (error) {
      if (!(error instanceof ParallaxError)) throw error;
      store.set(UNREADABLE_PROFILE_KEY, text);
      store.delete(PROFILE_KEY);
    }
    written = stringify(profileDocument(kernel));
  };

  return {
    id: 'persistence',
    install(kernel) {
      if (installed !== undefined) {
        fail('PP3950', 'This persistence plugin is already installed in another kernel', { fix: 'Build one per game (createRuntime does).' });
      }
      installed = kernel;
      kernel.provide(PERSISTENCE_SERVICE, service);
      loadProfile(kernel);
      kernel.addHook('render', () => {
        const text = stringify(profileDocument(kernel));
        if (text === written) return;
        store.set(PROFILE_KEY, text);
        written = text;
      });
    },
  };
}
