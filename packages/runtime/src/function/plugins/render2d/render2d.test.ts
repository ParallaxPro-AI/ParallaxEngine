/**
 * render2d against the kernel, with a recording surface. The rendering components belong
 * to the visuals plugin (built alongside); `STAND_INS` declares them here with the SDK's
 * field names and the two animation fields render2d reads (SPRITE_ANIMATION), which is
 * the contract render2d needs from visuals.
 */

import { describe, expect, it } from 'vitest';
import { Color, ParallaxError, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, Frame2d, ProjectFiles, Rgba } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { JsonObject, Project } from '../../../resource/index.js';
import { RecordingSurface2d } from '../../../platform/headless/render.js';
import { Kernel, t } from '../../kernel/index.js';
import type { BehaviorDef, ComponentDef, FieldType, GameDefinition, KernelPlugin, Schema } from '../../kernel/index.js';
import { ENVIRONMENT_SERVICE } from '../../services/index.js';
import type { EnvironmentService, ResolvedEnvironment } from '../../services/index.js';
import { AssetCatalog } from './assets.js';
import { parseEffect } from './effects.js';
import { BAR_SIZE, DEFAULT_AMBIENT_2D, lightAt, PARTICLES, parseMarkup, render2d, TRAIL_SECONDS } from './index.js';
import type { Render2dPlugin } from './index.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

// ── Stand-in rendering components (the visuals plugin's, by the SDK's field names) ──

const opt = (of: FieldType): FieldType => ({ kind: 'optional', of });
const image = opt({ kind: 'ref', to: 'asset/images' });

const STAND_INS: readonly ComponentDef[] = [
  {
    id: 'sprite', schema: {
      image: { type: image, default: null },
      size: t.vec2({ default: new Vec2(1, 1) }),
      color: t.color({ default: Color.WHITE }),
      offset: t.vec2({ default: Vec2.ZERO }),
      flip_x: t.bool({ default: false }),
      flip_y: t.bool({ default: false }),
      blend: t.enum(['normal', 'additive'], { default: 'normal' }),
      animations: t.json({ default: {} }),
      animation: { type: opt({ kind: 'string' }), default: null },
      animation_started: t.number({ default: 0 }),
    },
  },
  {
    id: 'shape', schema: {
      kind: t.enum(['box', 'sphere', 'capsule', 'cylinder', 'cone', 'plane', 'circle', 'rect', 'polygon', 'ring'], { default: 'rect' }),
      size: t.vec3({ default: Vec3.ONE }),
      offset: t.vec3({ default: Vec3.ZERO }),
      color: t.color({ default: Color.WHITE }),
      emissive: t.color({ default: Color.BLACK }),
      metallic: t.number({ default: 0 }),
      roughness: t.number({ default: 0.5 }),
      texture: { type: image, default: null },
      cast_shadows: t.bool({ default: true }),
      points: { type: { kind: 'list', of: { kind: 'vec2' } }, default: [] },
      thickness: t.number({ default: 0.1 }),
      corner_radius: t.number({ default: 0 }),
      stroke_width: t.number({ default: 0 }),
      stroke_color: t.color({ default: Color.BLACK }),
    },
  },
  {
    id: 'text_mesh', schema: {
      text: t.string({ default: '' }), size: t.number({ default: 0.5 }), color: t.color({ default: Color.WHITE }),
      face_camera: t.bool({ default: false }),
    },
  },
  {
    id: 'particles', schema: {
      effect: t.ref('asset/vfx'), emitting: t.bool({ default: true }), rate_scale: t.number({ default: 1 }),
    },
  },
  {
    id: 'camera', schema: {
      rig: t.enum(['fixed', 'follow', 'orbit', 'first_person'], { default: 'fixed' }),
      mode: t.enum(['perspective', 'orthographic'], { default: 'orthographic' }),
      fov: t.number({ default: 60 }),
      size: t.number({ default: 5 }),
      follow: t.json({ default: null }),
      fit: t.json({ default: null }),
      fit_margin: t.number({ default: 0 }),
      min_visible: t.json({ default: null }),
      background: { type: opt({ kind: 'color' }), default: null },
      viewport: t.json({ default: [0, 0, 1, 1] }),
    },
  },
  {
    id: 'world_bar', schema: {
      value: t.number({ default: 0 }), offset: t.vec3({ default: new Vec3(0, 1, 0) }), color: t.color({ default: Color.GREEN }),
      bands: t.json({ default: [] }), shown: t.bool({ default: true }),
    },
  },
  {
    id: 'light', schema: {
      kind: t.enum(['point', 'spot', 'directional'], { default: 'point' }), color: t.color({ default: Color.WHITE }),
      intensity: t.number({ default: 1 }), range: t.number({ default: 10 }), angle: t.number({ default: 45 }), shadows: t.bool({ default: false }),
    },
  },
  {
    id: 'grid', schema: {
      cols: t.int({ default: 8 }), rows: t.int({ default: 8 }), cell_size: t.vec2(),
      plane: t.enum(['xy', 'xz'], { default: 'xy' }), origin: t.enum(['center', 'corner'], { default: 'center' }),
      row_order: t.enum(['down', 'up'], { default: 'down' }),
    },
  },
];

// ── Fixtures ────────────────────────────────────────────────────────────────────

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([path, value]) =>
    [path, typeof value === 'string' ? value : JSON.stringify(value)]));
  return { list: () => Object.keys(text).sort(), read: (path) => text[path]! };
}

const SPARKS = { burst: 12, lifetime: 0.5, speed: [1, 3], size: 0.2, color_end: '#ffffff00' };

