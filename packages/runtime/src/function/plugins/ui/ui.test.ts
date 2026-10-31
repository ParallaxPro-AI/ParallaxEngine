import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { Fields, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { UI_EVENTS, UiDriver, ui } from './index.js';
import type { PanelAction, PanelDecl, PanelInstance, UiEngine, UiOptions } from './index.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function panel(id: string, extra: Partial<Omit<PanelDecl, 'actions'>> & {
  actions?: Record<string, PanelAction>; state?: (ctx: unknown, player?: unknown) => unknown;
} = {}): PanelDecl {
  const { actions, state, ...rest } = extra;
  return {
    id, html: `ui/${id}.html`, modal: false, layer: 'hud', scenes: [], perPlayer: false, handle: undefined,
    actions: new Map(Object.entries(actions ?? {})),
    create: (): PanelInstance => (state === undefined ? {} : { state }),
    ...rest,
  };
}

const close: PanelAction = { kind: 'command', command: { kind: 'close' } };
const openP = (p: string): PanelAction => ({ kind: 'command', command: { kind: 'open', panel: p } });

/** A fake input link: which action handles are pressed / held this frame, and whether mute was ignored. */
class Keys {
  pressed = new Set<unknown>();
  held = new Set<unknown>();
  muted = false;
  link = {
    pressed: (a: unknown, ignoreMute: boolean): boolean => (ignoreMute || !this.muted) && this.pressed.has(a),
    held: (a: unknown, ignoreMute: boolean): boolean => (ignoreMute || !this.muted) && this.held.has(a),
  };
}

interface Rig {
  readonly kernel: Kernel;
  readonly engine: UiEngine;
  readonly driver: UiDriver;
  readonly keys: Keys;
  readonly log: string[];
  run(): Fields;
  step(frames?: number): void;
}

const PROJECT = {
  'prefabs/chest.prefab.json': { components: {} },
  'scenes/level/scene.json': { tags: ['level'], ui: ['hud'], entities: [] },
  'scenes/title/scene.json': { ui: ['title'], entities: [] },
};

/** The rig being built or last built: `when=` conditions read its state (undefined while its scene first loads). */
let rigged: Rig | undefined;

function rig(panels: PanelDecl[], options: Partial<UiOptions> & { scene?: string; project?: Record<string, unknown>; after?: KernelPlugin[] } = {}): Rig {
  rigged = undefined;
  const keys = new Keys();
  const plugin = ui({ input: keys.link, ...options, panels: [panel('hud'), panel('title'), ...panels] });
  keys.muted = false;
  const log: string[] = [];
  const watcher: SystemDef = {
    id: 'watcher', scenes: [],
    handlers: [
      { event: UI_EVENTS.opened, method: 'opened', always: true },
      { event: UI_EVENTS.closed, method: 'closed', always: true },
      { event: UI_EVENTS.acted, method: 'acted', always: true },
    ],
    create: () => ({
      update: () => { log.push('update'); },
      opened: (_ctx: unknown, e: Fields) => { log.push(`opened ${String(e['panel'])}`); },
      closed: (_ctx: unknown, e: Fields) => { log.push(`closed ${String(e['panel'])}`); },
      acted: (_ctx: unknown, e: Fields) => { log.push(`acted ${String(e['panel'])}.${String(e['action'])}@${String(e['seat'])}`); },
    }),
  };
  const project = loadProject(files(options.project ?? PROJECT));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({
    project,
    game: {
      components: [], events: [], behaviors: [], systems: [watcher],
      resources: [{ id: 'run', schema: { lives: t.int({ default: 3 }), level: t.int({ default: 1 }), menu: t.bool({ default: false, keep: 'session' }) } }],
    },
    plugins: [plugin, ...(options.after ?? [])],
    context: { name: 'ctx' },
  });
  const engine = plugin.engine;
  kernel.start(options.scene ?? 'level');
  const r: Rig = {
    kernel, engine, driver: new UiDriver(engine), keys, log,
    run: () => kernel.resource('run'),
    step(frames = 1) {
      for (let i = 0; i < frames; i++) {
        keys.muted = engine.modalOpen();
        kernel.step(DT);
      }
    },
  };
  rigged = r;
  return r;
}

