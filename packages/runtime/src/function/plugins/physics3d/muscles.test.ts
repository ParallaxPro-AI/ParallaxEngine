/**
 * The `muscle` component: a world tilt muscle balances a body upright, a relative muscle
 * swings a jointed limb to its pose while the body it pulls against turns the other way
 * (angular momentum kept), yaw muscles turn headings only, and strength 0 is limp —
 * headless, measured.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields, GameDefinition } from '../../kernel/index.js';
import { initPhysics3d, physics3d } from './index.js';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics3d();
});

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function world(data: { prefabs: Record<string, unknown>; entities: unknown[] }, gravity = -9.8) {
  const project = loadProject(files({
    ...Object.fromEntries(Object.entries(data.prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities: data.entities },
  }));
  expect(project.diagnostics).toEqual([]);
  const def: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({ project, game: def, plugins: [physics3d({ gravity })], context: {}, fixedStep: DT });
  kernel.start('main');
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel,
    id,
    rot: (placed: string): Quat => kernel.world.require(id(placed)).transform.worldRotation(),
    pos: (placed: string): Vec3 => kernel.world.require(id(placed)).transform.worldPosition(),
    get: (placed: string, component: string): Fields => kernel.world.require(id(placed)).components.get(component)!,
    steps: (n: number) => {
      for (let i = 0; i < n; i++) kernel.step(DT);
    },
  };
}

const UP = new Vec3(0, 1, 0);
const FLOOR = { components: { collider: { shape: 'box', size: [40, 1, 40], offset: [0, -0.5, 0] } } };
const POST = { components: { rigidbody: { mass: 10 }, collider: { shape: 'box', size: [0.4, 2, 0.4], offset: [0, 1, 0], friction: 1 } } };
/** Degrees between a rotation's up and world up. */
const tilt = (q: Quat): number => Math.acos(Math.min(1, q.rotate(UP).dot(UP))) * 180 / Math.PI;
const headingOf = (q: Quat): number => {
  const f = q.rotate(new Vec3(0, 0, 1));
  return Math.atan2(f.x, f.z) * 180 / Math.PI;
};

describe('muscles', () => {
  it('a world tilt muscle stands a tipped post back up, leaving its heading free; without one it falls', () => {
    const tipped = [20, 35, 0];
    const g = world({
      prefabs: { floor: FLOOR, post: POST },
      entities: [
        { prefab: 'floor' },
        { prefab: 'post', id: 'held', at: [0, 0.05, 0], rotation: tipped, components: { muscle: { axes: 'tilt', stiffness: 12 } } },
        { prefab: 'post', id: 'free', at: [5, 0.05, 0], rotation: tipped },
      ],
    });
    g.steps(180);
    expect(tilt(g.rot('held'))).toBeLessThan(2);
    expect(tilt(g.rot('free'))).toBeGreaterThan(60);
    // Tilt doesn't touch the heading: still about the 35° it was placed at.
    expect(Math.abs(headingOf(g.rot('held')) - 35)).toBeLessThan(8);
  });

  it('strength 0 is limp, and enabled false holds nothing', () => {
    const g = world({
      prefabs: { floor: FLOOR, post: POST },
      entities: [
        { prefab: 'floor' },
        { prefab: 'post', id: 'limp', at: [0, 0.05, 0], rotation: [25, 0, 0], components: { muscle: { axes: 'tilt', strength: 0 } } },
        { prefab: 'post', id: 'off', at: [5, 0.05, 0], rotation: [25, 0, 0], components: { muscle: { axes: 'tilt', enabled: false } } },
      ],
    });
    g.steps(180);
    expect(tilt(g.rot('limp'))).toBeGreaterThan(60);
    expect(tilt(g.rot('off'))).toBeGreaterThan(60);
  });

  it('a relative muscle swings a jointed arm to its pose; the torso turns the other way (internal torque)', () => {
    const g = world({
      prefabs: {
        torso: { components: { rigidbody: { mass: 4 }, collider: { shape: 'box', size: [0.6, 1, 0.4] } } },
        arm: { components: { rigidbody: { mass: 1 }, collider: { shape: 'box', size: [0.12, 0.6, 0.12], offset: [0, -0.3, 0] } } },
      },
      entities: [
        { prefab: 'torso', id: 'torso', at: [0, 5, 0] },
        {
          prefab: 'arm', id: 'arm', at: [0.4, 5.4, 0], components: {
            joint: { kind: 'ball', connected: 'torso' },
            muscle: { relative_to: 'torso', target: [-90, 0, 0], stiffness: 14 },
          },
        },
      ],
    }, 0);
    g.steps(120);
    // The arm, in the torso's frame, points where -90° about x puts its hanging -y: forward (+z).
    const relative = g.rot('torso').inverse().__mul__(g.rot('arm'));
    const along = relative.rotate(new Vec3(0, -1, 0));
    expect(along.z).toBeGreaterThan(0.97);
    // No outside torque: the torso turned the other way about x as the arm swung (its
    // forward tips down where the arm's tips up).
    const forward = new Vec3(0, 0, 1);
    expect(g.rot('arm').rotate(forward).y).toBeGreaterThan(0.5);
    expect(g.rot('torso').rotate(forward).y).toBeLessThan(-0.05);
  });

  it('relative_to set from game code (an entity handle) drives the limb like placed data does', () => {
    const g = world({
      prefabs: {
        torso: { components: { rigidbody: { mass: 4 }, collider: { shape: 'box', size: [0.6, 1, 0.4] } } },
        arm: { components: { rigidbody: { mass: 1 }, collider: { shape: 'box', size: [0.12, 0.6, 0.12], offset: [0, -0.3, 0] } } },
      },
      entities: [
        { prefab: 'torso', id: 'torso', at: [0, 5, 0] },
        { prefab: 'arm', id: 'arm', at: [0.4, 5.4, 0], components: { joint: { kind: 'ball', connected: 'torso' }, muscle: { target: [-90, 0, 0], stiffness: 14 } } },
      ],
    }, 0);
    g.get('arm', 'muscle')['relative_to'] = g.kernel.handles.wrap(g.id('torso'));
    g.steps(120);
    const relative = g.rot('torso').inverse().__mul__(g.rot('arm'));
    expect(relative.rotate(new Vec3(0, -1, 0)).z).toBeGreaterThan(0.97);
  });

  it('a yaw muscle turns a body to face its target heading; max_torque slows it', () => {
    const disc = { components: { rigidbody: { mass: 2 }, collider: { shape: 'cylinder', radius: 0.5, height: 0.2 } } };
    const g = world({
      prefabs: { disc },
      entities: [
        { prefab: 'disc', id: 'fast', at: [0, 3, 0], components: { muscle: { axes: 'yaw', target: [0, 120, 0], stiffness: 10 } } },
        { prefab: 'disc', id: 'capped', at: [3, 3, 0], components: { muscle: { axes: 'yaw', target: [0, 120, 0], stiffness: 10, max_torque: 0.02 } } },
      ],
    }, 0);
    g.steps(90);
    expect(Math.abs(headingOf(g.rot('fast')) - 120)).toBeLessThan(2);
    expect(headingOf(g.rot('capped'))).toBeLessThan(60);
    g.get('fast', 'muscle')['target'] = new Vec3(0, -45, 0);
    g.steps(90);
    expect(Math.abs(headingOf(g.rot('fast')) + 45)).toBeLessThan(2);
  });
});