const BASE: Record<string, unknown> = {
  'prefabs/camera.prefab.json': { components: { camera: { mode: 'orthographic', size: 5 } } },
  'prefabs/block.prefab.json': { z: 2, components: { shape: { kind: 'rect', size: [2, 1], color: '#ff0000' } } },
  'prefabs/coin.prefab.json': { z: 1, components: { shape: { kind: 'circle', size: [0.5, 0.5], color: '#ffcc00' } } },
  'prefabs/hero.prefab.json': {
    z: 5,
    components: {
      sprite: {
        image: 'images/hero', size: [1, 2],
        animations: { run: { frames: ['images/run_0', 'images/run_1', 'images/run_2'], fps: 10, loop: true } },
      },
    },
    children: [{ name: 'label', at: [0, 1.5], components: { text_mesh: { text: 'Hi [b]you[/b]', size: 0.4 } } }],
  },
  'prefabs/smoke.prefab.json': { components: { particles: { effect: 'vfx/smoke' } } },
  'assets/images/hero.png': '',
  'assets/images/run_0.png': '',
  'assets/images/run_1.png': '',
  'assets/images/run_2.png': '',
  'assets/vfx/sparks.vfx.json': SPARKS,
  'assets/vfx/smoke.vfx.json': { rate: 20, lifetime: 1, speed: 1, direction: 90, spread: 0, burst: 2 },
};

const GAME: GameDefinition = { components: STAND_INS, resources: [], events: [], behaviors: [], systems: [] };

interface Setup {
  readonly kernel: Kernel;
  readonly surface: RecordingSurface2d;
  readonly plugin: Render2dPlugin;
}

function setup(entities: JsonObject[], extra: Record<string, unknown> = {}, surfaceOptions = {}, others: KernelPlugin[] = []): Setup {
  const contents = { ...BASE, ...extra, 'scenes/main/scene.json': { entities } };
  const projectFiles = files(contents);
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const surface = new RecordingSurface2d({ keep: 4, ...surfaceOptions });
  const plugin = render2d({ surface, files: projectFiles, assetFiles: true });
  const kernel = new Kernel({ project, game: GAME, plugins: [...others, plugin] });
  return { kernel, surface, plugin };
}

function started(entities: JsonObject[], extra: Record<string, unknown> = {}, surfaceOptions = {}): Setup {
  const s = setup(entities, extra, surfaceOptions);
  s.kernel.start('main');
  return s;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ParallaxError) return error.diagnostic.code;
    throw error;
  }
  throw new Error('expected a ParallaxError');
}

function placed(kernel: Kernel, prefab: string): EntityId {
  for (const record of kernel.world.live()) if (record.prefab === prefab) return record.id;
  throw new Error(`no ${prefab}`);
}

const close = (a: readonly number[], b: readonly number[]): void => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));
};

// ── Pieces ──────────────────────────────────────────────────────────────────────

describe('AssetCatalog', () => {
  const catalog = new AssetCatalog(files({ 'assets/images/ship.png': '', 'assets/images/ui/star.webp': '', 'assets/vfx/boom.vfx.json': '{}' }), true);

  it('resolves the three ways a reference is written', () => {
    expect(code(() => catalog.resolve('assets/images/ship.png', 'images', 'x'))).toBe('PP2063');
    expect(() => catalog.resolve('assets/images/ship.png', 'images', 'x')).toThrow(/"images\/ship"/);
    expect(catalog.resolve('images/ship', 'images', 'x')).toBe('assets/images/ship.png');
    expect(code(() => catalog.resolve('ship', 'images', 'x'))).toBe('PP2063');
    expect(catalog.resolve('images/ui/star', 'images', 'x')).toBe('assets/images/ui/star.webp');
    expect(catalog.resolve('vfx/boom', 'vfx', 'x')).toBe('assets/vfx/boom.vfx.json');
  });

  it('reports a missing or misplaced asset as PP2063 with a suggestion', () => {
    expect(code(() => catalog.resolve('images/shipp', 'images', 'sprite.image'))).toBe('PP2063');
    expect(() => catalog.resolve('images/shipp', 'images', 'sprite.image')).toThrow(/Did you mean "images\/ship"/);
    expect(code(() => catalog.resolve('images/nope', 'images', 'x'))).toBe('PP2063');
    expect(code(() => catalog.resolve('vfx/boom', 'images', 'sprite.image'))).toBe('PP2063');
  });
});

describe('AssetCatalog without the asset files (data-only runs)', () => {
  const catalog = new AssetCatalog(files({ 'assets/images/ship.png': '' }), false);

  it('checks form and folder only: a reference without a file resolves to its handle', () => {
    expect(catalog.resolve('images/night_forest', 'images', 'x')).toBe('images/night_forest');
    expect(catalog.resolve('images/ui/star', 'images', 'x')).toBe('images/ui/star');
    expect(code(() => catalog.resolve('assets/images/clouds.png', 'images', 'x'))).toBe('PP2063');
    expect(code(() => catalog.resolve('night_forest', 'images', 'x'))).toBe('PP2063');
    expect(catalog.resolve('images/ship', 'images', 'x')).toBe('assets/images/ship.png');
    expect(catalog.has('images/night_forest')).toBe(false);
  });

  it('still rejects a reference in the wrong folder', () => {
    expect(code(() => catalog.resolve('vfx/boom', 'images', 'sprite.image'))).toBe('PP2063');
    expect(code(() => catalog.resolve('assets/sfx/hit.ogg', 'images', 'sprite.image'))).toBe('PP2063');
  });
});

