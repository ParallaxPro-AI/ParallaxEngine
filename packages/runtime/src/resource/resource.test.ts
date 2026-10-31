import { describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { loadProject } from './load_project.js';
import { resolvePrefab } from './variants.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([path, value]) =>
    [path, typeof value === 'string' ? value : JSON.stringify(value)]));
  return { list: () => Object.keys(text).sort(), read: (path) => text[path]! };
}

function codes(contents: Record<string, unknown>): string[] {
  return loadProject(files(contents)).diagnostics.map((d) => d.code);
}

const BALL = { components: { shape: { kind: 'circle' } } };

describe('loadProject', () => {
  it('loads every kind of data file', () => {
    const project = loadProject(files({
      'prefabs/ball.prefab.json': BALL,
      'features/combat/prefabs/enemies/slime.prefab.json': { tags: ['enemy'], pool: 8 },
      'scenes/arena/scene.json': { ui: ['hud'], entities: [{ prefab: 'ball', at: [0, 1] }] },
      'config/rules.json': { lives: 3 },
      'content/stage/dawn.json': { number: 1 },
      'locale/en.json': { score: 'Score' },
      'assets/audio.json': { 'sfx/hit': { volume: 0.4 } },
      'assets/vfx/sparks.vfx.json': { rate: 10 },
      'game/main.py': 'game = Game(...)',
    }));
    expect(project.diagnostics).toEqual([]);
    expect([...project.prefabs.keys()]).toEqual(['slime', 'ball']);
    expect(project.prefabs.get('slime')?.feature).toBe('combat');
    expect(project.scenes.get('arena')?.entities[0]?.at).toEqual([0, 1]);
    expect(project.config.get('rules')?.values).toEqual({ lives: 3 });
    expect(project.content.get('stage')?.get('dawn')?.values).toEqual({ number: 1 });
    expect(project.locales.get('en')?.strings).toEqual({ score: 'Score' });
    expect(project.audio.get('sfx/hit')).toEqual({ volume: 0.4 });
  });

  it('assembles an open world from scene, world and region entity files', () => {
    const scene = loadProject(files({
      'prefabs/shrine.prefab.json': {},
      'scenes/vale/scene.json': {},
      'scenes/vale/world.json': { cell_size: 256, layers: { base: {}, fire: { active_when: { fact: 'burned' } } } },
      'scenes/vale/regions/village/entities/well_shrine.json': { prefab: 'shrine', at: [1, 0, 2], layer: 'fire' },
    })).scenes.get('vale')!;
    expect(scene.world?.cellSize).toBe(256);
    expect(scene.world?.layers.get('fire')?.activeWhen).toEqual({ fact: 'burned' });
    expect(scene.entities).toMatchObject([{ id: 'well_shrine', region: 'village', layer: 'fire', prefab: 'shrine' }]);
  });

  it('reads region manifests and warns when a region goes over its entity budget', () => {
    const project = loadProject(files({
      'prefabs/tree.prefab.json': {},
      'scenes/vale/scene.json': {},
      'scenes/vale/regions/wood/region.json': { bounds: { min: [0, 0], max: [64, 64] }, budget: { entities: 10 } },
      'scenes/vale/regions/wood/entities/grove.json': { prefab: 'tree', grid: { cols: 4, rows: 3, spacing: [2, 2], origin: [0, 0, 0] } },
      'scenes/vale/regions/wood/entities/camera.json': { prefab: 'tree', always_loaded: true },
    }));
    expect(project.scenes.get('vale')?.regions.get('wood')?.bounds).toEqual({ min: [0, 0], max: [64, 64] });
    expect(project.scenes.get('vale')?.entities.find((e) => e.id === 'camera')?.alwaysLoaded).toBe(true);
    expect(project.diagnostics).toMatchObject([{ code: 'PP5010', severity: 'warning' }]);
  });

  it('reports invalid JSON with its line', () => {
    const [d] = loadProject(files({ 'config/rules.json': '{\n  "lives": 3\n  "score": 1\n}' })).diagnostics;
    expect(d).toMatchObject({ code: 'PP1001', path: 'config/rules.json', line: 3 });
  });

  it('rejects unknown keys and suggests the right one', () => {
    const [d] = loadProject(files({ 'prefabs/ball.prefab.json': { componets: {} } })).diagnostics;
    expect(d).toMatchObject({ code: 'PP1003', pointer: '/componets', fix: 'Did you mean "components"?' });
  });

  it('keeps inline children one level deep, and says to make a prefab for more', () => {
    const { diagnostics } = loadProject(files({ 'prefabs/gun.prefab.json': { children: [{ name: 'scope', children: [{ name: 'reticle' }] }] } }));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'PP1003', pointer: '/children/0/children', message: expect.stringContaining('inline child'), fix: expect.stringContaining('its own prefab') });
  });

  it('points the wrong spellings of a placement at the one form', () => {
    const diagnostics = loadProject(files({
      'prefabs/ball.prefab.json': BALL,
      'scenes/arena/scene.json': { entities: [{ prefab: 'ball', position: [0, 0], behaviors: { orb: {} } }] },
    })).diagnostics;
    expect(diagnostics.map((d) => [d.pointer, d.fix])).toEqual([
      ['/entities/0/position', 'Use "at".'],
      ['/entities/0/behaviors', 'Per-instance behavior settings go in "params": {"<behavior id>": {...}}.'],
    ]);
  });

  it('checks value types with pointers', () => {
    const [d] = loadProject(files({ 'scenes/arena/scene.json': { entities: [{ prefab: 'x', at: [1, 2, 3, 4] }] } })).diagnostics;
    expect(d).toMatchObject({ code: 'PP1002', pointer: '/entities/0/at' });
  });

  it('requires snake_case ids and unique ids', () => {
    expect(codes({ 'prefabs/BigRock.prefab.json': {} })).toEqual(['PP1004']);
    expect(codes({
      'prefabs/rock.prefab.json': {},
      'features/caves/prefabs/rock.prefab.json': {},
    })).toEqual(['PP2010']);
  });

  it('refuses the transform as a component (it is the entity\'s), pointing at at/rotation/scale', () => {
    const [d] = loadProject(files({ 'prefabs/rock.prefab.json': { components: { transform: { scale: [2, 2, 2] } } } })).diagnostics;
    expect(d).toMatchObject({ code: 'PP1008', pointer: '/components/transform' });
    expect(codes({ 'prefabs/rock.prefab.json': { scale: [2, 2, 2] } })).toEqual([]);
  });

  it('keeps dialogue scripts as text by id, from the root or a feature', () => {
    const contents = { 'story/elder.yarn': 'title: Start\n---\nHi.\n===\n', 'features/quests/story/scout.yarn': 'x' };
    const project = loadProject({ list: () => Object.keys(contents).sort(), read: (p) => contents[p as keyof typeof contents] });
    expect(project.diagnostics).toEqual([]);
    expect(project.dialogues.get('elder')).toMatchObject({ path: 'story/elder.yarn', text: contents['story/elder.yarn'] });
    expect(project.dialogues.get('scout')!.feature).toBe('quests');
    const dup = { 'story/a.yarn': '', 'features/f/story/a.yarn': '' };
    expect(loadProject({ list: () => Object.keys(dup).sort(), read: () => '' }).diagnostics.map((d) => d.code)).toEqual(['PP2010']);
  });

  it('flags data files in the wrong place', () => {
    expect(codes({ 'data/stages.json': {} })).toEqual(['PP1005']);
    expect(codes({ 'build/manifest.json': {}, 'build/declarations.json': {} })).toEqual([]);
  });

  it('resolves references and suggests the closest name', () => {
    const [d] = loadProject(files({
      'prefabs/brick.prefab.json': {},
      'scenes/arena/scene.json': { entities: [{ prefab: 'brik' }] },
    })).diagnostics;
    expect(d).toMatchObject({ code: 'PP2041', pointer: '/entities/0/prefab', fix: 'Change "brik" to "brick".' });
  });

  it('checks extends targets, cycles, placed ids and world layers', () => {
    expect(codes({ 'prefabs/a.prefab.json': { extends: 'missing' } })).toEqual(['PP2042']);
    expect(codes({
      'prefabs/a.prefab.json': { extends: 'b' },
      'prefabs/b.prefab.json': { extends: 'a' },
    })).toEqual(['PP2043']);
    expect(codes({
      'prefabs/p.prefab.json': {},
      'scenes/s/scene.json': { entities: [{ prefab: 'p', id: 'door' }, { prefab: 'p', id: 'door' }] },
    })).toEqual(['PP2011']);
    expect(codes({
      'prefabs/p.prefab.json': {},
      'scenes/s/scene.json': {},
      'scenes/s/world.json': { cell_size: 64, layers: { base: {} } },
      'scenes/s/regions/r/entities/e.json': { prefab: 'p', layer: 'bse' },
    })).toEqual(['PP2044']);
  });

  it('allows unnamed and gridded children; names must be unique', () => {
    expect(codes({
      'prefabs/lane.prefab.json': {
        children: [
          { components: { shape: { kind: 'box' } }, grid: { cols: 8, rows: 1, spacing: [3, 0], origin: [-12, 0] } },
          { name: 'sign' },
        ],
      },
    })).toEqual([]);
    expect(codes({ 'prefabs/lane.prefab.json': { children: [{ name: 'sign' }, { name: 'sign' }] } })).toEqual(['PP2012']);
  });

  it('accepts audio levels as numbers or [lo, hi] ranges, keyed without extensions', () => {
    const project = loadProject(files({ 'assets/audio.json': { 'sfx/key': { volume: [0.5, 0.75], pitch: 1.1 } } }));
    expect(project.audio.get('sfx/key')).toEqual({ volume: [0.5, 0.75], pitch: 1.1 });
    const [d] = loadProject(files({ 'assets/audio.json': { 'assets/sfx/jump.ogg': { volume: 1 } } })).diagnostics;
    expect(d).toMatchObject({ code: 'PP1009', fix: 'Use "sfx/jump" (no \"assets/\", no extension).' });
  });

  it('keeps every language in step with English', () => {
    expect(codes({
      'locale/en.json': { score: 'Score', best: 'Best' },
      'locale/zh.json': { score: '分数', extra: '多余' },
    })).toEqual(['PP2060', 'PP2061']);
  });
});

