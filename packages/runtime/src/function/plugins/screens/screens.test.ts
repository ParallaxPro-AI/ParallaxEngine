import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { RecordingScreens } from '../../../platform/headless/screens.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import { SCREENS_SERVICE } from '../../services/index.js';
import { QUAD, screens } from './index.js';
import type { ScreenPanelHost, ScreenPointer, ScreensHost } from './index.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

interface Terminal { count: number; subject: unknown }

function make() {
  const project = loadProject(files({
    'prefabs/monitor.prefab.json': { components: { screen: { panel: 'terminal', size: [2, 1], resolution: [200, 100], fps: 4 } } },
    'scenes/main/scene.json': { entities: [
      { prefab: 'monitor', id: 'left', at: [-3, 1, 0] },
      { prefab: 'monitor', id: 'right', at: [3, 1, 0], rotation: [0, 180, 0] },
    ] },
  }));
  expect(project.diagnostics).toEqual([]);
  let pending: { origin: Vec3; direction: Vec3 } | null = null;
  let consumed = 0;
  const performed: [string, Readonly<Record<string, unknown>>][] = [];
  const panel: ScreenPanelHost = {
    id: 'terminal', html: 'ui/terminal.html',
    create: (subject) => ({ count: 0, subject }) as Terminal,
    state: (i) => ({ count: (i as Terminal).count }),
    enabled: () => ({}),
    perform: (i, action, data) => {
      performed.push([action, data]);
      if (action === 'add') (i as Terminal).count += Number(data['by'] ?? 1);
    },
  };
  const host: ScreensHost = {
    panel: (_k, id) => {
      if (id !== 'terminal') throw new Error(`no panel ${id}`);
      return panel;
    },
    press: (): ScreenPointer | null => {
      const p = pending;
      pending = null;
      return p === null ? null : { ...p, seat: 0, consume: () => { consumed++; } };
    },
    locale: () => ({ language: 'en', strings: {} }),
    values: () => ({ text: (v) => String(v), truthy: (v) => Boolean(v) }),
  };
  const surface = new RecordingScreens();
  const plugin = screens({ host });
  plugin.connect(surface);
  const kernel = new Kernel({ project, plugins: [plugin], context: {}, game: { components: [], resources: [], events: [], behaviors: [], systems: [] } });
  kernel.start('main');
  const id = (p: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === p)!.id;
  return {
    kernel, plugin, surface, performed, id,
    consumed: () => consumed,
    click: (origin: Vec3, direction: Vec3) => { pending = { origin, direction }; },
    step: () => kernel.step(1 / 60),
  };
}

