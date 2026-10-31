/**
 * `parallax.spawning` (sdk/parallax/spawning.pyi): the Spawner handle, its SpawnChoice and
 * Wave records, the wave events, and the `spawning()` factory `parallax.plugins` re-exports.
 * The behavior lives in the spawning plugin; this module is its Python-facing names.
 */

import type { KernelPlugin } from '../function/kernel/index.js';
import { SPAWNER, SPAWNER_SCHEMA, spawning as spawningPlugin, SPAWNING_EVENTS } from '../function/plugins/spawning/index.js';
import { record } from './declarations.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs, kw } from './kwargs.js';
import { field, PrefabRef, rt } from './types.js';

/** Waves of spawns: start / stop; done, alive_count. */
export const Spawner = componentHandle({ id: SPAWNER, schema: SPAWNER_SCHEMA }, 'Spawner');

export const WaveStarted = eventHandle(SPAWNING_EVENTS.waveStarted, 'WaveStarted');
export const WaveCleared = eventHandle(SPAWNING_EVENTS.waveCleared, 'WaveCleared');
export const SpawnerDone = eventHandle(SPAWNING_EVENTS.spawnerDone, 'SpawnerDone');

class SpawnChoiceFields {
  static readonly __annotations__ = { prefab: () => PrefabRef, weight: () => rt.float, cost: () => rt.float };
  static readonly weight = field(1, kw({ min: 0 }));
  static readonly cost = field(1, kw({ min: 0 }));
}
export const SpawnChoice = record(SpawnChoiceFields);

class WaveFields {
  static readonly __annotations__ = { count: () => rt.int, budget: () => rt.float, interval: () => rt.float, delay: () => rt.float };
  static readonly count = field(0, kw({ min: 0 }));
  static readonly budget = field(0, kw({ min: 0 }));
  static readonly interval = field(0.5, kw({ min: 0, unit: 's' }));
  static readonly delay = field(0, kw({ min: 0, unit: 's' }));
}
export const Wave = record(WaveFields);

/** `parallax.plugins.spawning()`. */
export function spawning(...args: unknown[]): KernelPlugin {
  bindArgs('spawning', args, {});
  return spawningPlugin();
}
