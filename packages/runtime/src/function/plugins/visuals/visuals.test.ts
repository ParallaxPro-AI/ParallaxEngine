import { describe, expect, it } from 'vitest';
import { Color, ParallaxError, Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { ComponentDef, EventDef, Fields, GameDefinition, Handle, SystemDef } from '../../kernel/index.js';
import { CAMERAS_SERVICE } from '../../services/index.js';
import { CameraApi, readBands, textSpans, visuals } from './index.js';
import type { Band, CameraView, TextSpan, VisualsOptions, VisualsPlugin } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** Stand-ins for other plugins' components, read by id (physics2d/3d collider, grid). */
const COLLIDER_DEF: ComponentDef = {
  id: 'collider',
  schema: {
    shape: t.string({ default: 'box' }),
    size: t.vec3({ default: Vec3.ONE }),
    radius: t.number({ default: 0.5 }),
    height: t.number({ default: 1 }),
    offset: t.vec3({ default: Vec3.ZERO }),
    trigger: t.bool({ default: false }),
  },
};
const GRID_DEF: ComponentDef = {
  id: 'grid',
  schema: {
    cols: t.int({ default: 8 }),
    rows: t.int({ default: 8 }),
    cell_size: t.vec2({ default: Vec2.ONE }),
    plane: t.string({ default: 'xy' }),
    origin: t.string({ default: 'center' }),
    row_order: t.string({ default: 'down' }),
  },
};

interface Camera extends Fields {
  readonly __view__: CameraView;
  readonly entity: unknown;
  shake(...args: unknown[]): void;
  kick(...args: unknown[]): void;
  zoom_to(...args: unknown[]): Handle;
  screen_to_world(screen: Vec2): Vec3;
  world_to_screen(point: Vec3): Vec2 | null;
  ray(screen?: Vec2): readonly [Vec3, Vec3];
  relative(stick: Vec2): Vec3;
  capture(): unknown;
}

interface Game {
  readonly kernel: Kernel;
  readonly plugin: VisualsPlugin;
  readonly cameras: CameraApi;
  id(placed: string): EntityId;
  get<T = Fields>(placed: string, component: string): T;
  camera(placed?: string): Camera;
  steps(n: number): void;
}

function game(
  data: { prefabs: Record<string, unknown>; entities: unknown[] },
  options: Partial<VisualsOptions> = {},
  extra: { systems?: SystemDef[]; events?: EventDef[] } = {},
): Game {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(data.prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities: data.entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const plugin = visuals({ dimension: '3d', ...options });
  const def: GameDefinition = {
    components: [COLLIDER_DEF, GRID_DEF], resources: [], events: extra.events ?? [], behaviors: [], systems: extra.systems ?? [],
  };
  const kernel = new Kernel({ project, game: def, plugins: [plugin], context: {}, fixedStep: DT });
  const cameras = plugin.namespace!.create(kernel) as CameraApi;
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  const get = <T = Fields>(placed: string, component: string): T => kernel.world.require(id(placed)).components.get(component) as T;
  return {
    kernel, plugin, cameras, id, get,
    camera: (placed = 'cam') => get<Camera>(placed, 'camera'),
    steps: (n) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

const near = (a: Vec3, b: Vec3, digits = 5): void => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
};

const forward = (view: CameraView): Vec3 => view.rotation.rotate(Vec3.FORWARD);

describe('components', () => {
  it('fill SDK defaults and keep authored values', () => {
    const g = game({
      prefabs: {
        thing: {
          components: {
            sprite: { image: 'assets/images/a.png', size: [2, 3] },
            shape: { kind: 'sphere', color: '#ff0000' },
            light: { kind: 'spot', angle: 30, inner_angle: 12 },
            player_start: {},
            marker: { icon: 'grave' },
            world_bar: {},
            environment_zone: { fog_density: 0.02 },
            collider: { shape: 'box', size: [4, 4, 4], trigger: true },
          },
        },
      },
      entities: [{ id: 'thing', prefab: 'thing' }],
    });
    const sprite = g.get('thing', 'sprite');
    expect(sprite['image']).toBe('assets/images/a.png');
    expect((sprite['size'] as Vec2).__eq__(new Vec2(2, 3))).toBe(true);
    expect((sprite['color'] as Color).__eq__(Color.WHITE)).toBe(true);
    expect(sprite['flip_x']).toBe(false);
    expect(g.get('thing', 'shape')['kind']).toBe('sphere');
    expect(g.get('thing', 'shape')['cast_shadows']).toBe(true);
    expect(g.get('thing', 'light')['angle']).toBe(30);
    expect(g.get('thing', 'light')['inner_angle']).toBe(12);
    expect(g.get('thing', 'player_start')['seat']).toBe(-1);
    expect(g.get('thing', 'marker')['shown']).toBe(true);
    expect(g.get('thing', 'environment_zone')['ambient']).toBeNull();
    expect(g.get<{ entity: unknown }>('thing', 'marker').entity).toBe(g.id('thing'));
  });

  it('reject what the schema does not allow, with codes', () => {
    const bad = (components: Record<string, unknown>): string => code(() => game({
      prefabs: { x: { components } }, entities: [{ prefab: 'x' }],
    }));
    expect(bad({ shape: { kind: 'blob' } })).toBe('PP4102');
    expect(bad({ model: {} })).toBe('PP4105');
    expect(bad({ particles: { emitting: true } })).toBe('PP4105');
    expect(bad({ light: { radius: 3 } })).toBe('PP4104');
    expect(bad({ camera: { viewport: [0, 0, 2, 1] } })).toBe('PP3710');
    expect(bad({ camera: { pitch_limits: [10] } })).toBe('PP3712');
    expect(bad({ camera: { fit: 'board' } })).toBe('PP3711');
    expect(bad({ environment_zone: {} })).toBe('PP3743');
  });
});

describe('camera views', () => {
  it('resolve a fixed camera from its transform, in viewport pixels', () => {
    const g = game({ prefabs: { cam: { components: { camera: { fov: 50 } } } }, entities: [{ id: 'cam', prefab: 'cam', at: [1, 2, 3] }] });
    const view = g.camera().__view__;
    expect(view.active).toBe(true);
    expect(view.seat).toBe(0);
    near(view.position, new Vec3(1, 2, 3));
    expect(view.fov).toBe(50);
    expect(view.viewport).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(view.aspect).toBeCloseTo(16 / 9);
    near(forward(view), Vec3.FORWARD);
  });

  it('project and unproject consistently (3D perspective)', () => {
    const g = game({ prefabs: { cam: { components: { camera: {} } } }, entities: [{ id: 'cam', prefab: 'cam', at: [0, 10, -10], rotation: [45, 0, 0] }] });
    const cam = g.camera();
    near(cam.screen_to_world(new Vec2(640, 360)), Vec3.ZERO, 4);
    for (const p of [new Vec3(2, 0, 1), new Vec3(-3, 0, -2)]) {
      const s = cam.world_to_screen(p)!;
      expect(s).not.toBeNull();
      near(cam.screen_to_world(s), p, 4);
    }
    expect(cam.world_to_screen(new Vec3(3, 0, 0))!.x).toBeGreaterThan(640);
    expect(cam.world_to_screen(new Vec3(0, 10, -20))).toBeNull();
    expect(cam.world_to_screen(new Vec3(500, 0, 5))).toBeNull();
    const [origin, dir] = cam.ray();
    near(origin, new Vec3(0, 10, -10));
    near(dir, new Vec3(0, -Math.SQRT1_2, Math.SQRT1_2));
    // Looking at the sky: the point far along the ray.
    near(cam.screen_to_world(new Vec2(640, 0)).__sub__(origin).normalized(), cam.ray(new Vec2(640, 0))[1]);
  });

  it('map the 2D plane through an orthographic camera', () => {
    const g = game(
      { prefabs: { cam: { components: { camera: { mode: 'orthographic', size: 5 } } } }, entities: [{ id: 'cam', prefab: 'cam', at: [2, 1] }] },
      { dimension: '2d' },
    );
    const cam = g.camera();
    expect(cam.world_to_screen(new Vec3(2, 1, 0))!.__eq__(new Vec2(640, 360))).toBe(true);
    near(cam.screen_to_world(new Vec2(0, 0)), new Vec3(2 - 5 * 16 / 9, 6, 0));
    expect(cam.world_to_screen(new Vec3(2 + 5 * 16 / 9 + 0.1, 1, 0))).toBeNull();
    near(cam.relative(new Vec2(1, 0.5)), new Vec3(1, 0.5, 0));
  });

  it('turn a move stick into a ground direction relative to the camera', () => {
    const g = game({ prefabs: { cam: { components: { camera: {} } } }, entities: [{ id: 'cam', prefab: 'cam', rotation: [60, 90, 0] }] });
    near(g.camera().relative(new Vec2(0, 1)), new Vec3(1, 0, 0));
    near(g.camera().relative(new Vec2(1, 0)), new Vec3(0, 0, -1));
  });

  it('refuse perspective in 2D', () => {
    expect(code(() => game(
      { prefabs: { cam: { components: { camera: {} } } }, entities: [{ prefab: 'cam' }] }, { dimension: '2d' },
    ))).toBe('PP3713');
  });

  it('use the screen the platform reports', () => {
    const g = game({ prefabs: { cam: { components: { camera: { viewport: [0.5, 0, 0.5, 1] } } } }, entities: [{ id: 'cam', prefab: 'cam' }] });
    g.plugin.resize(800, 600);
    g.steps(1);
    expect(g.camera().__view__.viewport).toEqual({ x: 400, y: 0, width: 400, height: 600 });
    expect(code(() => g.plugin.resize(0, 600))).toBe('PP3745');
  });
});

describe('follow rig', () => {
  const data = (camera: Record<string, unknown>, at: number[] = [0, 0, 0]) => ({
    prefabs: { cam: { components: { camera: { rig: 'follow', follow: 'hero', ...camera } } }, hero: { components: {} } },
    entities: [{ id: 'hero', prefab: 'hero', at }, { id: 'cam', prefab: 'cam' }],
  });

  it('sits at the offset and looks at the target', () => {
    const g = game(data({ offset: [0, 3, -6] }));
    const view = g.camera().__view__;
    near(view.position, new Vec3(0, 3, -6));
    near(forward(view), new Vec3(0, -3, 6).normalized());
  });

  it('turns a local offset with the target, keeps a world offset', () => {
    const local = game(data({ offset: [0, 3, -6] }));
    local.kernel.world.require(local.id('hero')).transform.rotation = Quat.from_euler(new Vec3(0, 90, 0));
    local.steps(1);
    near(local.camera().__view__.position, new Vec3(-6, 3, 0));
    const world = game(data({ offset: [0, 3, -6], world_offset: true }));
    world.kernel.world.require(world.id('hero')).transform.rotation = Quat.from_euler(new Vec3(0, 90, 0));
    world.steps(1);
    near(world.camera().__view__.position, new Vec3(0, 3, -6));
  });

  it('smooths exponentially with `smoothing` as the time constant', () => {
    const g = game(data({ offset: [0, 3, -6], smoothing: 0.5 }));
    g.kernel.world.require(g.id('hero')).transform.position = new Vec3(10, 0, 0);
    g.steps(1);
    expect(g.camera().__view__.position.x).toBeCloseTo(10 * (1 - Math.exp(-DT / 0.5)), 6);
    g.steps(600);
    expect(g.camera().__view__.position.x).toBeCloseTo(10, 4);
  });

  it('leads by `look_ahead` in the direction of travel, keeps it standing still, and never turns (side-scroller)', () => {
    const g = game(data({ offset: [0, 2, -20], world_offset: true, pitch: 0, look_ahead: 3, look_ahead_smoothing: 0 }));
    near(g.camera().__view__.position, new Vec3(0, 2, -20)); // no travel yet: no lead
    const hero = g.kernel.world.require(g.id('hero')).transform;
    for (let i = 0; i < 30; i++) {
      hero.position = hero.position.__add__(new Vec3(4 * DT, 0, 0));
      g.steps(1);
    }
    near(g.camera().__view__.position, new Vec3(hero.position.x + 3, 2, -20));
    g.steps(30); // standing still: the lead holds
    near(g.camera().__view__.position, new Vec3(hero.position.x + 3, 2, -20));
    hero.position = hero.position.__add__(new Vec3(-4 * DT, 0, 0));
    g.steps(1);
    near(g.camera().__view__.position, new Vec3(hero.position.x - 3, 2, -20));
    near(forward(g.camera().__view__), new Vec3(0, 0, 1));
  });

  it('eases the look_ahead lead over `look_ahead_smoothing`', () => {
    const g = game(data({ offset: [0, 0, -10], world_offset: true, pitch: 0, look_ahead: 2, look_ahead_smoothing: 0.5 }));
    const hero = g.kernel.world.require(g.id('hero')).transform;
    hero.position = new Vec3(1 * DT, 0, 0);
    g.steps(1);
    expect(g.camera().__view__.position.x).toBeCloseTo(DT + 2 * (1 - Math.exp(-DT / 0.5)), 6);
  });

  it('clamps its focus to bounds on the ground', () => {
    const g = game(data({ offset: [0, 10, -10], world_offset: true, bounds: [[-5, -5], [5, 5]] }, [20, 0, -30]));
    near(g.camera().__view__.position, new Vec3(5, 10, -15));
  });

  it('holds a fixed pitch along the heading when `pitch` is set', () => {
    // Camera pitch is positive up: -30 looks 30° down.
    const g = game(data({ offset: [0, 4, -15], pitch: -30 }));
    const f = forward(g.camera().__view__);
    expect(Math.asin(-f.y) * 180 / Math.PI).toBeCloseTo(30);
    expect(f.x).toBeCloseTo(0);
  });

  it('frames several targets by their weights, pulling back to fit them', () => {
    const g = game({
      prefabs: { cam: { components: { camera: { rig: 'follow', offset: [0, 0, -1], world_offset: true, fov: 60 } } }, p: { components: {} } },
      entities: [{ id: 'a', prefab: 'p', at: [-10, 0, 0] }, { id: 'b', prefab: 'p', at: [10, 0, 0] }, { id: 'cam', prefab: 'cam' }],
    });
    const cam = g.camera();
    cam['follow'] = [g.id('a'), g.id('b')];
    cam['follow_weights'] = [3, 1];
    g.steps(1);
    const view = cam.__view__;
    expect(view.position.x).toBeCloseTo(-5);
    expect(cam.world_to_screen(new Vec3(-10, 0, 0))).not.toBeNull();
    expect(cam.world_to_screen(new Vec3(10, 0, 0))).not.toBeNull();
    cam['follow_weights'] = [1];
    expect(code(() => g.steps(1))).toBe('PP3715');
  });

  it('follows only x and y in 2D, keeping its z', () => {
    const g = game({
      prefabs: { cam: { components: { camera: { rig: 'follow', follow: 'hero', mode: 'orthographic', offset: [1, 2, 0] } } }, hero: { components: {} } },
      entities: [{ id: 'hero', prefab: 'hero', at: [5, 5] }, { id: 'cam', prefab: 'cam', at: [0, 0, -10] }],
    }, { dimension: '2d' });
    near(g.camera().__view__.position, new Vec3(6, 7, -10));
  });

  it('follows the seat\'s entity for "local_player", and holds without one', () => {
    let seatEntity: EntityId | null = null;
    const g = game({
      prefabs: { cam: { components: { camera: { rig: 'follow', follow: 'local_player', offset: [0, 5, -5], world_offset: true } } }, hero: { components: {} } },
      entities: [{ id: 'hero', prefab: 'hero', at: [3, 0, 3] }, { id: 'cam', prefab: 'cam', at: [9, 9, 9] }],
    }, { seatEntity: () => seatEntity });
    near(g.camera().__view__.position, new Vec3(9, 9, 9));
    seatEntity = g.id('hero');
    g.steps(1);
    near(g.camera().__view__.position, new Vec3(3, 5, -2));
  });
});

describe('orbit and first-person rigs', () => {
  it('orbit turns with look input and clamps pitch', () => {
    let look = new Vec2(10, 0);
    const g = game({
      prefabs: { cam: { components: { camera: { rig: 'orbit', follow: 'hero', offset: [0, 1.6, -4.5] } } }, hero: { components: {} } },
      entities: [{ id: 'hero', prefab: 'hero' }, { id: 'cam', prefab: 'cam' }],
    }, { look: () => look });
    near(g.camera().__view__.position, new Vec3(0, 1.6, -4.5));
    g.steps(1);
    const r = 10 * Math.PI / 180;
    near(g.camera().__view__.position, new Vec3(-4.5 * Math.sin(r), 1.6, -4.5 * Math.cos(r)));
    look = new Vec2(0, -500);
    g.steps(1);
    const f = forward(g.camera().__view__);
    expect(Math.asin(-f.y) * 180 / Math.PI).toBeCloseTo(80);
    look = Vec2.ZERO;
    g.camera().kick(10, 0, { accumulate: true });
    g.steps(1);
    expect(Math.asin(-forward(g.camera().__view__).y) * 180 / Math.PI).toBeCloseTo(70);
  });

  it('first_person sits at the eye and turns its target\'s yaw', () => {
    const g = game({
      prefabs: { cam: { components: { camera: { rig: 'first_person', follow: 'hero', offset: [0, 1.6, 0] } } }, hero: { components: {} } },
      entities: [{ id: 'hero', prefab: 'hero', at: [2, 0, 2] }, { id: 'cam', prefab: 'cam' }],
    }, { look: () => new Vec2(90, 0) });
    g.steps(1);
    near(g.camera().__view__.position, new Vec3(2, 1.6, 2));
    near(forward(g.camera().__view__), Vec3.RIGHT);
    near(g.kernel.world.require(g.id('hero')).transform.rotation.rotate(Vec3.FORWARD), Vec3.RIGHT);
  });

  it('are refused in 2D', () => {
    const g = game({
      prefabs: { cam: { components: { camera: { mode: 'orthographic' } } } }, entities: [{ id: 'cam', prefab: 'cam' }],
    }, { dimension: '2d' });
    g.camera()['rig'] = 'orbit';
    expect(code(() => g.steps(1))).toBe('PP3717');
  });
});

describe('shake, kick and zoom', () => {
  const one = (camera: Record<string, unknown> = {}) => ({ prefabs: { cam: { components: { camera } } }, entities: [{ id: 'cam', prefab: 'cam' }] });

  it('shake offsets the view, decays, and never moves the transform', () => {
    const g = game(one());
    g.camera().shake(1, { seconds: 0.5 });
    g.steps(1);
    expect(g.camera().__view__.position.length()).toBeGreaterThan(0);
    near(g.kernel.world.require(g.id('cam')).transform.position, Vec3.ZERO);
    g.steps(30);
    near(g.camera().__view__.position, Vec3.ZERO);
  });

  it('shake is deterministic', () => {
    const run = (): Vec3 => {
      const g = game(one());
      g.camera().shake();
      g.steps(5);
      return g.camera().__view__.position;
    };
    expect(run().__eq__(run())).toBe(true);
  });

  it('kick raises the view and recovers', () => {
    const g = game(one());
    g.camera().kick(10);
    g.steps(1);
    expect(forward(g.camera().__view__).y).toBeGreaterThan(0);
    g.steps(12);
    near(forward(g.camera().__view__), Vec3.FORWARD);
    expect(code(() => g.camera().kick(1, { accumulate: true }))).toBe('PP3723');
    expect(code(() => g.camera().kick())).toBe('PP3030');
  });

  it('zoom_to tweens fov (or size) and returns a handle', () => {
    const g = game(one({ fov: 60 }));
    const handle = g.camera().zoom_to(30, 0.5);
    expect(handle.active).toBe(true);
    g.steps(15);
    expect(g.camera()['fov']).toBeCloseTo(45);
    g.steps(16);
    expect(g.camera()['fov']).toBe(30);
    expect(handle.active).toBe(false);
    const again = g.camera().zoom_to(90, 1);
    g.steps(2);
    again.cancel();
    const at = g.camera()['fov'];
    g.steps(5);
    expect(g.camera()['fov']).toBe(at);
    expect(code(() => g.camera().zoom_to(500))).toBe('PP3724');
  });

  it('present handles through the api', () => {
    const g = game(one(), { present: { handle: (h) => ({ wrapped: h }) } });
    expect(g.camera().zoom_to(40)).toHaveProperty('wrapped');
  });
});

describe('fit', () => {
  const board = (fit: unknown, extra: unknown[] = []) => ({
    prefabs: { cam: { components: { camera: { mode: 'orthographic', fit, fit_margin: 0.5 } } }, board: { components: { grid: { cols: 4, rows: 2 } } } },
    entities: [{ id: 'cam', prefab: 'cam', at: [0, 0, -10] }, ...extra],
  });

  it('frames a rectangle at any aspect ratio, centered', () => {
    const g = game(board([[-10, -8.5], [10, 7.5]]), { dimension: '2d' });
    expect(g.camera().__view__.size).toBeCloseTo(8.5);
    near(g.camera().__view__.position, new Vec3(0, -0.5, -10));
    g.plugin.resize(720, 1280);
    g.steps(1);
    expect(g.camera().__view__.size).toBeCloseTo(10.5 / (720 / 1280));
  });

  it('frames the scene\'s Grid with "grid", and ignores it without one', () => {
    const g = game(board('grid', [{ prefab: 'board', at: [1, 1] }]), { dimension: '2d' });
    expect(g.camera().__view__.size).toBeCloseTo(1.5);
    near(g.camera().__view__.position, new Vec3(1, 1, -10));
    const none = game(board('grid'), { dimension: '2d' });
    expect(none.camera().__view__.size).toBe(5);
  });

  it('takes a rectangle assigned in code', () => {
    const g = game(board(null), { dimension: '2d' });
    g.camera()['fit'] = Object.freeze([new Vec2(0, 0), new Vec2(4, 2)]);
    g.steps(1);
    expect(g.camera().__view__.size).toBeCloseTo(1.5);
  });

  it('is 2D only', () => {
    expect(code(() => game(board([[0, 0], [1, 1]])))).toBe('PP3718');
  });
});

describe('min_visible', () => {
  const cam = (camera: Record<string, unknown>) => ({ prefabs: { cam: { components: { camera } } }, entities: [{ id: 'cam', prefab: 'cam' }] });

  it('widens a perspective fov until width × height fit at the focus distance, at any aspect', () => {
    const g = game(cam({ fov: 60, min_visible: [20, 2], focus_distance: 10 }));
    g.plugin.resize(720, 1280);
    g.steps(1);
    const view = g.camera().__view__;
    // Portrait: the width decides — half-width 10 m over aspect 0.5625 at 10 m.
    expect(view.fov).toBeCloseTo(2 * Math.atan(10 / 0.5625 / 10) * (180 / Math.PI), 6);
    g.plugin.resize(4000, 1000);
    g.steps(1);
    // Wide screen: 20 m across fits in the 60° default.
    expect(g.camera().__view__.fov).toBe(60);
  });

  it('widens an orthographic size, in 2D or 3D', () => {
    const g = game(cam({ mode: 'orthographic', size: 2, min_visible: [16, 6] }), { dimension: '2d' });
    g.plugin.resize(1000, 1000);
    g.steps(1);
    expect(g.camera().__view__.size).toBeCloseTo(8);
  });

  it('needs a distance to measure at', () => {
    expect(code(() => game(cam({ min_visible: [20, 2] })))).toBe('PP3726');
    expect(code(() => game(cam({ min_visible: [20, 2], focus_distance: 0 })))).toBe('PP3726');
  });
});

describe('ctx.camera', () => {
  const two = { prefabs: { cam: { components: { camera: {} } } }, entities: [{ id: 'a', prefab: 'cam' }, { id: 'b', prefab: 'cam', at: [5, 0, 0] }] };

  it('the cameras service names each seat\'s live camera (what cinematics and vehicle tiers read)', () => {
    const g = game({
      prefabs: { cam: { components: { camera: {} } } },
      entities: [{ id: 'a', prefab: 'cam' }, { id: 'b', prefab: 'cam', at: [5, 0, 0] }],
    });
    const service = g.kernel.service(CAMERAS_SERVICE);
    expect(service.active(0)).toBe(g.id('a'));
    expect(service.active(1)).toBeNull();
    g.cameras.use(g.id('b'));
    expect(service.active(0)).toBe(g.id('b'));
    // One live camera per seat: the one it looks through, posed.
    expect(service.live().map((c) => [c.seat, c.entity, c.position.x])).toEqual([[0, g.id('b'), 5]]);
  });

  it('main is the first camera until use() picks another', () => {
    const g = game(two);
    expect(g.cameras.main).toBe(g.camera('a'));
    expect(g.camera('a').__view__.active).toBe(true);
    expect(g.camera('b').__view__.active).toBe(false);
    g.cameras.use(g.id('b'));
    expect(g.cameras.main).toBe(g.camera('b'));
    expect(g.camera('a').__view__.active).toBe(false);
    expect(g.camera('b').__view__.active).toBe(true);
    expect(g.cameras.for_player({ index: 0 })).toBe(g.camera('b'));
    expect(code(() => g.cameras.for_player({ index: 1 }))).toBe('PP3720');
    expect(code(() => g.cameras.for_player('p1'))).toBe('PP3746');
    g.kernel.destroy(g.id('b'));
    g.steps(1);
    expect(g.cameras.main).toBe(g.camera('a'));
  });

  it('tell renderers and audio which camera is active, and its shake', () => {
    const g = game(two);
    expect(g.plugin.rig.active()).toBe(g.id('a'));
    expect(g.plugin.listener()).toBe(g.id('a'));
    expect(g.plugin.rig.offset(g.id('a'))).toEqual([0, 0]);
    g.camera('a').shake(1, 1);
    g.steps(1);
    const [x, y] = g.plugin.rig.offset(g.id('a'));
    expect(Math.hypot(x, y)).toBeGreaterThan(0);
    g.cameras.use(g.id('b'));
    expect(g.plugin.listener()).toBe(g.id('b'));
    const none = game({ prefabs: { x: { components: {} } }, entities: [{ prefab: 'x' }] });
    expect(none.plugin.rig.active()).toBeUndefined();
    expect(none.plugin.listener()).toBeNull();
  });

  it('fails clearly without a camera, and capture needs a renderer', () => {
    const g = game({ prefabs: { x: { components: {} } }, entities: [{ prefab: 'x' }] });
    expect(code(() => g.cameras.main)).toBe('PP3720');
    const h = game(two);
    expect(code(() => h.camera('a').capture())).toBe('PP3725');
    const r = game(two, { capture: (view) => `shot of ${view.entity}` });
    expect(r.camera('a').capture()).toBe(`shot of ${r.id('a')}`);
  });
});

describe('sprites', () => {
  const runner = {
    prefabs: {
      runner: {
        components: {
          sprite: {
            image: 'assets/images/idle.png',
            animations: {
              run: { frames: ['assets/images/run_0.png', 'assets/images/run_1.png'], fps: 10, loop: true },
              hop: { frames: ['hop_0', 'hop_1'], fps: 10, loop: false },
            },
          },
        },
      },
    },
    entities: [{ id: 'r', prefab: 'runner' }],
  };
  interface Sprite extends Fields { readonly animation: string | null; readonly __image__: string | null; play(...a: unknown[]): void }

  it('shows the image, then animation frames in game time', () => {
    const g = game(runner);
    const sprite = g.get<Sprite>('r', 'sprite');
    expect(sprite.animation).toBeNull();
    expect(sprite.__image__).toBe('assets/images/idle.png');
    sprite.play('run');
    expect(sprite.__image__).toBe('assets/images/run_0.png');
    g.steps(6);
    expect(sprite.__image__).toBe('assets/images/run_1.png');
    g.steps(6);
    expect(sprite.__image__).toBe('assets/images/run_0.png');
    sprite.play('run');
    expect(sprite.__image__).toBe('assets/images/run_0.png');
    g.steps(6);
    sprite.play('run', { restart: true });
    expect(sprite.__image__).toBe('assets/images/run_0.png');
    sprite.play('hop');
    g.steps(60);
    expect(sprite.__image__).toBe('hop_1');
    expect(sprite.animation).toBe('hop');
  });

  it('keeps its animation in saved fields (render2d contract)', () => {
    const g = game(runner);
    g.steps(30);
    const sprite = g.get<Sprite>('r', 'sprite');
    sprite.play('run');
    expect(sprite['animation']).toBe('run');
    expect(sprite['animation_started']).toBeCloseTo(0.5);
  });

  it('checks animation names', () => {
    const g = game(runner);
    expect(code(() => g.get<Sprite>('r', 'sprite').play('rnu'))).toBe('PP3731');
  });
});

describe('text, bars and zones', () => {
  it('parse TextMesh markup into spans', () => {
    const spans: TextSpan[] = textSpans('HP [color=#ff0000]low [b]now[/b][/color]!');
    expect(spans.map((s) => [s.text, s.color?.r ?? null, s.bold])).toEqual([
      ['HP ', null, false], ['low ', 1, false], ['now', 1, true], ['!', null, false],
    ]);
    expect(code(() => textSpans('[b]open'))).toBe('PP3740');
    expect(code(() => textSpans('[/color]'))).toBe('PP3740');
    const g = game({ prefabs: { l: { components: { text_mesh: { text: '[b]x[/b]' } } } }, entities: [{ id: 'l', prefab: 'l' }] });
    expect(g.get<{ __spans__: TextSpan[] }>('l', 'text_mesh').__spans__).toEqual([{ text: 'x', color: null, bold: true }]);
  });

  it('read WorldBar bands from JSON and from code', () => {
    const json: Band[] = readBands([[0.4, 0.6, '#00ff00']]);
    expect(json[0]!.color.__eq__(Color.GREEN)).toBe(true);
    expect(readBands([Object.freeze([0, 0.2, Color.RED])])[0]!.from).toBe(0);
    expect(code(() => readBands([[0.6, 0.4, '#fff']]))).toBe('PP3741');
    expect(code(() => readBands([[0.1, 0.2]]))).toBe('PP3741');
  });

  it('keep world_bar.bands as (from, to, Color) tuples', () => {
    const g = game({ prefabs: { b: { components: { world_bar: { bands: [[0.4, 0.6, '#00ff00']] } } } }, entities: [{ id: 'b', prefab: 'b' }] });
    const bar = g.get('b', 'world_bar');
    const [band] = bar['bands'] as unknown[][];
    expect(band![2]).toBeInstanceOf(Color);
    bar['bands'] = [Object.freeze([0, 0.1, '#ff0000'])];
    g.steps(1);
    expect(((bar['bands'] as unknown[][])[0]![2] as Color).__eq__(Color.RED)).toBe(true);
    bar['bands'] = [[2, 3, '#fff']];
    expect(code(() => g.steps(1))).toBe('PP3741');
  });

  it('blend EnvironmentZones in and out around the camera', () => {
    const g = game({
      prefabs: {
        cam: { components: { camera: {} } },
        squall: { components: { collider: { shape: 'box', size: [10, 10, 10], trigger: true }, environment_zone: { blend: 1 } } },
      },
      entities: [{ id: 'cam', prefab: 'cam' }, { id: 'z', prefab: 'squall', at: [100, 0, 0] }],
    });
    const zone = g.get<{ __weight__: number }>('z', 'environment_zone');
    expect(zone.__weight__).toBe(0);
    g.kernel.world.require(g.id('cam')).transform.position = new Vec3(100, 0, 0);
    g.steps(30);
    expect(zone.__weight__).toBeCloseTo(0.5, 1);
    g.steps(60);
    expect(zone.__weight__).toBe(1);
    g.kernel.world.require(g.id('cam')).transform.position = Vec3.ZERO;
    g.steps(15);
    expect(zone.__weight__).toBeCloseTo(0.75, 1);
  });

  it('a zone spawned around the camera blends in over its blend seconds; blend 0 applies at once', () => {
    const g = game({
      prefabs: {
        cam: { components: { camera: {} } },
        squall: { components: { collider: { shape: 'box', size: [10, 10, 10], trigger: true }, environment_zone: { blend: 1 } } },
        snap: { components: { collider: { shape: 'box', size: [10, 10, 10], trigger: true }, environment_zone: { blend: 0 } } },
      },
      entities: [{ id: 'cam', prefab: 'cam' }, { id: 'z', prefab: 'squall' }, { id: 's', prefab: 'snap' }],
    });
    const zone = g.get<{ __weight__: number }>('z', 'environment_zone');
    expect(zone.__weight__).toBe(0);
    expect(g.get<{ __weight__: number }>('s', 'environment_zone').__weight__).toBe(1);
    g.steps(30);
    expect(zone.__weight__).toBeCloseTo(0.5, 1);
    g.steps(30);
    expect(zone.__weight__).toBe(1);
  });
});

describe('snapshots', () => {
  it('restore rig, effect and sprite state exactly (animators: animation.test.ts)', () => {
    const g = game({
      prefabs: {
        cam: { components: { camera: { rig: 'follow', follow: 'hero', offset: [0, 3, -6], smoothing: 0.4 } } },
        hero: { components: { sprite: { animations: { run: { frames: ['a', 'b', 'c'], fps: 5 } } } } },
      },
      entities: [{ id: 'hero', prefab: 'hero' }, { id: 'cam', prefab: 'cam' }],
    });
    const hero = g.kernel.world.require(g.id('hero'));
    hero.transform.position = new Vec3(8, 0, 0);
    (hero.components.get('sprite') as unknown as { play(n: string): void }).play('run');
    g.camera().shake(0.5, 1);
    g.steps(10);
    const snap = g.kernel.snapshot();
    const after = (): [Vec3, unknown] => {
      g.steps(20);
      return [
        g.camera().__view__.position,
        (g.kernel.world.require(g.id('hero')).components.get('sprite') as unknown as { __image__: unknown }).__image__,
      ];
    };
    const first = after();
    g.kernel.restore(snap);
    const second = after();
    expect(second[0].__eq__(first[0])).toBe(true);
    expect(second[1]).toBe(first[1]);
  });
});
