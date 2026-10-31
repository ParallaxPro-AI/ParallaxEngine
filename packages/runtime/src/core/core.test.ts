import { describe, expect, it } from 'vitest';
import { diagnostic, formatDiagnostic, ParallaxError } from './diagnostics.js';
import { EntityIdAllocator, generationOf, indexOf } from './entity_ids.js';
import { EventQueue } from './event_queue.js';
import { SeededRandom } from './random.js';

describe('diagnostics', () => {
  it('formats code, location, fix and docs link', () => {
    const d = diagnostic('PP2041', 'Unknown prefab "brik"', {
      path: 'scenes/level_1/scene.json',
      pointer: '/entities/3/prefab',
      fix: 'change "brik" to "brick"',
    });
    expect(formatDiagnostic(d)).toBe([
      'PP2041  Unknown prefab "brik"',
      '  at scenes/level_1/scene.json  (/entities/3/prefab)',
      '  Fix: change "brik" to "brick"',
      '  Docs: https://parallaxpro.ai/docs/engine/errors/PP2041',
    ].join('\n'));
  });

  it('carries the diagnostic on thrown errors', () => {
    const error = new ParallaxError(diagnostic('PP3001', 'Missing Health'));
    expect(error.diagnostic.code).toBe('PP3001');
    expect(error.message).toContain('PP3001');
  });
});

describe('SeededRandom', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    const sequence = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(sequence);
    expect(new SeededRandom(43).next()).not.toBe(sequence[0]);
  });

  it('restores from a saved state', () => {
    const rng = new SeededRandom(7);
    rng.next();
    const saved = rng.state();
    const expected = [rng.next(), rng.next()];
    rng.restore(saved);
    expect([rng.next(), rng.next()]).toEqual(expected);
  });

  it('keeps ints inside the inclusive range', () => {
    const rng = new SeededRandom(1);
    const rolls = Array.from({ length: 500 }, () => rng.int(1, 6));
    expect(Math.min(...rolls)).toBe(1);
    expect(Math.max(...rolls)).toBe(6);
  });
});

describe('EventQueue', () => {
  it('delivers in emission order, cascades after the current batch', () => {
    const queue = new EventQueue<string>();
    const seen: string[] = [];
    queue.emit('a');
    queue.emit('b');
    queue.flush((event) => {
      seen.push(event);
      if (event === 'a') queue.emit('a2');
    });
    expect(seen).toEqual(['a', 'b', 'a2']);
    expect(queue.size).toBe(0);
  });

  it('stops a cascade that never settles with PP3040', () => {
    const queue = new EventQueue<number>();
    queue.emit(0);
    expect(() => queue.flush((n) => queue.emit(n + 1), 8)).toThrow(/PP3040/);
    expect(queue.size).toBe(0);
  });
});

describe('EntityIdAllocator', () => {
  it('never confuses a stale id with the entity that reused its slot', () => {
    const ids = new EntityIdAllocator();
    const first = ids.allocate();
    ids.release(first);
    const second = ids.allocate();
    expect(indexOf(second)).toBe(indexOf(first));
    expect(generationOf(second)).toBe(generationOf(first) + 1);
    expect(ids.isAlive(first)).toBe(false);
    expect(ids.isAlive(second)).toBe(true);
  });

  it('rejects releasing a dead id with PP3002', () => {
    const ids = new EntityIdAllocator();
    const id = ids.allocate();
    ids.release(id);
    expect(() => ids.release(id)).toThrow(/PP3002/);
    expect(ids.count).toBe(0);
  });
});
