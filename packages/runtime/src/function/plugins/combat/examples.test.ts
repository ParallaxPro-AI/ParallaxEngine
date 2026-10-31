/**
 * The example games' combat data, through the real combat plugin: every scene of the
 * games that list `combat()` loads, every prefab with combat components decodes, every
 * status_effect content entry applies, and tower siege's armor/venom/chill rules hold on
 * its real invader prefab and effect files (other components get permissive schemas).
 */

import { describe, expect, it } from 'vitest';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { JsonObject, Project } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, ComponentDef, Fields, GameDefinition, Schema } from '../../kernel/index.js';
import { combat } from './index.js';
import type { CombatOptions, DamageModifier, StatusEffectRef } from './index.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const PREFIX = '../../../../../../examples/';
const raw = import.meta.glob('../../../../../../examples/*/**/*.json', { query: '?raw', import: 'default', eager: true });
const COMBAT_GAMES = [
  'tank_battle', 'brick_breaker', 'pirate_sailing', 'auto_runner', 'twin_stick_roguelite', 'horde_survival', 'fighting_game',
  'lane_defense', 'open_world_rpg', 'moba', 'fps_shooter', 'open_world_sandbox', 'bullet_hell', 'voxel_survival',
  'tower_defense',
];
// Plus every component the combat plugin defines (lock_on, strikers, …), so the data's don't get a second definition.
const OURS = new Set(['health', 'health_bar', 'side', 'status_effects', ...(combat({ host: { tag: (id) => id, effect: () => null as never } }).components ?? []).map((c) => c.id)]);
/**
 * Stats the games' status effects modify, declared modifiable as their Python components
 * (husk, invader) and the nav plugin (nav_agent.speed) declare them.
 */
const MODIFIABLE: Record<string, ReadonlyArray<readonly [string, string]>> = {
  lane_defense: [['husk', 'speed']],
  moba: [['nav_agent', 'speed']],
  tower_defense: [['invader', 'speed']],
};

function project(name: string): Project {
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(raw)) {
    if (path.startsWith(`${PREFIX}${name}/`)) files.set(path.slice(PREFIX.length + name.length + 1), text);
  }
  const pf: ProjectFiles = { list: () => [...files.keys()].sort(), read: (p) => files.get(p)! };
  const loaded = loadProject(pf);
  expect(loaded.diagnostics).toEqual([]);
  return loaded;
}

function permissive(p: Project, modifiable: ReadonlyArray<readonly [string, string]> = []): GameDefinition {
  const components = new Map<string, Set<string>>();
  const behaviors = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, id: string, fields: JsonObject): void => {
    const set = map.get(id) ?? new Set<string>();
    for (const key of Object.keys(fields)) set.add(key);
    map.set(id, set);
  };
  const inst = (i: { components: Readonly<Record<string, JsonObject>>; params: Readonly<Record<string, JsonObject>> }): void => {
    for (const [id, f] of Object.entries(i.components)) note(components, id, f);
    for (const [id, f] of Object.entries(i.params)) note(behaviors, id, f);
  };
  for (const prefab of p.prefabs.values()) {
    for (const [id, f] of Object.entries(prefab.components)) note(components, id, f);
    for (const use of prefab.behaviors) note(behaviors, use.use, use.params);
    prefab.children.forEach(inst);
  }
  for (const scene of p.scenes.values()) scene.entities.forEach(inst);
  for (const [id, field] of modifiable) note(components, id, { [field]: 0 });
  const schema = (id: string, fields: Set<string>): Schema => Object.fromEntries([...fields].map((f) => [
    f, modifiable.some(([c, n]) => c === id && n === f)
      ? { type: { kind: 'number' as const }, default: 0, modifiable: true }
      : { type: { kind: 'json' as const }, default: null },
  ]));
  const defs: ComponentDef[] = [...components].filter(([id]) => !OURS.has(id)).map(([id, f]) => ({ id, schema: schema(id, f) }));
  const logic: BehaviorDef[] = [...behaviors].map(([id, f]) => ({
    id, params: schema(id, f), state: {}, requires: [], handlers: [], create: () => ({}),
  }));
  return { components: defs, behaviors: logic, resources: [], events: [], systems: [] };
}

