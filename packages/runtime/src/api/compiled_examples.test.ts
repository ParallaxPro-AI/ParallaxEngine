/**
 * Acceptance: real examples, compiled by the Python transpiler (`python3 -m parallax_transpiler
 * build`) with `project.js` from `@parallax/check`, imported as ES modules and run headless
 * through `createRuntime`. Each example must construct its Game and run FRAMES frames.
 *
 * The compiled modules import `parallax*` and `project` by bare name (contract C1); this
 * test rewrites those specifiers to absolute paths (the engine sources from boot's
 * `ENGINE_MODULES`, and the build's `project.js`) before importing them.
 *
 * Needs `python3` on PATH (the transpiler is standard library only).
 */

import { describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { ENGINE_MODULES } from '../boot/modules.js';
import type { BuildManifest } from '../boot/modules.js';
import { initPhysics2d } from '../function/plugins/physics2d/index.js';
import { initPhysics3d } from '../function/plugins/physics3d/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { createRuntime, Game, resetDeclarations } from './index.js';

const FRAMES = 120;
const EXAMPLES = ['paddle_duel', 'typing_game', 'endless_runner'];

interface Fs {
  mkdtempSync(prefix: string): string;
  readdirSync(path: string, options: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, text: string): void;
  rmSync(path: string, options: { recursive: true; force: true }): void;
}
interface ChildProcess {
  spawnSync(cmd: string, args: string[], options: { cwd: string; encoding: 'utf8' }): { status: number | null; stdout: string; stderr: string };
}
interface CheckModule {
  checkProject(dir: string, options: { outDir: string }): { project?: unknown; errors: number; diagnostics: readonly { code: string; message: string; severity: string }[] };
  directoryFiles(dir: string): { all(): readonly string[]; read(path: string): string };
}

// Node built-ins and the check package, untyped here: the runtime compiles without @types/node.
const load = (specifier: string): Promise<unknown> => import(/* @vite-ignore */ specifier);
const fs = await load('node:fs') as Fs;
const { spawnSync } = await load('node:child_process') as ChildProcess;
const { tmpdir } = await load('node:os') as { tmpdir(): string };

const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PACKAGES = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const check = await load(`${PACKAGES}/check/src/index.ts`) as CheckModule;

function jsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? jsFiles(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []);
}

/** Bare engine and project specifiers → absolute paths. Reports engine modules that don't exist yet. */
function link(build: string): string[] {
  const missing = new Set<string>();
  for (const file of jsFiles(build)) {
    const text = fs.readFileSync(file, 'utf8').replace(/(from |import\()'([^'.][^']*)'/g, (whole, lead: string, spec: string) => {
      if (spec === 'project') return `${lead}'${build}/project.js'`;
      const source = ENGINE_MODULES[spec];
      if (source === undefined) return whole;
      if (!exists(`${SRC}/${source}`)) missing.add(`${spec} (${source})`);
      return `${lead}'${SRC}/${source}'`;
    });
    fs.writeFileSync(file, text);
  }
  return [...missing];
}

function exists(path: string): boolean {
  try { fs.readFileSync(path, 'utf8'); return true; } catch { return false; }
}

interface Built { readonly build: string; readonly entry: Record<string, unknown>; readonly files: ProjectFiles }

async function build(name: string): Promise<Built> {
  const project = `${PACKAGES}/../examples/${name}`;
  const out = fs.mkdtempSync(`${tmpdir()}/parallax-${name}-`);
  const compiled = spawnSync('python3', ['-m', 'parallax_transpiler', 'build', project, out], { cwd: `${PACKAGES}/transpiler`, encoding: 'utf8' });
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  // The examples' data has check errors of its own (wave 5 fixes those); project.js is what this needs.
  const checked = check.checkProject(project, { outDir: out });
  expect(checked.project, checked.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n')).toBeDefined();
  expect(link(out)).toEqual([]);
  resetDeclarations();
  // Every game module declares by being imported (decorators register), as a bundle loads them all.
  const manifest = JSON.parse(fs.readFileSync(`${out}/manifest.json`, 'utf8')) as BuildManifest;
  for (const m of manifest.modules) if (m.output !== null && m.output.startsWith('game/')) await load(`${out}/${m.output}`);
  const entry = await load(`${out}/${manifest.entry!}`) as Record<string, unknown>;
  const tree = check.directoryFiles(project);
  const all = tree.all();
  return { build: out, entry, files: { list: () => all, read: (p) => tree.read(p) } };
}

/** Build, import and run one example for FRAMES frames. */
async function play(name: string): Promise<void> {
  const { build: out, entry, files } = await build(name);
  try {
    const game = entry['game'];
    expect(game).toBeInstanceOf(Game);
    const g = game as Game;
    if (g.plugins.some((p) => p.id === 'physics2d')) await initPhysics2d();
    if (g.plugins.some((p) => p.id === 'physics3d')) await initPhysics3d();
    const project = loadProject(files);
    expect(project.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // The examples ship no sound files yet, so asset files are unknown (null).
    const runtime = createRuntime(g, project, {
      seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files,
      ...(g.mode === '3d' ? { surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}) } : { surface: new RecordingSurface2d() }),
    });
    const r3 = runtime.render3d;
    if (r3 !== undefined) {
      r3.preload();
      await r3.whenLoaded();
    }
    runtime.start();
    for (let i = 0; i < FRAMES; i++) runtime.step(1 / 60);
    expect(runtime.kernel.world.count).toBeGreaterThan(0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

/**
 * Examples that can't run yet, each with what stops it (owned outside api core). When a
 * blocker is fixed this test fails: move the example to RUNS.
 */
const BLOCKED: Readonly<Record<string, RegExp>> = {};
const RUNS: readonly string[] = EXAMPLES.filter((name) => !(name in BLOCKED));

describe('compiled examples run headless', () => {
  for (const name of RUNS) {
    it(`${name}: builds, constructs its Game and runs ${FRAMES} frames`, () => play(name), 60_000);
  }
  for (const [name, blocker] of Object.entries(BLOCKED)) {
    it(`${name}: still blocked by ${blocker.source}`, async () => {
      await expect(play(name)).rejects.toThrow(blocker);
    }, 60_000);
  }
});
