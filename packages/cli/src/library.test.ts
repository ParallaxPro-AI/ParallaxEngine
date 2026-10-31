import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAdd, formatList, LIBRARY_DIR, listPieces, loadLibrary, missingPlugins, planAdd, RECORD_PATH, resolvePieces, searchPieces, withPlugins,
} from './library.js';
import { libraryMain } from './library_cli.js';
import { runPiece } from './library_run.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(name: string): string {
  const dir = mkdtempSync(`${tmpdir()}/parallax-${name}-`);
  made.push(dir);
  return dir;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(`${root}/${path}`), { recursive: true });
    writeFileSync(`${root}/${path}`, text);
  }
}

function manifest(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, summary: `The ${id} piece.`, version: '2026.10.23', ...extra });
}

/** A small library: base ← panel (with strings) ← extra; plus a piece needing a plugin. */
function fixture(): string {
  const root = temp('library');
  write(root, {
    'core/base/piece.json': manifest('base'),
    'core/base/files/game/lib/__init__.py': '',
    'core/base/files/game/lib/base.py': 'BASE = 1\n',
    'ui/panel/piece.json': manifest('panel', { requires: ['base'], setup: ['List it.'] }),
    'ui/panel/files/game/lib/__init__.py': '',
    'ui/panel/files/game/lib/panel.py': 'PANEL = 1\n',
    'ui/panel/files/locale/en.json': '{ "panel_title": "Panel", "panel_ok": "OK" }',
    'ui/extra/piece.json': manifest('extra', { requires: ['panel'] }),
    'ui/extra/files/game/lib/extra.py': 'EXTRA = 1\n',
    'ui/hud_thing/piece.json': manifest('hud_thing', { plugins: ['hud'] }),
    'ui/hud_thing/files/game/lib/hud_thing.py': 'H = 1\n',
  });
  return root;
}

function project(main = 'game = Game(plugins=[physics2d()])\n'): string {
  const dir = temp('project');
  write(dir, { 'game/main.py': main, 'locale/en.json': '{ "title": "My game" }\n' });
  return dir;
}

describe('library manifests', () => {
  it('loads pieces by category and resolves requirements dependencies-first', () => {
    const library = loadLibrary(fixture());
    expect(library.diagnostics).toEqual([]);
    expect([...library.pieces.keys()].sort()).toEqual(['base', 'extra', 'hud_thing', 'panel']);
    expect(library.pieces.get('panel')!.files).toEqual(['game/lib/__init__.py', 'game/lib/panel.py', 'locale/en.json']);
    expect(resolvePieces(library, ['extra', 'base']).pieces.map((p) => p.id)).toEqual(['base', 'panel', 'extra']);
    expect(formatList(library)).toMatch(/core\/\n {2}base/);
  });

  it('reports bad manifests, unknown requirements, unknown pieces and cycles', () => {
    const root = temp('bad-library');
    write(root, {
      'a/wrong_name/piece.json': manifest('other'),
      'a/wrong_name/files/x.py': '',
      'a/typo/piece.json': JSON.stringify({ id: 'typo', summary: 's', version: '2026.10.23', requirs: [] }),
      'a/typo/files/x.py': '',
      'a/empty/piece.json': manifest('empty'),
      'a/needy/piece.json': manifest('needy', { requires: ['ghost'] }),
      'a/needy/files/x.py': '',
      'b/one/piece.json': manifest('one', { requires: ['two'] }),
      'b/one/files/x.py': '',
      'b/two/piece.json': manifest('two', { requires: ['one'] }),
      'b/two/files/x.py': '',
    });
    const library = loadLibrary(root);
    const messages = library.diagnostics.map((d) => `${d.code} ${d.message} ${d.fix ?? ''}`);
    expect(messages.some((m) => m.includes('PP9590') && m.includes('folder is "wrong_name"'))).toBe(true);
    expect(messages.some((m) => m.includes('unknown key "requirs"') && m.includes('"requires"'))).toBe(true);
    expect(messages.some((m) => m.includes('no files/'))).toBe(true);
    expect(messages.some((m) => m.includes('PP9591') && m.includes('"ghost"'))).toBe(true);
    expect(resolvePieces(library, ['one']).diagnostics[0]!.code).toBe('PP9592');
    expect(resolvePieces(library, ['onee']).diagnostics[0]!.fix).toMatch(/"one"/);
  });
});

