/**
 * Animation data in a real example (platformer, read-only, copied into memory): graphs,
 * authored clips, and with asset files the clip and bone names against the model.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('../../../examples/platformer', import.meta.url));

let files: Record<string, string>;
let declarations: Declarations;

beforeAll(() => {
  const tree = directoryFiles(DIR);
  files = {};
  // Without the example's own models (its hero.model.json has its own clips): each case brings its model.
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path) && !path.startsWith('assets/models/')) files[path] = tree.read(path);
  const extracted = runExtract(DIR);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

const PLAYER = 'prefabs/player.prefab.json';

function run(extra: Record<string, unknown>, animator: unknown, assetFiles = false): string[] {
  const all: Record<string, string> = { ...files };
  for (const [path, value] of Object.entries(extra)) all[path] = typeof value === 'string' ? value : JSON.stringify(value);
  const player = JSON.parse(all[PLAYER]!) as { components: Record<string, unknown> };
  player.components['animator'] = animator;
  if (assetFiles) player.components['model'] = { model: 'assets/models/hero.gltf' };
  all[PLAYER] = JSON.stringify(player);
  const found: readonly Diagnostic[] = checkFiles(memoryFiles(all), structuredClone(declarations), { assetFiles }).diagnostics;
  return found
    .filter((d) => d.path === PLAYER && d.pointer?.startsWith('/components/animator') === true || d.path?.startsWith('assets/clips/') === true)
    .map((d) => `${d.code} ${d.path} ${d.pointer ?? ''}`.trim());
}

const GRAPH = {
  params: { speed: 0, grounded: true },
  layers: [
    { name: 'base', states: { move: { blend: { param: 'speed', clips: [{ at: 0, clip: 'idle' }, { at: 4, clip: 'run' }] } }, air: { clip: 'air' } },
      transitions: [{ from: 'move', to: 'air', when: ['not grounded'] }, { from: 'air', to: 'move', when: ['grounded'] }] },
    { name: 'upper', mask: ['Spine2'] },
  ],
  events: { run: [{ time: 0.2, name: 'footstep' }] },
};

describe('animation checks', () => {
  it('a sound graph checks clean, with SDK fields and graph data alike', () => {
    expect(run({}, { ...GRAPH, root_motion: 'character', speed: 1.2 })).toEqual([]);
  });

  it('graph problems at their pointers, with the runtime\'s codes', () => {
    expect(run({}, {
      params: { speed: 0 },
      layers: [{ name: 'base', states: { move: { clip: 'run' } }, transitions: [{ from: 'move', to: 'jmp', when: ['sped > 1'] }] }],
    })).toEqual([
      'PP3762 prefabs/player.prefab.json /components/animator/layers/0/transitions/0/to',
      'PP3761 prefabs/player.prefab.json /components/animator/layers/0/transitions/0/when/0',
    ]);
    // Typed SDK fields are checked against the schema like any component's.
    expect(run({}, { root_motion: 'yes' })).toEqual(['PP4102 prefabs/player.prefab.json /components/animator/root_motion']);
  });

  it('authored clip files are read; a graph naming a missing one is PP2063 (with asset files)', () => {
    const clip = { rig: 'humanoid', duration: 1, keys: [{ time: 0, pose: { RightArm: [0, 0, 80] } }] };
    const gltf = JSON.stringify({ asset: { version: '2.0' }, nodes: [{ name: 'mixamorig:Hips' }, { name: 'mixamorig:Spine2' }], animations: [{ name: 'idle' }, { name: 'run' }] });
    expect(run({ 'assets/clips/wave.clip.json': clip, 'assets/models/hero.gltf': gltf }, {
      ...GRAPH,
      layers: [GRAPH.layers[0], { name: 'upper', mask: ['Spine2', 'Chest9'] }],
      events: { 'clips/wave': [{ time: 0.5, name: 'hello' }], 'clips/wav': [] },
    }, true)).toEqual([
      'PP3805 prefabs/player.prefab.json /components/animator/layers/0/states/air/clip',
      'PP2063 prefabs/player.prefab.json /components/animator/events/clips~1wav',
      'PP3780 prefabs/player.prefab.json /components/animator/layers/1/mask/1',
    ].sort((a, b) => a.split(' ')[2]!.localeCompare(b.split(' ')[2]!)));
    expect(run({ 'assets/clips/bad.clip.json': { rig: 'humanoid', duration: 1, keys: [{ time: 0, pose: { Tail1: [0, 0, 0] } }] } }, GRAPH))
      .toEqual(['PP3782 assets/clips/bad.clip.json /keys/0/pose/Tail1']);
  });

  it('Assets.clips.<name> is a ClipRef of the authored clip', () => {
    const clip = { rig: 'humanoid', duration: 1, keys: [{ time: 0, pose: { RightArm: [0, 0, 80] } }] };
    const project = checkFiles(memoryFiles({ ...files, 'assets/clips/wave.clip.json': JSON.stringify(clip) }), structuredClone(declarations), { assetFiles: true }).project!;
    expect(project.js).toContain('wave: clipRef("clips/wave")');
    expect(project.pyi).toContain('wave: ClassVar[ClipRef]');
  });
});

describe('animators on model documents (code models have no clips)', () => {
  const CRATE = fileURLToPath(new URL('../../../examples/tank_battle/assets/models/crate.model.json', import.meta.url));

  function found(animator: unknown, assetFiles: boolean): string[] {
    const all: Record<string, string> = { ...files, 'assets/models/crate.model.json': directoryFiles(CRATE.replace(/\/[^/]+$/, '')).read('crate.model.json') };
    const player = JSON.parse(all[PLAYER]!) as { components: Record<string, unknown> };
    player.components['animator'] = animator;
    player.components['model'] = { model: 'assets/models/crate.model.json' };
    all[PLAYER] = JSON.stringify(player);
    return checkFiles(memoryFiles(all), structuredClone(declarations), { assetFiles }).diagnostics
      .filter((d) => d.path === PLAYER && d.pointer?.startsWith('/components/animator') === true)
      .map((d) => `${d.code} ${d.pointer} ${d.fix ?? ''}`);
  }

  it('reports a default_clip the model document cannot have, with or without the asset files', () => {
    for (const assetFiles of [false, true]) {
      const out = found({ default_clip: 'idle' }, assetFiles);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(/^PP3805 \/components\/animator\/default_clip .*model document, which has no animations/);
    }
  });

  it('accepts authored clips on a model document', () => {
    expect(found({ default_clip: 'clips/wave' }, false)).toEqual([]);
  });
});
