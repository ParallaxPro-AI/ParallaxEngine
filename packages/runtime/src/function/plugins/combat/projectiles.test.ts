/**
 * Projectiles (`ctx.combat.fire`) on a bare kernel without physics: ballistic arcs and
 * pooling, homing onto a target through the damage pipeline, pierce, and sides — a shot
 * flies through its source's allies unless it has `friendly_fire`.
 */

import { describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields, SystemDef } from '../../kernel/index.js';
import { combat, COMBAT_EVENTS, PROJECTILE_EVENTS, turnTowards } from './index.js';
import type { CombatNamespace, StatusEffectRef } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

class TestTag {
  constructor(readonly id: string) {}
  get __tag_id__(): string { return this.id; }
  __eq__(o: unknown): boolean { return o instanceof TestTag && o.id === this.id; }
  toJSON(): string { return this.id; }
}
const tags = new Map<string, TestTag>();
const tag = (id: string): TestTag => {
  let found = tags.get(id);
  if (found === undefined) tags.set(id, found = new TestTag(id));
  return found;
};

function rig(entities: unknown[], prefabs: Record<string, unknown>) {
  const heard: string[] = [];
  const damage: Array<{ target: string; amount: number; kind: unknown }> = [];
  let kernelRef: Kernel | undefined;
  const placed = (v: unknown): string => kernelRef!.world.peek(kernelRef!.handles.unwrap(v) ?? (v as EntityId))?.placedId ?? `#${String(v)}`;
  const listener: SystemDef = {
    id: 'listen', scenes: [],
    handlers: [
      { event: COMBAT_EVENTS.damaged, method: 'damaged' },
      { event: PROJECTILE_EVENTS.projectileHit, method: 'hit' },
      { event: PROJECTILE_EVENTS.projectileExpired, method: 'expired' },
    ],
    create: () => ({
      damaged: (_ctx: unknown, e: Fields) => {
        const kind = e['kind'] as TestTag | null;
        damage.push({ target: placed(e['entity']), amount: e['amount'] as number, kind: kind === null ? null : kind.id });
      },
      hit: (_ctx: unknown, e: Fields) => { heard.push(`projectile_hit target=${e['target'] === null ? 'scenery' : placed(e['target'])}`); },
      expired: (_ctx: unknown, e: Fields) => { heard.push(`projectile_expired #${String(kernelRef!.handles.unwrap(e['entity']))}`); },
    }),
  };
  const project = loadProject(files({
    'prefabs/thing.prefab.json': { components: {} },
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const noEffect = (): StatusEffectRef => { throw new Error('no status effects here'); };
  const plugin = combat({ host: { tag, effect: noEffect } });
  const kernel = new Kernel({ project, game: { components: [], events: [], behaviors: [], systems: [listener], resources: [] }, plugins: [plugin] });
  kernelRef = kernel;
  kernel.start('main', { seed: 1 });
  const ns = plugin.namespace!.create(kernel) as CombatNamespace;
  const id = (name: string): EntityId => kernel.world.query([]).find(([x]) => kernel.world.get(x)?.placedId === name)![0];
  return {
    kernel, heard, damage, id,
    fire: (prefab: string, kw: Record<string, unknown>): EntityId => kernel.handles.unwrap(ns.fire(prefab, kw))!,
    step(frames = 1) { for (let i = 0; i < frames; i++) kernel.step(DT); },
  };
}

const PREFABS = {
  arrow: { components: { projectile: { motion: 'ballistic', speed: 10, lifetime: 1 } } },
  missile: { components: { projectile: { motion: 'homing', speed: 10, turn_rate: 360, damage: 25, damage_kind: 'fire', lifetime: 5 } } },
  bolt: { components: { projectile: { speed: 30, damage: 5, pierce: 1, lifetime: 2 } } },
  shot: { components: { projectile: { speed: 30, damage: 5, lifetime: 2 } } },
  friendly_shot: { components: { projectile: { speed: 30, damage: 5, lifetime: 2, friendly_fire: true } } },
};

describe('projectiles', () => {
  it('ballistic projectiles follow the arc and are pooled: a retired one is reused by the next shot', () => {
    const r = rig([], PREFABS);
    const arrow = r.fire('arrow', { at: new Vec3(0, 0, -5), direction: new Vec3(1, 0, 0) });
    r.step(30);
    const pos = r.kernel.world.get(arrow)!.transform.position;
    expect(pos.x).toBeCloseTo(5, 5);
    // Semi-implicit Euler: y = g·dt²·n(n+1)/2.
    expect(pos.y).toBeCloseTo(-9.8 * DT * DT * 30 * 31 / 2, 5);
    r.step(31);
    expect(r.heard).toContain(`projectile_expired #${arrow}`);
    expect(r.kernel.world.get(arrow)!.visible).toBe(false);
    const again = r.fire('arrow', { at: new Vec3(0, 0, -5), direction: new Vec3(1, 0, 0) });
    expect(again).toBe(arrow);
    expect(r.kernel.world.get(arrow)!.visible).toBe(true);
    const second = r.fire('arrow', { at: new Vec3(0, 0, -5), direction: new Vec3(1, 0, 0) });
    expect(second).not.toBe(arrow);
  });

  it('homing projectiles turn onto their target and hurt it through the damage pipeline', () => {
    const r = rig([
      { prefab: 'thing', id: 'shooter', at: [0, 0, 0] },
      { prefab: 'thing', id: 'dummy', at: [0, 0, 10], components: { health: {} } },
    ], PREFABS);
    r.fire('missile', { at: new Vec3(0, 0, 0), direction: new Vec3(1, 0, 0), source: r.id('shooter'), target: r.id('dummy') });
    r.step(120);
    expect(r.damage).toEqual([{ target: 'dummy', amount: 25, kind: 'fire' }]);
    expect(r.heard).toContain('projectile_hit target=dummy');
  });

  it('pierce lets a projectile pass through targets', () => {
    const r = rig([
      { prefab: 'thing', id: 'a', at: [0, 0, 5], components: { health: {} } },
      { prefab: 'thing', id: 'b', at: [0, 0, 10], components: { health: {} } },
      { prefab: 'thing', id: 'c', at: [0, 0, 15], components: { health: {} } },
    ], PREFABS);
    r.fire('bolt', { at: new Vec3(0, 0, 0), direction: new Vec3(0, 0, 1) });
    r.step(60);
    expect(r.damage.map((d) => d.target)).toEqual(['a', 'b']);
  });

  it('flies through its source\'s side unless friendly_fire, like area_damage', () => {
    const line = [
      { prefab: 'thing', id: 'shooter', at: [0, 0, 0], components: { health: {}, side: { side: 'blue' } } },
      { prefab: 'thing', id: 'ally', at: [0, 0, 5], components: { health: {}, side: { side: 'blue' } } },
      { prefab: 'thing', id: 'enemy', at: [0, 0, 10], components: { health: {}, side: { side: 'red' } } },
    ];
    const r = rig(line, PREFABS);
    r.fire('shot', { at: new Vec3(0, 0, 0), direction: new Vec3(0, 0, 1), source: r.id('shooter') });
    r.step(60);
    expect(r.damage.map((d) => d.target)).toEqual(['enemy']);

    const ff = rig(line, PREFABS);
    ff.fire('friendly_shot', { at: new Vec3(0, 0, 0), direction: new Vec3(0, 0, 1), source: ff.id('shooter') });
    ff.step(60);
    expect(ff.damage.map((d) => d.target)).toEqual(['ally']);
  });

  it('turnTowards turns by at most the given angle', () => {
    const v = turnTowards(new Vec3(1, 0, 0), new Vec3(0, 0, 1), 30);
    expect(v.length()).toBeCloseTo(1);
    expect(Math.atan2(v.z, v.x) * 180 / Math.PI).toBeCloseTo(30);
    expect(turnTowards(new Vec3(2, 0, 0), new Vec3(0, 0, 1), 120).is_close(new Vec3(0, 0, 2))).toBe(true);
  });
});