describe('library add', () => {
  it('copies a piece with its requirements, merges strings and records each file', () => {
    const library = loadLibrary(fixture());
    const dir = project();
    const plan = planAdd(library, dir, ['panel']);
    expect(plan.diagnostics).toEqual([]);
    expect([...plan.writes.keys()].sort()).toEqual(['game/lib/__init__.py', 'game/lib/base.py', 'game/lib/panel.py', 'locale/en.json']);
    applyAdd(dir, plan);
    expect(readFileSync(`${dir}/game/lib/panel.py`, 'utf8')).toBe('PANEL = 1\n');
    expect(JSON.parse(readFileSync(`${dir}/locale/en.json`, 'utf8'))).toEqual({ title: 'My game', panel_title: 'Panel', panel_ok: 'OK' });
    const record = JSON.parse(readFileSync(`${dir}/${RECORD_PATH}`, 'utf8'));
    expect(Object.keys(record.pieces)).toEqual(['base', 'panel']);
    expect(record.pieces.panel.from).toMatch(/ui\/panel$/);
    expect(record.pieces.panel.files['game/lib/panel.py']).toMatch(/^[0-9a-f]{64}$/);
    expect(record.pieces.panel.text['locale/en.json']).toEqual(['panel_title', 'panel_ok']);

    // Adding again changes nothing; the shared __init__.py is identical, not a conflict.
    const again = planAdd(library, dir, ['extra']);
    expect(again.diagnostics).toEqual([]);
    expect([...again.writes.keys()]).toEqual(['game/lib/extra.py']);
    expect(again.unchanged).toContain('game/lib/panel.py');
  });

  it('never overwrites: a different file or string is a conflict and nothing is written', () => {
    const library = loadLibrary(fixture());
    const dir = project();
    write(dir, { 'game/lib/base.py': 'MINE = 2\n', 'locale/en.json': '{ "panel_ok": "Okay" }' });
    const plan = planAdd(library, dir, ['panel']);
    const conflicts = plan.diagnostics.filter((d) => d.code === 'PP9594').map((d) => d.message);
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toMatch(/would overwrite game\/lib\/base\.py: the project already has a different file/);
    expect(conflicts[1]).toMatch(/already has "panel_ok"/);
    expect(() => applyAdd(dir, plan)).toThrow(/nothing was written/);
    expect(existsSync(`${dir}/game/lib/panel.py`)).toBe(false);
  });

  it('refuses a folder that is not a project, and warns about a missing plugin', () => {
    const library = loadLibrary(fixture());
    const notProject = temp('empty');
    expect(planAdd(library, notProject, ['base']).diagnostics[0]!.code).toBe('PP9593');
    const dir = project();
    const warnings = missingPlugins(dir, planAdd(library, dir, ['hud_thing']).pieces);
    expect(warnings.map((w) => [w.code, w.severity])).toEqual([['PP9595', 'warning']]);
    expect(missingPlugins(project('Game(plugins=[hud()])'), resolvePieces(library, ['hud_thing']).pieces)).toEqual([]);
  });

  it('adds the plugin a piece needs to Game(plugins=[...]) so the game still builds', () => {
    const root = fixture();
    write(root, {
      'models/hut/piece.json': manifest('hut', { plugins: ['physics3d'] }),
      'models/hut/files/prefabs/hut.prefab.json': '{ "components": { "collider": {} } }\n',
    });
    const library = loadLibrary(root);
    const main = 'from parallax import Game\nfrom parallax.plugins import hud\nfrom project import Scenes\n\ngame = Game(\n    plugins=[\n        hud()\n    ],\n    start_scene=Scenes.title,\n)\n';
    const dir = project(main);
    const plan = planAdd(library, dir, ['hut']);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.plugins).toEqual(['physics3d']);
    expect([...plan.writes.keys()].sort()).toEqual(['game/main.py', 'prefabs/hut.prefab.json']);
    applyAdd(dir, plan);
    expect(readFileSync(`${dir}/game/main.py`, 'utf8')).toBe(
      'from parallax import Game\nfrom parallax.plugins import hud, physics3d\nfrom project import Scenes\n\ngame = Game(\n    plugins=[\n        hud(),\n        physics3d(),\n    ],\n    start_scene=Scenes.title,\n)\n');
    expect(missingPlugins(dir, plan.pieces)).toEqual([]);
    // Adding again: main.py already lists it.
    expect(planAdd(library, dir, ['hut']).writes.has('game/main.py')).toBe(false);

    // A 2D game keeps its one physics plugin: main.py is untouched and the add warns.
    const flat = project('game = Game(plugins=[physics2d()])\n');
    const flatPlan = planAdd(library, flat, ['hut']);
    expect(flatPlan.writes.has('game/main.py')).toBe(false);
    expect(flatPlan.diagnostics.map((d) => [d.code, d.severity])).toEqual([['PP9595', 'warning']]);
  });

  it('edits the plugin list and its import in the shapes main.py is written in', () => {
    expect(withPlugins('from parallax import Game\n\ngame = Game(plugins=[], systems=[A])\n', ['physics3d'])!.source)
      .toBe('from parallax import Game\nfrom parallax.plugins import physics3d\n\ngame = Game(plugins=[physics3d()], systems=[A])\n');
    expect(withPlugins('from parallax.plugins import combat  # mine\ng = Game(plugins=[combat(dmg=[1, 2])], start_scene=S)\n', ['physics3d', 'hud'])!.source)
      .toBe('from parallax.plugins import combat, physics3d, hud  # mine\ng = Game(plugins=[combat(dmg=[1, 2]), physics3d(), hud()], start_scene=S)\n');
    expect(withPlugins('from parallax.plugins import (\n    combat,\n)\ng = Game(systems=[A])\n', ['physics3d'])!.source)
      .toBe('from parallax.plugins import (\n    combat,\n    physics3d,\n)\ng = Game(plugins=[physics3d()], systems=[A])\n');
    expect(withPlugins('g = Game(\n    start_scene=S,\n)\n', ['physics3d'])!.source)
      .toBe('from parallax.plugins import physics3d\ng = Game(\n    plugins=[physics3d()],\n    start_scene=S,\n)\n');
    expect(withPlugins('g = Game()\n', ['physics3d', 'physics2d'])).toEqual({ source: 'from parallax.plugins import physics3d\ng = Game(plugins=[physics3d()])\n', added: ['physics3d'] });
    // Not a list literal, or no Game(...): left to the author.
    expect(withPlugins('g = Game(plugins=PLUGINS)\n', ['hud'])).toBeUndefined();
    expect(withPlugins('print("hi")\n', ['hud'])).toBeUndefined();
    expect(withPlugins('g = Game(plugins=[physics2d()])\n', ['physics3d'])).toEqual({ source: 'g = Game(plugins=[physics2d()])\n', added: [] });
  });

  it('edits the real Game(...) call, not one a docstring or comment mentions, and keeps a plugins.x() list qualified', () => {
    const main = '"""The one `Game(plugins=[...], ...)` the engine starts."""\n\nfrom parallax import Game, plugins\n'
      + '# Game(plugins=[old()]) was here\ngame = Game(\n    plugins=[plugins.physics3d(), plugins.terrain()],\n    start_scene=S,\n)\n';
    expect(withPlugins(main, ['characters'])!.source).toBe(main.replace('plugins.terrain()]', 'plugins.terrain(), plugins.characters()]'));
    const plain = '"""Starts `Game(plugins=[...])`."""\nfrom parallax import Game\n\ng = Game(plugins=[], systems=[A])\n';
    expect(withPlugins(plain, ['hud'])!.source)
      .toBe('"""Starts `Game(plugins=[...])`."""\nfrom parallax import Game\nfrom parallax.plugins import hud\n\ng = Game(plugins=[hud()], systems=[A])\n');
    // A plugin named only in a docstring is not listed.
    expect(withPlugins('"""Add hud() later."""\ng = Game(plugins=[])\n', ['hud'])!.added).toEqual(['hud']);
  });
});

