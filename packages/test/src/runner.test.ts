/**
 * The whole pipeline on fixture projects: the real transpiler and checker build them, a
 * child process loads the compiled modules through the hooks, and every harness call
 * runs against the real runtime.
 */

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { formatReport } from './report.js';
import { runProjectTests } from './runner.js';
import type { ProjectTestReport } from './runner.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function byName(report: ProjectTestReport): Record<string, ProjectTestReport['results'][number]> {
  return Object.fromEntries(report.results.map((r) => [r.name === '' ? r.id : r.name, r]));
}

describe('a passing project (fixtures/tally)', async () => {
  const report = await runProjectTests(fixture('tally'));
  const results = byName(report);

  it('builds and passes every test', () => {
    expect(report.diagnostics, formatReport(report)).toEqual([]);
    expect(report.results.filter((r) => r.status !== 'passed'), formatReport(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('collects playtests and plain test_* functions in definition order, not helpers', () => {
    expect(report.results.map((r) => r.id)).toEqual([
      'tests/test_rules.py::test_arithmetic',
      'tests/test_rules.py::test_async_plain',
      'tests/test_tally.py::test_start_scene',
      'tests/test_tally.py::test_press',
      'tests/test_tally.py::test_hold',
      'tests/test_tally.py::test_hold_while_moving',
      'tests/test_tally.py::test_vec2_position',
      'tests/test_tally.py::test_axes',
      'tests/test_tally.py::test_events',
      'tests/test_tally.py::test_panels',
      'tests/test_tally.py::test_advance_until',
      'tests/test_tally.py::test_pointer_and_text',
      'tests/test_tally.py::test_print',
    ]);
    expect(results['test_press']?.title).toBe('press is one frame: it counts once');
    expect(results['test_press']?.kind).toBe('playtest');
    expect(results['test_arithmetic']?.kind).toBe('test');
  });

  it('captures print() from the test and the game', () => {
    expect(results['test_print']?.output).toBe('before start\nbump 1\n');
  });

  it('filters by id or title', async () => {
    const only = await runProjectTests(fixture('tally'), { filter: 'pointer' });
    expect(only.results.map((r) => r.name)).toEqual(['test_pointer_and_text']);
  });
});

const BROKEN = `from parallax.test import playtest
from project import Scenes

from game.actions import Controls
from game.events import Bumped
from game.resources import Tally


@playtest("an assert that does not hold")
async def test_assert(game):
    await game.start(scene=Scenes.arena)
    assert game.get(Tally).value == 99, "expected 99"


@playtest("a harness call without await")
async def test_unawaited(game):
    await game.start(scene=Scenes.arena)
    game.press(Controls.bump)
    await game.advance(frames=1)


@playtest("a wait that never ends")
async def test_wait(game):
    await game.start(scene=Scenes.arena)
    await game.advance_until(lambda: game.get(Tally).value > 0, timeout=0.5)


@playtest("an event that never comes")
async def test_until(game):
    await game.start(scene=Scenes.arena)
    await game.until(Bumped, timeout=0.25)


@playtest("the game raises during a frame")
async def test_game_raises(game):
    await game.start(scene=Scenes.arena)
    game.ctx.get(Tally).explode = True
    await game.advance(frames=1)


@playtest("a test that never yields")
async def test_hang(game):
    while True:
        pass


@playtest("runs after the hang, in a new process")
async def test_after_hang(game):
    await game.start(scene=Scenes.arena)


@playtest("not async")
def test_sync(game):
    pass


@playtest("press() with a button_group slot")
async def test_press_slot(game):
    await game.start(scene=Scenes.arena)
    await game.press(Controls.bump, index=1)
`;

const MISSING = `from parallax.voxels import VoxelWorld


def test_never_runs():
    pass
`;

describe('a failing project', async () => {
  const dir = mkdtempSync(`${tmpdir()}/parallax-broken-`);
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  cpSync(fixture('tally'), dir, { recursive: true });
  writeFileSync(`${dir}/tests/test_broken.py`, BROKEN);
  writeFileSync(`${dir}/tests/test_missing.py`, MISSING);
  const report = await runProjectTests(dir, { filter: 'tests/test_', timeout: 3 });
  const results = byName(report);
  const codes = (name: string): string[] => results[name]?.diagnostics.map((d) => d.code) ?? [];

  it('reports, not throws, and is not ok', () => {
    expect(report.ok).toBe(false);
    expect(report.summary.passed).toBe(report.results.filter((r) => r.status === 'passed').length);
  });

  it('a failed assert is "failed" with its message and the assert line', () => {
    const r = results['test_assert']!;
    expect(r.status).toBe('failed');
    expect(r.diagnostics[0]?.message).toBe('assertion failed: expected 99');
    expect(r.traceback.map((f) => f.source)).toEqual(['tests/test_broken.py']);
    // The .py line, through the transpiler's source map, quoted from the .py source.
    expect(r.traceback.map((f) => [f.line, f.code])).toEqual([[12, 'assert game.get(Tally).value == 99, "expected 99"']]);
  });

  it('a call without await is PP3446 at the call', () => {
    expect(codes('test_unawaited')).toEqual(['PP3446']);
    expect(results['test_unawaited']?.traceback.map((f) => [f.line, f.code])).toEqual([[18, 'game.press(Controls.bump)']]);
  });

  it('press(index=) points at press_index()', () => {
    expect(codes('test_press_slot')).toEqual(['PP3449']);
    expect(results['test_press_slot']?.diagnostics[0]?.fix).toContain('press_index(group, index)');
  });

  it('waits that time out fail with PP3444 / PP3445', () => {
    expect([results['test_wait']?.status, codes('test_wait')]).toEqual(['failed', ['PP3444']]);
    expect([results['test_until']?.status, codes('test_until')]).toEqual(['failed', ['PP3445']]);
  });

  it('a Python exception in game code is an error traced from the test into the game module', () => {
    const r = results['test_game_raises']!;
    expect(r.status).toBe('error');
    expect(r.diagnostics[0]?.message).toBe('ValueError: the counter exploded');
    expect(r.traceback.map((f) => `${f.source}:${String(f.line)} ${String(f.code)}`)).toEqual([
      'tests/test_broken.py:38 await game.advance(frames=1)',
      'game/systems.py:15 raise ValueError("the counter exploded")',
    ]);
  });

  it('a hung test is stopped (PP3414) and the rest still run', () => {
    expect(codes('test_hang')).toEqual(['PP3414']);
    expect(results['test_after_hang']?.status).toBe('passed');
  });

  it('a playtest that is not async def is PP3450', () => {
    expect(codes('test_sync')).toEqual(['PP3450']);
  });

  it('a test module importing an engine module that does not exist yet is PP9501', () => {
    const r = results['tests/test_missing.py']!;
    expect([r.kind, r.status]).toEqual(['module', 'error']);
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([['PP9501', 'tests/test_missing.py']]);
  });
});

describe('a 3D project with its own .glb model (fixtures/local_glb)', async () => {
  const report = await runProjectTests(fixture('local_glb'));

  it('reads the project model file in the playtest (no PP3804)', () => {
    expect(report.diagnostics, formatReport(report)).toEqual([]);
    expect(report.results.map((r) => [r.name, r.status]), formatReport(report)).toEqual([['test_local_glb', 'passed']]);
  });
});