describe('resolvePrefab', () => {
  it('flattens a variant onto its base', () => {
    const project = loadProject(files({
      'prefabs/brick.prefab.json': {
        components: { shape: { kind: 'rect', color: '#fff' }, health: { max: 1 } },
        tags: ['brick'],
        behaviors: { flash: { color: '#fff', seconds: 0.1 } },
        children: [{ name: 'crack', prefab: 'crack' }],
        pool: 64,
        scale: 1.5,
      },
      'prefabs/crack.prefab.json': {},
      'prefabs/gold_brick.prefab.json': {
        extends: 'brick',
        components: { shape: { color: '#fc0' } },
        tags: ['brick', 'valuable'],
        behaviors: { flash: { color: '#ff0' }, sparkle: {} },
        children: [{ name: 'crack', at: [0, 1] }],
      },
      'prefabs/plain_brick.prefab.json': {
        extends: 'gold_brick',
        components: { health: null, shape: { color: null } },
        tags: [],
        behaviors: { sparkle: null },
        scale: null,
      },
    }));
    expect(project.diagnostics).toEqual([]);
    const gold = resolvePrefab(project, 'gold_brick');
    expect(gold.components).toEqual({ shape: { kind: 'rect', color: '#fc0' }, health: { max: 1 } });
    // Plain lists replace (the variant lists every tag it keeps).
    expect(gold.tags).toEqual(['brick', 'valuable']);
    expect(gold.behaviors.map((b) => [b.use, b.params])).toEqual([
      ['flash', { color: '#ff0', seconds: 0.1 }],
      ['sparkle', {}],
    ]);
    // Children merge by name.
    expect(gold.children).toMatchObject([{ name: 'crack', prefab: 'crack', at: [0, 1] }]);
    expect(gold.pool).toBe(64);
    expect(gold.scale).toBe(1.5);
    expect('extends' in gold).toBe(false);
    // null deletes what is inherited.
    const plain = resolvePrefab(project, 'plain_brick');
    expect(plain.components).toEqual({ shape: { kind: 'rect' } });
    expect(plain.tags).toEqual([]);
    expect(plain.behaviors.map((b) => b.use)).toEqual(['flash']);
    expect(plain.scale).toBeUndefined();
  });

  it('refuses the old behaviors list, with the map as the fix', () => {
    const [d] = loadProject(files({ 'prefabs/ball.prefab.json': { behaviors: [{ use: 'orb', params: { speed: 2 } }, { use: 'glow' }] } })).diagnostics;
    expect(d).toMatchObject({ code: 'PP1002', pointer: '/behaviors' });
    expect(d!.fix).toContain('{"orb":{"speed":2},"glow":{}}');
  });

  it('fails clearly on unknown prefabs', () => {
    expect(() => resolvePrefab(loadProject(files({})), 'ghost')).toThrow(/PP2041/);
  });
});