describe('render2d without the asset files', () => {
  const contents = {
    ...BASE,
    'prefabs/backdrop.prefab.json': { components: { sprite: { image: 'images/night_forest', size: [16, 16] } } },
    'prefabs/torch.prefab.json': { components: { particles: { effect: 'vfx/flame' } } },
    'scenes/main/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'backdrop' }, { prefab: 'torch' }] },
  };

  it('draws sprites without their files as their color, fetches nothing, and runs effects that emit nothing', () => {
    const surface = new RecordingSurface2d();
    const plugin = render2d({ surface, files: files(contents), assetFiles: false });
    const kernel = new Kernel({ project: loadProject(files(contents)), game: GAME, plugins: [plugin] });
    kernel.start('main');
    kernel.step(1 / 60);
    expect(surface.loaded).toEqual([]);
    expect(surface.last!.commands.some((c) => c.kind === 'image')).toBe(false);
    expect(surface.last!.commands.some((c) => c.kind === 'rect')).toBe(true);
    plugin.engine.play('vfx/boom', { x: 0, y: 0, z: null }, {});
    kernel.step(1 / 60);
    expect(plugin.engine.particles.liveParticles).toBe(0);
  });

  it('tints each missing image by a hue hashed from its reference, so pieces stay distinguishable', () => {
    const pieces = {
      ...contents,
      'prefabs/rook.prefab.json': { components: { sprite: { image: 'images/white_rook', color: '#ffffff' } } },
      'prefabs/queen.prefab.json': { components: { sprite: { image: 'images/white_queen', color: '#ffffff' } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'rook' }, { prefab: 'queen' }, { prefab: 'rook', at: [2, 0] }] },
    };
    const surface = new RecordingSurface2d();
    const kernel = new Kernel({ project: loadProject(files(pieces)), game: GAME, plugins: [render2d({ surface, files: files(pieces), assetFiles: false })] });
    kernel.start('main');
    kernel.step(1 / 60);
    const fills = surface.last!.commands.map((c) => (c as { fill: Rgba }).fill);
    expect(fills).toHaveLength(3);
    expect(fills[0]).toEqual(fills[2]);
    expect(fills[0]).not.toEqual(fills[1]);
    for (const fill of fills) {
      expect(fill).not.toEqual([1, 1, 1, 1]);
      expect(fill.every((v) => v >= 0 && v <= 1)).toBe(true);
    }
  });

  it('with the asset files available, a missing file stays PP2063', () => {
    const plugin = render2d({ surface: new RecordingSurface2d(), files: files(contents), assetFiles: true });
    const kernel = new Kernel({ project: loadProject(files(contents)), game: GAME, plugins: [plugin] });
    expect(code(() => { kernel.start('main'); kernel.step(1 / 60); })).toBe('PP2063');
  });
});

describe('effect files', () => {
  const catalog = new AssetCatalog(files({ 'assets/images/spark.png': '' }), true);
  const parse = (doc: unknown): ReturnType<typeof parseEffect> => parseEffect('assets/vfx/x.vfx.json', JSON.stringify(doc), catalog);

  it('fills defaults and reads ranges, colors and images', () => {
    const def = parse({ burst: 5, lifetime: [0.2, 0.4], color: '#ff0000', color_end: '#ff000000', image: 'images/spark' });
    expect(def).toMatchObject({
      burst: 5, rate: 0, lifetime: { lo: 0.2, hi: 0.4 }, speed: { lo: 2, hi: 2 }, spread: 360, shape: 'circle',
      color: [1, 0, 0, 1], colorEnd: [1, 0, 0, 0], image: 'assets/images/spark.png', sizeEnd: null,
    });
  });

  it('rejects what it cannot run, naming the file', () => {
    expect(code(() => parse({ burst: 1, speeed: 3 }))).toBe('PP3808');
    expect(() => parse({ burst: 1, speeed: 3 })).toThrow(/unknown key "speeed"/);
    expect(() => parse({})).toThrow(/emits nothing/);
    expect(() => parse({ burst: 1, speed: [3, 1] })).toThrow(/lo must not exceed hi/);
    expect(() => parse({ burst: 1, lifetime: 0 })).toThrow(/above 0/);
    expect(() => parse({ burst: 1.5 })).toThrow(/whole number/);
    expect(code(() => parse({ burst: 1, image: 'images/missing' }))).toBe('PP2063');
    expect(code(() => parseEffect('assets/vfx/x.vfx.json', '{', catalog))).toBe('PP3808');
  });
});

describe('text markup', () => {
  const white: Rgba = [1, 1, 1, 1];

  it('splits color and bold spans, nesting, and keeps other brackets literal', () => {
    expect(parseMarkup('Score [b]12[/b] [x]', white)).toEqual([
      { text: 'Score ', color: white, bold: false },
      { text: '12', color: white, bold: true },
      { text: ' [x]', color: white, bold: false },
    ]);
    const spans = parseMarkup('[color=#ff0000]red [b]bold[/b][/color]!', white);
    expect(spans.map((s) => [s.text, s.color, s.bold])).toEqual([
      ['red ', [1, 0, 0, 1], false], ['bold', [1, 0, 0, 1], true], ['!', white, false],
    ]);
  });

  it('rejects unbalanced markup', () => {
    expect(code(() => parseMarkup('a[/b]', white))).toBe('PP3603');
    expect(code(() => parseMarkup('[color=#fff]a', white))).toBe('PP3603');
    expect(code(() => parseMarkup('a[/color]', white))).toBe('PP3603');
  });
});

// ── The renderer in a kernel ────────────────────────────────────────────────────

describe('2D lighting', () => {
  const lights = {
    'prefabs/torch.prefab.json': { components: { light: { kind: 'point', color: '#ff0000', range: 4, intensity: 1 } } },
    'prefabs/beam.prefab.json': { components: { light: { kind: 'spot', color: '#0000ff', range: 5, angle: 60, intensity: 2 } } },
    'prefabs/moon.prefab.json': { components: { light: { kind: 'directional', color: '#00ff00', intensity: 0.5 } } },
  };

  it('is off without lights; with them, point and spot pools over the ambient, directional raises the ambient', () => {
    const plain = started([{ prefab: 'camera' }, { prefab: 'block' }]);
    plain.kernel.step(1 / 60);
    expect(plain.surface.last!.lighting).toBeNull();

    const { kernel, surface } = started([
      { prefab: 'camera' }, { prefab: 'torch', at: [2, 0] }, { prefab: 'beam', at: [0, 0], rotation: 90 }, { prefab: 'moon' },
    ], lights);
    kernel.step(1 / 60);
    const lighting = surface.last!.lighting!;
    close(lighting.ambient, [DEFAULT_AMBIENT_2D[0], DEFAULT_AMBIENT_2D[1] + 0.5, DEFAULT_AMBIENT_2D[2]]);
    expect(lighting.lights.map((l) => [l.kind, l.x, l.y, l.radius])).toEqual([['point', 2, 0, 4], ['spot', 0, 0, 5]]);
    expect(lighting.lights[1]!.direction).toBeCloseTo(90);
    // At the torch: full red. Halfway out: a quarter. Beyond its range: ambient.
    expect(lightAt(lighting, 2, 0)[0]).toBe(1);
    expect(lightAt(lighting, 4, 0)[0]).toBeCloseTo(DEFAULT_AMBIENT_2D[0] + 0.25);
    expect(lightAt(lighting, 7, 0)[0]).toBeCloseTo(DEFAULT_AMBIENT_2D[0]);
    // The spot points up (+y) with a 60° cone: lit above, dark below and to the side.
    expect(lightAt(lighting, 0, 2.5)[2]).toBeCloseTo(Math.min(1, DEFAULT_AMBIENT_2D[2] + 0.25 * 2));
    expect(lightAt(lighting, 0, -2.5)[2]).toBeCloseTo(DEFAULT_AMBIENT_2D[2]);
    expect(lightAt(lighting, 2.5, 0.5)[2]).toBeCloseTo(DEFAULT_AMBIENT_2D[2]);
  });
});

