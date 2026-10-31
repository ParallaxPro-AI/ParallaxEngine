import { describe, expect, it } from 'vitest';
import { kw, ParallaxError } from '../core/index.js';
import { Kernel } from '../function/kernel/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { loadProject } from '../resource/index.js';
import type { GameRuntime } from './runtime.js';
import { Time, timeRampPlugin } from './time.js';

function make(plugins: KernelPlugin[] = [timeRampPlugin()]): { kernel: Kernel; time: Time } {
  const project = loadProject({ list: () => ['scenes/main/scene.json'], read: () => JSON.stringify({ entities: [] }) });
  const kernel = new Kernel({ project, plugins, context: {}, game: { components: [], resources: [], events: [], behaviors: [], systems: [] } });
  kernel.start('main');
  // Time reads only the kernel for ramps.
  return { kernel, time: new Time({ kernel } as unknown as GameRuntime) };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

describe('ctx.time.ramp', () => {
  it('eases the scale over real seconds and lands exactly, even into a freeze', () => {
    const { kernel, time } = make();
    const handle = time.ramp(0, 0.5, kw({ ease: 'linear' }));
    expect(handle.active).toBe(true);
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      kernel.step(1 / 60);
      seen.push(kernel.time.scale);
    }
    expect(seen[14]).toBeCloseTo(0.5, 6);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
    expect(seen[29]).toBe(0);
    expect(handle.active).toBe(false);
    // Game time stopped once the scale reached 0.
    const now = kernel.time.now;
    kernel.step(1 / 60);
    expect(kernel.time.now).toBe(now);
  });

  it('a new ramp replaces the running one from where it is; setting scale cancels it', () => {
    const { kernel, time } = make();
    const first = time.ramp(0.2, 1);
    for (let i = 0; i < 30; i++) kernel.step(1 / 60);
    const mid = kernel.time.scale;
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(1);
    const second = time.ramp(2, 1);
    expect(first.active).toBe(false);
    kernel.step(1 / 60);
    expect(kernel.time.scale).toBeGreaterThan(mid - 1e-9);
    time.scale = 1;
    expect(second.active).toBe(false);
    kernel.step(1 / 60);
    expect(kernel.time.scale).toBe(1);
  });

  it('rides in snapshots: a restored ramp continues exactly', () => {
    const { kernel, time } = make();
    time.ramp(0.25, 1, kw({ ease: 'out_cubic' }));
    for (let i = 0; i < 20; i++) kernel.step(1 / 60);
    const snap = kernel.snapshot();
    const after: number[] = [];
    for (let i = 0; i < 20; i++) { kernel.step(1 / 60); after.push(kernel.time.scale); }
    kernel.restore(snap);
    const again: number[] = [];
    for (let i = 0; i < 20; i++) { kernel.step(1 / 60); again.push(kernel.time.scale); }
    expect(again).toEqual(after);
  });

  it('checks its arguments, and says when the runtime has no ramp', () => {
    const { time } = make();
    expect(code(() => time.ramp(-1, 1))).toBe('PP3036');
    expect(code(() => time.ramp(1, -1))).toBe('PP3036');
    expect(code(() => time.ramp(1, 1, 'wobbly'))).toBe('PP3033');
    expect(code(() => make([]).time.ramp(1, 1))).toBe('PP9036');
  });
});
