/** The pure parts: collection rules, frame counts, traceback mapping. */

import { describe, expect, it } from 'vitest';
import { collect, definitionOrder, isTestModule } from './discover.js';
import { FRAME, framesFor } from './harness.js';
import { playtest } from './sdk.js';
import { decodeLines, formatFrames, projectFrames, traceback } from './traceback.js';

describe('collection', () => {
  it('collects test_*.py anywhere under tests/, nothing else', () => {
    expect(['tests/test_a.py', 'tests/sub/test_b.py', 'tests/helpers.py', 'game/test_x.py', 'tests/test_c.pyi'].filter(isTestModule))
      .toEqual(['tests/test_a.py', 'tests/sub/test_b.py']);
  });

  it('orders by definition, playtests and plain tests together; skips helpers, classes and imports', () => {
    const python = [
      'from x import helper',
      'class test_not_a_test: ...',
      'async def test_late_name(game): ...',
      'def test_plain(): ...',
      '@playtest("second")',
      'async def a_playtest(game): ...',
      'def helper_fn(): ...',
    ].join('\n');
    const exports = {
      helper: () => null,
      test_not_a_test: class {},
      a_playtest: playtest('second')(function* a() { /* compiled async def */ }),
      test_plain: () => null,
      test_late_name: playtest('first')(function* b() { /* compiled async def */ }),
      helper_fn: () => null,
    };
    expect(collect(exports, python)).toEqual([
      { name: 'test_late_name', title: 'first', kind: 'playtest' },
      { name: 'test_plain', title: 'test_plain', kind: 'test' },
      { name: 'a_playtest', title: 'second', kind: 'playtest' },
    ]);
    expect([...definitionOrder(python).keys()]).toEqual(['test_late_name', 'test_plain', 'a_playtest', 'helper_fn']);
  });

  it('@playtest needs one non-empty name', () => {
    expect(() => playtest()).toThrow(/PP3450/);
    expect(() => playtest('')).toThrow(/PP3450/);
  });
});

describe('frames', () => {
  it('rounds seconds up to whole fixed steps, ignoring float noise', () => {
    expect(FRAME).toBe(1 / 60);
    expect(framesFor(1.5)).toBe(90);
    expect(framesFor(0.35)).toBe(21);
    expect(framesFor(0.01)).toBe(1);
    expect(framesFor(0)).toBe(0);
  });
});

describe('tracebacks', () => {
  const build = 'file:///tmp/b/';
  // game/s.js line 2 ← game/s.py line 3 (a v3 map: AAEA = col 0, source 0, line +2, col 0);
  // tests/test_x.js has no map, so its frames keep the compiled line.
  const map = JSON.stringify({ version: 3, sources: ['../../p/game/s.py'], sourcesContent: ['a = 1\n\nraise_it()\n'], mappings: ';AAEA' });
  const files: Record<string, string> = { 'game/s.js': 'line one\n  raise_it();\n', 'game/s.js.map': map };
  const context = {
    build,
    project: '/tmp/p/',
    sources: { 'tests/test_x.js': 'tests/test_x.py', 'game/s.js': 'game/s.py' },
    read: (output: string) => files[output],
  };
  const stack = [
    'ValueError: boom',
    '    at Object.update (file:///tmp/b/game/s.js?realm=4:2:5)',
    '    at Kernel.step (file:///engine/kernel.ts:10:1)',
    '    at file:///tmp/b/tests/test_x.js?realm=4:9:3',
  ].join('\n');

  it('decodes v3 mappings to the source line of each generated line', () => {
    expect(decodeLines(';AAEA;;AACA,EAAE;AADA')).toEqual([0, 3, 0, 4, 3]);
  });

  it('maps compiled frames to the .py line through the source map, quoting the .py line', () => {
    expect(projectFrames(stack, context)).toEqual([
      { source: 'game/s.py', line: 3, compiled: 'game/s.js', compiledLine: 2, column: 5, code: 'raise_it()' },
      { source: 'tests/test_x.py', compiled: 'tests/test_x.js', compiledLine: 9, column: 3 },
    ]);
  });

  it('takes frames V8 already source-mapped (absolute .py paths under the project)', () => {
    const mapped = 'ValueError: boom\n    at Object.update (/tmp/p/game/s.py:3:1)\n    at /elsewhere/x.py:1:1';
    expect(projectFrames(mapped, context)).toEqual([
      { source: 'game/s.py', line: 3, compiled: 'game/s.js', column: 1, code: 'raise_it()' },
    ]);
    expect(formatFrames(projectFrames(mapped, context), '')).toEqual(['game/s.py:3', '  raise_it()']);
  });

  it('puts the harness call site first, outermost call first', () => {
    const site = 'Error\n    at new Command (file:///pkg/harness.ts:1:1)\n    at file:///tmp/b/tests/test_x.js?realm=4:7:1';
    expect(traceback(stack, site, context).map((f) => `${f.source}:${f.line ?? `js${f.compiledLine}`}`))
      .toEqual(['tests/test_x.py:js7', 'tests/test_x.py:js9', 'game/s.py:3']);
  });
});
