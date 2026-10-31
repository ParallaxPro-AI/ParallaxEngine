/**
 * The spawning plugin on a bare kernel: waves in order under `max_alive`, count and budget
 * waves, clearing, and the wave events.
 */

import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields, SystemDef } from '../../kernel/index.js';
import { SPAWNING_EVENTS, spawning } from './index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

function rig(spawner: Record<string, unknown>) {
  const heard: string[] = [];
  let kernelRef: Kernel | undefined;
  const events = Object.values(SPAWNING_EVENTS);
  const listener: SystemDef = {
    id: 'listen', scenes: [],
    handlers: events.map((event) => ({ event, method: event.id })),
    create: () => Object.fromEntries(events.map((event) => [event.id, (_ctx: unknown, e: Fields) => {
      const who = kernelRef!.world.peek(e['entity'] as EntityId)?.placedId ?? String(e['entity']);
      heard.push(`${event.id} ${who}${e['wave'] === undefined ? '' : ` wave=${String(e['wave'])}`}`);
    }])),
  };
  const project = loadProject(files({
    'prefabs/thing.prefab.json': { components: {} },
    'prefabs/grunt.prefab.json': { components: {} },
    'scenes/main/scene.json': { entities: [{ prefab: 'thing', id: 'sp', at: [10, 0, 0], components: { spawner } }] },
  }));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({ project, game: { components: [], events: [], behaviors: [], systems: [listener], resources: [] }, plugins: [spawning()] });
  kernelRef = kernel;
  kernel.start('main', { seed: 7 });
  const id = kernel.world.query([]).find(([x]) => kernel.world.get(x)?.placedId === 'sp')![0];
  return {
    kernel, heard,
    sp: kernel.world.get(id)!.components.get('spawner')! as Fields & { alive_count?: number },
    step(frames = 1) { for (let i = 0; i < frames; i++) kernel.step(DT); },
    grunts(): EntityId[] {
      return kernel.world.query([]).filter(([x]) => kernel.world.get(x)!.prefab === 'grunt').map(([x]) => x);
    },
  };
}

describe('spawners', () => {
  it('runs waves in order under the alive budget, clears them, and finishes', () => {
    const r = rig({
      prefabs: [{ prefab: 'grunt' }], waves: [{ count: 3, interval: 0.1 }, { budget: 5, interval: 0 }], max_alive: 2,
      points: [[1, 0, 0], [-1, 0, 0]], between_waves: 0.5,
    });
    r.step(30);
    expect(r.sp['spawned']).toBe(2);
    expect(r.sp.alive_count).toBe(2);
    expect(r.grunts().map((id) => r.kernel.world.get(id)!.transform.position.x)).toEqual([11, 9]);
    for (const id of r.grunts()) r.kernel.destroy(id);
    r.step(10);
    expect(r.sp['spawned']).toBe(3);
    for (const id of r.grunts()) r.kernel.destroy(id);
    r.step(2);
    expect(r.heard).toContain('wave_cleared sp wave=0');
    r.step(40);
    expect(r.heard).toContain('wave_started sp wave=1');
    // Budget 5, cost 1 each, two alive at a time.
    for (let i = 0; i < 5; i++) {
      for (const id of r.grunts()) r.kernel.destroy(id);
      r.step(2);
    }
    expect(r.sp['spent']).toBe(5);
    expect(r.heard).toContain('spawner_done sp');
  });

  it('a wave with neither a count nor a budget is an error', () => {
    const r = rig({ prefabs: [{ prefab: 'grunt' }], waves: [{ interval: 0.1 }] });
    expect(code(() => r.step())).toBe('PP7700');
  });
});
