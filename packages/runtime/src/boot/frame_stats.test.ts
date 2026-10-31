/**
 * FrameStats: off until a consumer holds it (no probe, nothing kept), wall intervals → fps and
 * the frame-time history, kernel samples → phases, scripts, hooks and the budget buckets, the
 * probe following a replaced kernel, and the window bound.
 */

import { describe, expect, it } from 'vitest';
import { FRAME_PHASES, Kernel } from '../function/kernel/index.js';
import type { FramePhase, FrameSample, KernelProbe } from '../function/kernel/index.js';
import { loadProject } from '../resource/index.js';
import { budgetOf, distribution, FrameStats } from './frame_stats.js';
import type { RenderStats } from './frame_stats.js';

/** A stand-in kernel: records its probe and holds `entities` live records with `behaviors` each. */
function fakeKernel(entities = 0, behaviors = 0): Kernel & { probe: KernelProbe | null } {
  const records = Array.from({ length: entities }, () => ({ alive: true, behaviors: Array.from({ length: behaviors }, () => ({})) }));
  const k = {
    probe: null as KernelProbe | null,
    setProbe(p: KernelProbe | null) { k.probe = p; },
    world: { *live() { yield* records; } },
  };
  return k as unknown as Kernel & { probe: KernelProbe | null };
}

function phases(values: Partial<Record<FramePhase, number>>): Record<FramePhase, number> {
  return Object.fromEntries(FRAME_PHASES.map((p) => [p, values[p] ?? 0])) as Record<FramePhase, number>;
}

function sample(frame: number, p: Partial<Record<FramePhase, number>>, extra: Partial<FrameSample> = {}): FrameSample {
  const ph = phases(p);
  return {
    frame, totalMs: Object.values(ph).reduce((a, b) => a + b, 0), phases: ph, fixedSteps: 1, logic: true, units: [], hooks: [], ...extra,
  };
}

