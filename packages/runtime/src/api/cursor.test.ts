/**
 * `Cursor`: its arguments, and the look the panel surface is handed each frame — the game's
 * `Game(cursor=...)`, replaced by the newest open panel's `@ui(cursor=...)` while it is open.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Color, ParallaxError } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { Kernel } from '../function/kernel/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { UiPresenter } from '../function/plugins/ui/index.js';
import { RecordingUiSurface } from '../platform/headless/ui.js';
import { loadProject } from '../resource/index.js';
import { Game } from './game.js';
import { Actions, button, resetActionSets } from './input.js';
import { kw } from './kwargs.js';
import { ImageRef, SceneRef } from './types.js';
import { Cursor, interfacePlugins, Panel, resetPanels, ui } from './ui.js';

afterEach(() => { resetActionSets(); resetPanels(); });

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

describe('Cursor', () => {
  it('defaults to the engine ring, centred, drawn only where the engine owns the cursor', () => {
    expect(new Cursor().__cursor__).toEqual({ visual: 'ring', size: 24, color: null, image: null, hotspot: [0.5, 0.5], showInMenus: false });
  });

  it('takes a look, an image (path or ImageRef, which implies visual "image"), a hotspot and show_in_menus', () => {
    const dot = new Cursor('dot', kw({ size: 10, color: Color.hex('#ff0000'), show_in_menus: true }));
    expect(dot.__cursor__).toMatchObject({ visual: 'dot', size: 10, color: [1, 0, 0, 1], showInMenus: true });
    const quill = new Cursor(kw({ image: new ImageRef('assets/ui/quill.png'), hotspot: [0, 0.25] }));
    expect(quill.__cursor__).toMatchObject({ visual: 'image', image: 'assets/ui/quill.png', hotspot: [0, 0.25] });
  });

  it('rejects what it cannot draw (PP4429)', () => {
    expect(code(() => new Cursor('arrow'))).toBe('PP4429');
    expect(code(() => new Cursor('image'))).toBe('PP4429');
    expect(code(() => new Cursor(kw({ size: 1000 })))).toBe('PP4429');
    expect(code(() => new Cursor(kw({ color: '#fff' })))).toBe('PP4429');
    expect(code(() => new Cursor(kw({ hotspot: [2, 0] })))).toBe('PP4429');
    expect(code(() => ui('m', kw({ html: 'ui/m.html', cursor: 'dot' }))(class M extends Panel {}))).toBe('PP4429');
    const game = { id: 'g', title: 'G', sdk: '1', start_scene: new SceneRef('main'), mode: '2d' };
    expect(code(() => new Game(kw({ ...game, cursor: 'ring' })))).toBe('PP4113');
    expect(new Game(kw({ ...game, cursor: new Cursor('crosshair') })).cursor?.visual).toBe('crosshair');
    expect(new Game(kw(game)).cursor).toBeNull();
    // pointer_lock=: a host's Play locks by default; False opts out; anything else is refused.
    expect(new Game(kw(game)).pointer_lock).toBe(true);
    expect(new Game(kw({ ...game, pointer_lock: false })).pointer_lock).toBe(false);
    expect(code(() => new Game(kw({ ...game, pointer_lock: 'no' })))).toBe('PP4113');
  });
});

describe('the cursor look in the UI frame', () => {
  it('is the game\'s, and a panel\'s own while it is open', () => {
    class Controls extends Actions {
      static map = button(kw({ keyboard: 'KeyM' }));
    }
    Controls.__init_subclass__();
    ui('hud', kw({ html: 'ui/hud.html' }))(class Hud extends Panel {});
    const quill = new Cursor(kw({ image: 'assets/ui/quill.png', hotspot: [0, 0] }));
    ui('map', kw({ html: 'ui/map.html', modal: true, toggle_with: Controls.map, cursor: quill }))(class MapPanel extends Panel {});

    const text = { 'scenes/main/scene.json': JSON.stringify({ ui: ['hud'], entities: [] }) };
    const files: ProjectFiles = { list: () => Object.keys(text), read: (p) => text[p as keyof typeof text] };
    const project = loadProject(files);
    const devices = new HeadlessInput();
    const plugins = interfacePlugins({ devices, content: { content: (_t, id) => id } });
    const kernel = new Kernel({
      project, game: { components: [], events: [], behaviors: [], systems: [], resources: [] },
      plugins: [plugins.input, plugins.ui], context: {},
    });
    const surface = new RecordingUiSurface();
    const presenter = new UiPresenter({
      engine: plugins.ui.engine, kernel, surface, screen: () => ({ width: 800, height: 600 }),
      locale: () => ({ language: 'en', strings: {} }), values: { text: String, truthy: Boolean },
      cursor: new Cursor('dot').__cursor__,
    });
    kernel.addHook('input', () => presenter.takeClicks());
    kernel.addHook('render', () => presenter.present());
    kernel.start('main');
    const step = (): void => kernel.step(1 / 60);

    step();
    expect(surface.last?.cursor?.visual).toBe('dot');
    devices.tapKey('KeyM');
    step();
    step();
    expect(surface.last?.panels.map((p) => p.id)).toEqual(['hud', 'map']);
    expect(surface.last?.cursor).toEqual(quill.__cursor__);
    devices.tapKey('KeyM');
    step();
    step();
    expect(surface.last?.cursor?.visual).toBe('dot');
  });
});
