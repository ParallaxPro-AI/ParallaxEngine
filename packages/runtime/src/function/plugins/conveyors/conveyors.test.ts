import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import type { Project, SceneDoc } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition } from '../../kernel/index.js';
import { CONVEYOR_ITEM_STRIDE, CONVEYOR_SERVICE } from '../../services/index.js';
import { ConveyorNet, conveyors } from './index.js';

const STEP = 1 / 60;
const run = (net: ConveyorNet, seconds: number): void => {
  for (let t = 0; t < seconds - 1e-9; t += STEP) net.step(STEP);
};
const straight = (net: ConveyorNet, x0: number, x1: number, speed = 2, spacing = 0.25): number =>
  net.lane([[x0, 0, 0], [x1, 0, 0]], { speed, spacing });

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

describe('conveyor lanes', () => {
  it('carry an item to the end at their speed, where it waits to be popped', () => {
    const net = new ConveyorNet();
    const lane = straight(net, 0, 4);
    expect(net.push(lane, 'ore')).toBe(true);
    run(net, 1);
    expect(net.positions(lane)[0]).toBeCloseTo(2, 6);
    expect(net.front(lane)).toBeNull();
    run(net, 1.5);
    expect(net.positions(lane)[0]).toBeCloseTo(4, 6);
    expect(net.front(lane)).toBe('ore');
    expect(net.pop(lane)).toBe('ore');
    expect(net.count()).toBe(0);
  });

  it('keep items spacing apart and back up behind a stopped one', () => {
    const net = new ConveyorNet();
    const lane = straight(net, 0, 1);
    let pushed = 0;
    for (let i = 0; i < 120; i++) {
      if (net.push(lane, 'plate')) pushed++;
      net.step(STEP);
    }
    // A 1 m lane holds items 0.25 m apart: at the end, 0.75, 0.5, 0.25 and 0.
    expect(pushed).toBe(5);
    expect(net.positions(lane)).toEqual([1, 0.75, 0.5, 0.25, 0].map((d) => expect.closeTo(d, 6)));
    expect(net.room(lane, 0)).toBe(false);
    expect(net.push(lane, 'plate')).toBe(false);
  });

  it('hand items to the lane they feed, inline or from the side, when there is room', () => {
    const net = new ConveyorNet();
    const a = straight(net, 0, 1);
    const b = straight(net, 1, 3);
    const side = net.lane([[2, 0, -1], [2, 0, 0]], { speed: 2, spacing: 0.25 });
    net.connect(a, b);
    net.connect(side, b, 1);
    net.push(a, 'ore');
    net.push(side, 'coal');
    run(net, 0.6);
    expect(net.items(a)).toEqual([]);
    expect(net.items(side)).toEqual([]);
    expect(net.items(b).sort()).toEqual(['coal', 'ore']);
    run(net, 2);
    expect(net.front(b)).not.toBeNull();
    // Removing the target stops the feeders at their ends again.
    expect(net.remove(b).length).toBe(2);
    net.push(a, 'ore');
    run(net, 1);
    expect(net.front(a)).toBe('ore');
  });

  it('take the item nearest a point, optionally of some kinds', () => {
    const net = new ConveyorNet();
    const lane = straight(net, 0, 2, 0);
    net.push(lane, 'ore', 0.5);
    net.push(lane, 'coal', 1.5);
    expect(net.take(lane, 1.4, 0.3, ['ore'])).toBeNull();
    expect(net.take(lane, 1.4, 0.3)).toBe('coal');
    expect(net.take(lane, 1.4, 0.3)).toBeNull();
    expect(net.take(lane, 0.4, 0.3, ['ore'])).toBe('ore');
  });

  it('stop when their speed is 0', () => {
    const net = new ConveyorNet();
    const lane = straight(net, 0, 2);
    net.push(lane, 'ore');
    net.setSpeed(lane, 0);
    run(net, 1);
    expect(net.positions(lane)).toEqual([0]);
  });

  it('draw the items of kinds with a look, along the lane and turned to its heading', () => {
    const net = new ConveyorNet();
    net.look('ore', { model: 'models/ore', scale: 0.5, lift: 0.1 });
    const lane = net.lane([[0, 1, 0], [0, 1, 4]], { speed: 1, spacing: 0.25 });
    net.push(lane, 'ore', 2);
    net.push(lane, 'unseen', 1);
    const draws = net.draws(1);
    expect(draws.length).toBe(1);
    expect(draws[0]).toMatchObject({ model: 'models/ore', scale: 0.5, count: 1 });
    expect([...draws[0]!.items.subarray(0, CONVEYOR_ITEM_STRIDE)].map((v) => Number(v.toFixed(4)))).toEqual([0, 1.1, 2, 0]);
    net.setVisible(lane, false);
    expect(net.draws(1)).toEqual([]);
  });

  it('round-trip through snapshots', () => {
    const net = new ConveyorNet();
    net.look('ore', { model: 'models/ore', scale: 1, lift: 0 });
    const a = straight(net, 0, 1);
    const b = straight(net, 1, 2);
    net.connect(a, b);
    net.push(a, 'ore', 0.5);
    const copy = new ConveyorNet();
    copy.restore(net.snapshot());
    expect(copy.items(a)).toEqual(['ore']);
    expect(copy.positions(a)).toEqual([0.5]);
    run(copy, 1);
    expect(copy.items(b)).toEqual(['ore']);
    expect(copy.lane([[0, 0, 0], [1, 0, 0]], { speed: 1, spacing: 0.25 })).toBeGreaterThan(b);
  });

  it('reject bad lanes and unknown ids with PP3910', () => {
    const net = new ConveyorNet();
    expect(code(() => net.lane([[0, 0, 0]], { speed: 1, spacing: 0.25 }))).toBe('PP3910');
    expect(code(() => net.lane([[0, 0, 0], [0, 0, 0]], { speed: 1, spacing: 0.25 }))).toBe('PP3910');
    expect(code(() => net.lane([[0, 0, 0], [1, 0, 0]], { speed: 1, spacing: 0 }))).toBe('PP3910');
    expect(code(() => net.push(99, 'ore'))).toBe('PP3910');
    const lane = straight(net, 0, 1);
    expect(code(() => net.connect(lane, lane))).toBe('PP3910');
  });

  it('move many items cheaply', () => {
    const net = new ConveyorNet();
    const lanes: number[] = [];
    for (let i = 0; i < 2000; i++) lanes.push(net.lane([[i, 0, 0], [i + 1, 0, 0]], { speed: 2, spacing: 0.25 }));
    for (let i = 0; i < lanes.length - 1; i++) net.connect(lanes[i]!, lanes[i + 1]!);
    for (const lane of lanes) for (let k = 0; k < 4; k++) net.push(lane, 'ore', k * 0.25);
    expect(net.count()).toBe(8000);
    const t0 = performance.now();
    run(net, 1);
    const perStep = (performance.now() - t0) / 60;
    expect(net.count()).toBe(8000);
    expect(perStep).toBeLessThan(10);
  });
});