describe('the library as data (list --json)', () => {
  it('lists every piece with its requirements and the files an add copies, sorted like the text list', () => {
    const pieces = listPieces(loadLibrary(fixture()));
    expect(pieces.map((p) => p.id)).toEqual(['base', 'extra', 'hud_thing', 'panel']);
    expect(pieces.find((p) => p.id === 'panel')).toEqual({
      id: 'panel', category: 'ui', summary: 'The panel piece.', version: '2026.10.23', requires: ['base'],
      files: ['game/lib/__init__.py', 'game/lib/panel.py', 'locale/en.json'],
    });
  });
});

describe('library search', () => {
  it('ranks id matches first, matches plurals and needs every word when some piece has them all', () => {
    const root = temp('search');
    write(root, {
      'models/tree_pine/files/assets/tree_pine.txt': '',
      'models/tree_pine/piece.json': JSON.stringify({ id: 'tree_pine', summary: 'A tall evergreen conifer.', version: '2026.10.23' }),
      'models/tree_oak/files/assets/tree_oak.txt': '',
      'models/tree_oak/piece.json': JSON.stringify({ id: 'tree_oak', summary: 'A broad oak with a pine-free crown.', version: '2026.10.23' }),
      'models/fence_pine/files/assets/fence_pine.txt': '',
      'models/fence_pine/piece.json': JSON.stringify({ id: 'fence_pine', summary: 'A pine plank fence.', version: '2026.10.23' }),
      'ui/pine_panel/files/assets/pine_panel.txt': '',
      'ui/pine_panel/piece.json': JSON.stringify({ id: 'pine_panel', summary: 'A panel.', version: '2026.10.23' }),
    });
    const library = loadLibrary(root);
    expect(searchPieces(library, 'pine trees').map((p) => p.id)).toEqual(['tree_pine', 'tree_oak']);
    expect(searchPieces(library, 'pine').map((p) => p.id)).toEqual(['fence_pine', 'pine_panel', 'tree_pine', 'tree_oak']);
    expect(searchPieces(library, 'pine', { category: 'ui' }).map((p) => p.id)).toEqual(['pine_panel']);
    expect(searchPieces(library, 'pine', { limit: 1 })).toHaveLength(1);
    expect(searchPieces(library, 'submarine')).toEqual([]);
    expect(searchPieces(library, '  ')).toEqual([]);
  });

  it('finds models in the shipped library', () => {
    expect(searchPieces(loadLibrary(), 'pine tree')[0]?.id).toBe('tree_pine');
    expect(searchPieces(loadLibrary(), 'bowling pin')[0]?.id).toBe('bowling_pin');
  });
});

