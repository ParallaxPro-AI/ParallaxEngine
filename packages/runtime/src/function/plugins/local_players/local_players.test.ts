import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { EntityRecord, GameDefinition, Schema } from '../../kernel/index.js';
import { PLAYERS_SERVICE } from '../../services/index.js';
import { localPlayers, viewport } from './index.js';
import type { LocalPlayersOptions } from './index.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const PLAYER_START: Schema = { seat: t.int({ default: -1 }) };
const CAMERA: Schema = {
  follow: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null },
  viewport: t.list({ kind: 'number' }, { default: [0, 0, 1, 1] }),
};
const DEFINITION: GameDefinition = {
  components: [{ id: 'player_start', schema: PLAYER_START }, { id: 'camera', schema: CAMERA }, { id: 'chef', schema: {} }],
  resources: [], events: [], behaviors: [], systems: [],
};

const DATA = {
  'prefabs/chef.prefab.json': { components: { chef: {} } },
  'prefabs/chef_camera.prefab.json': { components: { camera: {} } },
  'prefabs/start.prefab.json': { components: { player_start: {} } },
  'prefabs/lamp.prefab.json': { components: {} },
  'scenes/kitchen/scene.json': { entities: [
    { prefab: 'start', at: [6, 0, 0], rotation: [0, 90, 0], components: { player_start: { seat: 1 } } },
    { prefab: 'start', at: [-6, 0, 0], components: { player_start: { seat: 0 } } },
  ] },
  'scenes/any/scene.json': { entities: [
    { prefab: 'start', at: [1, 0, 0] },
    { prefab: 'start', at: [2, 0, 0] },
  ] },
  'scenes/title/scene.json': { entities: [{ prefab: 'lamp' }] },
  'scenes/short/scene.json': { entities: [{ prefab: 'start', components: { player_start: { seat: 0 } } }] },
};

const OPTIONS: LocalPlayersOptions = {
  seats: 2, playerPrefab: 'chef', controls: ['p1', 'p2'], cameraPrefab: 'chef_camera', splitScreen: 'vertical',
};

function start(scene: string, options: Partial<LocalPlayersOptions> = {}): Kernel {
  const project = loadProject(files(DATA));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({ project, game: DEFINITION, plugins: [localPlayers({ ...OPTIONS, ...options })] });
  kernel.start(scene);
  return kernel;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ParallaxError) return error.diagnostic.code;
    throw error;
  }
  throw new Error('expected a coded error');
}

const byPrefab = (kernel: Kernel, prefab: string): EntityRecord[] => [...kernel.world.live()].filter((r) => r.prefab === prefab);

describe('local_players', () => {
  it('spawns each seat at its PlayerStart, owned by the seat, with a camera in its viewport', () => {
    const kernel = start('kitchen');
    const service = kernel.service(PLAYERS_SERVICE);
    const chefs = byPrefab(kernel, 'chef');
    expect(chefs.map((r) => [r.owner, r.transform.position.x])).toEqual([[0, -6], [1, 6]]);
    expect(chefs[1]!.transform.rotation.to_euler().y).toBeCloseTo(90);
    expect(service.entity(0)).toBe(chefs[0]!.id);
    expect(service.entity(1)).toBe(chefs[1]!.id);
    const cameras = byPrefab(kernel, 'chef_camera');
    expect(cameras.map((r) => [r.owner, r.components.get('camera')!['follow'], r.components.get('camera')!['viewport']]))
      .toEqual([[0, chefs[0]!.id, [0, 0, 0.5, 1]], [1, chefs[1]!.id, [0.5, 0, 0.5, 1]]]);
  });

  it('lists the seats with their devices and controls', () => {
    const kernel = start('kitchen');
    expect(kernel.service(PLAYERS_SERVICE).seats()).toEqual([
      { index: 0, id: 'local-0', name: 'Player 1', local: true, input: { keyboard: true, mouse: true, touch: true, gamepad: 0, controls: 'p1' } },
      { index: 1, id: 'local-1', name: 'Player 2', local: true, input: { keyboard: true, mouse: false, touch: false, gamepad: 1, controls: 'p2' } },
    ]);
    const pads = start('kitchen', { controls: 'gamepads' }).service(PLAYERS_SERVICE).seats();
    expect(pads.map((s) => s.input)).toEqual([
      { keyboard: true, mouse: true, touch: true, gamepad: 0 },
      { keyboard: false, mouse: false, touch: false, gamepad: 1 },
    ]);
  });

  it('uses free seat=-1 starts, spawns nothing without starts, and respawns on every scene load', () => {
    expect(byPrefab(start('any'), 'chef').map((r) => r.transform.position.x)).toEqual([1, 2]);
    const kernel = start('title');
    expect(byPrefab(kernel, 'chef')).toEqual([]);
    expect(kernel.service(PLAYERS_SERVICE).entity(0)).toBeNull();
    kernel.requestScene('kitchen');
    kernel.step(1 / 60);
    expect(byPrefab(kernel, 'chef')).toHaveLength(2);
  });

  it('a scene with starts must have one for every seat', () => {
    expect(code(() => start('short'))).toBe('PP3962');
  });

  it('checks its options', () => {
    expect(code(() => localPlayers({ ...OPTIONS, seats: 0 }))).toBe('PP3960');
    expect(code(() => localPlayers({ ...OPTIONS, controls: ['p1'] }))).toBe('PP3960');
    expect(code(() => localPlayers({ ...OPTIONS, splitScreen: 'none' }))).toBe('PP3960');
    expect(code(() => start('kitchen', { playerPrefab: 'cook' }))).toBe('PP3961');
    expect(code(() => start('kitchen', { cameraPrefab: 'lamp' }))).toBe('PP3961');
    expect(byPrefab(start('kitchen', { splitScreen: 'none', cameraPrefab: null }), 'chef_camera')).toEqual([]);
  });
});

describe('viewport', () => {
  it('splits the screen per layout', () => {
    expect(viewport('vertical', 2, 3)).toEqual([2 / 3, 0, 1 / 3, 1]);
    expect(viewport('horizontal', 1, 2)).toEqual([0, 0.5, 1, 0.5]);
    expect([0, 1, 2].map((i) => viewport('grid', i, 3))).toEqual([[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5]]);
    expect(viewport('none', 1, 2)).toEqual([0, 0, 1, 1]);
  });
});
