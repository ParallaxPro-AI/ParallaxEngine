/**
 * spawning — wave spawners (sdk/parallax/spawning.pyi). A `Spawner` runs its `waves` in
 * order: each waits `delay`, then spawns one choice every `interval` seconds — `count` of
 * them, or until its `budget` (sum of choices' `cost`) can't pay for any choice — never
 * more than `max_alive` alive at once. A wave is cleared when everything it spawned is
 * gone; the next starts `between_waves` later (`loop` restarts from the first). Spawns go
 * to `points` in turn (local offsets), else a random point in the `area` box (local
 * half-extents); choices are drawn by `weight`. Events: wave_started, wave_cleared,
 * spawner_done.
 *
 * The plugin keeps its own seeded random stream (reseeded on every scene load from the
 * load's seed, saved in snapshots), so game rolls don't shift spawns and replays and
 * playtests spawn the same. Every counter is on the component, so spawners save and
 * replay. The `spawning.upkeep` system runs before the game's systems, on frame time.
 *
 * One `spawning()` value serves one kernel.
 */

import { fail, hashNumbers, SeededRandom, Vec3 } from '../../../core/index.js';
import type { EntityId, RandomState } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, EventDef, Fields, FieldType, Kernel, KernelPlugin, Schema, SystemDef } from '../../kernel/index.js';

export const SPAWNER = 'spawner';

export const SPAWNING_EVENTS = {
  waveStarted: { id: 'wave_started', target: 'entity' },
  waveCleared: { id: 'wave_cleared', target: 'entity' },
  spawnerDone: { id: 'spawner_done', target: 'entity' },
} as const satisfies Record<string, EventDef>;

const record = (fields: Schema): FieldType => ({ kind: 'record', fields });

export const SPAWN_CHOICE_RECORD: Schema = {
  prefab: t.ref('prefab'),
  weight: t.number({ default: 1, min: 0 }),
  cost: t.number({ default: 1, min: 0 }),
};

export const WAVE_RECORD: Schema = {
  count: t.int({ default: 0, min: 0 }),
  budget: t.number({ default: 0, min: 0 }),
  interval: t.number({ default: 0.5, min: 0 }),
  delay: t.number({ default: 0, min: 0 }),
};

export const SPAWNER_PHASES = ['idle', 'delay', 'spawning', 'clearing', 'done'] as const;

export const SPAWNER_SCHEMA: Schema = {
  prefabs: t.list(record(SPAWN_CHOICE_RECORD)),
  waves: t.list(record(WAVE_RECORD)),
  max_alive: t.int({ default: 10, min: 1 }),
  area: t.vec3({ default: Vec3.ZERO }),
  points: t.list({ kind: 'vec3' }, { default: [] }),
  auto_start: t.bool({ default: true }),
  loop: t.bool({ default: false }),
  between_waves: t.number({ default: 2, min: 0 }),
  // Kept by the engine:
  phase: t.enum(SPAWNER_PHASES, { default: 'idle' }),
  wave: t.int({ default: -1, min: -1 }),
  spawned: t.int({ default: 0, min: 0 }),
  spent: t.number({ default: 0, min: 0 }),
  next_at: t.number({ default: 0 }),
  alive: t.list({ kind: 'entity' }, { default: [] }),
};

export interface SpawningSnapshot {
  readonly random: RandomState;
}

interface Choice {
  readonly prefab: string;
  readonly weight: number;
  readonly cost: number;
}

interface WaveData {
  readonly count: number;
  readonly budget: number;
  readonly interval: number;
  readonly delay: number;
}

// ── Readers ────────────────────────────────────────────────────────────────────

/** The id of a PrefabRef (an object with `id`), or a bare id string. */
function idOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id;
  return null;
}

/** A list field as an array (pyrt lists are arrays; tuples and iterables are spread). */
function listOf<T>(value: unknown): readonly T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'object' && Symbol.iterator in value) return [...(value as Iterable<T>)];
  return [];
}

function attr(data: unknown, name: string): unknown {
  if (typeof data !== 'object' || data === null) return undefined;
  return (data as Record<string, unknown>)[name];
}

function num(data: unknown, name: string, fallback: number): number {
  const v = attr(data, name);
  return typeof v === 'number' ? v : fallback;
}

