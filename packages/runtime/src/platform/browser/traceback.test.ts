import { describe, expect, it } from 'vitest';
import { decodeLines, formatTraceback, pythonTraceback } from './traceback.js';

const BUILD = 'http://127.0.0.1:5180/build/';

// JS line 1 → .py 1, line 2 → .py 2, line 3 unmapped, line 4 → .py 5.
const MAP = JSON.stringify({ version: 3, sources: ['../../game/paddle.py'], mappings: 'AAAA;AACA;;AAGA' });

const sources = {
  build: BUILD,
  sources: { 'game/paddle.js': 'game/behaviors/paddle.py', 'game/main.js': 'game/main.py' },
  fetchText: async (url: string) => (url === `${BUILD}game/paddle.js.map` ? MAP : undefined),
};

describe('Python tracebacks from browser stacks', () => {
  it('decodes the .py line of each compiled line', () => {
    expect(decodeLines('AAAA;AACA;;AAGA')).toEqual([1, 2, 0, 5]);
  });

  it('keeps the game frames, maps them through the source map, outermost first (Chrome and Firefox stacks)', async () => {
    const chrome = [
      'TypeError: boom',
      `    at Paddle.update (${BUILD}game/paddle.js:4:12)`,
      `    at ${BUILD}game/paddle.js:3:1`,
      '    at Kernel.step (http://127.0.0.1:5180/engine/chunks/kernel-abc.js:900:3)',
      `    at ${BUILD}game/main.js:7:2`,
    ].join('\n');
    const frames = await pythonTraceback(chrome, sources);
    expect(formatTraceback(frames)).toEqual([
      'File "game/main.py" (compiled game/main.js:7)',
      'File "game/behaviors/paddle.py" (compiled game/paddle.js:3)',
      'File "game/behaviors/paddle.py", line 5, in Paddle.update',
    ]);
    const firefox = `update@${BUILD}game/paddle.js:2:5\nstep@http://127.0.0.1:5180/engine/boot.js:1:1`;
    expect(formatTraceback(await pythonTraceback(firefox, sources))).toEqual(['File "game/behaviors/paddle.py", line 2, in update']);
  });
});
