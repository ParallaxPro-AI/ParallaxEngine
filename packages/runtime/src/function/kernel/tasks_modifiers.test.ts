import { describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../../core/index.js';
import { loadProject } from '../../resource/index.js';
import type { EventDef, GameDefinition } from './definitions.js';
import { Kernel } from './kernel.js';
import { t } from './schema.js';
import { waits } from './tasks.js';
import type { TaskBody } from './tasks.js';

const STEP = 1 / 60;

const STATS = {
  id: 'stats',
  schema: {
    speed: t.number({ default: 4, min: 0, modifiable: true }),
    damage: t.int({ default: 10, modifiable: true }),
    armor: t.number({ default: 0, max: 0.8, modifiable: true }),
    name: t.string({ default: 'hero' }),
  },
};
const GAME_OWNER = { kind: 'game' } as const;

function start(def: Partial<GameDefinition> = {}): Kernel {
  const contents: Record<string, string> = {
    'prefabs/hero.prefab.json': JSON.stringify({ components: { stats: {} } }),
    'scenes/main/scene.json': JSON.stringify({ entities: [{ prefab: 'hero' }] }),
  };
  const files: ProjectFiles = { list: () => Object.keys(contents).sort(), read: (p) => contents[p]! };
  const kernel = new Kernel({
    project: loadProject(files),
    game: { components: [STATS], resources: [], events: [], behaviors: [], systems: [], ...def },
  });
  kernel.start('main');
  return kernel;
}

describe('tasks', () => {
  it('run to their first wait immediately, then resume when it is satisfied', () => {
    const k = start();
    const log: string[] = [];
    k.run(GAME_OWNER, (function* (): TaskBody {
      log.push(`begin@${k.time.frame}`);
      yield waits.seconds(0.05);
      log.push(`after seconds@${k.time.frame}`);
      yield waits.frames(2);
      log.push(`after frames@${k.time.frame}`);
    })());
    expect(log).toEqual(['begin@0']);
    for (let i = 0; i < 6; i++) k.step(STEP);
    expect(log).toEqual(['begin@0', 'after seconds@3', 'after frames@5']);
  });

  it('wait for events (with a filter) and receive the payload', () => {
    const Scored: EventDef = { id: 'scored' };
    const k = start({ events: [Scored] });
    const got: unknown[] = [];
    k.run(GAME_OWNER, (function* (): TaskBody {
      got.push(yield waits.event(Scored, (e) => (e['points'] as number) >= 10));
    })());
    k.emit(Scored, { points: 3 });
    k.step(STEP);
    expect(got).toEqual([]);
    k.emit(Scored, { points: 12 });
    k.step(STEP);
    k.step(STEP);
    expect(got).toEqual([{ points: 12 }]);
  });

  it('wait on other handles: all, and any with the index of the first', () => {
    const k = start();
    const log: unknown[] = [];
    const short = k.after(GAME_OWNER, 0.02, () => {});
    const long = k.after(GAME_OWNER, 0.1, () => {});
    k.run(GAME_OWNER, (function* (): TaskBody {
      log.push(['any', yield waits.any(long, short)]);
      yield waits.all(short, long);
      log.push(['all', k.time.frame]);
    })());
    for (let i = 0; i < 8; i++) k.step(STEP);
    expect(log).toEqual([['any', 1], ['all', 6]]);
  });

  it('end with their owner and pause while frozen', () => {
    const k = start();
    const hero = [...k.world.live()][0]!;
    const log: string[] = [];
    let ticks = 0;
    k.run({ kind: 'entity', id: hero.id }, (function* (): TaskBody {
      yield waits.seconds(1);
      log.push('should never run');
    })());
    k.run(GAME_OWNER, (function* (): TaskBody {
      for (;;) {
        yield waits.frames(1);
        ticks++;
      }
    })());
    k.destroy(hero.id);
    k.setFrozen(true);
    for (let i = 0; i < 3; i++) k.step(STEP);
    expect(ticks).toBe(0);
    k.setFrozen(false);
    for (let i = 0; i < 120; i++) k.step(STEP);
    expect(log).toEqual([]);
    expect(ticks).toBeGreaterThan(100);
  });

  it('resume in start order and can be cancelled', () => {
    const k = start();
    const log: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const handle = k.run(GAME_OWNER, (function* (): TaskBody {
        yield waits.frames(1);
        log.push(name);
      })());
      if (name === 'b') handle.cancel();
    }
    k.step(STEP);
    k.step(STEP);
    expect(log).toEqual(['a', 'c']);
  });
});

describe('modifiers', () => {
  const RUN = { id: 'run', schema: { multiplier: t.number({ default: 1, modifiable: true }) } };

  function hero(): [Kernel, ReturnType<Kernel['world']['live']> extends Iterable<infer R> ? R : never] {
    const k = start({ resources: [RUN] });
    return [k, [...k.world.live()][0]!];
  }

  it('read as the effective value; assigning sets the base, immediately', () => {
    const [k, e] = hero();
    const stats = e.components.get('stats')!;
    k.modify(e.id, 'stats', 'speed', { multiply: 1.5, key: 'haste' });
    expect(stats['speed']).toBe(6);
    stats['speed'] = 10;
    expect(stats['speed']).toBe(15);
    expect(k.base(e.id, 'stats', 'speed')).toBe(10);
  });

  it('replace by key per field; one key may span fields; unmodify removes it everywhere', () => {
    const [k, e] = hero();
    const stats = e.components.get('stats')!;
    k.modify(e.id, 'stats', 'speed', { add: 1, key: 'boots' });
    k.modify(e.id, 'stats', 'speed', { add: 2, key: 'boots' });
    k.modify(e.id, 'stats', 'damage', { add: 5, key: 'boots' });
    expect([stats['speed'], stats['damage']]).toEqual([6, 15]);
    k.unmodify(e.id, 'boots');
    expect([stats['speed'], stats['damage']]).toEqual([4, 10]);
  });

  it('stack permanent upgrades, expire timed ones, clamp and round', () => {
    const [k, e] = hero();
    const stats = e.components.get('stats')!;
    k.modify(e.id, 'stats', 'damage', { add: 1.4, stack: true });
    k.modify(e.id, 'stats', 'damage', { add: 1.4, stack: true });
    expect(stats['damage']).toBe(13);
    k.modify(e.id, 'stats', 'armor', { add: 2, key: 'shield' });
    expect(stats['armor']).toBe(0.8);
    k.modify(e.id, 'stats', 'speed', { multiply: 0, key: 'stun', seconds: 0.05 });
    expect(stats['speed']).toBe(0);
    for (let i = 0; i < 4; i++) k.step(STEP);
    expect(stats['speed']).toBe(4);
  });

  it('refuse fields that are not modifiable, and keyless non-stacking modifiers', () => {
    const [k, e] = hero();
    expect(() => k.modify(e.id, 'stats', 'name', { add: 1, key: 'x' })).toThrow(/PP4106/);
    expect(() => k.modify(e.id, 'stats', 'speed', { add: 1 })).toThrow(/PP4107/);
    expect(() => k.modify(e.id, 'missing', 'speed', { add: 1, key: 'x' })).toThrow(/PP3001/);
  });

  it('work on resources too', () => {
    const [k] = hero();
    k.modifyResource('run', 'multiplier', { multiply: 2, key: 'frenzy' });
    expect(k.resource('run')['multiplier']).toBe(2);
    k.unmodifyResource('run', 'frenzy');
    expect(k.resource('run')['multiplier']).toBe(1);
    expect(k.resourceBase('run', 'multiplier')).toBe(1);
  });
});