describe('scene inheritance', () => {
  const ARENA = {
    ui: ['hud'],
    music: 'battle',
    environment: { sky: 'atmosphere', time_of_day: 15 },
    terrain: { size: [64, 64] },
    entities: [
      { prefab: 'ball', id: 'camera', at: [0, 5, 0] },
      { prefab: 'ball', at: [1, 0, 0] },
      { prefab: 'ball', id: 'player', at: [2, 0, 0] },
    ],
  };

  it('inherits every key, replaces the ones the derived scene sets, and adds its entities', () => {
    const project = loadProject(files({
      'prefabs/ball.prefab.json': BALL,
      'scenes/arena/scene.json': ARENA,
      'scenes/title/scene.json': {
        extends: 'arena', ui: ['title_screen'], music: 'menu', exclude: ['player'],
        entities: [{ prefab: 'ball', id: 'logo', at: [0, 9, 0] }],
      },
    }));
    expect(project.diagnostics).toEqual([]);
    const title = project.scenes.get('title')!;
    expect(title.extends).toBe('arena');
    expect(title.ui).toEqual(['title_screen']);
    expect(title.music).toBe('menu');
    expect(title.environment).toEqual(ARENA.environment);
    expect(title.plugins['terrain']).toEqual(ARENA.terrain);
    expect(title.entities.map((p) => p.id ?? '-')).toEqual(['camera', '-', 'logo']);
    // Inherited placements keep their base file, so edits land there.
    expect(title.entities[0]!.origin).toEqual({ path: 'scenes/arena/scene.json', pointer: '/entities/0' });
    expect(title.entities[2]!.origin).toEqual({ path: 'scenes/title/scene.json', pointer: '/entities/0' });
    expect(title.keyPaths).toMatchObject({ environment: 'scenes/arena/scene.json', ui: 'scenes/title/scene.json', terrain: 'scenes/arena/scene.json' });
    expect([...project.scenes.keys()]).toEqual(['arena', 'title']);
    expect(project.scenes.get('arena')!.extends).toBeUndefined();
  });

  it('null replaces an inherited key with nothing', () => {
    const project = loadProject(files({
      'prefabs/ball.prefab.json': BALL,
      'scenes/arena/scene.json': { ...ARENA, tags: ['battle'] },
      'scenes/title/scene.json': { extends: 'arena', music: null, terrain: null, tags: [] },
    }));
    expect(project.diagnostics).toEqual([]);
    const title = project.scenes.get('title')!;
    expect(title.music).toBeUndefined();
    expect(title.plugins['terrain']).toBeUndefined();
    expect(title.tags).toEqual([]);
    expect(title.environment).toEqual(ARENA.environment);
    expect(loadProject(files({ 'scenes/arena/scene.json': { music: null } })).diagnostics.map((d) => d.code)).toEqual(['PP1002']);
  });

  it('deep-merges objects, replaces plain lists, deletes with null, and resolves chains', () => {
    const project = loadProject(files({
      'prefabs/ball.prefab.json': BALL,
      'scenes/arena/scene.json': ARENA,
      'scenes/dusk/scene.json': { extends: 'arena', environment: { time_of_day: 19 }, terrain: { size: [32, 32] } },
      'scenes/menu/scene.json': { extends: 'dusk', environment: { sky: null }, entities: [{ prefab: 'ball', id: 'logo' }] },
    }));
    expect(project.diagnostics).toEqual([]);
    expect(project.scenes.get('dusk')!.environment).toEqual({ sky: 'atmosphere', time_of_day: 19 });
    expect(project.scenes.get('dusk')!.plugins['terrain']).toEqual({ size: [32, 32] });
    const menu = project.scenes.get('menu')!;
    expect(menu.environment).toEqual({ time_of_day: 19 });
    expect(menu.keyPaths?.['environment']).toBe('scenes/menu/scene.json');
    expect(menu.entities).toHaveLength(4);
  });

  it('merges a placement over the base one with the same id ("prefab" optional); an unmatched one needs a prefab', () => {
    const project = loadProject(files({
      'prefabs/ball.prefab.json': BALL,
      'scenes/arena/scene.json': ARENA,
      'scenes/title/scene.json': { extends: 'arena', entities: [{ id: 'camera', at: [0, 9, 0], tags: ['menu'] }, { id: 'ghost' }] },
    }));
    const title = project.scenes.get('title')!;
    expect(title.entities.map((p) => p.id ?? '-')).toEqual(['camera', '-', 'player']);
    expect(title.entities[0]).toMatchObject({ prefab: 'ball', at: [0, 9, 0], tags: ['menu'] });
    expect(project.diagnostics.map((d) => [d.code, d.pointer])).toEqual([['PP1002', '/entities/1']]);
  });

  it('ignores a scene "mode" with a warning (2D/3D is Game(mode=))', () => {
    const [d] = loadProject(files({ 'scenes/arena/scene.json': { mode: '3d' } })).diagnostics;
    expect(d).toMatchObject({ code: 'PP1003', severity: 'warning', pointer: '/mode' });
  });

  it('reports unknown bases, cycles and excluded ids that the base does not place, at the derived file', () => {
    const project = loadProject(files({
      'prefabs/ball.prefab.json': BALL,
      'scenes/arena/scene.json': ARENA,
      'scenes/title/scene.json': { extends: 'arenna' },
      'scenes/a/scene.json': { extends: 'b' },
      'scenes/b/scene.json': { extends: 'a' },
      'scenes/menu/scene.json': { extends: 'arena', exclude: ['playr'] },
      'scenes/lone/scene.json': { exclude: ['player'] },
    }));
    const found = project.diagnostics.map((d) => [d.code, d.path, d.pointer, d.fix]);
    expect(found).toContainEqual(['PP2047', 'scenes/title/scene.json', '/extends', 'Change "arenna" to "arena".']);
    expect(found).toContainEqual(['PP2049', 'scenes/menu/scene.json', '/exclude/0', 'Did you mean "player"?']);
    expect(found).toContainEqual(['PP1002', 'scenes/lone/scene.json', '/exclude', 'Add "extends": "<scene id>", or remove "exclude".']);
    expect(project.diagnostics.filter((d) => d.code === 'PP2048')).toHaveLength(1);
    expect(project.diagnostics.find((d) => d.code === 'PP2048')!.message).toMatch(/a → b → a|b → a → b/);
  });

  it('reports a problem in a base placement once, at the base file', () => {
    const project = loadProject(files({
      'prefabs/ball.prefab.json': BALL,
      'scenes/arena/scene.json': { entities: [{ prefab: 'bal' }] },
      'scenes/title/scene.json': { extends: 'arena' },
    }));
    expect(project.diagnostics.map((d) => [d.code, d.path])).toEqual([['PP2041', 'scenes/arena/scene.json']]);
  });
});
