/**
 * `@ui` panels and actions wired to real input through `interfacePlugins`, on a real
 * kernel: the derive-don't-toggle rules end to end.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Color, ParallaxError, Vec3 } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { Kernel } from '../function/kernel/index.js';
import { actionDecl, HeadlessInput } from '../function/plugins/input/index.js';
import { UiDriver } from '../function/plugins/ui/index.js';
import { Settings } from './builtins.js';
import { event, resource } from './declarations.js';
import { Actions, button, resetActionSets } from './input.js';
import { kw, Kwargs } from './kwargs.js';
import { dictEntries } from './py.js';
import { bind, fn_annotations, pyfn, sig } from './pyrt/index.js';
import { loadProject } from '../resource/index.js';
import { rt, schemaOf, SceneRef, Tag } from './types.js';
import type { AnyClass } from './types.js';
import {
  action, close_panel, FloatStyle, interfacePlugins, load_scene, open_panel, Panel, PanelCommand, reload_scene, resetPanels,
  SettingsPanel, ui, UiApi,
} from './ui.js';

const DT = 1 / 60;
const Level = new Tag('level');

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

afterEach(() => { resetActionSets(); resetPanels(); });

/** A small game in the shape of the examples' ui.py / actions.py. */
function game(scene = 'level') {
  class RunC {
    static __annotations__ = { level: () => rt.int, lives: () => rt.int };
    static level = 1;
    static lives = 3;
  }
  const Run = resource('run')(RunC) as AnyClass & (new (...a: unknown[]) => object);

  class Controls extends Actions {
    static pause = button(kw({ keyboard: ['KeyP', 'Escape'] }));
    static jump = button(kw({ keyboard: 'Space' }));
    static override scenes = [Level];
  }
  Controls.__init_subclass__();

  const picks: unknown[][] = [];
  function pick(ctx: unknown, slot: number, kind: string): unknown {
    picks.push([ctx, slot, kind]);
    return kind === 'done' ? close_panel() : null;
  }
  (pick as unknown as { __annotations__: unknown }).__annotations__ = {
    slot: () => rt.int, kind: () => rt.literal('sword', 'shield', 'done'),
  };
  let rerolls = 0;
  const reroll = action(kw({ when: (ctx: { get(c: unknown): Record<string, number> }) => ctx.get(Run)['lives']! > 1 }))(
    function reroll(): void { rerolls++; },
  );
  // `def start(ctx, mode: str, stage: int = 0)`, exactly as the transpiler emits it.
  const starts: unknown[][] = [];
  const startSig = sig('start', ['ctx', 'mode', 'stage'], 0, [0], [], [], null, null, false);
  const start = fn_annotations(pyfn(function (ctx: unknown, mode: unknown, stage: unknown) {
    // eslint-disable-next-line prefer-rest-params
    if (arguments.length !== 3 || arguments[2] instanceof Kwargs) [ctx, mode, stage] = bind(startSig, arguments);
    starts.push([mode, stage]);
  }, () => startSig), { mode: () => rt.str, stage: () => rt.int });
  class PickedC { static __annotations__ = { slot: () => rt.int }; }
  const Picked = event('picked')(PickedC);

  const Pause = ui('pause_menu', kw({ html: 'ui/pause.html', modal: true, layer: 'menu', scenes: [Level], toggle_with: Controls.pause }))(
    class PauseMenu extends Panel {
      static override actions: unknown = {
        resume: close_panel(),
        settings: open_panel(SettingsPanel),
        quit: load_scene(new SceneRef('title'), kw({ new_run: true })),
      };
    },
  );
  const Over = ui('game_over', kw({ html: 'ui/over.html', modal: true, when: (ctx: { get(c: unknown): Record<string, number> }) => ctx.get(Run)['lives'] === 0, delay: 0.5 }))(
    class GameOver extends Panel {
      static override actions: unknown = { retry: reload_scene(kw({ new_run: true })) };
      override state(ctx: { get(c: unknown): Record<string, number> }): unknown { return { level: ctx.get(Run)['level'] }; }
    },
  );
  const Hud = ui('hud', kw({ html: 'ui/hud.html' }))(
    class Hud extends Panel {
      static override actions: unknown = {
        pause: open_panel(Pause), pick, reroll, picked: Picked, start,
        level3: load_scene(new SceneRef('level'), kw({ init: [new Run(kw({ level: 3 }))] })),
      };
    },
  );
  const Title = ui('title', kw({ html: 'ui/title.html', layer: 'menu' }))(class Title extends Panel {});

  const project = loadProject(files({
    'scenes/level/scene.json': { tags: ['level'], ui: ['hud'], entities: [] },
    'scenes/title/scene.json': { ui: ['title'], entities: [] },
  }));
  expect(project.diagnostics).toEqual([]);
  const devices = new HeadlessInput();
  const emitted: unknown[] = [];
  const plugins = interfacePlugins({
    devices, content: { content: (_t, id) => id },
    overrides: () => Object.fromEntries(dictEntries(kernel.resource('settings')['controls'], 'controls')) as Record<string, string>,
  });
  const context: Record<string, unknown> = {
    get: (cls: { __resource_id__: string }) => kernel.resource(cls.__resource_id__),
    emit: (e: unknown) => emitted.push(e),
    __languages__: () => ['en', 'fr'],
  };
  const kernel: Kernel = new Kernel({
    project,
    game: {
      components: [], events: [], behaviors: [], systems: [],
      resources: [
        { id: 'run', schema: schemaOf(Run, 'resource Run').schema },
        { id: 'settings', schema: schemaOf(Settings as AnyClass, 'resource Settings').schema, keep: 'profile' },
      ],
    },
    plugins: [plugins.input, plugins.ui],
    context,
  });
  context['ui'] = plugins.ui.namespace!.create(kernel);
  context['input'] = plugins.input.namespace!.create(kernel);
  kernel.start(scene);
  const step = (n = 1): void => { for (let i = 0; i < n; i++) kernel.step(DT); };
  const tap = (key: string): void => { devices.tapKey(key); step(); };
  return {
    kernel, devices, step, tap, picks, starts, emitted, Controls, Pause, Over, Hud, Title,
    rerolls: () => rerolls,
    input: plugins.input.engine, engine: plugins.ui.engine, driver: new UiDriver(plugins.ui.engine),
    ctxUi: context['ui'] as UiApi,
    run: () => kernel.resource('run'),
  };
}