describe('render2d frames', () => {
  it('draws every visible entity back to front through the camera, with hierarchy transforms', () => {
    const { kernel, surface } = started([
      { prefab: 'camera', at: [1, 2] },
      { prefab: 'hero', at: [3, 0], rotation: 90, scale: 2 },
      { prefab: 'block', at: [0, -1] },
      { prefab: 'coin', at: [-2, 0] },
    ]);
    kernel.step(1 / 60);
    const frame = surface.last!;
    expect(frame.view).toEqual({ center: [1, 2], halfHeight: 5, angle: 0, background: null, viewport: [0, 0, 1, 1] });
    expect(frame.commands.map((c) => [c.kind, c.z])).toEqual([['ellipse', 1], ['rect', 2], ['image', 5], ['text', 5]]);
    const [coin, block, hero, label] = frame.commands as [Frame2d['commands'][number], ...Frame2d['commands']];
    expect(coin).toMatchObject({ kind: 'ellipse', size: [0.5, 0.5], image: null });
    expect(block).toMatchObject({ kind: 'rect', size: [2, 1], fill: [1, 0, 0, 1], transform: [1, 0, 0, 1, 0, -1] });
    expect(hero).toMatchObject({ kind: 'image', image: 'assets/images/hero.png', size: [1, 2], tint: [1, 1, 1, 1] });
    close((hero as { transform: readonly number[] }).transform, [0, 2, -2, 0, 3, 0]);
    // The label child sits 1.5 up in its parent's space: turned 90° and doubled → 3 to the left.
    close((label as { transform: readonly number[] }).transform, [0, 2, -2, 0, 0, 0]);
    expect(label).toMatchObject({ kind: 'text', size: 0.4, spans: [{ text: 'Hi ', bold: false }, { text: 'you', bold: true }] });
    expect(surface.loaded).toEqual(['assets/images/hero.png', 'assets/images/run_0.png', 'assets/images/run_1.png', 'assets/images/run_2.png']);
  });

  it('carries an additive sprite\'s blend on its image (and on its rect without an image)', () => {
    const glow = { 'prefabs/glow.prefab.json': { z: 3, components: { sprite: { image: 'images/hero', blend: 'additive' } } },
      'prefabs/flare.prefab.json': { z: 4, components: { sprite: { blend: 'additive' } } } };
    const { kernel, surface } = started([{ prefab: 'camera' }, { prefab: 'glow' }, { prefab: 'flare' }, { prefab: 'hero' }], glow);
    kernel.step(1 / 60);
    const [image, rect, plain] = surface.last!.commands;
    expect(image).toMatchObject({ kind: 'image', blend: 'additive' });
    expect(rect).toMatchObject({ kind: 'rect', blend: 'additive' });
    expect(plain).toMatchObject({ kind: 'image' });
    expect('blend' in plain!).toBe(false);
  });

  it('hides invisible entities and their children', () => {
    const { kernel, surface } = started([{ prefab: 'camera' }, { prefab: 'hero', visible: false }, { prefab: 'block' }]);
    kernel.step(1 / 60);
    expect(surface.counts()).toEqual({ rect: 1 });
    kernel.world.get(placed(kernel, 'hero'))!.visible = true;
    kernel.step(1 / 60);
    expect(surface.counts()).toEqual({ rect: 1, image: 1, text: 1 });
  });

  it('shows the playing animation frame by game time, looping', () => {
    const { kernel, surface } = started([{ prefab: 'camera' }, { prefab: 'hero' }]);
    const sprite = kernel.world.get(placed(kernel, 'hero'))!.components.get('sprite')!;
    const shown = (): string => (surface.last!.commands.find((c) => c.kind === 'image') as { image: string }).image;
    kernel.step(1 / 60);
    expect(shown()).toBe('assets/images/hero.png');
    // What visuals' Sprite.play("run") records.
    sprite['animation'] = 'run';
    sprite['animation_started'] = kernel.time.now;
    const frames: string[] = [];
    for (let i = 0; i < 24; i++) {
      kernel.step(1 / 60);
      frames.push(shown());
    }
    expect(frames.slice(0, 5)).toEqual(Array(5).fill('assets/images/run_0.png'));
    expect(frames[6]).toBe('assets/images/run_1.png');
    expect(frames[12]).toBe('assets/images/run_2.png');
    expect(frames[18]).toBe('assets/images/run_0.png');
    sprite['animation'] = 'jump';
    expect(code(() => kernel.step(1 / 60))).toBe('PP3609');
  });

  it('fits a rectangle at any aspect ratio, or the grid', () => {
    const fit = { prefab: 'camera', components: { camera: { fit: [[-4, -1], [4, 3]], fit_margin: 1 } } };
    const wide = started([fit], {}, { width: 1600, height: 900 });
    wide.kernel.step(1 / 60);
    expect(wide.surface.last!.view.center).toEqual([0, 1]);
    expect(wide.surface.last!.view.halfHeight).toBeCloseTo(3); // height-bound: (4 + 2) / 2
    const tall = started([fit], {}, { width: 900, height: 1600 });
    tall.kernel.step(1 / 60);
    expect(tall.surface.last!.view.halfHeight).toBeCloseTo(5 / (900 / 1600)); // width-bound: (8 + 2) / 2 / aspect

    const board = { 'prefabs/board.prefab.json': { components: { grid: { cols: 4, rows: 2, cell_size: [1, 1], origin: 'corner' } } } };
    const grid = started([{ prefab: 'camera', components: { camera: { fit: 'grid' } } }, { prefab: 'board', at: [10, 10] }], board, { width: 800, height: 800 });
    grid.kernel.step(1 / 60);
    expect(grid.surface.last!.view.center).toEqual([12, 9]);
    expect(grid.surface.last!.view.halfHeight).toBeCloseTo(2);
  });

  it('keeps min_visible in view at any aspect ratio', () => {
    const cam = { prefab: 'camera', components: { camera: { size: 4.5, min_visible: [9, 9] } } };
    const wide = started([cam], {}, { width: 1600, height: 900 });
    wide.kernel.step(1 / 60);
    expect(wide.surface.last!.view.halfHeight).toBeCloseTo(4.5); // size already shows 9 m
    const tall = started([cam], {}, { width: 900, height: 1600 });
    tall.kernel.step(1 / 60);
    expect(tall.surface.last!.view.halfHeight).toBeCloseTo(4.5 / (900 / 1600)); // widened to keep 9 m across
  });

  it('turns the view with the camera and clears with its background', () => {
    const { kernel, surface } = started([{ prefab: 'camera', rotation: 30, components: { camera: { background: '#000000' } } }]);
    kernel.step(1 / 60);
    expect(surface.last!.view.angle).toBeCloseTo(30);
    expect(surface.last!.view.background).toEqual([0, 0, 0, 1]);
  });

  it('a camera without a background clears with the environment\'s sky colour', () => {
    const sky: KernelPlugin = {
      id: 'sky',
      install: (k) => k.provide(ENVIRONMENT_SERVICE, {
        resolve: () => ({ clear: new Color(0.2, 0.4, 0.6) }) as ResolvedEnvironment,
      } as EnvironmentService),
    };
    const s = setup([{ prefab: 'camera' }], {}, {}, [sky]);
    s.kernel.start('main');
    s.kernel.step(1 / 60);
    close(s.surface.last!.view.background!, [0.2, 0.4, 0.6, 1]);
    const own = setup([{ prefab: 'camera', components: { camera: { background: '#000000' } } }], {}, {}, [sky]);
    own.kernel.start('main');
    own.kernel.step(1 / 60);
    expect(own.surface.last!.view.background).toEqual([0, 0, 0, 1]);
  });

  it('applies the rig: its active camera and shake offset', () => {
    const contents = { ...BASE, 'scenes/main/scene.json': { entities: [{ prefab: 'camera', at: [0, 0] }, { prefab: 'camera', at: [5, 5] }] } };
    const surface = new RecordingSurface2d();
    const plugin = render2d({
      surface, files: files(contents), assetFiles: true,
      rig: (k) => ({ active: () => [...k.world.live()][1]!.id, offset: () => [0.25, -0.5] }),
    });
    const kernel = new Kernel({ project: loadProject(files(contents)), game: GAME, plugins: [plugin] });
    kernel.start('main');
    kernel.step(1 / 60);
    expect(surface.last!.view.center).toEqual([5.25, 4.5]);
  });

  it('draws a world bar as back, bands and fill over its entity', () => {
    const bars = { 'prefabs/meter.prefab.json': { z: 3, components: { world_bar: { value: 0.25 } } } };
    const { kernel, surface } = started([{ prefab: 'camera' }, { prefab: 'meter', at: [2, 0] }], bars);
    const bar = kernel.world.get(placed(kernel, 'meter'))!.components.get('world_bar')!;
    bar['bands'] = [[0.5, 0.75, Color.RED]];
    kernel.step(1 / 60);
    const rects = surface.last!.commands.filter((c) => c.kind === 'rect') as Array<{ size: readonly number[]; transform: readonly number[]; fill: Rgba }>;
    expect(rects.map((r) => [r.size[0], r.transform[4], r.transform[5], r.fill])).toEqual([
      [BAR_SIZE[0], 2, 1, [0, 0, 0, 0.6]],
      [0.25, 2.125, 1, [1, 0, 0, 1]],
      [0.25, 1.625, 1, [0, 1, 0, 1]],
    ]);
    bar['shown'] = false;
    kernel.step(1 / 60);
    expect(surface.counts()).toEqual({});
  });

  it('draws rings, polygons, rounded rects and outlines', () => {
    const { kernel, surface } = started([
      { prefab: 'camera' },
      { prefab: 'block', at: [0, 0], components: { shape: { kind: 'ring', size: [3, 2, 1], thickness: 0.25 } } },
      { prefab: 'block', at: [1, 0], components: { shape: { kind: 'polygon', size: [2, 1, 1], points: [[-1, 0], [1, 0], [0, 2]], stroke_width: 0.1, stroke_color: [1, 0, 0, 1] } } },
      { prefab: 'block', at: [2, 0], components: { shape: { kind: 'rect', size: [2, 1, 1], corner_radius: 5 } } },
      { prefab: 'block', at: [3, 0], components: { shape: { kind: 'ring', size: [1, 1, 1], thickness: 2 } } },
    ]);
    kernel.step(1 / 60);
    const [ring, polygon, rect, disc] = surface.last!.commands as unknown as Array<Record<string, unknown>>;
    expect(ring).toMatchObject({ kind: 'ellipse', size: [3, 2], hole: [2.5, 1.5] });
    expect(ring!['stroke']).toBeUndefined();
    expect(polygon).toMatchObject({ kind: 'polygon', points: [-2, 0, 2, 0, 0, 2], stroke: { width: 0.1, color: [1, 0, 0, 1] } });
    // The radius is clamped to half the shorter side.
    expect(rect).toMatchObject({ kind: 'rect', size: [2, 1], radius: 0.5 });
    // A band at least as wide as the radius is a filled disc.
    expect(disc).toMatchObject({ kind: 'ellipse' });
    expect(disc!['hole']).toBeUndefined();
  });

  it('fails loudly on what it cannot draw', () => {
    expect(code(() => started([{ prefab: 'hero', components: { sprite: { image: 'images/villain' } } }]))).toBe('PP2063');
    const noCamera = started([{ prefab: 'block' }]);
    expect(code(() => noCamera.kernel.step(1 / 60))).toBe('PP3604');
    const perspective = started([{ prefab: 'camera', components: { camera: { mode: 'perspective' } } }]);
    expect(code(() => perspective.kernel.step(1 / 60))).toBe('PP3605');
    const box = started([{ prefab: 'camera' }, { prefab: 'block', components: { shape: { kind: 'box' } } }]);
    expect(() => box.kernel.step(1 / 60)).toThrow(/Use "kind": "rect"/);
    const polygon = started([{ prefab: 'camera' }, { prefab: 'block', components: { shape: { kind: 'polygon', points: [[0, 0], [1, 0]] } } }]);
    expect(code(() => polygon.kernel.step(1 / 60))).toBe('PP3608');
    const flat = started([{ prefab: 'camera' }, { prefab: 'block', components: { shape: { kind: 'ring', thickness: 0 } } }]);
    expect(code(() => flat.kernel.step(1 / 60))).toBe('PP3608');
    const badFit = started([{ prefab: 'camera', components: { camera: { fit: [[1, 1], [0, 0]] } } }]);
    expect(code(() => badFit.kernel.step(1 / 60))).toBe('PP3606');
  });

  it('raises an image the surface failed to load on the next frame', () => {
    const { kernel } = started([{ prefab: 'camera' }, { prefab: 'hero' }], {}, { failing: ['assets/images/run_1.png'] });
    expect(code(() => kernel.step(1 / 60))).toBe('PP3610');
  });

  it('checks images given at runtime when they are drawn', () => {
    const { kernel, surface } = started([{ prefab: 'camera' }, { prefab: 'hero' }]);
    const sprite = kernel.world.get(placed(kernel, 'hero'))!.components.get('sprite')!;
    sprite['image'] = { path: 'images/run_2' }; // an ImageRef, as game code assigns it
    kernel.step(1 / 60);
    expect((surface.last!.commands[0] as { image: string }).image).toBe('assets/images/run_2.png');
    sprite['image'] = 'nobody';
    expect(code(() => kernel.step(1 / 60))).toBe('PP2063');
  });
});

