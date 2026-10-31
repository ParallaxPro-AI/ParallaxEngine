/**
 * `parallax.interaction` the way a game uses it: `plugins.interaction(action=Controls.interact)`,
 * Interactable / Interactor in prefab JSON, `@on(Interacted)` on the interactable's behavior,
 * the real input engine behind the actions service (keyboard, gamepad, remaps, modal mute),
 * and the built-in prompt panel's state.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ParallaxError } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { Actions, button, gamepad } from './input.js';
import { Behavior, behavior, createRuntime, EntityRef, Game, kw, on, resetDeclarations, SceneRef } from './index.js';
import type { Context, Entity, GameRuntime } from './index.js';
import { Interacted, interaction, InteractPromptPanel, Interactor } from './interaction.js';
import { registeredPanels } from './ui.js';

const STEP = 1 / 60;

beforeEach(() => resetDeclarations());

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

function setup(chest: Record<string, unknown> = {}): { r: GameRuntime; input: HeadlessInput; heard: string[]; Controls: typeof Actions & { interact: unknown } } {
  class Controls extends Actions {
    static interact = button(kw({ keyboard: 'KeyE', gamepad: gamepad.WEST }));
  }
  Controls.__init_subclass__();
  const heard: string[] = [];
  class Chest extends Behavior {
    declare entity: Entity;
    opened(_ctx: Context, e: { entity: Entity; source: Entity }) { heard.push(`${e.entity.name} by ${e.source.name}`); }
  }
  on(Interacted)(Chest.prototype.opened);
  behavior('chest')(Chest);
  const projectFiles = files({
    'prefabs/player.prefab.json': { components: { interactor: {} } },
    'prefabs/chest.prefab.json': { components: { interactable: { prompt: 'Open', ...chest } }, behaviors: { chest: {} } },
    'prefabs/cam.prefab.json': { components: { camera: { rig: 'fixed' } } },
    'scenes/main/scene.json': {
      entities: [
        { prefab: 'player', id: 'player', at: [0, 0, 0] },
        { prefab: 'chest', id: 'chest', at: [0, 0, 2] },
        { prefab: 'cam', id: 'cam', at: [0, 1.6, -3] },
      ],
    },
  });
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const input = new HeadlessInput();
  const game = new Game(kw({
    id: 't', title: 'T', sdk: '1.0', start_scene: new SceneRef('main'), mode: '3d', plugins: [interaction(kw({ action: Controls.interact }))],
  }));
  const r = createRuntime(game, project, {
    seed: 1, devices: input, audio: new HeadlessAudio(), assets: null, files: projectFiles, surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  r.start();
  r.step(STEP);
  return { r, input, heard, Controls: Controls as never };
}

describe('parallax.interaction', () => {
  it('a key press on the focused interactable reaches its behavior; the prompt shows the key', () => {
    const { r, input, heard } = setup();
    r.step(STEP);
    const player = r.ctx.world.placed(new EntityRef('player'));
    const chest = r.ctx.world.placed(new EntityRef('chest'));
    expect((player.get(Interactor) as unknown as { focus: Entity | null }).focus).toBe(chest);
    expect(registeredPanels()).toContain(InteractPromptPanel);
    const prompt = r.uiEngine.view('interact_prompt')!.states[0] as Record<string, unknown>;
    expect(prompt).toMatchObject({ shown: true, text: 'Open', hold: false, anchored: true });
    expect(prompt['keys']).toEqual([expect.objectContaining({ text: 'E', code: 'KeyE', device: 'keyboard' })]);
    input.tapKey('KeyE');
    r.step(STEP);
    expect(heard).toEqual(['chest by player']);
  });

  it('the prompt follows the device and the player\'s remap', () => {
    const { r, input } = setup();
    (r.resource('settings') as { controls: { __setitem__(k: string, v: string): void } }).controls.__setitem__('Controls.interact:key', 'KeyF');
    r.step(STEP);
    r.step(STEP);
    let prompt = r.uiEngine.view('interact_prompt')!.states[0] as { keys: { text: string }[] };
    expect(prompt.keys[0]!.text).toBe('F');
    input.padDown('west');
    r.step(STEP);
    r.step(STEP);
    prompt = r.uiEngine.view('interact_prompt')!.states[0] as { keys: { text: string; pad: boolean }[] };
    expect(prompt.keys[0]).toMatchObject({ text: 'X', pad: true });
  });

  it('hold-to-interact fills progress before firing', () => {
    const { r, input, heard } = setup({ hold: 0.5 });
    input.keyDown('KeyE');
    for (let i = 0; i < 15; i++) r.step(STEP);
    const prompt = r.uiEngine.view('interact_prompt')!.states[0] as Record<string, unknown>;
    expect(prompt['hold']).toBe(true);
    expect(Number.parseFloat(String(prompt['fill']))).toBeGreaterThan(40);
    expect(heard).toEqual([]);
    for (let i = 0; i < 20; i++) r.step(STEP);
    expect(heard).toEqual(['chest by player']);
  });

  it('interaction(action=) takes a button', () => {
    expect(code(() => interaction(kw({ action: 'KeyE' })))).toBe('PP4580');
    expect(code(() => interaction())).toBe('PP3030');
  });
});
