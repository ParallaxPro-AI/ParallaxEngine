/**
 * Cinematic checks over an in-memory project, with a real example's declarations (core
 * components as the extract pass gives them) plus the cinematics plugin's engine
 * declarations: a clean cinematic, then each problem one at a time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadProject } from '@parallax/runtime/resource';
import { checkCinematics } from './cinematics_checks.js';
import { CheckContext } from './context.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('../../../examples/paddle_duel', import.meta.url));
let declarations: Declarations;

beforeAll(() => {
  const extracted = runExtract(DIR);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  const decl = structuredClone(extracted.declarations) as unknown as {
    game: { plugins: { id: string; options: unknown; line: number }[] };
    engine: { components: Record<string, unknown>; content: Record<string, unknown> };
  };
  decl.game.plugins.push({ id: 'cinematics', options: {}, line: 1 });
  decl.engine.content['cinematic'] = {
    name: 'CinematicDef', module: 'parallax.cinematics', plugins: ['cinematics'], localized: [], fields: {
      duration: { type: { kind: 'optional', of: { kind: 'number' } }, default: null, min: 0 },
      skippable: { type: { kind: 'bool' }, default: true },
      scenes: { type: { kind: 'list', of: { kind: 'ref', to: 'scene' } }, default: [] },
      bind: { type: { kind: 'list', of: { kind: 'string' } }, default: [] },
      tracks: { type: { kind: 'list', of: { kind: 'json' } }, default: [] },
    },
  };
  decl.engine.components['cinematic_trigger'] = {
    name: 'CinematicTrigger', module: 'parallax.cinematics', plugins: ['cinematics'], fields: {
      cinematic: { type: { kind: 'ref', to: 'content/cinematic' } },
      radius: { type: { kind: 'number' }, default: 3, min: 0 },
      activator: { type: { kind: 'tag' } },
      once: { type: { kind: 'bool' }, default: true },
      fired: { type: { kind: 'bool' }, default: false },
      occupied: { type: { kind: 'bool' }, default: false },
    },
  };
  declarations = decl as unknown as Declarations;
});

const INTRO = {
  bind: ['hero'],
  tracks: [
    { type: 'camera', camera: 'cam', keys: [{ t: 1, position: [0, 2, -4], relative_to: 'hero', look_at: 'gate' }] },
    { type: 'transform', target: 'gate', keys: [{ t: 1, position: [0, 4, 0] }] },
    { type: 'property', target: 'lamp', field: 'light.intensity', keys: [{ t: 0, value: 0 }, { t: 2, value: 3 }] },
    { type: 'property', target: 'lamp', field: 'light.color', keys: [{ t: 2, value: '#ff8800' }] },
    { type: 'event', keys: [{ t: 2, name: 'done' }] },
  ],
};

function run(cinematics: Record<string, unknown>, extra: Record<string, unknown> = {}): string[] {
  const contents: Record<string, unknown> = {
    'prefabs/cam.prefab.json': { components: { camera: {} } },
    'prefabs/thing.prefab.json': { components: {} },
    'prefabs/lamp.prefab.json': { components: { light: {} } },
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'cam', id: 'cam' }, { prefab: 'thing', id: 'gate' }, { prefab: 'lamp', id: 'lamp' },
      ],
    },
    'scenes/other/scene.json': { entities: [{ prefab: 'thing', id: 'gate' }] },
    ...Object.fromEntries(Object.entries(cinematics).map(([id, v]) => [`content/cinematic/${id}.json`, v])),
    ...extra,
  };
  const files = memoryFiles(Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)])));
  const project = loadProject(files);
  expect(project.diagnostics).toEqual([]);
  const ctx = new CheckContext(files, project, declarations, { assetFiles: false });
  checkCinematics(ctx);
  return ctx.out.map((d) => `${d.code}${d.severity === 'warning' ? '?' : ''} ${d.path ?? ''}${d.pointer ?? ''}`);
}

describe('cinematic checks', () => {
  it('a sound cinematic passes', () => {
    expect(run({ intro: INTRO })).toEqual([]);
  });

  it('reports the parser\'s problems as they are', () => {
    expect(run({ bad: { tracks: [{ type: 'transform', target: 'gate', keys: [{ t: 1, position: [0, 0, 0], ease: 'wobble' }] }] } }))
      .toEqual(['PP7203 content/cinematic/bad.json/tracks/0/keys/0/ease']);
  });

  it('targets resolve to bind names or placed ids (in every autoplay scene)', () => {
    expect(run({ a: { tracks: [{ type: 'visibility', target: 'gaet', keys: [{ t: 1, visible: false }] }] } }))
      .toEqual(['PP2650 content/cinematic/a.json/tracks/0/target']);
    expect(run({ a: { scenes: ['main', 'other'], tracks: [{ type: 'visibility', target: 'lamp', keys: [{ t: 1, visible: false }] }] } }))
      .toEqual(['PP2650 content/cinematic/a.json/tracks/0/target']);
    expect(run({ a: { scenes: ['main', 'other'], tracks: [{ type: 'visibility', target: 'gate', keys: [{ t: 1, visible: false }] }] } }))
      .toEqual([]);
  });

  it('property paths, field kinds and key values', () => {
    const prop = (field: string, value: unknown, target = 'lamp') => ({ tracks: [{ type: 'property', target, field, keys: [{ t: 1, value }] }] });
    expect(run({ a: prop('lite.intensity', 1) })).toEqual(['PP2651 content/cinematic/a.json/tracks/0/field']);
    expect(run({ a: prop('light.brightness', 1) })).toEqual(['PP2652 content/cinematic/a.json/tracks/0/field']);
    expect(run({ a: prop('light.intensity', 'bright') })).toEqual(['PP2653 content/cinematic/a.json/tracks/0/keys/0/value']);
    expect(run({ a: prop('light.intensity', 2, 'gate') })).toEqual(['PP2655? content/cinematic/a.json/tracks/0/field']);
  });

  it('autoplay conflicts and binds; triggers bind only "activator"; the camera entity has a Camera', () => {
    const plain = { scenes: ['main'], tracks: [{ type: 'event', keys: [{ t: 1, name: 'x' }] }] };
    expect(run({ a: plain, b: plain })).toEqual(['PP2654 content/cinematic/b.json/scenes/0']);
    expect(run({ a: { ...plain, bind: ['hero'] } })).toEqual(['PP2656 content/cinematic/a.json/bind']);
    expect(run({ intro: INTRO }, { 'prefabs/zone.prefab.json': { components: { cinematic_trigger: { cinematic: 'intro', activator: 'player' } } } }))
      .toEqual(['PP2657 prefabs/zone.prefab.json/components/cinematic_trigger/cinematic']);
    expect(run({ a: { tracks: [{ type: 'camera', camera: 'gate', keys: [{ t: 1, fov: 30 }] }] } }))
      .toEqual(['PP2655? content/cinematic/a.json/tracks/0/camera']);
  });
});