describe('effects', () => {
  const particleCount = (frame: Frame2d | undefined): number =>
    (frame?.commands ?? []).reduce((n, c) => n + (c.kind === 'particles' ? c.count : 0), 0);

  it('plays a one-shot burst at a point, on top, and lets it die', () => {
    const { kernel, surface, plugin } = started([{ prefab: 'camera' }, { prefab: 'block' }]);
    plugin.engine.play('vfx/sparks', { x: 1, y: 2, z: null });
    kernel.step(1 / 60);
    const draw = surface.last!.commands.at(-1)!;
    expect(draw).toMatchObject({ kind: 'particles', count: 12, z: Infinity, entity: null, shape: 'circle' });
    // Born at the point this frame.
    expect((draw as { data: readonly number[] }).data.slice(0, 2)).toEqual([1, 2]);
    for (let i = 0; i < 40; i++) kernel.step(1 / 60);
    expect(particleCount(surface.last)).toBe(0);
    expect(plugin.engine.particles.activeEffects).toBe(0);
  });

  it('plays at an entity, at its z, with color and scale', () => {
    const { kernel, surface, plugin } = started([{ prefab: 'camera' }, { prefab: 'block', at: [4, 4] }]);
    plugin.engine.play('vfx/sparks', { entity: placed(kernel, 'block') }, { color: [0, 0, 1, 1], scale: 2 });
    kernel.step(1 / 60);
    const draw = surface.last!.commands.find((c) => c.kind === 'particles') as { z: number; data: readonly number[] };
    expect(draw.z).toBe(2);
    expect(draw.data.slice(0, 3)).toEqual([4, 4, 0.4]);
    expect(draw.data.slice(4, 8)).toEqual([0, 0, 1, 1]);
    expect(code(() => plugin.engine.play('vfx/fireworks', { x: 0, y: 0, z: null }))).toBe('PP2063');
  });

  it('is deterministic for the same seed and frames', () => {
    const run = (): Frame2d => {
      const { kernel, surface, plugin } = setup([{ prefab: 'camera' }, { prefab: 'smoke' }]);
      kernel.start('main', { seed: 7 });
      plugin.engine.play('vfx/sparks', { x: 0, y: 0, z: 0 });
      for (let i = 0; i < 20; i++) kernel.step(1 / 60);
      return surface.last!;
    };
    expect(run()).toEqual(run());
  });

  it('runs a continuous emitter while emitting; its particles outlive it', () => {
    const { kernel, surface } = started([{ prefab: 'camera' }, { prefab: 'smoke', at: [0, 1] }]);
    for (let i = 0; i < 30; i++) kernel.step(1 / 60);
    // burst 2, then 20/s for half a second
    expect(particleCount(surface.last)).toBe(12);
    const smoke = placed(kernel, 'smoke');
    kernel.world.get(smoke)!.components.get(PARTICLES)!['emitting'] = false;
    // Lifetime is 1 s: the first ones die, nothing new is born.
    for (let i = 0; i < 45; i++) kernel.step(1 / 60);
    expect(particleCount(surface.last)).toBeLessThan(12);
    expect(particleCount(surface.last)).toBeGreaterThan(0);
    kernel.world.get(smoke)!.components.get(PARTICLES)!['emitting'] = true;
    kernel.step(1 / 60);
    kernel.destroy(smoke);
    kernel.step(1 / 60);
    const lingering = particleCount(surface.last);
    expect(lingering).toBeGreaterThan(0);
    expect(surface.last!.commands.find((c) => c.kind === 'particles')!.entity).toBeNull();
    for (let i = 0; i < 70; i++) kernel.step(1 / 60);
    expect(particleCount(surface.last)).toBe(0);
  });

  it('freezes with game time', () => {
    const { kernel, surface, plugin } = started([{ prefab: 'camera' }]);
    plugin.engine.play('vfx/sparks', { x: 0, y: 0, z: 0 });
    kernel.step(1 / 60);
    kernel.step(1 / 60);
    const before = surface.last!.commands[0];
    kernel.setFrozen(true);
    kernel.step(1 / 60);
    expect(surface.last!.commands[0]).toEqual(before);
  });

  it('survives a snapshot and restore exactly', () => {
    const a = started([{ prefab: 'camera' }, { prefab: 'smoke' }]);
    a.plugin.engine.play('vfx/sparks', { x: 2, y: 0, z: 1 }, { color: [1, 0, 0, 0.5] });
    for (let i = 0; i < 10; i++) a.kernel.step(1 / 60);
    const snapshot = JSON.parse(JSON.stringify(a.kernel.snapshot()));
    const b = setup([{ prefab: 'camera' }, { prefab: 'smoke' }]);
    b.kernel.restore(snapshot);
    for (let i = 0; i < 10; i++) {
      a.kernel.step(1 / 60);
      b.kernel.step(1 / 60);
    }
    expect(b.surface.last!.commands).toEqual(a.surface.last!.commands);
  });

  it('ends every effect when a scene loads', () => {
    const { kernel, surface, plugin } = started([{ prefab: 'camera' }]);
    plugin.engine.play('vfx/sparks', { x: 0, y: 0, z: 0 });
    kernel.step(1 / 60);
    kernel.requestScene('main');
    kernel.step(1 / 60);
    kernel.step(1 / 60);
    expect(particleCount(surface.last)).toBe(0);
  });

  it('draws beams for their seconds and trails behind a moving entity', () => {
    const { kernel, surface, plugin } = started([{ prefab: 'camera' }, { prefab: 'block' }]);
    plugin.engine.beam([0, 0], [3, 4], { seconds: 0.05, color: [1, 1, 0, 1] });
    const block = kernel.world.get(placed(kernel, 'block'))!;
    const handle = plugin.engine.trail(block.id, { width: 0.2 });
    const lines = (): Array<{ z: number; points: readonly number[]; width: number }> =>
      surface.last!.commands.filter((c) => c.kind === 'line') as never;
    for (let i = 0; i < 2; i++) {
      block.transform.position = new Vec3(i, 0, 2);
      kernel.step(1 / 60);
    }
    expect(lines()).toEqual([
      expect.objectContaining({ z: 2, points: [0, 0, 1, 0], width: 0.2 }),
      expect.objectContaining({ z: Infinity, points: [0, 0, 3, 4], width: 0.05 }),
    ]);
    for (let i = 2; i < 40; i++) {
      block.transform.position = new Vec3(i, 0, 2);
      kernel.step(1 / 60);
    }
    // No beam; the trail keeps about TRAIL_SECONDS of samples.
    const trail = lines();
    expect(trail).toHaveLength(1);
    expect(trail[0]!.points.length / 2).toBeLessThanOrEqual(Math.ceil(TRAIL_SECONDS * 60) + 2);
    expect(handle.active).toBe(true);
    handle.cancel();
    kernel.step(1 / 60);
    expect(lines()).toEqual([]);
    expect(handle.active).toBe(false);
  });
});

