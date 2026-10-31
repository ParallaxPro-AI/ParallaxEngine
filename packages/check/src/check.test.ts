/**
 * The checks over real example projects (read-only): each test copies an example into
 * memory, breaks one thing, and expects exactly the diagnostic for it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));

interface Example {
  readonly files: Record<string, string>;
  readonly declarations: Declarations;
}

function load(name: string): Example {
  const dir = `${EXAMPLES}${name}`;
  const tree = directoryFiles(dir);
  const files: Record<string, string> = {};
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path)) files[path] = tree.read(path);
  const extracted = runExtract(dir);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  return { files, declarations: extracted.declarations };
}

function run(example: Example, edits: Record<string, (text: string) => string> = {},
  declarations: (d: Declarations) => Declarations = (d) => d): readonly Diagnostic[] {
  const files = { ...example.files };
  for (const [path, edit] of Object.entries(edits)) files[path] = edit(files[path] ?? '');
  return checkFiles(memoryFiles(files), declarations(structuredClone(example.declarations)), { assetFiles: false }).diagnostics;
}

function brief(found: readonly Diagnostic[]): string[] {
  return found.map((d) => `${d.code} ${d.path ?? ''}${d.pointer !== undefined ? ` ${d.pointer}` : ''}${d.line !== undefined ? `:${d.line}` : ''}`);
}

let brick: Example;
let open_world_rpg: Example;

beforeAll(() => {
  brick = load('brick_breaker');
  open_world_rpg = load('open_world_rpg');
});

describe('a clean project', () => {
  it('brick_breaker checks clean', () => {
    expect(run(brick)).toEqual([]);
  });

  it('open_world_rpg (features, regions, quests, migrations) is clean', () => {
    expect(brief(run(open_world_rpg))).toEqual([]);
  });
});

describe('data against declarations', () => {
  it('unknown ids in prefabs and scenes, with the closest id', () => {
    const found = run(brick, {
      'prefabs/brick.prefab.json': (t) => t.replace('"health"', '"helth"').replace('"tags": ["brick"]', '"tags": ["brik"]')
        .replace('"prism_brick": {', '"prism_brik": {'),
      'scenes/arena/scene.json': (t) => t.replace('"ui": ["hud"]', '"ui": ["hdu"]'),
    });
    expect(brief(found)).toEqual([
      'PP2051 prefabs/brick.prefab.json /behaviors/prism_brik',
      'PP2050 prefabs/brick.prefab.json /components/helth',
      'PP2055 prefabs/brick.prefab.json /tags/0',
      'PP2054 scenes/arena/scene.json /ui/0',
    ]);
    expect(found.map((d) => d.fix)).toEqual(['Did you mean "prism_brick"?', 'Did you mean "health"?', 'Did you mean "brick"?', 'Did you mean "hud"?']);
  });

  it('a panel that opens by itself (when=) listed in a scene\'s ui is PP2081', () => {
    const found = run(brick, { 'scenes/arena/scene.json': (t) => t.replace('"ui": ["hud"]', '"ui": ["hud", "game_over"]') });
    expect(brief(found)).toEqual(['PP2081 scenes/arena/scene.json /ui/1']);
    expect(found[0]!.severity).toBe('error');
    expect(found[0]!.fix).toBe('Remove "game_over" from the scene\'s "ui" list.');
  });

  it('component fields and behavior params against their schemas', () => {
    const found = run(brick, {
      'prefabs/ball.prefab.json': (t) => t.replace('"kind": "dynamic"', '"kind": "dynamc"').replace('"base_speed": 9', '"base_sped": 9')
        .replace('"min_climb": 0.32', '"min_climb": 2'),
      'prefabs/paddle.prefab.json': (t) => t.replace('"color": "#a0daff"', '"color": "blue"'),
    });
    expect(brief(found)).toEqual([
      'PP4104 prefabs/ball.prefab.json /behaviors/orb/base_sped',
      'PP4103 prefabs/ball.prefab.json /behaviors/orb/min_climb',
      'PP4102 prefabs/ball.prefab.json /components/rigidbody/kind',
      'PP4101 prefabs/paddle.prefab.json /components/shape/color',
    ]);
  });

  it('engine components need their plugin', () => {
    const found = run(brick, {}, (d) => ({ ...d, game: { ...d.game!, plugins: d.game!.plugins.filter((p) => p.id !== 'physics3d') } }));
    expect(new Set(found.map((d) => d.code))).toEqual(new Set(['PP2066']));
    expect(found[0]!.fix).toBe('Add physics3d() to Game(plugins=[...]).');
  });

  it('behavior requires: placements are errors, code spawn sites count their components', () => {
    const noShape = run(brick, { 'prefabs/brick.prefab.json': (t) => t.replace('"shape": { "kind": "box", "size": [1.9, 0.6, 0.7] },', '') });
    expect(brief(noShape)).toEqual(['PP2104 game/systems/stages.py:44']);
    expect(noShape[0]!.severity).toBe('error');
    const placed = run(brick, { 'prefabs/ball.prefab.json': (t) => t.replace(/"rigidbody": \{[^}]*\},/, '') });
    expect(brief(placed)).toEqual(['PP2104 scenes/arena/scene.json /entities/8']);
  });

  it('config and content documents are complete and typed', () => {
    const found = run(brick, {
      'config/rules.json': (t) => t.replace('"lives": 3,', '"lives": "three",'),
      'content/stage/core.json': (t) => t.replace('"number": 5, ', ''),
      'content/upgrade/wide.json': (t) => t.replace('"paddle_width": 1.4', '"paddle_widht": 1.4'),
      'content/powerup/x.json': () => '{}',
      'config/extra.json': () => '{}',
    });
    expect(brief(found)).toEqual([
      'PP2058 config/extra.json',
      'PP4102 config/rules.json /lives',
      'PP2056 content/powerup/x.json',
      'PP4105 content/stage/core.json',
      'PP4104 content/upgrade/wide.json /paddle_widht',
    ]);
  });

  it('a locale key written where Localized text belongs (players would see the key)', () => {
    const found = run(brick, { 'content/upgrade/wide.json': (t) => t.replace('"name": "Wide Array"', '"name": "title_start"') });
    expect(brief(found)).toEqual(['PP2079 content/upgrade/wide.json /name']);
    expect(found[0]!.fix).toContain(JSON.stringify(brick.files['locale/en.json']!.match(/"title_start": ("[^"]*")/)![1]!.slice(1, -1)));
  });
});

describe('content code reads', () => {
  it('a content kind code reads with ctx.content() but no entry fills (PP2083, a warning)', () => {
    const files = Object.keys(brick.files).filter((p) => p.startsWith('content/upgrade/'));
    const example = { ...brick, files: Object.fromEntries(Object.entries(brick.files).filter(([p]) => !files.includes(p))) };
    const found = run(example).filter((d) => d.code === 'PP2083');
    expect(brief(found)).toEqual(['PP2083 game/systems/upgrades.py:19']);
    expect(found[0]!.severity).toBe('warning');
    expect(found[0]!.message).toBe('ctx.content(UpgradeDef) reads content kind "upgrade", which has no entries');
  });
});

describe('code against data', () => {
  it('project handles used in code must exist', () => {
    const found = run(brick, { 'prefabs/brick.prefab.json': () => '{}' }, (d) => ({
      ...d,
      project_refs: [...d.project_refs, { ref: ['Content', 'stage', 'cor'], path: 'game/x.py', line: 3, column: 0 },
        { ref: ['Text', 'scroe'], path: 'game/x.py', line: 4, column: 0 },
        { ref: ['Prefab', 'ball'], path: 'game/x.py', line: 5, column: 0 }],
    }));
    expect(found.filter((d) => d.path === 'game/x.py').map((d) => [d.code, d.fix])).toEqual([
      ['PP2057', 'Change "cor" to "core".'],
      ['PP2062', 'Change "scroe" to "score".'],
      ['PP2069', 'Change "Prefab" to "Prefabs".'],
    ]);
  });

  it('systems that never run, and scopes that never match', () => {
    const found = run(brick, {}, (d) => ({
      ...d,
      game: { ...d.game!, systems: d.game!.systems.filter((s) => s !== 'feedback') },
      systems: { ...d.systems, stages: { ...d.systems['stages']!, scenes: [{ scene: 'arnea', line: 1 }, { tag: 'level', line: 1 }] } },
    }));
    expect(brief(found)).toEqual(['PP2090 game/systems/feedback.py:13', 'PP2045 game/systems/stages.py:1', 'PP2091 game/systems/stages.py:1']);
  });
});

describe('UI bindings', () => {
  it('state keys, list items, actions, payloads and text keys', () => {
    const found = run(brick, {
      'ui/hud.html': (t) => t.replace('data-bind="combo"', 'data-bind="comob"').replace('data-action="pause"', 'data-action="pasue"')
        .replace('data-text="score"', 'data-text="scroe"'),
      'ui/draft.html': (t) => t.replace('data-bind="name"', 'data-bind="nmae"').replace('data-each="cards"', 'data-each="cleared"'),
      'ui/game_over.html': (t) => t.replace('data-format="int"', 'data-format="pecent"'),
    }, (d) => ({
      ...d,
      panels: { ...d.panels, draft: { ...d.panels['draft']!, state: rename(d.panels['draft']!.state!, 'upgrade') } },
    }));
    expect(found.map((d) => `${d.code} ${d.path!}:${d.line!} ${d.message}`)).toEqual([
      // Line numbers: the parity pass rewrote brick_breaker's panels in the template's kit markup.
      'PP2073 ui/draft.html:67 data-each="cleared" is not a list in draft.state()',
      'PP2075 ui/game_over.html:49 Unknown data-format "pecent"',
      'PP2062 ui/hud.html:68 data-text="scroe" is not a key of locale/en.json',
      'PP2070 ui/hud.html:73 data-bind="comob": "comob" is not a key of hud.state()',
      'PP2071 ui/hud.html:125 data-action="pasue" is not an action of panel "hud"',
    ]);
    const payload = run(brick, {}, (d) => ({
      ...d,
      panels: { ...d.panels, draft: { ...d.panels['draft']!, state: rename(d.panels['draft']!.state!, 'upgrade') } },
    }));
    // The kit's draft card also shows the upgrade's icon (data-attr-data-icon="upgrade"), which the renamed state lacks too.
    expect(payload.map((d) => `${d.code} ${d.message}`)).toEqual([
      'PP2074 data-action="pick" sends no "upgrade"',
      'PP2070 data-attr-data-icon="upgrade": "upgrade" is not a key of the data-each item',
    ]);
  });

  it('built-in icons by name', () => {
    const found = run(brick, {
      'ui/hud.html': (t) => t.replace('data-text="score"', 'data-text="score"><icon name="coin"></icon><icon name="skul"></icon><icon></icon'),
    });
    expect(found.filter((d) => d.code === 'PP2077').map((d) => `${d.message} | ${d.fix!.slice(0, 20)}`)).toEqual([
      'Unknown icon "skul" | Did you mean "skull"',
      '<icon> has no name | Built-in icons: blad',
    ]);
  });

  it('data-key="Escape" (the browser takes Escape to release the cursor lock)', () => {
    const found = run(brick, {
      'ui/hud.html': (t) => t.replace('data-action="pause"', 'data-action="pause" data-key="Escape"'),
    });
    expect(found.filter((d) => d.code === 'PP2078').map((d) => `${d.path!}:${d.line!} ${d.fix!}`)).toEqual([
      'ui/hud.html:125 Use data-key="KeyP" for pause and menus.',
    ]);
    const fine = run(brick, {
      'ui/hud.html': (t) => t.replace('data-action="pause"', 'data-action="pause" data-key="KeyP"'),
    });
    expect(fine.filter((d) => d.code === 'PP2078')).toEqual([]);
  });

  it('missing html files', () => {
    const files = run(brick, { 'ui/pause.html': () => '' }, (d) => ({ ...d, panels: { ...d.panels, pause_menu: { ...d.panels['pause_menu']!, html: 'ui/paus.html' } } }));
    expect(brief(files)).toEqual(['PP2072 game/ui.py:43']);
  });
});

describe('dialogue', () => {
  it('parses every .yarn file and checks its facts and commands against the declarations', () => {
    const path = 'story/elder_mirelle.yarn';
    const found = run(open_world_rpg, {
      [path]: (t) => t.replace('<<if not $welcome_hero_done>>', '<<if not $welcome_hero_dun>>\n<<ring_bell>>'),
      'story/scout_rowan.yarn': (t) => t.replace('---', 'oops'),
    });
    expect(brief(found).filter((d) => !d.startsWith('PP1010') &&!d.startsWith('PP2553'))).toEqual([
      `PP2184 ${path}:3`, `PP2187 ${path}:4`, 'PP2181 story/scout_rowan.yarn:2',
    ]);
  });

  it('expects dialogue lines in translations, by their line keys', () => {
    const fr = { ...JSON.parse(open_world_rpg.files['locale/en.json']!) as Record<string, string>, 'story.elder_mirelle.start.1': 'Tu es venu.' };
    const found = brief(run(open_world_rpg, { 'locale/fr.json': () => JSON.stringify(fr) }));
    expect(found).not.toContain('PP2061 locale/fr.json /story.elder_mirelle.start.1');
    expect(found).toContain('PP2060 locale/fr.json');
    expect(found).not.toContain('PP2061 locale/fr.json');
  });
});

describe('feature boundaries', () => {
  it('imports of another feature need requires and go through feature.py', () => {
    const found = run(open_world_rpg, {}, (d) => ({
      ...d,
      modules: {
        ...d.modules,
        'features.hero.x': { path: 'features/hero/x.py', feature: 'hero', imports: [{ module: 'features.quests.feature', line: 2 }] },
        'game.y': { path: 'game/y.py', feature: null, imports: [{ module: 'features.combat.systems', line: 3 }] },
      },
    }));
    expect(brief(found).filter((b) => /^PP201[5-8]/.test(b))).toEqual(['PP2015 features/hero/x.py:2', 'PP2016 game/y.py:3']);
  });

  it('cycles and unknown required features', () => {
    const found = run(open_world_rpg, {}, (d) => ({
      ...d,
      features: { ...d.features, hero: { ...d.features['hero']!, requires: ['combat', 'magic'] } },
    }));
    // hero ⇄ combat, and hero → combat → inventory → hero: two distinct cycles.
    expect(found.filter((x) => x.code === 'PP2017').map((x) => x.message).sort()).toEqual([
      'Features require each other in a cycle: combat → hero → combat',
      'Features require each other in a cycle: combat → inventory → hero → combat',
    ]);
    expect(found.filter((x) => x.code === 'PP2018').map((x) => x.message)).toEqual(['Feature "hero" requires unknown feature "magic"']);
  });
});

function rename(state: NonNullable<Declarations['panels'][string]['state']>, key: string): typeof state {
  if (state.kind !== 'object') return state;
  const cards = state.keys['cards'];
  if (cards === undefined || cards.kind !== 'list' || cards.item.kind !== 'object') return state;
  const { [key]: _, ...rest } = cards.item.keys;
  return { ...state, keys: { ...state.keys, cards: { kind: 'list', item: { ...cards.item, keys: rest } } } };
}

describe('scene inheritance ("extends")', () => {
  it('brick_breaker\'s title extends arena; a bad base or exclude is reported at the title file', () => {
    const found = run(brick, {
      'scenes/title/scene.json': (t) => t.replace('"extends": "arena"', '"extends": "arean"'),
    });
    expect(brief(found)).toContain('PP2047 scenes/title/scene.json /extends');
    expect(found.find((d) => d.code === 'PP2047')?.fix).toBe('Change "arean" to "arena".');
    const excluded = run(brick, { 'scenes/title/scene.json': (t) => t.replace('"paddle"', '"padle"') });
    expect(brief(excluded)).toEqual(['PP2049 scenes/title/scene.json /exclude/1']);
    expect(excluded[0]?.fix).toBe('Did you mean "paddle"?');
  });

  it('a problem in an inherited placement is reported once, at the base file', () => {
    const found = run(brick, {
      'scenes/arena/scene.json': (t) => t.replace('{ "prefab": "camera"', '{ "prefab": "camera", "components": { "camra": {} }'),
    });
    expect(brief(found)).toEqual(['PP2050 scenes/arena/scene.json /entities/0/components/camra']);
  });
});