describe('the conveyors plugin', () => {
  it('steps lanes with the fixed step, provides the service and clears on scene load', () => {
    const scene: SceneDoc = { id: 'main', path: 'scenes/main/scene.json', tags: [], ui: [], init: {}, entities: [], regions: new Map(), plugins: {} };
    const project: Project = {
      prefabs: new Map(), scenes: new Map([['main', scene]]), config: new Map(), content: new Map(),
      locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
    };
    const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
    const plugin = conveyors();
    const kernel = new Kernel({ project, game, plugins: [plugin] });
    kernel.start('main');
    expect(kernel.service(CONVEYOR_SERVICE)).toBe(plugin.net);
    const lane = plugin.net.lane([[0, 0, 0], [10, 0, 0]], { speed: 1, spacing: 0.25 });
    plugin.net.push(lane, 'ore');
    for (let i = 0; i < 60; i++) kernel.step(STEP);
    expect(plugin.net.positions(lane)[0]).toBeCloseTo(1, 3);
    const saved = kernel.snapshot();
    for (let i = 0; i < 60; i++) kernel.step(STEP);
    kernel.restore(saved);
    expect(plugin.net.positions(lane)[0]).toBeCloseTo(1, 3);
    kernel.loadScene('main');
    expect(plugin.net.laneCount).toBe(0);
  });
});