// ── Every 2D example ────────────────────────────────────────────────────────────

const PREFIX = '../../../../../../examples/';
const rawJson = import.meta.glob('../../../../../../examples/*/**/*.json', { query: '?raw', import: 'default', eager: true });
const rawMain = import.meta.glob('../../../../../../examples/*/game/main.py', { query: '?raw', import: 'default', eager: true });

const examples2d = Object.entries(rawMain)
  .filter(([, text]) => /mode\s*=\s*"2d"/.test(text))
  .map(([path]) => path.slice(PREFIX.length).split('/')[0]!)
  .sort();

const VISUAL_IDS = new Set(STAND_INS.map((c) => c.id));

/** An asset reference as the file it would be ("assets are assumed to exist", examples/README.md). */
function assumedFile(ref: string, folder: 'images' | 'vfx'): string {
  const ext = folder === 'images' ? '.png' : '.vfx.json';
  if (ref.startsWith('assets/')) return ref;
  return ref.includes('/') ? `assets/${ref}${ext}` : `assets/${folder}/${ref}${ext}`;
}

/** The example's data, plus stand-in files for every image and effect its data names. */
function exampleFiles(name: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, text] of Object.entries(rawJson)) {
    if (path.startsWith(`${PREFIX}${name}/`)) out.set(path.slice(PREFIX.length + name.length + 1), text);
  }
  const visit = (components: Record<string, JsonObject> | undefined): void => {
    for (const [id, fields] of Object.entries(components ?? {})) {
      if (id === 'sprite') {
        if (typeof fields['image'] === 'string') out.set(assumedFile(fields['image'], 'images'), '');
        for (const anim of Object.values((fields['animations'] ?? {}) as Record<string, { frames: string[] }>)) {
          for (const frame of anim.frames) out.set(assumedFile(frame, 'images'), '');
        }
      }
      if (id === 'shape' && typeof fields['texture'] === 'string') out.set(assumedFile(fields['texture'], 'images'), '');
      if (id === 'particles' && typeof fields['effect'] === 'string') {
        out.set(assumedFile(fields['effect'], 'vfx'), JSON.stringify({ rate: 30, burst: 4, lifetime: [0.5, 1], spread: 360 }));
      }
    }
  };
  for (const [path, text] of [...out]) {
    if (!path.endsWith('.prefab.json') && !path.endsWith('scene.json')) continue;
    const doc = JSON.parse(text) as { components?: Record<string, JsonObject>; children?: { components?: Record<string, JsonObject> }[]; entities?: { components?: Record<string, JsonObject> }[] };
    visit(doc.components);
    for (const child of [...(doc.children ?? []), ...(doc.entities ?? [])]) visit(child.components);
  }
  return out;
}