/** Component methods take no arguments; a stray positional or keyword is a binding error. */
function noArgs(name: string, args: readonly unknown[]): void {
  if (args.length === 0) return;
  const last = args[args.length - 1];
  const keywords = typeof last === 'object' && last !== null && !Array.isArray(last)
    ? (Object.getPrototypeOf(last) === Object.prototype ? last : (last as { values?: unknown }).values) : undefined;
  if (args.length === 1 && typeof keywords === 'object' && keywords !== null && Object.keys(keywords).length === 0) return;
  fail('PP3030', `${name}() takes no arguments`, { fix: 'Remove the arguments.' });
}

// ── The engine ─────────────────────────────────────────────────────────────────

export class Spawning {
  #kernel: Kernel | undefined;
  random = new SeededRandom(0);

  get kernel(): Kernel {
    return this.#kernel ?? fail('PP7790', 'The spawning plugin is used before its kernel was built');
  }

  bind(kernel: Kernel): void {
    if (this.#kernel !== undefined) {
      fail('PP7791', 'This spawning plugin is already installed in another kernel', { fix: 'Call spawning() once per kernel.' });
    }
    this.#kernel = kernel;
  }

  reseed(seed: number): void {
    this.random = new SeededRandom(hashNumbers(seed, 0x5a0)); // Its own stream: game rolls don't shift spawns.
  }

  snapshot(): SpawningSnapshot {
    return { random: this.random.state() };
  }

  restore(saved: SpawningSnapshot): void {
    this.random.restore(saved.random);
  }