describe('pause, derived', () => {
  it('toggle_with opens the pause menu and the same key closes it; time freezes and gameplay input is muted meanwhile', () => {
    const g = game();
    g.step();
    g.tap('KeyP');
    expect(g.engine.isOpen(g.Pause)).toBe(true);
    expect(g.kernel.time.frozen).toBe(true);
    expect(g.devices.output?.cursor).toBe('free');

    g.devices.keyDown('Space');
    g.step();
    expect(g.input.pressed(g.Controls.jump.__action__)).toBe(false); // muted under the modal
    g.devices.keyUp('Space');

    g.tap('Escape'); // the other key of the same action
    expect(g.engine.isOpen(g.Pause)).toBe(false);
    expect(g.kernel.time.frozen).toBe(false);
    g.devices.keyDown('Space');
    g.step();
    expect(g.input.pressed(g.Controls.jump.__action__)).toBe(true);
  });

  it('a panel button still works under the modal while gameplay keys are muted', () => {
    const g = game();
    g.tap('KeyP');
    g.driver.click(g.Pause, 'resume');
    g.step();
    expect(g.engine.isOpen(g.Pause)).toBe(false);
  });

  it('settings opened from pause stacks on top; the pause key leaves it alone; closing settings returns to pause', () => {
    const g = game();
    g.tap('KeyP');
    g.driver.click(g.Pause, 'settings');
    g.step();
    expect(g.driver.openPanels()).toEqual(['hud', 'pause_menu', 'settings']);
    g.tap('KeyP');
    expect(g.driver.openPanels()).toEqual(['hud', 'pause_menu', 'settings']);
    expect(Object.keys(g.driver.stateOf(SettingsPanel))).toContain('master_volume');
    g.driver.click(SettingsPanel, 'back');
    g.step();
    expect(g.driver.openPanels()).toEqual(['hud', 'pause_menu']);
    expect(g.kernel.time.frozen).toBe(true);
  });

  it('the settings menu edits Settings: volumes and sensitivities in range, quality and language cycle, invert toggles', () => {
    const g = game();
    g.tap('KeyP');
    g.driver.click(g.Pause, 'settings');
    g.step();
    const settings = g.kernel.resource('settings');
    g.driver.click(SettingsPanel, 'adjust', { setting: 'master_volume', step: '-0.1' });
    g.driver.click(SettingsPanel, 'adjust', { setting: 'sfx_volume', step: '0.1' });
    g.driver.click(SettingsPanel, 'adjust', { setting: 'mouse_sensitivity', step: '-5' });
    g.driver.click(SettingsPanel, 'cycle', { setting: 'quality', step: '1' });
    g.driver.click(SettingsPanel, 'cycle', { setting: 'language', step: '-1' });
    g.driver.click(SettingsPanel, 'toggle', { setting: 'invert_look' });
    g.step();
    expect([settings['master_volume'], settings['sfx_volume'], settings['mouse_sensitivity']]).toEqual([0.9, 1, 0.1]);
    expect([settings['quality'], settings['language'], settings['invert_look']]).toEqual(['low', 'fr', true]);
    expect(g.driver.stateOf(SettingsPanel)).toMatchObject({ master_volume: 0.9, quality: 'low', languages_many: true });
    g.driver.click(SettingsPanel, 'adjust', { setting: 'quality', step: '1' });
    expect(code(() => g.step())).toBe('PP4440');
  });

  it('rebinding: the next key becomes the binding (the action reads it), Escape cancels, reset restores', () => {
    const g = game();
    g.tap('KeyP');
    g.driver.click(g.Pause, 'settings');
    g.step();
    const rows = () => g.driver.stateOf(SettingsPanel)['controls'] as Record<string, unknown>[];
    expect(rows().map((r) => [r['slot'], r['label'], r['binding']])).toEqual([
      ['Controls.pause:key', 'Pause', 'P'], ['Controls.jump:key', 'Jump', 'Space'],
    ]);
    g.driver.click(SettingsPanel, 'rebind', { slot: 'Controls.jump:key' });
    g.step();
    expect(g.driver.stateOf(SettingsPanel)['capturing']).toBe(true);
    expect(g.input.capturing).toBe('Controls.jump:key');
    g.tap('KeyJ');
    g.step();
    expect(dictEntries(g.kernel.resource('settings')['controls'], 'c')).toEqual([['Controls.jump:key', 'KeyJ']]);
    expect(rows()[1]).toMatchObject({ binding: 'J', changed: true, capturing: false });
    // Back to play: J jumps, Space no longer does.
    g.driver.click(SettingsPanel, 'back');
    g.step();
    g.tap('KeyP');
    g.devices.tapKey('KeyJ');
    g.step();
    expect(g.input.pressed(actionDecl(g.Controls.jump) as never)).toBe(true);
    g.tap('Space');
    expect(g.input.pressed(actionDecl(g.Controls.jump) as never)).toBe(false);
    // Escape cancels a capture; reset_controls restores the declared keys.
    g.tap('KeyP');
    g.driver.click(g.Pause, 'settings');
    g.step();
    g.driver.click(SettingsPanel, 'rebind', { slot: 'Controls.pause:key' });
    g.step();
    g.tap('Escape');
    g.step();
    expect(g.input.capturing).toBe(null);
    expect(rows()[0]!['binding']).toBe('P');
    g.driver.click(SettingsPanel, 'reset_controls');
    g.step();
    expect(dictEntries(g.kernel.resource('settings')['controls'], 'c')).toEqual([]);
    g.driver.click(SettingsPanel, 'rebind', { slot: 'Controls.nothing:key' });
    expect(code(() => g.step())).toBe('PP3408');
  });

  it('on the title scene the pause panel and its key do not exist', () => {
    const g = game('title');
    g.tap('KeyP');
    expect(g.driver.openPanels()).toEqual(['title']);
    expect(code(() => g.ctxUi.open(g.Pause))).toBe('PP3420');
  });

  it('quit loads the title with new_run=True', () => {
    const g = game();
    g.run()['lives'] = 1;
    g.tap('KeyP');
    g.driver.click(g.Pause, 'quit');
    g.step();
    expect(g.kernel.scene?.id).toBe('title');
    expect(g.run()['lives']).toBe(3);
    expect(g.kernel.time.frozen).toBe(false);
  });
});

