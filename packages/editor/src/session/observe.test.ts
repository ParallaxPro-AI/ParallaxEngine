/**
 * Observation and profiler feeds on a known scene: boxes match an independent projection
 * of the drawn geometry, off-screen and behind-camera entities say so, panels list their
 * actions and state, the camera block re-projects, and the profiler's numbers add up.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Vec3 } from '@parallax/runtime/core';
import { openHeadlessEditor } from './headless.js';
import type { HeadlessEditor } from './headless.js';
import { observe } from './observe.js';
import type { ObservedEntity } from './observe.js';
import { assertBudget, checkBudget, runtimeMemory, worldCounts } from './profiler.js';
import { DATA_2D, DATA_3D, declare2d, declare3d, files, LOG, lookAt } from './test_fixtures.js';

const DATA = {
  ...DATA_3D,
  'scenes/main/scene.json': {
    ui: ['hud'],
    entities: [
      { prefab: 'camera', id: 'camera', at: [0, 5, -10], rotation: [26.56505, 0, 0] },
      { prefab: 'crate', id: 'a', at: [0, 0, 0] },
      { prefab: 'crate', id: 'far_right', at: [60, 0, 0] },
      { prefab: 'crate', id: 'behind', at: [0, 5, -30] },
    ],
  },
};

async function playing(): Promise<HeadlessEditor> {
  const ed = await openHeadlessEditor({ entry: () => declare3d(1), files: files(DATA), mode: '3d', size: { width: 800, height: 600 } });
  ed.session.play();
  ed.frames(2);
  return ed;
}

const byPlaced = (entities: readonly ObservedEntity[], id: string): ObservedEntity => entities.find((e) => e.placedId === id)!;

beforeEach(() => { LOG.length = 0; });

describe('observe', () => {
  it('boxes every drawn entity where an independent projection of its geometry lands', async () => {
    const ed = await playing();
    const o = observe(ed.session.runtime);
    // The game's camera: at (0, 5, -10) looking at the origin, 60° on 800×600.
    const lens = lookAt(new Vec3(0, 5, -10), Vec3.ZERO);
    const corners: Vec3[] = [];
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) corners.push(new Vec3(x, y, z));
    const px = corners.map((c) => lens.project(c)!);
    const expected = {
      x: Math.min(...px.map((p) => p.x)), y: Math.min(...px.map((p) => p.y)),
      width: Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x)),
      height: Math.max(...px.map((p) => p.y)) - Math.min(...px.map((p) => p.y)),
    };
    const a = byPlaced(o.entities, 'a');
    expect(a.drawn).toBe(true);
    expect(a.onScreen).toBe(true);
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(a.screen![k]).toBeCloseTo(expected[k], 2);
    expect(a.center![0]).toBeCloseTo(400, 1);
    expect(a.bounds).toEqual({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
    expect(a.behaviors).toEqual(['spinner']);
    expect(a.components).toContain('shape');

    const right = byPlaced(o.entities, 'far_right');
    expect(right.drawn).toBe(true);
    expect(right.onScreen).toBe(false);
    expect(right.screen!.x).toBeGreaterThan(800);
    const behind = byPlaced(o.entities, 'behind');
    expect(behind.screen).toBeNull();
    expect(behind.onScreen).toBe(false);
    // The camera itself draws nothing.
    expect(byPlaced(o.entities, 'camera').drawn).toBe(false);
  });

  it('describes the camera so a consumer can re-project, and the open panels with actions and state', async () => {
    const ed = await playing();
    const o = observe(ed.session.runtime);
    const cam = o.camera!;
    expect(cam.entity).toBe(byPlaced(o.entities, 'camera').id);
    expect(cam.perspective).toBe(true);
    expect(cam.fov).toBeCloseTo(60, 3);
    expect(cam.position.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0, 5, -10]);
    const vp = cam.viewProjection;
    const clip = [0, 1, 2, 3].map((r) => vp[r]! * 0 + vp[4 + r]! * 0 + vp[8 + r]! * 0 + vp[12 + r]!);
    expect(clip[0]! / clip[3]!).toBeCloseTo(0, 5);
    expect(o.panels).toEqual([{
      id: 'hud', html: 'ui/hud.html', layer: 'hud', modal: false, actions: [{ name: 'dismiss', kind: 'command', enabled: true }], state: { score: 3 },
    }]);
    expect(o.time.logic).toBe(true);
    expect(o.scene).toBe('main');
  });

  it('in edit mode describes the editor camera\'s view and leaves the editor camera out', async () => {
    const ed = await openHeadlessEditor({ entry: () => declare3d(1), files: files(DATA), mode: '3d', size: { width: 800, height: 600 } });
    ed.frame();
    const o = ed.session.observe();
    expect(o.camera!.entity).toBe(ed.session.cameraEntity);
    expect(o.entities.some((e) => e.id === ed.session.cameraEntity)).toBe(false);
    expect(o.time.logic).toBe(false);
    expect(o.panels).toEqual([]);
    expect(LOG).toEqual([]);
  });

  it('2D: boxes in screen pixels through the orthographic view', async () => {
    const ed = await openHeadlessEditor({ entry: declare2d, files: files(DATA_2D), mode: '2d', size: { width: 800, height: 600 } });
    ed.frame();
    const o = ed.session.observe();
    // size 5: 600 px span 10 m → 60 px per meter; the block (2×1 m) at (2, 1).
    const block = o.entities.find((e) => e.placedId === 'block')!;
    expect(block.screen!.x).toBeCloseTo(400 + 60, 6);
    expect(block.screen!.width).toBeCloseTo(120, 6);
    expect(block.screen!.y).toBeCloseTo(300 - 90, 6);
    expect(block.screen!.height).toBeCloseTo(60, 6);
    expect(o.camera!.dimension).toBe('2d');
    expect(o.camera!.view).toBeNull();
  });
});

describe('profiler feeds', () => {
  it('reports per-phase, per-unit and per-hook times that add up, with counts and memory', async () => {
    const ed = await playing();
    ed.session.setProfiling(true);
    const seen: number[] = [];
    const unsubscribe = ed.session.profiler.subscribe((s) => seen.push(s.frame));
    ed.frames(20);
    unsubscribe();
    expect(seen).toHaveLength(20);
    const stats = ed.session.profiler.stats();
    expect(stats.frames).toBe(20);
    expect(stats.frameMs.mean).toBeGreaterThan(0);
    expect(stats.frameMs.max).toBeGreaterThanOrEqual(stats.frameMs.p95);
    const phaseMean = Object.values(stats.phases).reduce((a, p) => a + p.mean, 0);
    expect(phaseMean).toBeLessThanOrEqual(stats.frameMs.mean + 1e-9);
    expect(stats.phases.render.mean).toBeGreaterThan(0);
    expect(stats.fixedStepsPerFrame).toBe(1);
    const spinner = stats.units.find((u) => u.id === 'spinner')!;
    expect(spinner).toMatchObject({ kind: 'behavior', callsPerFrame: 3 });
    expect(stats.hooks.some((h) => h.point === 'render' && h.owner === 'render3d')).toBe(true);

    const counts = worldCounts(ed.session.runtime.kernel);
    expect(counts.prefabs).toEqual({ camera: 1, crate: 3 });
    expect(counts.behaviors).toEqual({ spinner: 3 });
    expect(counts.components['shape']).toBe(3);
    const memory = runtimeMemory(ed.session.runtime);
    expect(memory.geometries).toBe(1);
    expect(memory.instances).toBe(3);
    expect(memory.geometryBytes).toBeGreaterThan(0);

    expect(checkBudget({ stats, counts, memory }, { frameMs: { mean: 1000 }, entities: 10, units: { spinner: 100 } })).toEqual([]);
    const over = checkBudget({ stats, counts, memory }, { entities: 2, components: { shape: 1 }, memory: { geometryBytes: 1 }, frameMs: { max: 0 } });
    expect(over.map((d) => d.message.split(' ')[0])).toEqual(['Frame', '4', '3', 'geometryBytes']);
    expect(new Set(over.map((d) => d.code))).toEqual(new Set(['PP5020']));
    expect(() => assertBudget({ counts }, { entities: 2 })).toThrow(/PP5020[\s\S]*4 entities, over the budget of 2/);
    // Edit-mode frames can be left out.
    ed.session.stop();
    ed.frames(5);
    expect(ed.session.profiler.stats({ logicOnly: true }).frames).toBe(20);
    expect(ed.session.profiler.stats().frames).toBe(25);
    ed.session.setProfiling(false);
    ed.frames(2);
    expect(ed.session.profiler.stats().frames).toBe(25);
  });

  it('keeps feeding the profiler across a hot reload', async () => {
    const ed = await playing();
    ed.session.setProfiling(true);
    await ed.session.reload();
    ed.frames(3);
    expect(ed.session.profiler.stats().frames).toBe(3);
    expect(ed.session.profiler.stats().units.find((u) => u.id === 'spinner')!.callsPerFrame).toBe(3);
  });
});