/** Stand-in visuals components, plus permissive schemas for the game's own components and behaviors. */
function exampleGame(project: Project): GameDefinition {
  const componentFields = new Map<string, Set<string>>();
  const behaviorParams = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, id: string, fields: JsonObject): void => {
    const set = map.get(id) ?? new Set<string>();
    for (const key of Object.keys(fields)) set.add(key);
    map.set(id, set);
  };
  const noteAll = (components: Readonly<Record<string, JsonObject>>, params: Readonly<Record<string, JsonObject>>): void => {
    for (const [id, fields] of Object.entries(components)) if (!VISUAL_IDS.has(id)) note(componentFields, id, fields);
    for (const [id, p] of Object.entries(params)) note(behaviorParams, id, p);
  };
  for (const prefab of project.prefabs.values()) {
    noteAll(prefab.components, {});
    for (const use of prefab.behaviors) note(behaviorParams, use.use, use.params);
    for (const child of prefab.children) noteAll(child.components, child.params);
  }
  for (const scene of project.scenes.values()) for (const p of scene.entities) noteAll(p.components, p.params);
  const permissive = (fields: Set<string>): Schema =>
    Object.fromEntries([...fields].map((f) => [f, { type: { kind: 'json' as const }, default: null }]));
  const behaviors: BehaviorDef[] = [...behaviorParams].map(([id, params]) => ({
    id, params: permissive(params), state: {}, requires: [], handlers: [], create: () => ({}),
  }));
  return {
    components: [...STAND_INS, ...[...componentFields].map(([id, fields]) => ({ id, schema: permissive(fields) }))],
    behaviors, resources: [], events: [], systems: [],
  };
}