describe('game over, derived', () => {
  it('opens 0.5s after lives reach 0 (re-checked at opening), shows its state, and retry restarts the run', () => {
    const g = game();
    g.run()['lives'] = 0;
    g.step(30);
    expect(g.engine.isOpen(g.Over)).toBe(false);
    g.step();
    expect(g.engine.isOpen(g.Over)).toBe(true);
    g.step();
    expect(g.driver.stateOf(g.Over)).toEqual({ level: 1 });
    expect(code(() => g.ctxUi.close(g.Over))).toBe('PP3422');
    g.driver.click(g.Over, 'retry');
    g.step();
    expect(g.run()['lives']).toBe(3);
    g.step();
    expect(g.engine.isOpen(g.Over)).toBe(false);
  });
});

describe('panel actions', () => {
  it('a function action receives typed arguments from the click data and may return close_panel()', () => {
    const g = game();
    g.driver.click(g.Hud, 'pick', { slot: '2', kind: 'sword', label: 'extra fields are ignored' });
    g.step();
    expect(g.picks).toEqual([[g.kernel.context, 2, 'sword']]);
    g.driver.click(g.Hud, 'pick', { slot: 1, kind: 'axe' });
    expect(code(() => g.step())).toBe('PP4102');
  });

  it('a parameter with a default may be left out of the click: the function\'s default applies', () => {
    const g = game();
    g.driver.click(g.Hud, 'start', { mode: 'practice' });
    g.step();
    g.driver.click(g.Hud, 'start', { mode: 'circuit', stage: '2' });
    g.step();
    expect(g.starts).toEqual([['practice', 0], ['circuit', 2]]);
    g.driver.click(g.Hud, 'start', { stage: 1 });
    expect(code(() => g.step())).toBe('PP3425');
  });

  it('@action(when=) disables an action', () => {
    const g = game();
    g.run()['lives'] = 1;
    g.step();
    expect(code(() => g.driver.click(g.Hud, 'reroll'))).toBe('PP3429');
    g.run()['lives'] = 2;
    g.step();
    g.driver.click(g.Hud, 'reroll');
    g.step();
    expect(g.rerolls()).toBe(1);
  });

  it('an event class as an action emits it with fields from the click', () => {
    const g = game();
    g.driver.click(g.Hud, 'picked', { slot: '4' });
    g.step();
    expect(g.emitted).toHaveLength(1);
    expect((g.emitted[0] as { slot: number }).slot).toBe(4);
  });

  it('load_scene(init=[Run(level=3)]) applies the fields the instance was given', () => {
    const g = game();
    g.run()['lives'] = 2;
    g.driver.click(g.Hud, 'level3');
    g.step();
    expect(g.run()['level']).toBe(3);
    expect(g.run()['lives']).toBe(2); // not given, not reset (no new_run=True)
  });

  it('commands are values; bad ones fail at declaration', () => {
    expect(close_panel()).toBeInstanceOf(PanelCommand);
    expect(code(() => open_panel(class NotAPanel {}))).toBe('PP4426');
    expect(code(() => load_scene('title'))).toBe('PP4424');
    expect(code(() => reload_scene(kw({ new_run: 'yes' })))).toBe('PP4424');
    expect(code(() => reload_scene(kw({ reset: 'run' })))).toBe('PP4424'); // renamed: new_run=True
    expect(code(() => ui('Bad Id', kw({ html: 'x.html' })))).toBe('PP4427');
    expect(code(() => ui('x', kw({ html: 'x.html', toggle_with: 'KeyP' })))).toBe('PP4427');
    expect(code(() => ui('x', kw({ html: 'x.html', scale: 'fit' })))).toBe('PP4427');
    expect(() => ui('x', kw({ html: 'x.html', scale: 'design' }))).not.toThrow();
  });
});

