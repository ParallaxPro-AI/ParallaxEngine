/**
 * `parallax.physics` in 3D, `parallax.characters` and `parallax.vehicles` the way compiled
 * game code calls them: plugin factories with Python keywords, component handles through
 * `entity.get(...)`, `ctx.physics`, and the plugin events heard with `@on`.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { Character, characters, Jumped, Landed } from './characters.js';
import { Behavior, behavior, Context, createRuntime, Entity, EntityRef, Game, kw, on, resetDeclarations, SceneRef, Vec3 } from './index.js';
import type { GameRuntime } from './index.js';
import { Collider, Layers, layer, Rigidbody } from './physics.js';
import { initPhysics3d, physics3d } from './physics3d.js';
import { Vehicle, VehicleEntered, VehicleExited, VehicleLanded, vehicles } from './vehicles.js';

const STEP = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});
beforeEach(() => resetDeclarations());

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function run(data: Record<string, unknown>, plugins: unknown[]): GameRuntime {
  const projectFiles = files(data);
  const project = loadProject(projectFiles);
  expect(project.diagnostics).toEqual([]);
  const game = new Game(kw({ id: 'test', title: 'Test', sdk: '1.0', start_scene: new SceneRef('main'), mode: '3d', plugins }));
  const runtime = createRuntime(game, project, {
    seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: projectFiles, surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  runtime.start();
  return runtime;
}

const FLOOR = { components: { collider: { shape: 'box', size: [100, 1, 100], offset: [0, -0.5, 0], layer: 'ground' } } };

describe('parallax.plugins.physics3d / characters / vehicles', () => {
  it('bind Python arguments; the handles name the plugins\' components and events', () => {
    class GameLayers extends Layers { static ground = layer(); static hero = layer(); }
    const plugin = physics3d(kw({ gravity: -20, layers: GameLayers }));
    expect(plugin.id).toBe('physics3d');
    expect(plugin.components!.find((c) => c.id === 'collider')!.schema['collides_with']!.default).toEqual(['default', 'ground', 'hero']);
    expect(() => physics3d(kw({ gravty: 0 }))).toThrow(/PP3030/);
    expect(() => characters(1)).toThrow(/PP3030/);
    expect(characters().id).toBe('characters');
    expect(vehicles().id).toBe('vehicles');
    expect(Rigidbody.__component_id__).toBe('rigidbody');
    expect(Collider.__component_id__).toBe('collider');
    expect(Character.__component_id__).toBe('character');
    expect(Vehicle.__component_id__).toBe('vehicle');
    expect([Landed, Jumped, VehicleEntered, VehicleExited, VehicleLanded].map((e) => e.__event_id__))
      .toEqual(['landed', 'jumped', 'vehicle_entered', 'vehicle_exited', 'vehicle_landed']);
  });

  it('runs a 3D game: ctx.physics, Character with keywords, @on(Landed / Jumped / VehicleEntered)', () => {
    const heard: string[] = [];
    class Hero extends Behavior {
      declare entity: Entity;
      landed(_ctx: Context, e: { fall_speed: number; target: Entity | null }) { heard.push(`landed ${e.target?.name ?? 'none'}`); }
      jumped(_ctx: Context, e: { in_air: boolean }) { heard.push(`jumped ${e.in_air}`); }
    }
    on(Landed)(Hero.prototype.landed);
    on(Jumped)(Hero.prototype.jumped);
    behavior('hero', kw({ requires: [Character] }))(Hero);
    class Car extends Behavior {
      entered(_ctx: Context, e: { source: Entity }) { heard.push(`entered by ${e.source.name}`); }
    }
    on(VehicleEntered)(Car.prototype.entered);
    behavior('car', kw({ requires: [Vehicle] }))(Car);
    class GameLayers extends Layers { static ground = layer(); }
    const r = run({
      'prefabs/floor.prefab.json': FLOOR,
      'prefabs/hero.prefab.json': { components: { character: { walk_speed: 5, run_speed: 9, acceleration: 1000 } }, behaviors: { hero: {} } },
      'prefabs/car.prefab.json': {
        components: { rigidbody: { mass: 1000 }, collider: { shape: 'box', size: [1.8, 1.2, 4], offset: [0, 0.6, 0] }, vehicle: { max_speed: 20 } },
        behaviors: { car: {} },
        children: [{ name: 'driver_seat', at: [0, 0.6, 0], components: { seat: { enter_time: 0 } } }],
      },
      'scenes/main/scene.json': { entities: [
        { prefab: 'floor', id: 'floor' }, { prefab: 'hero', id: 'hero', at: [0, 0.3, 0] }, { prefab: 'car', id: 'car', at: [5, 0.3, 0] },
      ] },
    }, [physics3d(kw({ layers: GameLayers })), characters(), vehicles()]);
    const hero = r.ctx.world.placed(new EntityRef('hero'));
    const floor = r.ctx.world.placed(new EntityRef('floor'));
    for (let i = 0; i < 30; i++) r.step(STEP);
    expect(heard).toEqual([`landed ${floor.name}`]);
    const physics = (r.ctx as unknown as { physics: { raycast(...a: unknown[]): { entity: unknown } | null; gravity: number } }).physics;
    expect(physics.gravity).toBe(-9.8);
    expect(physics.raycast(new Vec3(0, 5, 0), new Vec3(0, -1, 0), kw({ layers: [GameLayers.ground] }))!.entity).toBe(floor);
    const body = hero.get(Character) as unknown as { move(...a: unknown[]): void; jump(): boolean; velocity: Vec3; vehicle: unknown; grounded: boolean };
    for (let i = 0; i < 10; i++) {
      body.move(new Vec3(0, 0, 1), kw({ run: true }));
      r.step(STEP);
    }
    expect(body.velocity.z).toBeCloseTo(9, 3);
    expect(body.jump()).toBe(true);
    r.step(STEP);
    expect(heard.at(-1)).toBe('jumped false');
    for (let i = 0; i < 90; i++) r.step(STEP);
    expect(heard.at(-1)).toBe(`landed ${floor.name}`);
    expect(body.grounded).toBe(true);
    const car = r.ctx.world.placed(new EntityRef('car'));
    const vehicle = car.get(Vehicle) as unknown as { enter(...a: unknown[]): boolean; drive(...a: unknown[]): void; speed: number; driver: unknown };
    expect(vehicle.enter(hero, kw({ seat: 0 }))).toBe(true);
    expect(body.vehicle).toBe(car);
    expect(vehicle.driver).toBe(hero);
    r.step(STEP);
    expect(heard.at(-1)).toBe(`entered by ${hero.name}`);
    for (let i = 0; i < 60; i++) {
      vehicle.drive(kw({ throttle: 1 }));
      r.step(STEP);
    }
    expect(vehicle.speed).toBeGreaterThan(5);
    expect((car.get(Rigidbody) as unknown as { speed: number }).speed).toBeGreaterThan(5);
  });
});
