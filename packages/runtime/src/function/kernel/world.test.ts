import { describe, expect, it } from 'vitest';
import type { Fields } from './schema.js';
import { newRecord, World } from './world.js';

const f = (n: number): Fields => ({ n }) as Fields;

describe('World.query (per-component index)', () => {
  it('rows stay in spawn order when a component is added to an older entity later', () => {
    const world = new World();
    const a = world.create();
    const b = world.create();
    const c = world.create();
    c.components.set('hp', f(3));
    a.components.set('hp', f(1));
    b.components.set('hp', f(2));
    expect(world.query(['hp']).map(([id]) => id)).toEqual([a.id, b.id, c.id]);
  });

  it('follows removed components, destroyed and torn-down entities, and reused ids', () => {
    const world = new World();
    const a = world.create();
    const b = world.create();
    a.components.set('hp', f(1)).set('armor', f(1));
    b.components.set('hp', f(2));
    expect(world.query(['hp', 'armor']).map(([id]) => id)).toEqual([a.id]);
    a.components.delete('armor');
    expect(world.query(['armor'])).toEqual([]);
    world.destroy(a.id);
    expect(world.query(['hp']).map(([id]) => id)).toEqual([b.id]);
    world.remove(world.takeDoomed());
    const c = world.create();
    c.components.set('hp', f(3));
    expect(world.query(['hp']).map(([id]) => id)).toEqual([b.id, c.id]);
    b.components.clear();
    expect(world.query(['hp']).map(([id]) => id)).toEqual([c.id]);
  });

  it('keeps tag filters and the rows the full scan gave', () => {
    const world = new World();
    const rows = Array.from({ length: 50 }, (_, i) => {
      const r = world.create();
      if (i % 3 === 0) r.components.set('hp', f(i));
      if (i % 2 === 0) r.tags.add('even');
      return r;
    });
    const expected = rows.filter((_, i) => i % 3 === 0 && i % 2 === 0).map((r) => [r.id, r.components.get('hp')]);
    expect(world.query(['hp'], { tagged: ['even'] })).toEqual(expected);
    expect(world.query(['hp'], { without: ['even'] })).toHaveLength(rows.filter((_, i) => i % 3 === 0 && i % 2 !== 0).length);
  });

  it('a snapshot replace indexes the restored records', () => {
    const world = new World();
    const a = world.create();
    a.components.set('hp', f(1));
    const ids = world.idState();
    const restored = newRecord(a.id);
    restored.components.set('hp', f(9));
    world.replace(ids, [restored]);
    expect(world.query(['hp'])).toEqual([[a.id, f(9)]]);
    a.components.set('armor', f(1));
    expect(world.query(['armor'])).toEqual([]);
  });
});