describe('FrameStats', () => {
  it('measures nothing and holds no probe until enabled; disabling forgets the window', () => {
    let clock = 0;
    const kernel = fakeKernel();
    const stats = new FrameStats({ now: () => clock, heap: () => null });
    stats.connect({ kernel: () => kernel, render: () => null });
    for (let i = 0; i < 5; i++) { clock += 16; stats.tick(); }
    expect(kernel.probe).toBeNull();
    expect(stats.snapshot().frames).toBe(0);

    stats.enable('panel');
    expect(kernel.probe).toBe(stats);
    for (let i = 0; i < 5; i++) { clock += 16; stats.tick(); }
    expect(stats.snapshot().frames).toBe(4);

    stats.enable('copy');
    stats.disable('panel');
    expect(stats.enabled).toBe(true);
    expect(kernel.probe).toBe(stats);
    stats.disable('copy');
    expect(stats.enabled).toBe(false);
    expect(kernel.probe).toBeNull();
    expect(stats.snapshot().frames).toBe(0);
  });

  it('turns wall intervals into fps and a bounded history, skipping pauses', () => {
    let clock = 0;
    const stats = new FrameStats({ now: () => clock, window: 10, heap: () => null });
    stats.connect({ kernel: () => fakeKernel(), render: () => null });
    stats.enable();
    stats.tick();
    for (let i = 0; i < 30; i++) { clock += 20; stats.tick(); }
    clock += 60_000; // a hidden page: not a frame
    stats.tick();
    clock += 40;
    stats.tick();
    const snap = stats.snapshot();
    expect(snap.frames).toBe(10);
    expect(snap.frameMsHistory).toEqual([20, 20, 20, 20, 20, 20, 20, 20, 20, 40]);
    expect(snap.frameMs).toMatchObject({ min: 20, max: 40, last: 40 });
    expect(snap.frameMs.avg).toBeCloseTo(22);
    expect(snap.fps).toBe(Math.round(1000 / 22));
  });

  it('aggregates kernel samples into phases, scripts, hooks and budget', () => {
    const kernel = fakeKernel(3, 2);
    const stats = new FrameStats({ now: () => 0, heap: () => ({ used: 64 * 1024 * 1024, total: 128 * 1024 * 1024 }) });
    stats.connect({ kernel: () => kernel, render: () => null });
    stats.enable();
    stats.frame(sample(1, { update: 2, physics: 1, render: 3 }, {
      units: [{ kind: 'behavior', id: 'mover', ms: 1.5, calls: 3 }, { kind: 'system', id: 'director', ms: 0.5, calls: 1 }],
      hooks: [{ point: 'render', owner: 'models', ms: 1 }, { point: 'render', owner: 'render3d', ms: 2 }],
    }));
    stats.frame(sample(2, { update: 4, physics: 1, render: 3 }, {
      units: [{ kind: 'behavior', id: 'mover', ms: 3.5, calls: 3 }],
      hooks: [{ point: 'render', owner: 'models', ms: 1 }, { point: 'render', owner: 'render3d', ms: 2 }],
    }));
    const snap = stats.snapshot();
    expect(snap.cpuMs.avg).toBe(7);
    expect(snap.cpuMsHistory).toEqual([6, 8]);
    const update = snap.phases.find((p) => p.name === 'update')!;
    expect(update).toMatchObject({ avgMs: 3, maxMs: 4 });
    expect(update.pct).toBeCloseTo(3 / 7);
    expect(snap.scripts.map((s) => s.name)).toEqual(['mover', 'director']);
    expect(snap.scripts[0]).toMatchObject({ kind: 'behavior', lastMs: 3.5, avgMs: 2.5, maxMs: 3.5, callsPerFrame: 3 });
    expect(snap.scripts[1]).toMatchObject({ lastMs: 0, avgMs: 0.25, maxMs: 0.5 });
    expect(snap.hooks[0]).toMatchObject({ point: 'render', owner: 'render3d', avgMs: 2 });
    const budget = Object.fromEntries(snap.budget.map((b) => [b.bucket, b.ms]));
    expect(budget).toEqual({ Scripts: 3, Physics: 1, Animation: 1, Rendering: 2, Other: 0 });
    expect(snap.budget.reduce((a, b) => a + b.pct, 0)).toBeCloseTo(1);
    expect(snap.counts).toEqual({ entities: 3, behaviors: 6 });
    expect(snap.memory).toMatchObject({ supported: true, usedMB: 64, totalMB: 128, historyMB: [64] });
    expect(snap.logic).toBe(true);
  });

  it('passes the renderer\'s counts through', () => {
    const render: RenderStats = {
      backend: 'webgpu', drawCalls: 12, triangles: 3400, drawCallsByPass: { geometry: 10, shadow: 2 }, trianglesByPass: { geometry: 3000, shadow: 400 },
      instances: 40, renderScale: 0.75, renderWidth: 960, renderHeight: 540, cpuMs: 1.2,
    };
    const stats = new FrameStats({ now: () => 0, heap: () => null });
    stats.connect({ kernel: () => fakeKernel(), render: () => render });
    expect(stats.snapshot().render).toBe(render);
    expect(stats.snapshot().memory.supported).toBe(false);
  });

  it('moves the probe to a replaced kernel on the next tick', () => {
    let current = fakeKernel();
    const first = current;
    const stats = new FrameStats({ now: () => 0, heap: () => null });
    stats.connect({ kernel: () => current, render: () => null });
    stats.enable();
    current = fakeKernel();
    stats.tick();
    expect(first.probe).toBeNull();
    expect(current.probe).toBe(stats);
  });

  it('times a real kernel\'s frames', () => {
    const text: Record<string, string> = { 'scenes/main/scene.json': JSON.stringify({ entities: [] }) };
    const project = loadProject({ list: () => Object.keys(text), read: (p) => text[p]! });
    const kernel = new Kernel({
      project, plugins: [],
      game: { components: [], resources: [], events: [], behaviors: [], systems: [{ id: 'clock', scenes: [], handlers: [], create: () => ({ update: () => {} }) }] },
    });
    let clock = 0;
    const stats = new FrameStats({ now: () => (clock += 1), heap: () => null });
    stats.connect({ kernel: () => kernel, render: () => null });
    stats.enable();
    kernel.start('main');
    for (let i = 0; i < 3; i++) { stats.tick(); kernel.step(1 / 60); }
    const snap = stats.snapshot();
    expect(snap.cpuMsHistory).toHaveLength(3);
    expect(snap.scripts.find((s) => s.name === 'clock')).toMatchObject({ kind: 'system', callsPerFrame: 1 });
    expect(snap.phases.map((p) => p.name)).toEqual([...FRAME_PHASES]);
  });
});

describe('distribution and budgetOf', () => {
  it('summarizes in arrival order', () => {
    expect(distribution([])).toEqual({ avg: 0, min: 0, max: 0, p95: 0, last: 0 });
    const values = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(distribution(values)).toMatchObject({ avg: 50.5, min: 1, max: 100, p95: 96, last: 1 });
  });

  it('charges animation systems to Animation, not Scripts, and never goes negative', () => {
    const slices = budgetOf(phases({ update: 1, render: 0.5 }), [{ point: 'render', owner: 'models', avgMs: 2, maxMs: 2 }],
      [{ kind: 'system', name: 'visuals.animation', lastMs: 0.4, avgMs: 0.4, p95Ms: 0.4, maxMs: 0.4, callsPerFrame: 1 }]);
    const ms = Object.fromEntries(slices.map((s) => [s.bucket, s.ms]));
    expect(ms['Scripts']).toBeCloseTo(0.6);
    expect(ms['Animation']).toBeCloseTo(0.9);
    expect(ms['Rendering']).toBe(0);
  });
});