describe('2D examples', () => {
  const cases = examples2d.flatMap((name) => {
    const contents = exampleFiles(name);
    const projectFiles: ProjectFiles = { list: () => [...contents.keys()].sort(), read: (p) => contents.get(p)! };
    const project = loadProject(projectFiles);
    return [...project.scenes.keys()].sort().map((scene) => [`${name}/${scene}`, project, projectFiles, scene] as const);
  });

  it('finds every 2D example', () => {
    expect(examples2d).toEqual([
      'auto_runner', 'bullet_hell', 'chess', 'crate_puzzle', 'four_in_a_row', 'match_three', 'maze_chase',
      'number_merge', 'tic_tac_toe',
    ]);
    expect(cases.length).toBeGreaterThanOrEqual(examples2d.length * 2);
  });

  it.each(cases)('%s draws a sane frame', (_label, project, projectFiles, scene) => {
    const surface = new RecordingSurface2d();
    const plugin = render2d({ surface, files: projectFiles, assetFiles: true });
    const kernel = new Kernel({ project, game: exampleGame(project), plugins: [plugin] });
    kernel.start(scene);
    for (let i = 0; i < 30; i++) kernel.step(1 / 60);
    expect(surface.drawn).toBe(30);
    const frame = surface.last!;

    // A view that looks at something, from an orthographic camera.
    const { view } = frame;
    expect(view.halfHeight).toBeGreaterThan(0);
    expect(Number.isFinite(view.halfHeight)).toBe(true);
    const halfWidth = view.halfHeight * (surface.width / surface.height);

    // Every visible entity with a shape or sprite is drawn, from a loaded image if it has one.
    const drawn = new Set(frame.commands.map((c) => c.entity));
    const expected = [...kernel.world.live()].filter((r) => (r.components.has('sprite') || r.components.has('shape')) && r.visible
      && (r.parent === null || kernel.world.get(r.parent)!.visible));
    // A title scene may be only a camera under an HTML panel: then nothing is drawn.
    if (expected.length === 0) {
      expect(project.scenes.get(scene)!.ui.length).toBeGreaterThan(0);
      expect(frame.commands).toEqual([]);
      return;
    }
    for (const record of expected) expect(drawn.has(record.id)).toBe(true);
    for (const c of frame.commands) {
      if (c.kind === 'image') expect(surface.loaded).toContain(c.image);
      if ('transform' in c) expect(c.transform.every(Number.isFinite)).toBe(true);
      if (c.kind === 'particles') expect(c.data.every(Number.isFinite)).toBe(true);
    }
    // Back to front.
    for (let i = 1; i < frame.commands.length; i++) expect(frame.commands[i]!.z).toBeGreaterThanOrEqual(frame.commands[i - 1]!.z);
    // Most of what is drawn is on screen.
    // (A command overlaps the view: its half size counts, so side-by-side background tiles do.)
    const placedCommands = frame.commands.filter((c) => 'transform' in c) as Array<{ transform: readonly number[]; size?: unknown }>;
    const half = (c: { size?: unknown }, i: number): number => (Array.isArray(c.size) ? Math.abs(c.size[i] as number) / 2 : 0);
    const onScreen = placedCommands.filter((c) =>
      Math.abs(c.transform[4]! - view.center[0]) <= halfWidth + 1 + half(c, 0)
      && Math.abs(c.transform[5]! - view.center[1]) <= view.halfHeight + 1 + half(c, 1));
    expect(onScreen.length / placedCommands.length).toBeGreaterThan(0.5);
    // Emitters that emit have particles in the air.
    if ([...kernel.world.live()].some((r) => r.components.get(PARTICLES)?.['emitting'] === true)) {
      expect(frame.commands.some((c) => c.kind === 'particles' && c.count > 0)).toBe(true);
    }
  });
});