/** Press a key for exactly one frame. */
function tap(r: Rig, action: unknown): void {
  r.keys.pressed.add(action);
  r.step();
  r.keys.pressed.delete(action);
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

const PAUSE_KEY = { action: 'pause' };

// ── Scene lists and scoping ────────────────────────────────────────────────────

describe('scenes', () => {
  it('a scene opens its "ui" list; a load closes every panel and opens the new list', () => {
    const r = rig([panel('pause', { modal: true, toggleWith: PAUSE_KEY, scenes: [{ tag: 'level' }] })]);
    expect(r.driver.openPanels()).toEqual(['hud']);
    tap(r, PAUSE_KEY);
    expect(r.driver.openPanels()).toEqual(['hud', 'pause']);
    r.kernel.requestScene('title');
    r.step();
    expect(r.driver.openPanels()).toEqual(['title']);
    expect(r.kernel.time.frozen).toBe(false);
  });

  it('scenes= keeps a panel (and its toggle key) out of other scenes', () => {
    const r = rig([panel('pause', { modal: true, toggleWith: PAUSE_KEY, scenes: [{ tag: 'level' }] })], { scene: 'title' });
    tap(r, PAUSE_KEY);
    expect(r.engine.isOpen('pause')).toBe(false);
    expect(code(() => r.engine.open('pause'))).toBe('PP3420');
  });

  it('rejects unknown panels and self-opening panels in a scene list', () => {
    expect(code(() => rig([], { project: { 'scenes/level/scene.json': { ui: ['hudd'], entities: [] } } }))).toBe('PP2080');
    expect(code(() => rig([panel('over', { when: () => false })], {
      project: { 'scenes/level/scene.json': { ui: ['over'], entities: [] } },
    }))).toBe('PP2081');
  });
});

// ── Modals ─────────────────────────────────────────────────────────────────────

describe('modal panels', () => {
  it('toggle_with opens the panel and the same key closes it; while open, time is frozen', () => {
    const r = rig([panel('pause', { modal: true, toggleWith: PAUSE_KEY })]);
    r.step();
    const before = r.kernel.time.now;
    tap(r, PAUSE_KEY);
    expect(r.engine.isOpen('pause')).toBe(true);
    expect(r.kernel.time.frozen).toBe(true);
    // Events emitted in the ui hook arrive in the same frame.
    expect(r.log.at(-1)).toBe('opened pause');
    r.log.length = 0;
    r.step(3);
    // Systems don't update while frozen.
    expect(r.log).toEqual([]);
    const frozenAt = r.kernel.time.now;
    tap(r, PAUSE_KEY);
    expect(r.engine.isOpen('pause')).toBe(false);
    expect(r.kernel.time.frozen).toBe(false);
    r.step();
    expect(r.kernel.time.now).toBeGreaterThan(frozenAt);
    expect(frozenAt).toBeCloseTo(before + DT);
    expect(r.log).toContain('update');
  });

  it('without time freezing (net games) a modal still mutes input but time runs', () => {
    const r = rig([panel('inventory', { modal: true, toggleWith: PAUSE_KEY })], { freezeTime: false });
    tap(r, PAUSE_KEY);
    expect(r.engine.modalOpen()).toBe(true);
    expect(r.kernel.time.frozen).toBe(false);
  });

  it('modals stack: the toggle key closes only its own panel, and only while it is on top', () => {
    const r = rig([
      panel('pause', { modal: true, toggleWith: PAUSE_KEY, actions: { settings: openP('settings'), resume: close } }),
      panel('settings', { modal: true, layer: 'menu', actions: { back: close } }),
    ]);
    tap(r, PAUSE_KEY);
    r.driver.click('pause', 'settings');
    r.step();
    expect(r.driver.openPanels()).toEqual(['hud', 'pause', 'settings']);
    expect(r.engine.topModal()?.id).toBe('settings');
    tap(r, PAUSE_KEY);
    expect(r.driver.openPanels()).toEqual(['hud', 'pause', 'settings']);
    r.driver.click('settings', 'back');
    r.step();
    expect(r.driver.openPanels()).toEqual(['hud', 'pause']);
    expect(r.kernel.time.frozen).toBe(true); // still frozen under the pause menu
    tap(r, PAUSE_KEY);
    expect(r.driver.openPanels()).toEqual(['hud']);
    expect(r.kernel.time.frozen).toBe(false);
  });

  it('a toggle key does not open its panel through another modal (it is a muted gameplay action)', () => {
    const r = rig([
      panel('over', { modal: true, when: (ctx) => (ctx as { over?: boolean }).over === true }),
      panel('pause', { modal: true, toggleWith: PAUSE_KEY }),
    ]);
    (r.kernel.context as { over?: boolean }).over = true;
    r.step();
    expect(r.engine.isOpen('over')).toBe(true);
    tap(r, PAUSE_KEY);
    expect(r.engine.isOpen('pause')).toBe(false);
  });

  it('emits PanelOpened / PanelClosed with the panel handle', () => {
    const Pause = class Pause {};
    const r = rig([panel('pause', { modal: true, toggleWith: PAUSE_KEY, handle: Pause })]);
    r.log.length = 0;
    tap(r, PAUSE_KEY);
    r.step();
    tap(r, PAUSE_KEY);
    r.step();
    expect(r.log.filter((l) => !l.startsWith('update'))).toEqual([`opened ${String(Pause)}`, `closed ${String(Pause)}`]);
    expect(r.engine.isOpen(Pause)).toBe(false); // looked up by class
  });

  it('emits PanelAction for every action that ran (after its command), even while a modal freezes time; not for a disabled one', () => {
    const Pause = class Pause {};
    let ran = 0;
    const r = rig([panel('pause', {
      modal: true, toggleWith: PAUSE_KEY, handle: Pause,
      actions: {
        resume: close,
        quit: { kind: 'call', params: [], run: () => { ran++; return undefined; }, when: () => false },
      },
    })]);
    tap(r, PAUSE_KEY);
    r.log.length = 0;
    r.engine.click(Pause, 'quit'); // the driver refuses disabled clicks (PP3429); a stale renderer click can still arrive
    r.step();
    expect(ran).toBe(0);
    expect(r.log.filter((l) => l.startsWith('acted'))).toEqual([]);
    r.driver.click(Pause, 'resume');
    r.step();
    expect(r.log.filter((l) => !l.startsWith('update'))).toEqual([`closed ${String(Pause)}`, `acted ${String(Pause)}.resume@0`]);
  });
});

// ── Derived opening ────────────────────────────────────────────────────────────

describe('when= and while_held=', () => {
  it('when= opens exactly while the condition holds', () => {
    const r = rig([panel('over', { modal: true, when: () => rigged?.run()['lives'] === 0 })]);
    r.step();
    expect(r.engine.isOpen('over')).toBe(false);
    r.run()['lives'] = 0;
    r.step();
    expect(r.engine.isOpen('over')).toBe(true);
    expect(code(() => r.engine.close('over'))).toBe('PP3422');
    r.run()['lives'] = 2;
    r.step();
    expect(r.engine.isOpen('over')).toBe(false);
  });

  it('with logic off (edit mode) when= is not asked: the panel neither opens nor closes until logic is back', () => {
    let asked = 0;
    const r = rig([panel('over', { modal: true, when: () => { asked++; return rigged?.run()['lives'] === 0; } })]);
    r.step();
    r.kernel.setLogic(false);
    r.run()['lives'] = 0;
    const before = asked;
    r.step(3);
    expect(asked).toBe(before);
    expect(r.engine.isOpen('over')).toBe(false);
    r.kernel.setLogic(true);
    r.step();
    expect(r.engine.isOpen('over')).toBe(true);
  });

  it('a when= panel whose condition holds is open as the scene starts, before any frame', () => {
    const r = rig([panel('menu_screen', { modal: true, when: () => true, actions: { go: { kind: 'call', params: [], run: () => {} } } })]);
    expect(r.engine.isOpen('menu_screen')).toBe(true);
    expect(r.engine.modalOpen()).toBe(true);
    r.driver.click('menu_screen', 'go');
    r.step();
    expect(r.engine.isOpen('menu_screen')).toBe(true);
  });

  it('delay= opens after the delay of game time, and only if the condition is still true', () => {
    const r = rig([panel('result', { modal: true, when: () => rigged?.run()['lives'] === 0, delay: 0.5 })]);
    r.run()['lives'] = 0;
    r.step(); // condition seen: the delay starts
    r.step(29);
    expect(r.engine.isOpen('result')).toBe(false);
    r.step();
    expect(r.engine.isOpen('result')).toBe(true);

    r.run()['lives'] = 1;
    r.step();
    r.run()['lives'] = 0;
    r.step(20);
    r.run()['lives'] = 1; // false again before the delay ran out
    r.step(20);
    expect(r.engine.isOpen('result')).toBe(false);
  });

  it('delay= may be computed from the context', () => {
    const r = rig([panel('result', { when: () => rigged?.run()['lives'] === 0, delay: () => 2 * DT })]);
    r.run()['lives'] = 0;
    r.step(2);
    expect(r.engine.isOpen('result')).toBe(false);
    r.step();
    expect(r.engine.isOpen('result')).toBe(true);
  });

  it('while_held= opens while the action is held', () => {
    const TAB = { action: 'scores' };
    const r = rig([panel('scores', { whileHeld: TAB })]);
    r.keys.held.add(TAB);
    r.step();
    expect(r.engine.isOpen('scores')).toBe(true);
    r.keys.held.delete(TAB);
    r.step();
    expect(r.engine.isOpen('scores')).toBe(false);
  });

  it('rejects contradictory declarations', () => {
    expect(code(() => rig([panel('x', { when: () => true, toggleWith: PAUSE_KEY })]))).toBe('PP4421');
    expect(code(() => rig([panel('x', { delay: 1 })]))).toBe('PP4422');
    expect(code(() => rig([panel('x', { when: () => true, actions: { done: close } })]))).toBe('PP4423');
    expect(code(() => rig([panel('hud')]))).toBe('PP4420');
    expect(code(() => ui({ panels: [panel('x', { toggleWith: PAUSE_KEY })] }))).toBe('PP9420');
  });
});

// ── Actions ────────────────────────────────────────────────────────────────────

describe('panel actions', () => {
  it('reload_scene(new_run=True) and load_scene(init=...) request the scene change', () => {
    const r = rig([panel('menu', {
      actions: {
        retry: { kind: 'command', command: { kind: 'scene', scene: null, newRun: true } },
        level3: { kind: 'command', command: { kind: 'scene', scene: 'level', newRun: true, init: { run: { level: 3 } } } },
        seeded: { kind: 'command', command: { kind: 'scene', scene: 'level', seed: 7 } },
      },
    })]);
    r.engine.open('menu');
    r.run()['lives'] = 0;
    r.driver.click('menu', 'retry');
    r.step();
    expect(r.run()['lives']).toBe(3);
    expect(r.driver.openPanels()).toEqual(['hud']); // the load closed the menu
    r.engine.open('menu');
    r.driver.click('menu', 'level3');
    r.step();
    expect(r.run()['level']).toBe(3);
    const seeds: unknown[] = [];
    r.kernel.observeScenes({ loading: (_scene, request) => seeds.push(request.seed) });
    r.engine.open('menu');
    r.driver.click('menu', 'seeded');
    r.step();
    expect(seeds).toEqual([7]);
  });

  it('function actions receive typed arguments from the click data, and may return a command', () => {
    const calls: unknown[][] = [];
    const r = rig([panel('shop', {
      actions: {
        buy: {
          kind: 'call',
          params: [
            { name: 'slot', type: { kind: 'int' } },
            { name: 'kind', type: { kind: 'enum', values: ['sword', 'shield'] }, present: (v) => `Kind.${String(v)}` },
            { name: 'gift', type: { kind: 'optional', of: { kind: 'bool' } } },
          ],
          run: (ctx, args) => { calls.push([ctx, ...args]); return args[0] === 9 ? { __command__: { kind: 'close' } } : null; },
        },
      },
    })]);
    r.engine.open('shop');
    r.driver.click('shop', 'buy', { slot: '2', kind: 'sword', gift: 'true', name: 'ignored extra field' });
    r.step();
    expect(calls).toEqual([[{ name: 'ctx' }, 2, 'Kind.sword', true]]);
    r.driver.click('shop', 'buy', { slot: 9, kind: 'shield', gift: '' });
    r.step();
    expect(calls[1]).toEqual([{ name: 'ctx' }, 9, 'Kind.shield', null]);
    expect(r.engine.isOpen('shop')).toBe(false);

    r.engine.open('shop');
    r.driver.click('shop', 'buy', { slot: 1, kind: 'axe', gift: null });
    expect(code(() => r.step())).toBe('PP4102');
    r.driver.click('shop', 'buy', { kind: 'sword' });
    expect(code(() => r.step())).toBe('PP3425');
    expect(code(() => r.driver.click('shop', 'bye'))).toBe('PP2082');
  });

  it('function action arguments also take runtime values (a ContentRef, an enum member, a Vec3), encoded by the type', () => {
    const calls: unknown[][] = [];
    const ref = { id: 'feather_charm', toJSON: () => 'feather_charm' };
    const member = { name: 'shield', toJSON: () => 'shield' };
    const r = rig([panel('shop', {
      actions: {
        buy: {
          kind: 'call',
          params: [
            { name: 'upgrade', type: { kind: 'ref', to: 'upgrade' } },
            { name: 'kind', type: { kind: 'enum', values: ['sword', 'shield'] } },
            { name: 'at', type: { kind: 'vec3' } },
          ],
          run: (_ctx, args) => { calls.push([...args]); },
        },
      },
    })]);
    r.engine.open('shop');
    r.driver.click('shop', 'buy', { upgrade: ref, kind: member, at: new Vec3(1, 2, 3) });
    r.step();
    expect(calls).toEqual([['feather_charm', 'shield', new Vec3(1, 2, 3)]]);
    r.driver.click('shop', 'buy', { upgrade: ref, kind: { toJSON: () => 'axe' }, at: new Vec3(0, 0, 0) });
    expect(code(() => r.step())).toBe('PP4108');
  });

  it('@action(when=) disables a function action', () => {
    let can = false;
    let ran = 0;
    const r = rig([panel('shop', { actions: { reroll: { kind: 'call', params: [], when: () => can, run: () => { ran++; } } } })]);
    r.engine.open('shop');
    r.step();
    expect(r.engine.view('shop')?.enabled).toEqual({ reroll: false });
    expect(code(() => r.driver.click('shop', 'reroll'))).toBe('PP3429');
    r.engine.click('shop', 'reroll'); // a stale click from the page is ignored
    r.step();
    expect(ran).toBe(0);
    can = true;
    r.step();
    r.driver.click('shop', 'reroll');
    r.step();
    expect(ran).toBe(1);
  });

  it('a function action returning something else is an error; clicks on closed panels are refused', () => {
    const r = rig([panel('shop', { actions: { odd: { kind: 'call', params: [], run: () => 42 } } })]);
    expect(code(() => r.driver.click('shop', 'odd'))).toBe('PP3428');
    r.engine.open('shop');
    r.driver.click('shop', 'odd');
    expect(code(() => r.step())).toBe('PP3427');
  });

  it('a function action returning a scene command is an error (functions use ctx.scenes.load)', () => {
    const r = rig([panel('menu', { actions: { go: { kind: 'call', params: [], run: () => ({ kind: 'scene', scene: null }) } } })]);
    r.engine.open('menu');
    r.driver.click('menu', 'go');
    expect(code(() => r.step())).toBe('PP3427');
  });

  it('a panel action keeps working under its own modal (data-key / clicks are not gameplay input)', () => {
    let resumed = 0;
    const r = rig([panel('pause', { modal: true, toggleWith: PAUSE_KEY, actions: { note: { kind: 'call', params: [], run: () => { resumed++; } } } })]);
    tap(r, PAUSE_KEY);
    r.driver.click('pause', 'note');
    r.step();
    expect(resumed).toBe(1);
  });
});

// ── State, subjects, seats, requests ───────────────────────────────────────────

describe('state and presentation', () => {
  it('evaluates state() every frame for open panels, as plain data', () => {
    const r = rig([panel('score', { state: () => ({ lives: r.run()['lives'], tags: new Map([['a', [1, 2]]]) }) })]);
    expect(code(() => r.driver.stateOf('score'))).toBe('PP3428');
    r.engine.open('score');
    r.step();
    expect(r.driver.stateOf('score')).toEqual({ lives: 3, tags: { a: [1, 2] } });
    r.run()['lives'] = 1;
    r.step();
    expect(r.driver.stateOf('score')['lives']).toBe(1);
  });

  it("views are computed after every other 'ui' hook (camera rigs), so they show this frame", () => {
    let rigFrame = 0;
    // Installed after ui, like the visuals plugin whose camera rigs settle in the 'ui' hook.
    const cameras: KernelPlugin = { id: 'cameras', install: (k) => { k.addHook('ui', () => { rigFrame++; }); } };
    const r = rig([panel('nameplate', { state: () => ({ frame: rigFrame }) })], { after: [cameras] });
    r.engine.open('nameplate');
    r.step();
    expect(r.driver.stateOf('nameplate')).toEqual({ frame: rigFrame });
    r.step(3);
    expect(r.driver.stateOf('nameplate')).toEqual({ frame: rigFrame });
  });

  it('state() must return a dict', () => {
    const r = rig([panel('bad', { state: () => [1] })]);
    r.engine.open('bad');
    expect(code(() => r.step())).toBe('PP3424');
  });

  it('a PlayerPanel renders one state per seat', () => {
    const r = rig([panel('seat_hud', { perPlayer: true, state: (_ctx, p) => ({ who: p }) })], { players: () => ['p1', 'p2'] });
    r.engine.open('seat_hud');
    r.step();
    expect(r.driver.stateOf('seat_hud', 0)).toEqual({ who: 'p1' });
    expect(r.driver.stateOf('seat_hud', 1)).toEqual({ who: 'p2' });
  });

  it('a panel opened about a subject closes when the subject is destroyed', () => {
    const r = rig([panel('chest', { modal: true })]);
    const chest = r.kernel.spawn('chest');
    r.engine.open('chest', chest.id);
    r.step();
    expect(r.engine.openPanels.at(-1)?.instance.subject).toBe(chest.id);
    r.kernel.destroy(chest.id);
    r.step();
    expect(r.engine.isOpen('chest')).toBe(false);
    expect(r.kernel.time.frozen).toBe(false);
    expect(code(() => r.engine.open('chest', 'not an entity'))).toBe('PP3421');
  });

  it('records toasts, announcements, floating text, flashes and labels for the renderer', () => {
    const r = rig([]);
    const crate = r.kernel.spawn('chest');
    r.engine.toast('Saved', 2, null);
    r.engine.announce('Wave 3', 'Survive', 3, null);
    r.engine.floatText('+10', new Vec3(1, 2, 3), null, null);
    r.engine.flash(crate.id, null, 0.1);
    expect(r.engine.takeRequests().map((q) => q.kind)).toEqual(['toast', 'announce', 'float_text', 'flash']);
    expect(r.engine.takeRequests()).toEqual([]);
    const label = r.engine.label(crate.id, 'Crate', null);
    expect(r.engine.labels).toHaveLength(1);
    label.cancel();
    expect([label.active, r.engine.labels.length]).toEqual([false, 0]);
    r.engine.label(crate.id, 'Crate', null, 'you');
    expect(r.engine.labels.at(-1)).toMatchObject({ text: 'Crate', kind: 'you' });
    r.kernel.destroy(crate.id);
    r.step();
    expect(r.engine.labels).toEqual([]);
  });
});

// ── Snapshots ──────────────────────────────────────────────────────────────────

describe('snapshots', () => {
  it('kernel snapshots carry the open panels, their order and when= delays; restore emits nothing', () => {
    const r = rig([
      panel('pause', { modal: true, toggleWith: PAUSE_KEY, state: () => ({ paused: true }) }),
      panel('result', { when: () => rigged?.run()['lives'] === 0, delay: 0.5 }),
    ]);
    r.run()['lives'] = 0;
    r.step(10); // the result delay is under way
    tap(r, PAUSE_KEY);
    r.step(); // panel_opened (emitted in the ui hook) is delivered next frame; snapshots need it settled
    const snap = r.kernel.snapshot();
    expect(snap.plugins['ui']).toEqual({ open: [{ id: 'hud', subject: null }, { id: 'pause', subject: null }], pending: [{ id: 'result', elapsed: expect.closeTo(10 * DT) as unknown, delay: 0.5 }] });

    tap(r, PAUSE_KEY);
    r.step(30);
    expect([r.engine.isOpen('pause'), r.engine.isOpen('result')]).toEqual([false, true]);
    r.log.length = 0;
    r.kernel.restore(snap);
    expect(r.driver.openPanels()).toEqual(['hud', 'pause']);
    expect(r.engine.modalOpen()).toBe(true);
    expect(r.kernel.time.frozen).toBe(true);
    expect(r.driver.stateOf('pause')).toEqual({ paused: true });
    expect(r.log).toEqual([]);
    // The delay continues from where it was: 20 more frames once unpaused (frozen frames don't count).
    tap(r, PAUSE_KEY);
    r.step(18);
    expect(r.engine.isOpen('result')).toBe(false);
    r.step(2);
    expect(r.engine.isOpen('result')).toBe(true);
  });
});