  #wrap(id: EntityId): unknown {
    return this.kernel.handles.wrap(id);
  }

  #where(id: EntityId): string {
    const r = this.kernel.world.peek(id);
    return `entity ${r?.placedId ?? r?.prefab ?? id} ${SPAWNER}`;
  }

  #choices(sp: Fields): Choice[] {
    return listOf<unknown>(sp['prefabs']).map((c) => ({ prefab: idOf(attr(c, 'prefab'))!, weight: num(c, 'weight', 1), cost: num(c, 'cost', 1) }));
  }

  #wave(id: EntityId, sp: Fields, index: number): WaveData {
    const w = listOf<unknown>(sp['waves'])[index];
    const wave = { count: num(w, 'count', 0), budget: num(w, 'budget', 0), interval: num(w, 'interval', 0.5), delay: num(w, 'delay', 0) };
    if (wave.count === 0 && wave.budget === 0) {
      fail('PP7700', `${this.#where(id)} waves[${index}] has neither a count nor a budget`, { fix: 'Give the wave "count": N or "budget": points.' });
    }
    return wave;
  }

  /** Live entities a spawner spawned, as ids (handles of destroyed ones dropped). */
  #alive(sp: Fields): EntityId[] {
    const kernel = this.kernel;
    return listOf<unknown>(sp['alive']).map((h) => kernel.handles.unwrap(h)).filter((x): x is EntityId => x !== undefined && kernel.world.isAlive(x));
  }

  start(id: EntityId, sp: Fields): void {
    if (listOf<unknown>(sp['waves']).length === 0) fail('PP7700', `${this.#where(id)} has no waves`, { fix: 'Add "waves": [{"count": 5}].' });
    sp['wave'] = 0;
    sp['phase'] = 'delay';
    sp['next_at'] = this.kernel.time.now + this.#wave(id, sp, 0).delay;
  }

  stop(sp: Fields): void {
    sp['phase'] = 'done';
  }

  aliveCount(sp: Fields): number {
    return this.#alive(sp).length;
  }

  #pick(choices: readonly Choice[]): Choice | undefined {
    const total = choices.reduce((sum, c) => sum + c.weight, 0);
    if (total <= 0) return undefined;
    let pick = this.random.next() * total;
    let last: Choice | undefined;
    for (const c of choices) {
      if (c.weight <= 0) continue;
      last = c;
      pick -= c.weight;
      if (pick < 0) return c;
    }
    return last;
  }

  #spawnOne(record: EntityRecord, sp: Fields, choice: Choice): void {
    const points = listOf<Vec3>(sp['points']);
    const spawned = sp['spawned'] as number;
    let local: Vec3;
    if (points.length > 0) local = points[spawned % points.length]!;
    else {
      const area = sp['area'] as Vec3;
      const r = this.random;
      local = new Vec3((r.next() * 2 - 1) * area.x, (r.next() * 2 - 1) * area.y, (r.next() * 2 - 1) * area.z);
    }
    const at = record.transform.toWorld(local);
    const child = this.kernel.spawn(choice.prefab, { at: [at.x, at.y, at.z] });
    sp['alive'] = [...listOf<unknown>(sp['alive']), this.kernel.handles.wrap(child.id)];
    sp['spawned'] = spawned + 1;
    sp['spent'] = (sp['spent'] as number) + choice.cost;
  }

  tick(): void {
    const kernel = this.kernel;
    const now = kernel.time.now;
    for (const row of kernel.world.query([SPAWNER])) {
      const id = row[0];
      const sp = row[1]!;
      const record = kernel.world.get(id)!;
      const alive = this.#alive(sp);
      if (alive.length !== listOf<unknown>(sp['alive']).length) sp['alive'] = alive.map((a) => kernel.handles.wrap(a));
      if (sp['phase'] === 'idle') {
        if (sp['auto_start'] === true) this.start(id, sp);
        else continue;
      }
      const index = sp['wave'] as number;
      if (sp['phase'] === 'delay' && now >= (sp['next_at'] as number)) {
        sp['phase'] = 'spawning';
        sp['spawned'] = 0;
        sp['spent'] = 0;
        kernel.emit(SPAWNING_EVENTS.waveStarted, { entity: this.#wrap(id), wave: index });
      }
      if (sp['phase'] === 'spawning') {
        const wave = this.#wave(id, sp, index);
        const choices = this.#choices(sp);
        while (now >= (sp['next_at'] as number)) {
          const done = wave.count > 0 ? (sp['spawned'] as number) >= wave.count : false;
          const affordable = wave.count > 0 ? choices : choices.filter((c) => c.cost <= wave.budget - (sp['spent'] as number));
          if (done || affordable.length === 0) {
            sp['phase'] = 'clearing';
            break;
          }
          if (this.#alive(sp).length >= (sp['max_alive'] as number)) break;
          const choice = this.#pick(affordable);
          if (choice === undefined) {
            sp['phase'] = 'clearing';
            break;
          }
          this.#spawnOne(record, sp, choice);
          sp['next_at'] = Math.max(sp['next_at'] as number, now - wave.interval) + wave.interval;
          if (wave.interval === 0 && (sp['spawned'] as number) > 10_000) {
            fail('PP7701', `${this.#where(id)} wave ${index} spawned over 10000 at once`, { fix: 'Give its choices a cost above 0, or the wave a count.' });
          }
        }
      }
      if (sp['phase'] === 'clearing' && this.#alive(sp).length === 0) {
        kernel.emit(SPAWNING_EVENTS.waveCleared, { entity: this.#wrap(id), wave: index });
        const waves = listOf<unknown>(sp['waves']).length;
        const next = index + 1 < waves ? index + 1 : sp['loop'] === true ? 0 : -1;
        if (next < 0) {
          sp['phase'] = 'done';
          kernel.emit(SPAWNING_EVENTS.spawnerDone, { entity: this.#wrap(id) });
        } else {
          sp['wave'] = next;
          sp['phase'] = 'delay';
          sp['next_at'] = now + (sp['between_waves'] as number) + this.#wave(id, sp, next).delay;
        }
      }
    }
  }

  component(): ComponentDef {
    const engine = this;
    const owner = (fields: unknown): EntityId => componentEntity(fields as Fields);
    const methods = {
      start(this: Fields, ...args: unknown[]): null {
        noArgs('start', args);
        engine.start(owner(this), this);
        return null;
      },
      stop(this: Fields, ...args: unknown[]): null {
        noArgs('stop', args);
        engine.stop(this);
        return null;
      },
    };
    Object.defineProperty(methods, 'entity', { get(this: Fields): unknown { return engine.kernel.handles.wrap(owner(this)); }, enumerable: false });
    Object.defineProperty(methods, 'done', { get(this: Fields): unknown { return this['phase'] === 'done'; }, enumerable: false });
    Object.defineProperty(methods, 'alive_count', { get(this: Fields): unknown { return engine.aliveCount(this); }, enumerable: false });
    return { id: SPAWNER, schema: SPAWNER_SCHEMA, methods };
  }
}

export function spawning(): KernelPlugin {
  const engine = new Spawning();
  const system: SystemDef = {
    id: 'spawning.upkeep',
    scenes: [],
    handlers: [],
    create: () => ({ update: () => engine.tick() }),
  };
  return {
    id: 'spawning',
    components: [engine.component()],
    events: Object.values(SPAWNING_EVENTS),
    systems: [system],
    install(kernel) {
      engine.bind(kernel);
      kernel.observeScenes({ loading: (_scene, request) => engine.reseed(request.seed ?? 0) });
    },
    snapshot: () => engine.snapshot() as unknown as Json,
    restore: (_kernel, saved) => engine.restore(saved as unknown as SpawningSnapshot),
  };
}