/** Status effect entries as the api presents them: StatusEffectDef defaults filled in. */
function effects(name: string): Map<string, StatusEffectRef> {
  const out = new Map<string, StatusEffectRef>();
  const dir = `${PREFIX}${name}/content/status_effect/`;
  class Ref implements StatusEffectRef {
    constructor(readonly id: string, readonly kind: string, readonly data: unknown) {}
  }
  for (const [path, text] of Object.entries(raw)) {
    if (!path.startsWith(dir)) continue;
    const id = path.slice(dir.length, -'.json'.length);
    const data = JSON.parse(text) as Record<string, unknown>;
    const modifiers = ((data['modifiers'] ?? []) as Array<Record<string, unknown>>).map((m) => ({ multiply: 1, add: 0, ...m }));
    out.set(id, new Ref(id, 'status_effect', {
      damage_per_second: 0, damage_kind: null, tick: 0.5, speed_multiplier: 1, tint: null, stacking: 'refresh', resisted_by: null,
      ...data, modifiers,
    }));
  }
  return out;
}

function kernelFor(name: string, options: Partial<CombatOptions> = {}, game?: GameDefinition): Kernel {
  const p = project(name);
  const refs = effects(name);
  const plugin = combat({ host: { tag: (id) => id, effect: (_k, id) => refs.get(id)! }, ...options });
  return new Kernel({ project: p, game: game ?? permissive(p, MODIFIABLE[name]), plugins: [plugin], fixedStep: 1 / 60 });
}

describe('example combat data', () => {
  it.each(COMBAT_GAMES)('%s: scenes load, combat prefabs decode, status effects apply', (name) => {
    const p = project(name);
    const sceneId = [...p.scenes.keys()].sort()[0]!;
    for (const scene of p.scenes.keys()) {
      const kernel = kernelFor(name);
      kernel.start(scene);
      for (let i = 0; i < 30; i++) kernel.step(1 / 60);
    }
    const kernel = kernelFor(name);
    kernel.start(sceneId);
    const withCombat = [...p.prefabs.values()].filter((prefab) => Object.keys(prefab.components).some((c) => OURS.has(c)));
    for (const prefab of withCombat) {
      const record = kernel.spawn(prefab.id);
      for (const id of OURS) if (id in prefab.components) expect(record.components.has(id)).toBe(true);
      const health = record.components.get('health') as (Fields & { damage(n: number): number; current: number }) | undefined;
      if (health !== undefined) {
        const before = health.current;
        expect(health.damage(1)).toBeLessThanOrEqual(1);
        expect(health.current).toBeLessThanOrEqual(before);
      }
      const fx = record.components.get('status_effects') as (Fields & { apply(r: unknown, s: number): void; has(r: unknown): boolean }) | undefined;
      for (const ref of effects(name).values()) {
        if (fx === undefined) break;
        fx.apply(ref, 1);
        expect(fx.has(ref)).toBe(true);
      }
    }
    for (let i = 0; i < 90; i++) kernel.step(1 / 60);
  });

  it('tower_defense: armor blunts a hit to min_damage 1; venom ticks pierce it; chill keeps the strongest', () => {
    const p = project('tower_defense');
    const venomPierces: DamageModifier = (_ctx, hit) => {
      if (hit.kind === 'poison') hit.ignores_armor = true;
    };
    const refs = effects('tower_defense');
    const kernel = kernelFor('tower_defense', { minDamage: 1, modifiers: [venomPierces] });
    kernel.start([...p.scenes.keys()].sort()[0]!);
    const enemy: EntityId = kernel.spawn('invader', { components: { invader: { speed: 3 } } }).id;
    const components = kernel.world.require(enemy).components;
    const health = components.get('health') as Fields & { damage(n: number): number; current: number; max: number; flat_armor: number };
    const fx = components.get('status_effects') as Fields & { apply(...a: unknown[]): void; strength(r: unknown): number };
    health.flat_armor = 5;
    health.damage(3);
    expect(health.current).toBe(health.max - 1);
    fx.apply(refs.get('venom'), 1, { strength: 12 });
    for (let i = 0; i < 60; i++) kernel.step(1 / 60);
    expect(health.current).toBe(health.max - 1 - 12);

    fx.apply(refs.get('chill'), 2, { strength: 0.65 });
    fx.apply(refs.get('chill'), 2, { strength: 0.5 });
    expect(fx.strength(refs.get('chill'))).toBe(0.65);
    expect(components.get('invader')!['speed']).toBeCloseTo(3 * 0.35);
  });

  it('moba: a timed shield soaks a hit, then runs out', () => {
    const kernel = kernelFor('moba');
    kernel.start([...project('moba').scenes.keys()].sort()[0]!);
    const hero = kernel.spawn('hero').id;
    const health = kernel.world.require(hero).components.get('health') as Fields & {
      add_shield(...a: unknown[]): void; damage(n: number): number; current: number; shield: number;
    };
    health.add_shield(100, { seconds: 2 });
    const before = health.current;
    health.damage(60);
    expect(health.current).toBe(before);
    for (let i = 0; i < 150; i++) kernel.step(1 / 60);
    expect(health.shield).toBe(0);
  });
});