describe('ctx.ui', () => {
  it('opens, closes and reports panels by class, and records presentation requests', () => {
    const g = game();
    expect(g.ctxUi.is_open(g.Hud)).toBe(true);
    g.ctxUi.open(g.Pause);
    expect(g.ctxUi.is_open(g.Pause)).toBe(true);
    g.ctxUi.close(g.Pause);
    expect(g.ctxUi.is_open(g.Pause)).toBe(false);
    g.ctxUi.toast('Saved');
    g.ctxUi.announce('Wave 3', 'Survive', kw({ seconds: 3 }));
    expect(g.engine.takeRequests()).toEqual([
      { kind: 'toast', text: 'Saved', seconds: 2, to: null },
      { kind: 'announce', title: 'Wave 3', subtitle: 'Survive', seconds: 3, to: null },
    ]);
    expect(code(() => g.ctxUi.toast('x', kw({ secs: 1 })))).toBe('PP3030');
  });

  it('float_text takes a FloatStyle: its look and motion travel with the request; bad values are named', () => {
    const g = game();
    const hit = new FloatStyle(kw({
      size: 28, font: 'Bangers', color: Color.hex('#ff4040'), outline: Color.hex('#000000'), outline_width: 3, pop: 1.6,
      end_scale: 0.6, rise: 70, seconds: 0.8,
    }));
    g.ctxUi.float_text('-12', new Vec3(1, 2, 3), kw({ style: hit }));
    g.ctxUi.float_text('+5', new Vec3(0, 0, 0));
    const [styled, plain] = g.engine.takeRequests() as Array<{ style: unknown; color: unknown }>;
    expect(styled!.style).toEqual({
      size: 28, font: 'Bangers', bold: true, color: [1, 0.25098039215686274, 0.25098039215686274, 1], outline: [0, 0, 0, 1],
      outlineWidth: 3, pop: 1.6, endScale: 0.6, rise: 70, seconds: 0.8,
    });
    expect(styled!.color).toBeNull();
    expect(plain!.style).toBeNull();
    expect(code(() => new FloatStyle(kw({ size: 0 })))).toBe('PP3030');
    expect(code(() => new FloatStyle(kw({ outline: '#000' })))).toBe('PP3030');
    expect(code(() => new FloatStyle(kw({ seconds: 1, colour: Color.WHITE })))).toBe('PP3030');
    expect(code(() => g.ctxUi.float_text('x', new Vec3(), kw({ style: { size: 3 } })))).toBe('PP3030');
  });
});
