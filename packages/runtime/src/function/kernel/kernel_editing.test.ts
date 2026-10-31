/**
 * The kernel hooks hosts use to edit and profile a game: logic off (edit mode, pause),
 * `loadScene`, `settle`, `replaceProject`, frame probes, plugin hook owners and `dispose`.
 */

import { describe, expect, it } from 'vitest';
import { Vec3 } from '../../core/index.js';
import type { ProjectFiles } from '../../core/index.js';
import { loadProject } from '../../resource/index.js';
import type { BehaviorDef, EventDef, GameDefinition, KernelPlugin, LogicInstance, SystemDef } from './definitions.js';
import { Kernel, KERNEL_EVENTS } from './kernel.js';
import type { FrameSample } from './probe.js';
import { t } from './schema.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const PING: EventDef = { id: 'ping' };

function definitions(log: string[]): GameDefinition {
  const mover: BehaviorDef = {
    id: 'mover', params: { speed: t.number({ default: 1 }) }, state: {}, requires: [],
    handlers: [{ event: PING, method: 'pinged' }],
    create: () => ({
      start(this: LogicInstance) { log.push('mover.start'); },
      update(this: LogicInstance) { log.push('mover.update'); },
      end(this: LogicInstance) { log.push('mover.end'); },
      pinged() { log.push('mover.pinged'); },
    }),
  };
  const director: SystemDef = {
    id: 'director', scenes: [],
    handlers: [{ event: KERNEL_EVENTS.sceneLoaded, method: 'loaded' }],
    create: () => ({
      start: () => log.push('director.start'),
      update: () => log.push('director.update'),
      loaded: () => log.push('director.loaded'),
    }),
  };
  return {
    components: [{ id: 'size', schema: { value: t.number({ default: 1 }) } }],
    resources: [], events: [PING], behaviors: [mover], systems: [director],
  };
}

const DATA = {
  'prefabs/crate.prefab.json': { components: { size: { value: 2 } }, behaviors: { mover: {} } },
  'scenes/main/scene.json': { entities: [{ prefab: 'crate', id: 'a', at: [1, 0, 0] }, { prefab: 'crate', id: 'b' }] },
};

function build(log: string[], plugins: KernelPlugin[] = [], data: Record<string, unknown> = DATA): Kernel {
  const project = loadProject(files(data));
  expect(project.diagnostics).toEqual([]);
  return new Kernel({ project, game: definitions(log), plugins });
}

function renderPlugin(log: string[]): KernelPlugin {
  return {
    id: 'painter',
    install(kernel) {
      kernel.addHook('render', () => log.push('render'));
      kernel.addHook('physics', () => log.push('physics'));
    },
  };
}

describe('logic off (edit mode)', () => {
  it('loads a scene without starting anything and draws frames without running the game', () => {
    const log: string[] = [];
    const k = build(log, [renderPlugin(log)]);
    k.setLogic(false);
    k.start('main');
    expect(k.world.count).toBe(2);
    expect(log).toEqual([]);
    k.step(1 / 60);
    k.step(1 / 60);
    expect(log).toEqual(['render', 'render']);
    expect(k.time.now).toBe(0);
    expect(k.time.dt).toBe(0);
    expect(k.time.frame).toBe(2);
  });

  it('drops events and starts nothing it spawns', () => {
    const log: string[] = [];
    const k = build(log);
    k.setLogic(false);
    k.start('main');
    k.emit(PING, {});
    const crate = k.spawn('crate');
    k.step(1 / 60);
    expect(log).toEqual([]);
    expect(crate.behaviors[0]!.started).toBe(false);
  });

  it('enters play by loading the scene fresh: systems and behaviors start, scene_loaded is heard', () => {
    const log: string[] = [];
    const k = build(log);
    k.setLogic(false);
    k.start('main');
    const before = [...k.world.live()].map((r) => r.id);
    k.setLogic(true);
    k.loadScene('main', { seed: 4 });
    expect(log).toEqual(['director.start', 'mover.start', 'mover.start', 'director.loaded']);
    expect([...k.world.live()].map((r) => r.id)).not.toEqual(before);
    log.length = 0;
    k.step(1 / 60);
    expect(log).toEqual(['director.update', 'mover.update', 'mover.update']);
  });

  it('pauses mid-play: no updates, timers or physics while off; resumes where it was', () => {
    const log: string[] = [];
    const k = build(log, [renderPlugin(log)]);
    k.start('main');
    let fired = 0;
    k.after({ kind: 'game' }, 0.05, () => { fired++; });
    k.step(1 / 60);
    const now = k.time.now;
    log.length = 0;
    k.setLogic(false);
    for (let i = 0; i < 10; i++) k.step(1 / 60);
    expect(log.every((l) => l === 'render')).toBe(true);
    expect(k.time.now).toBe(now);
    expect(fired).toBe(0);
    k.setLogic(true);
    log.length = 0;
    k.step(1 / 60);
    expect(log).toContain('physics');
    expect(log).toContain('mover.update');
    for (let i = 0; i < 3; i++) k.step(1 / 60);
    expect(fired).toBe(1);
  });

  it('snapshots and restores an edit-mode world exactly (the editor restores it on stop)', () => {
    const log: string[] = [];
    const k = build(log);
    k.setLogic(false);
    k.start('main');
    const a = [...k.world.live()][0]!;
    a.transform.position = new Vec3(9, 9, 9);
    const snap = k.snapshot();
    k.setLogic(true);
    k.loadScene('main');
    for (let i = 0; i < 5; i++) k.step(1 / 60);
    k.setLogic(false);
    k.restore(snap);
    expect(k.world.get(a.id)?.transform.position.x).toBe(9);
    expect(k.world.count).toBe(2);
    expect(k.time.frame).toBe(snap.time.frame);
  });

  it('settles between frames: destroyed entities are torn down at once', () => {
    const log: string[] = [];
    const k = build(log);
    k.setLogic(false);
    k.start('main');
    const a = [...k.world.live()][0]!;
    k.destroy(a.id);
    expect(k.world.settled).toBe(false);
    k.settle();
    expect(k.world.settled).toBe(true);
    expect(k.world.peek(a.id)).toBeUndefined();
    expect(() => k.snapshot()).not.toThrow();
  });

  it('replaceProject: the next load builds from the new data', () => {
    const log: string[] = [];
    const k = build(log);
    k.setLogic(false);
    k.start('main');
    const changed = loadProject(files({
      ...DATA,
      'scenes/main/scene.json': { entities: [{ prefab: 'crate', id: 'a', at: [5, 0, 0] }] },
    }));
    k.replaceProject(changed);
    expect(k.world.count).toBe(2);
    k.loadScene('main');
    expect(k.world.count).toBe(1);
    expect([...k.world.live()][0]!.transform.position.x).toBe(5);
    expect(k.project).toBe(changed);
  });
});

