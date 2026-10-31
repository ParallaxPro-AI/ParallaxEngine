/**
 * The whole pipeline headless: the real transpiler and checker build a project, the game
 * bundle links it with the engine, and `bootHeadless` runs it through the frame loop.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { directoryFiles } from '@parallax/check';
import { buildProject } from './build.js';
import { loadGame } from './bundle.js';

const DROP = fileURLToPath(new URL('./fixtures/drop', import.meta.url));
const BRICK_BREAKER = fileURLToPath(new URL('../../../examples/brick_breaker', import.meta.url));

const temp: string[] = [];
const tempDir = (name: string): string => { const dir = mkdtempSync(`${tmpdir()}/parallax-${name}-`); temp.push(dir); return dir; };
afterAll(() => { for (const dir of temp) rmSync(dir, { recursive: true, force: true }); });

describe('a compiled project, booted headless', () => {
  it('builds with the real transpiler and runs N frames with physics and behaviors', async () => {
    const build = buildProject(DROP, { outDir: tempDir('drop') });
    expect(build.diagnostics).toEqual([]);
    expect(build.manifest?.entry).toBe('game/main.js');

    const loaded = await loadGame(build.buildDir);
    const game = await loaded.bootHeadless({ entry: loaded.entry, files: directoryFiles(DROP) });
    const ball = () => [...game.runtime.kernel.world.live()].find((r) => r.placedId === 'ball')!;
    game.frames(30);
    expect(ball().transform.position.y).toBeLessThan(5);
    game.frames(90);
    expect(ball().transform.position.y).toBeCloseTo(1, 1);
    expect(game.runtime.kernel.time.frame).toBe(120);
    const counter = game.runtime.kernel.world.require(ball().id).behaviors[0]!.instance as unknown as { ticks: number };
    expect(counter.ticks).toBe(120);
  });
});

// examples/brick_breaker: the transpiler must build every module; it boots once every engine
// module it imports exists (combat and grid arrive in wave 2), which the link check reports.
const brick = buildProject(BRICK_BREAKER, { outDir: tempDir('bb'), assetFiles: false });
const unlinked = brick.diagnostics.filter((d) => d.code === 'PP9501').map((d) => d.message);

describe('examples/brick_breaker', () => {
  it('compiles every module without diagnostics', () => {
    expect(brick.manifest?.entry).toBe('game/main.js');
    expect(brick.manifest?.modules.every((m) => m.output !== null)).toBe(true);
    expect(brick.diagnostics.filter((d) => d.code.startsWith('PP6'))).toEqual([]);
  });

  it.skipIf(unlinked.length > 0)(`boots headless and runs 600 frames${unlinked.length > 0 ? ` (waiting on: ${unlinked.join('; ')})` : ''}`, async () => {
    expect(brick.errors).toBe(0);
    const loaded = await loadGame(brick.buildDir);
    const game = await loaded.bootHeadless({ entry: loaded.entry, files: directoryFiles(BRICK_BREAKER) });
    game.frames(600);
    expect(game.runtime.kernel.time.frame).toBe(600);
    expect(game.runtime.kernel.scene?.id).toBe('title');
  });
});