describe('in-world screens', () => {
  it('shows one panel instance per screen, redrawn when its state changes, at most fps times a second', () => {
    const g = make();
    g.step();
    const left = `screen:${g.id('left')}`;
    const right = `screen:${g.id('right')}`;
    expect(g.surface.last.get(left)!.panel).toMatchObject({ id: 'terminal', html: 'ui/terminal.html', state: { count: 0 } });
    expect(g.surface.last.get(left)!).toMatchObject({ width: 200, height: 100, due: true });
    // Unchanged state: no redraw.
    for (let i = 0; i < 30; i++) g.step();
    expect(g.surface.redraws.get(left)).toBe(1);
    const monitor = g.kernel.world.get(g.id('left'))!.components.get('screen') as Record<string, unknown> & { click(a: string, k?: unknown): void };
    monitor.click('add');
    g.step();
    expect(g.surface.last.get(left)!.panel.state).toEqual({ count: 1 });
    expect(g.surface.last.get(right)!.panel.state).toEqual({ count: 0 });
    expect(g.surface.redraws.get(left)).toBe(2);
    // Changes faster than fps (4/s) wait for the period.
    for (let i = 0; i < 6; i++) { monitor.click('add'); g.step(); }
    expect(g.surface.last.get(left)!.panel.state).toEqual({ count: 7 });
    expect(g.surface.redraws.get(left)).toBe(2);
    for (let i = 0; i < 10; i++) g.step();
    expect(g.surface.redraws.get(left)).toBe(3);
  });

  it('a pointer press on a screen runs what is under it, from the front only', () => {
    const g = make();
    g.step();
    const left = `screen:${g.id('left')}`;
    // A button across the top-left quarter of the left screen.
    g.surface.layout(left, [{ rect: [0, 0, 100, 50], action: 'add', data: { by: '5' } }]);
    // From in front (+z, looking down -z), the viewer's left is +x (left-handed), so the
    // screen's upper-left quarter is at x = -2.5, y = 1.25.
    expect(g.plugin.pick(new Vec3(-2.5, 1.25, 5), new Vec3(0, 0, -1))).toMatchObject({ entity: g.id('left'), x: 50, y: 25 });
    g.click(new Vec3(-2.5, 1.25, 5), new Vec3(0, 0, -1));
    g.step();
    expect(g.performed).toEqual([['add', { by: '5' }]]);
    expect(g.consumed()).toBe(1);
    // Off the button: nothing runs, nothing is consumed.
    g.click(new Vec3(-3.5, 0.75, 5), new Vec3(0, 0, -1));
    g.step();
    expect(g.performed).toHaveLength(1);
    expect(g.consumed()).toBe(1);
    // From behind (the screen faces +z): a miss.
    expect(g.plugin.pick(new Vec3(-2.5, 1.25, -5), new Vec3(0, 0, 1))).toBeUndefined();
    // The right monitor is turned around: its front faces -z.
    expect(g.plugin.pick(new Vec3(3, 1, -5), new Vec3(0, 0, 1))?.entity).toBe(g.id('right'));
  });

  it('reads correctly from the front: the panel left edge is on the viewer left', () => {
    // Seen from +z looking down -z (left-handed), the viewer's left is +x: the u = 0 corners
    // must sit at +x and v = 0 (the panel's top) at +y, or the text reads mirrored.
    const corner = (i: number) => ({ x: QUAD.positions[i * 3]!, y: QUAD.positions[i * 3 + 1]!, u: QUAD.uvs![i * 2]!, v: QUAD.uvs![i * 2 + 1]! });
    for (let i = 0; i < 4; i++) {
      const c = corner(i);
      expect(c.u).toBe(c.x > 0 ? 0 : 1);
      expect(c.v).toBe(c.y > 0 ? 0 : 1);
    }
    // And a press agrees with what is drawn: the viewer's upper-left is texel (0, 0)'s corner.
    const g = make();
    g.step();
    expect(g.plugin.pick(new Vec3(-2.001, 1.499, 5), new Vec3(0, 0, -1))).toMatchObject({ x: 0, y: 0 });
    expect(g.plugin.pick(new Vec3(-3.999, 0.501, 5), new Vec3(0, 0, -1))).toMatchObject({ x: 199, y: 99 });
  });

  it('render3d gets an unlit quad per screen sampling its target', () => {
    const g = make();
    g.step();
    const draws = g.kernel.service(SCREENS_SERVICE).draws();
    expect(draws).toHaveLength(2);
    const d = draws[0]!;
    expect(d.material.unlit).toBe(true);
    expect(d.material.baseColorTexture!.source).toEqual({ kind: 'target', target: `screen:${g.id('left')}` });
    // The unit quad scaled to size (2 × 1), at the entity.
    expect(Array.from(d.instances.subarray(0, 16)).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -3, 1, 0, 1]);
    const screen = g.kernel.world.get(g.id('left'))!.components.get('screen')! as Record<string, unknown>;
    screen['on'] = false;
    expect(g.kernel.service(SCREENS_SERVICE).draws()).toHaveLength(1);
  });

  it('a bad resolution is PP3338', () => {
    const g = make();
    (g.kernel.world.get(g.id('left'))!.components.get('screen') as Record<string, unknown>)['resolution'] = new Vec3(4, 4, 0) as never;
    let code = '';
    try { g.step(); } catch (e) { code = (e as ParallaxError).diagnostic.code; }
    expect(code).toBe('PP3338');
  });
});