describe('frame probes', () => {
  it('times phases, units by definition and hooks by owning plugin', () => {
    const log: string[] = [];
    const k = build(log, [renderPlugin(log)]);
    k.addHook('input', () => {}, { owner: 'editor' });
    k.addHook('ui', () => {});
    let clock = 0;
    const samples: FrameSample[] = [];
    k.setProbe({ now: () => (clock += 1), frame: (s) => samples.push(s) });
    k.start('main');
    k.step(1 / 60);
    expect(samples).toHaveLength(1);
    const s = samples[0]!;
    expect(s.frame).toBe(1);
    expect(s.logic).toBe(true);
    expect(s.fixedSteps).toBe(1);
    for (const phase of ['input', 'fixed_update', 'physics', 'timers', 'update', 'late_update', 'ui', 'render'] as const) {
      expect(s.phases[phase]).toBeGreaterThan(0);
    }
    const phaseSum = Object.values(s.phases).reduce((a, b) => a + b, 0);
    expect(phaseSum).toBeLessThanOrEqual(s.totalMs);
    expect(s.units.find((u) => u.id === 'mover')).toMatchObject({ kind: 'behavior', calls: 2 });
    expect(s.units.find((u) => u.id === 'director')).toMatchObject({ kind: 'system', calls: 1 });
    expect(s.hooks.map((h) => `${h.point}:${h.owner}`)).toEqual(['input:editor', 'physics:painter', 'ui:host', 'render:painter']);
  });

  it('marks frames run with logic off, and stops when the probe is removed', () => {
    const log: string[] = [];
    const k = build(log);
    const samples: FrameSample[] = [];
    k.setProbe({ now: () => 0, frame: (s) => samples.push(s) });
    k.setLogic(false);
    k.start('main');
    k.step(1 / 60);
    expect(samples[0]!.logic).toBe(false);
    expect(samples[0]!.units).toEqual([]);
    k.setProbe(null);
    k.step(1 / 60);
    expect(samples).toHaveLength(1);
  });

  it('charges a scene change at the end of a frame to scene_load', () => {
    const log: string[] = [];
    const k = build(log);
    let clock = 0;
    const samples: FrameSample[] = [];
    k.start('main');
    k.setProbe({ now: () => (clock += 1), frame: (s) => samples.push(s) });
    k.requestScene('main');
    k.step(1 / 60);
    expect(samples[0]!.phases.scene_load).toBeGreaterThan(0);
    expect(samples[0]!.units.find((u) => u.id === 'director')!.calls).toBe(3);
  });
});

describe('dispose', () => {
  it('calls plugin dispose last-installed first, once, and refuses to step afterwards', () => {
    const log: string[] = [];
    const plugin = (id: string): KernelPlugin => ({ id, dispose: () => log.push(`dispose ${id}`) });
    const k = build([], [plugin('first'), plugin('second')]);
    k.start('main');
    k.dispose();
    k.dispose();
    expect(log).toEqual(['dispose second', 'dispose first']);
    let code: string | undefined;
    try { k.step(1 / 60); } catch (e) { code = (e as { diagnostic?: { code: string } }).diagnostic?.code; }
    expect(code).toBe('PP9007');
  });
});
