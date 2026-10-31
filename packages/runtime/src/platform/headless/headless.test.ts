import { describe, expect, it } from 'vitest';
import { ManualClock } from './manual_clock.js';
import { MemoryStore } from './memory_store.js';

describe('ManualClock', () => {
  it('moves only when advanced, never backwards', () => {
    const clock = new ManualClock();
    expect(clock.now()).toBe(0);
    clock.advance(0.5);
    expect(clock.now()).toBe(0.5);
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });
});

describe('MemoryStore', () => {
  it('stores, lists and deletes', () => {
    const store = new MemoryStore();
    store.set('best', '12');
    expect(store.get('best')).toBe('12');
    expect(store.keys()).toEqual(['best']);
    store.delete('best');
    expect(store.get('best')).toBeUndefined();
  });
});
