/**
 * The hud plugin on a bare kernel: a stand-in camera (a `camera` component whose
 * `__view__` is a fixed view, as visuals resolves one) and stand-in combat events, so the
 * models, the base map, the projections and the gameplay ticks are tested without the
 * renderers.
 */

import { describe, expect, it } from 'vitest';
import { Color, ParallaxError, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { componentEntity, Kernel, t } from '../../kernel/index.js';
import type { Fields, KernelPlugin } from '../../kernel/index.js';
import { abilitiesTick, abilityUse, comboHit, formatDistance } from './engine.js';
import { DEFAULT_ACCESSIBILITY, hud, place, planeOf } from './index.js';
import type { Accessibility, HudPlugin, ViewLike } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

/** A camera at `position` looking along +z (north), 60° fov, 1280×720. */
function view(entity: number, position: Vec3, extra: Partial<ViewLike> = {}): ViewLike {
  return {
    entity, seat: 0, active: true, dimension: '3d', mode: 'perspective', position, rotation: Quat.IDENTITY, fov: 60, size: 5,
    near: 0.1, far: 1000, aspect: 16 / 9, viewport: { width: 1280, height: 720 }, ...extra,
  };
}

const shakes: number[] = [];

function cameraPlugin(at: Vec3, extra: Partial<ViewLike> = {}): KernelPlugin {
  return {
    id: 'fake_visuals',
    components: [
      {
        id: 'camera', schema: {},
        methods: {
          get __view__(): ViewLike { return view(componentEntity(this as unknown as Fields), at, extra); },
          shake(intensity: number): void { shakes.push(intensity); },
        },
      },
      { id: 'shape', schema: { kind: t.string({ default: 'box' }), size: t.vec3({ default: Vec3.ONE }), offset: t.vec3({ default: Vec3.ZERO }), color: t.color({ default: Color.WHITE }) } },
      { id: 'marker', schema: { icon: t.string({ default: 'waypoint' }), label: { type: { kind: 'optional', of: { kind: 'string' } }, default: null }, shown: t.bool({ default: true }), color: t.color({ default: Color.WHITE }) } },
      { id: 'rigidbody', schema: {} },
    ],
  };
}

const combatStandIn: KernelPlugin = {
  id: 'combat_stand_in',
  events: [{ id: 'damaged' }, { id: 'died' }],
  components: [{ id: 'health', schema: { current: t.number({ default: 100 }), max: t.number({ default: 100 }) } }],
};

interface Rig {
  readonly kernel: Kernel;
  readonly plugin: HudPlugin;
  readonly a11y: { value: Accessibility };
  readonly stops: number[];
  step(frames?: number): void;
  id(placed: string): EntityId;
}

function rig(data: Record<string, unknown>, options: { camera?: Vec3; view?: Partial<ViewLike> } = {}): Rig {
  const a11y = { value: DEFAULT_ACCESSIBILITY };
  const stops: number[] = [];
  const plugin = hud({
    viewer: (_k, seat, candidates) => (seat === 0 ? candidates[0]! : null),
    seats: () => [0],
    accessibility: () => a11y.value,
    hitstop: (_k, s) => { stops.push(s); },
    seatOf: () => null,
  });
  const project = loadProject(files(data));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({
    project,
    game: { components: [], events: [], behaviors: [], systems: [], resources: [] },
    plugins: [cameraPlugin(options.camera ?? new Vec3(0, 2, -10), options.view), combatStandIn, plugin],
  });
  kernel.start('main');
  return {
    kernel, plugin, a11y, stops,
    step(frames = 1) { for (let i = 0; i < frames; i++) kernel.step(DT); },
    id(placed) {
      const found = kernel.world.query([]).find(([id]) => kernel.world.get(id)?.placedId === placed);
      if (found === undefined) throw new Error(`no ${placed}`);
      return found[0];
    },
  };
}

const WORLD = {
  'prefabs/cam.prefab.json': { components: { camera: {} } },
  'prefabs/player.prefab.json': {
    components: {
      health: { current: 100, max: 100 }, minimap: { range: 10 }, crosshair: {}, hurt_feedback: { shake: 0.5, hitstop: 0.04 },
      abilities: { slots: [{ id: 'blink', cooldown: 1, charges: 2 }] }, combo: { window: 0.5 }, rigidbody: {},
    },
  },
  'prefabs/wall.prefab.json': { components: { shape: { kind: 'box', size: [4, 3, 2] } } },
  'prefabs/pad.prefab.json': { components: { shape: { kind: 'box', size: [4, 0.2, 4] } } },
  'prefabs/crate.prefab.json': { components: { shape: { kind: 'box' }, rigidbody: {} } },
  'prefabs/node.prefab.json': { components: { map_feature: { kind: 'path', width: 2 } } },
  'prefabs/coin.prefab.json': { components: { map_icon: { icon: 'star' } } },
  'prefabs/goal.prefab.json': { components: { map_icon: { icon: 'flag', edge: true }, marker: { label: 'Goal' } } },
  'scenes/main/scene.json': {
    entities: [
      { prefab: 'cam', id: 'cam', at: [0, 2, -10] },
      { prefab: 'player', id: 'player', at: [0, 0, 0] },
      { prefab: 'wall', id: 'wall', at: [5, 1.5, 0], rotation: [0, 90, 0] },
      { prefab: 'pad', id: 'pad', at: [-5, 0, 0] },
      { prefab: 'crate', id: 'crate', at: [0, 0, 3] },
      { prefab: 'node', at: [0, 0, 10], components: { map_feature: { kind: 'path', order: 2 } } },
      { prefab: 'node', at: [0, 0, -10], components: { map_feature: { kind: 'path', order: 1 } } },
      { prefab: 'coin', id: 'coin', at: [3, 0, 4] },
      { prefab: 'goal', id: 'goal', at: [0, 0, 100] },
    ],
  },
};

describe('projection', () => {
  it('places points on screen as viewport fractions and pins off-screen ones to the edge', () => {
    const v = view(1, new Vec3(0, 0, 0));
    expect(place(v, new Vec3(0, 0, 10))).toMatchObject({ x: 0.5, y: 0.5, onScreen: true });
    const right = place(v, new Vec3(100, 0, 10));
    expect(right.onScreen).toBe(false);
    expect(right.x).toBeCloseTo(0.95, 5);
    expect(right.angle).toBeCloseTo(90, 0);
    const behind = place(v, new Vec3(0, 0, -10));
    expect(behind.onScreen).toBe(false);
    expect(behind.y).toBeCloseTo(0.95, 5);
    expect(planeOf('2d', new Vec3(1, 2, 3))).toEqual([1, 2]);
  });
});

describe('hud models', () => {
  it('derives the base map: static shapes as floor or solid, movers and icons left out, a path in order', () => {
    const r = rig(WORLD);
    const base = r.plugin.engine.baseMap()!;
    // wall (solid) + pad (floor, 0.2 m tall) + the path; not the player (rigidbody), crate (rigidbody) or icons.
    expect(base.shapes).toBe(3);
    const svg = decodeURIComponent(base.uri.slice(base.uri.indexOf(',') + 1));
    expect(svg).toContain('<polyline');
    // Path nodes joined in order: (0,-10) first, then (0,10) — in SVG y is -z.
    expect(svg).toMatch(/points="0,10 0,-10"/);
    // The wall turned 90° spans 2 m along x and 4 m along z.
    expect(base.minU).toBeLessThan(-7);
    expect(base.maxV).toBeGreaterThanOrEqual(10);
  });

  it('builds the minimap around the viewer: icons in range, edge icons on the rim, player arrow', () => {
    const r = rig(WORLD);
    const map = r.plugin.engine.minimap(0);
    expect(map.shown).toBe(true);
    const star = map.icons.find((i) => i.icon === 'star')!;
    // 3 m east, 4 m north on a 10 m-radius map, player-up (heading 0): x = 0.5 + 3/20, y = 0.5 - 4/20.
    expect([star.x, star.y]).toEqual(['65%', '30%']);
    const flag = map.icons.find((i) => i.icon === 'flag')!;
    expect(flag.edge).toBe(true);
    expect(flag.y).toBe('4%');
    // Base image placed so the viewer is at the center.
    expect(map.base_left).toMatch(/%$/);
  });

  it('turns the map with the viewer heading', () => {
    const r = rig(WORLD);
    r.kernel.world.get(r.id('player'))!.transform.rotation = Quat.from_euler(new Vec3(0, 90, 0));
    const map = r.plugin.engine.minimap(0);
    expect(map.turn).toBe('rotate(-90deg)');
    // Facing east, the coin (3 east, 4 north) is ahead-left: up and to the left of center.
    const star = map.icons.find((i) => i.icon === 'star')!;
    expect(Number.parseFloat(star.x)).toBeLessThan(50);
    expect(Number.parseFloat(star.y)).toBeLessThan(50);
  });

  it('markers pin off-screen objectives to the edge with an arrow', () => {
    const r = rig(WORLD);
    const markers = r.plugin.engine.markers(0).markers;
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ label: 'Goal', on_screen: true });
    r.kernel.world.get(r.id('goal'))!.transform.position = new Vec3(0, 0, -100);
    const behind = r.plugin.engine.markers(0).markers[0]!;
    expect(behind.on_screen).toBe(false);
  });

  it('distances read in metres then kilometres past 1000 m (or feet then miles)', () => {
    expect([12.4, 999.4, 999.6, 1234, 9940, 12_600].map((m) => formatDistance(m))).toEqual(['12 m', '999 m', '1.0 km', '1.2 km', '9.9 km', '13 km']);
    expect([10, 304, 1609.344, 20_000].map((m) => formatDistance(m, 'imperial'))).toEqual(['33 ft', '997 ft', '1.0 mi', '12 mi']);
    const r = rig(WORLD);
    r.kernel.world.get(r.id('goal'))!.transform.position = new Vec3(0, 0, 2500);
    expect(r.plugin.engine.markers(0).markers[0]!.distance).toMatch(/^2\.5 km$/);
  });

  it('reacts to damage: flash scaled by the hit, shake, hit-stop, arc; low health vignette', () => {
    shakes.length = 0;
    const r = rig(WORLD);
    const player = r.id('player');
    r.kernel.emit({ id: 'damaged' } as never, { entity: player, amount: 10, source: r.id('coin'), point: null });
    r.kernel.world.get(player)!.components.get('health')!['current'] = 20;
    const damaged = r.kernel.registry.events.get('damaged')!;
    r.kernel.emit(damaged, { entity: player, amount: 25, source: r.id('coin'), point: null });
    r.step();
    const screen = r.plugin.engine.screen(0);
    expect(screen.flash).toBeGreaterThan(0.4);
    expect(screen.vignette).toBeGreaterThan(0.25);
    expect(shakes).toHaveLength(1);
    expect(r.stops).toEqual([0.04]);
    expect(r.plugin.engine.awareness(0).hits).toHaveLength(1);
    // Reduced motion: no shake, a much softer flash.
    r.a11y.value = { ...DEFAULT_ACCESSIBILITY, reducedMotion: true };
    r.kernel.emit(damaged, { entity: player, amount: 25, source: null, point: null });
    r.step();
    expect(shakes).toHaveLength(1);
    expect(r.plugin.engine.screen(0).a11y.calm).toBe(true);
  });

  it('crosshair widens with spread and shows the reload bar', () => {
    const r = rig(WORLD);
    const fields = r.kernel.world.get(r.id('player'))!.components.get('crosshair')!;
    const narrow = Number.parseFloat(r.plugin.engine.crosshair(0).gap);
    fields['spread'] = 5;
    fields['reload'] = 0.5;
    const wide = r.plugin.engine.crosshair(0);
    expect(Number.parseFloat(wide.gap)).toBeGreaterThan(narrow + 20);
    expect(wide).toMatchObject({ reloading: true, reload: '50%' });
    fields['style'] = 'scope';
    expect(r.plugin.engine.crosshair(0)).toMatchObject({ scope: true, cross: false });
  });

  it('needs a camera to know the plane', () => {
    const r = rig({ ...WORLD, 'scenes/main/scene.json': { entities: [{ prefab: 'player', id: 'player' }] } });
    expect(code(() => r.plugin.engine.minimap(0))).toBe('PP3557');
  });
});

describe('ability cooldowns and combos (fields-level)', () => {
  it('charges come back one cooldown at a time', () => {
    const fields: Fields = { slots: [{ id: 'blink', cooldown: 1, charges: 2 }], charges: {}, left: {} };
    expect(abilityUse(fields, 'blink')).toBe(true);
    expect(abilityUse(fields, 'blink')).toBe(true);
    expect(abilityUse(fields, 'blink')).toBe(false);
    abilitiesTick(fields, 1.01);
    expect(fields['charges']).toEqual({ blink: 1 });
    abilitiesTick(fields, 1);
    expect(fields['charges']).toEqual({});
    expect(fields['left']).toEqual({});
  });

  it('combo windows run in game time; the best is kept', () => {
    const r = rig(WORLD);
    const combo = r.kernel.world.get(r.id('player'))!.components.get('combo')!;
    comboHit(combo, 3);
    r.step(20);
    expect(combo['count']).toBe(3);
    r.step(15);
    expect(combo['count']).toBe(0);
    expect(combo['best']).toBe(3);
  });
});
