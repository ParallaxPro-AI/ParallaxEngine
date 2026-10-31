import { describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '../../../core/index.js';
import type { ProjectFiles, UiClick, UiFrame, UiSurface } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import { projectToScreen, ui, UiPresenter } from './index.js';
import type { PanelAction, PanelDecl, PanelInstance } from './index.js';

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

class Surface implements UiSurface {
  frames: UiFrame[] = [];
  clicks: UiClick[] = [];
  present(frame: UiFrame): void { this.frames.push(frame); }
  takeClicks(): UiClick[] { const out = this.clicks; this.clicks = []; return out; }
  get last(): UiFrame { return this.frames.at(-1)!; }
}

/** A kernel with the ui plugin and a presenter wired the way the api runtime wires it. */
function rig(panels: PanelDecl[], players?: () => readonly unknown[]) {
  const plugin = ui({ panels: [panel('hud', { state: () => ({ lives: kernel.resource('run')['lives'] }) }), ...panels], ...(players && { players }) });
  const project = loadProject(files({ 'scenes/level/scene.json': { ui: ['hud'], entities: [] } }));
  const kernel: Kernel = new Kernel({
    project,
    game: { components: [], events: [], behaviors: [], systems: [], resources: [{ id: 'run', schema: { lives: t.int({ default: 3 }) } }] },
    plugins: [plugin],
    context: { name: 'ctx' },
  });
  const surface = new Surface();
  const presenter = new UiPresenter({
    engine: plugin.engine, kernel, surface,
    screen: () => ({ width: 1280, height: 720 }),
    locale: () => ({ language: 'en', strings: { hello: 'Hello' } }),
    values: { text: (v) => (typeof v === 'object' && v !== null && 'key' in v ? `<${String((v as { key: string }).key)}>` : String(v)), truthy: Boolean },
  });
  kernel.addHook('input', () => presenter.takeClicks());
  kernel.addHook('render', () => presenter.present());
  kernel.start('level');
  return { kernel, engine: plugin.engine, surface, step: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); } };
}

describe('UiPresenter', () => {
  it('presents open panels, oldest first, with their state, layer, modality and disabled actions', () => {
    let allowed = false;
    const r = rig([panel('shop', {
      modal: true, layer: 'menu', state: () => ({ gold: 5 }),
      actions: { buy: { kind: 'call', params: [], when: () => allowed, run: () => null } },
    })]);
    r.step();
    expect(r.surface.last.panels.map((p) => p.id)).toEqual(['hud']);
    expect(r.surface.last.panels[0]!.instances).toEqual([{ seat: 0, viewport: [0, 0, 1, 1], state: { lives: 3 } }]);
    expect(r.surface.last.strings).toEqual({ hello: 'Hello' });
    r.engine.open('shop');
    r.step();
    const shop = r.surface.last.panels[1]!;
    expect([shop.id, shop.html, shop.layer, shop.modal, shop.enabled]).toEqual(['shop', 'ui/shop.html', 'menu', true, { buy: false }]);
    allowed = true;
    r.step();
    expect(r.surface.last.panels[1]!.enabled).toEqual({ buy: true });
  });

  it('a PlayerPanel has one copy per seat (the full surface without seat cameras)', () => {
    const r = rig([panel('card', { perPlayer: true, state: (_c, p) => ({ who: p }) })], () => ['a', 'b']);
    r.engine.open('card');
    r.step();
    expect(r.surface.last.panels[1]!.instances.map((i) => [i.seat, i.state['who']])).toEqual([[0, 'a'], [1, 'b']]);
  });

  it('routes surface clicks into the engine with their payload and seat', () => {
    const calls: unknown[] = [];
    const r = rig([panel('pick', {
      actions: {
        choose: {
          kind: 'call', params: [{ name: 'n', type: { kind: 'int' } }],
          run: (_ctx, args, _p, seat) => { calls.push([args[0], seat]); return null; },
        },
        off: { kind: 'call', params: [], when: () => false, run: () => { calls.push('off ran'); return null; } },
        close: { kind: 'command', command: { kind: 'close' } },
      },
    })]);
    r.engine.open('pick');
    r.step();
    r.surface.clicks.push({ panel: 'pick', action: 'choose', data: { n: '2', extra: 'x' }, seat: 1 });
    r.surface.clicks.push({ panel: 'pick', action: 'off', data: {}, seat: 0 });
    r.step();
    expect(calls).toEqual([[2, 1]]);
    r.surface.clicks.push({ panel: 'pick', action: 'close', data: {}, seat: 0 });
    r.step();
    expect(r.engine.isOpen('pick')).toBe(false);
    // A click on a panel that closed since it was drawn is dropped, not an error.
    r.surface.clicks.push({ panel: 'pick', action: 'choose', data: { n: '1' }, seat: 0 });
    r.step();
    expect(calls).toEqual([[2, 1]]);
  });

  it('turns requests into effects once, with text in the game language', () => {
    const r = rig([]);
    r.engine.toast({ key: 'saved' }, 2, null);
    r.engine.announce('Wave 3', null, 3, { index: 1 });
    r.step();
    expect(r.surface.last.effects).toEqual([
      { kind: 'toast', text: '<saved>', seconds: 2, viewport: [0, 0, 1, 1] },
      { kind: 'announce', title: 'Wave 3', subtitle: null, seconds: 3, viewport: [0, 0, 1, 1] },
    ]);
    r.step();
    expect(r.surface.last.effects).toEqual([]);
    expect(r.engine.requests).toEqual([]);
  });
});

describe('projectToScreen', () => {
  const view = {
    seat: 0, active: true, dimension: '3d' as const, mode: 'perspective' as const, position: new Vec3(0, 0, 0),
    rotation: Quat.IDENTITY, fov: 90, size: 5, near: 0.1, far: 100,
    viewport: { x: 640, y: 0, width: 640, height: 720 }, aspect: 640 / 720,
  };
  const screen = { width: 1280, height: 720 };

  it('puts a point ahead of the camera in its viewport, as screen fractions', () => {
    expect(projectToScreen(view, new Vec3(0, 0, 10), screen)).toEqual([0.75, 0.5]);
    const up = projectToScreen(view, new Vec3(0, 5, 10), screen)!;
    expect(up[0]).toBeCloseTo(0.75);
    expect(up[1]).toBeCloseTo(0.25);
  });

  it('is null behind the camera or outside its view', () => {
    expect(projectToScreen(view, new Vec3(0, 0, -10), screen)).toBeNull();
    expect(projectToScreen(view, new Vec3(100, 0, 10), screen)).toBeNull();
  });

  it('projects orthographic and 2D views by size', () => {
    const flat = { ...view, dimension: '2d' as const, mode: 'orthographic' as const, viewport: { x: 0, y: 0, width: 1280, height: 720 }, aspect: 1280 / 720 };
    const at = projectToScreen(flat, new Vec3(0, 2.5, 0), screen)!;
    expect(at[0]).toBeCloseTo(0.5);
    expect(at[1]).toBeCloseTo(0.25);
  });
});