describe('parallax library (command line)', () => {
  it('rejects bad usage with exit 2', async () => {
    expect(await libraryMain([])).toBe(2);
    expect(await libraryMain(['frobnicate'])).toBe(2);
    expect(await libraryMain(['add', 'time_trial'])).toBe(2);
    expect(await libraryMain(['add', 'time_trial', '/nonexistent/project'])).toBe(2);
    expect(await libraryMain(['test', 'no_such_piece'])).toBe(2);
    expect(await libraryMain(['test', '--fast'])).toBe(2);
    expect(await libraryMain(['list', '--xml'])).toBe(2);
  });

  it('adds into a project and exits 1 on a conflict', async () => {
    const root = fixture();
    const dir = project();
    expect(await libraryMain(['add', 'extra', dir], root)).toBe(0);
    expect(existsSync(`${dir}/game/lib/extra.py`)).toBe(true);
    write(dir, { 'game/lib/extra.py': 'EDITED = 1\n' });
    expect(await libraryMain(['add', 'extra', dir, '--json'], root)).toBe(1);
  });
});

describe('the shipped library', () => {
  const library = loadLibrary(LIBRARY_DIR);

  it('has valid manifests, and every piece ships a demo with playtests', () => {
    expect(library.diagnostics).toEqual([]);
    expect(library.pieces.size).toBeGreaterThan(20);
    for (const piece of library.pieces.values()) {
      expect(existsSync(`${piece.dir}/demo/game/main.py`), `${piece.id} demo/game/main.py`).toBe(true);
      expect(existsSync(`${piece.dir}/demo/tests`), `${piece.id} demo/tests`).toBe(true);
      expect(resolvePieces(library, [piece.id]).diagnostics).toEqual([]);
    }
  });

  it('runs a piece end to end: copied into a scratch project, checked, playtested', async () => {
    const run = await runPiece(library, library.pieces.get('time_trial')!);
    expect(run.check.errors).toBe(0);
    expect(run.ok).toBe(true);
    expect(run.tests!.summary.passed).toBe(run.tests!.summary.total);
  });

  it('ships no piece that no example uses (models and clips excepted)', () => {
    // The examples are the library's real coverage: a piece no example copies is only ever run by its
    // own demo. Use it in an example or delete it. Models and clips are exempt: they are data, checked
    // statically, and a clip set's demo plays every clip.
    const examples = fileURLToPath(new URL('../../../examples/', import.meta.url));
    const used = new Set<string>();
    for (const name of readdirSync(examples)) {
      const record = `${examples}${name}/${RECORD_PATH}`;
      if (!existsSync(record)) continue;
      for (const id of Object.keys((JSON.parse(readFileSync(record, 'utf8')) as { pieces: Record<string, unknown> }).pieces)) used.add(id);
    }
    const unused = [...library.pieces.values()]
      .filter((piece) => piece.category !== 'models' && piece.category !== 'clips' && !used.has(piece.id))
      .map((piece) => piece.id)
      .sort();
    expect(unused, 'pieces no example copies: use each in an example (parallax library add) or delete it').toEqual([]);
  });
});
