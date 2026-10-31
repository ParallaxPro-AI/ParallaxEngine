/**
 * Frame stats: what a profiler panel shows about a running game. Wall time between frames
 * (fps, the frame-time chart), the kernel's own timings (per phase, per system / behavior,
 * per plugin hook: `KernelProbe`, probe.ts), and what the last frame drew (draw calls and
 * triangles by pass, from the renderer).
 *
 * Off until someone holds it on (`enable(consumer)`); the loop's `tick()` is then the only
 * cost while nobody watches: one boolean test per frame. While on, the kernel is probed (the
 * probe follows the runtime across hot reloads: the source is read every frame) and the last
 * `window` frames are kept. `snapshot()` aggregates the window; call it at a panel's rate
 * (a few times a second), never per frame.
 *
 * A kernel has one probe: while these stats are on they own it (the editor session's
 * `Profiler` attached to the same kernel would be detached, and the other way round).
 */

import type { FramePhase, FrameSample, Kernel, KernelProbe } from '../function/kernel/index.js';
import { FRAME_PHASES } from '../function/kernel/index.js';
import type { DrawCounts } from '../platform/index.js';

/** What the stats read from the running game. */
export interface FrameStatsSource {
  /** The kernel to time now (re-read every frame: a hot reload replaces it). */
  kernel(): Kernel;
  /** The renderer and what its last frame drew, or null before it drew (or with no renderer). */
  render(): RenderStats | null;
}

export interface RenderStats {
  readonly backend: 'webgpu' | 'webgl2' | 'canvas2d';
  readonly drawCalls: number;
  /** Null where the renderer has no triangles to count (2D canvas). */
  readonly triangles: number | null;
  readonly drawCallsByPass: Readonly<Record<string, number>>;
  readonly trianglesByPass: Readonly<Record<string, number>>;
  /** Mesh instances drawn (a batch of 40 trees: 40). */
  readonly instances: number;
  /** Dynamic resolution: per-axis scale of the canvas, and the size drawn at. */
  readonly renderScale: number;
  readonly renderWidth: number;
  readonly renderHeight: number;
  /** Milliseconds the renderer spent planning and recording the last frame (inside the render phase). */
  readonly cpuMs: number;
}

export interface Distribution {
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly p95: number;
  readonly last: number;
}

export interface PhaseStat {
  readonly name: FramePhase;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly p95Ms: number;
  /** Share of the kernel's frame (0..1). */
  readonly pct: number;
}

export interface UnitStat {
  readonly kind: 'system' | 'behavior';
  readonly name: string;
  /** The last frame's milliseconds. */
  readonly lastMs: number;
  /** Per frame over the window (frames it didn't run in count as 0). */
  readonly avgMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly callsPerFrame: number;
}

export interface HookStat {
  readonly point: string;
  readonly owner: string;
  readonly avgMs: number;
  readonly maxMs: number;
}

export type BudgetBucket = 'Scripts' | 'Physics' | 'Animation' | 'Rendering' | 'Other';
export const BUDGET_BUCKETS: readonly BudgetBucket[] = ['Scripts', 'Physics', 'Animation', 'Rendering', 'Other'];

export interface BudgetSlice {
  readonly bucket: BudgetBucket;
  /** Milliseconds per frame, averaged over the window. */
  readonly ms: number;
  /** Share of the kernel's frame (0..1). */
  readonly pct: number;
}

export interface PerfSnapshot {
  /** Frames in the window (wall intervals). */
  readonly frames: number;
  /** Frames per second over the window (0 before two frames). */
  readonly fps: number;
  /** Wall milliseconds between frames: what the player sees. */
  readonly frameMs: Distribution;
  /** Oldest first. */
  readonly frameMsHistory: readonly number[];
  /** Milliseconds the kernel's step took (everything the engine does in a frame). */
  readonly cpuMs: Distribution;
  readonly cpuMsHistory: readonly number[];
  /** Kernel phases, in frame order. */
  readonly phases: readonly PhaseStat[];
  /** The phases grouped into what an author can act on (`budgetOf`). */
  readonly budget: readonly BudgetSlice[];
  /** Systems and behaviors (every entity of one behavior summed), most expensive first. */
  readonly scripts: readonly UnitStat[];
  /** Plugin hooks, most expensive first. */
  readonly hooks: readonly HookStat[];
  readonly fixedStepsPerFrame: number;
  /** False while the kernel's logic is off (edit mode, paused). */
  readonly logic: boolean;
  readonly render: RenderStats | null;
  readonly counts: { readonly entities: number; readonly behaviors: number };
  /** The JS heap where the platform reports one (Chromium); history: one reading per snapshot, oldest first. */
  readonly memory: { readonly supported: boolean; readonly usedMB: number; readonly totalMB: number; readonly historyMB: readonly number[] };
}

export interface FrameStatsOptions {
  /** Milliseconds on a monotonic clock; default `performance.now`. */
  readonly now?: () => number;
  /** Frames kept (default 120: two seconds at 60 fps). */
  readonly window?: number;
  /** JS heap bytes `{ used, total }`, or null where unknown. Default: Chromium's `performance.memory`. */
  readonly heap?: () => { readonly used: number; readonly total: number } | null;
}

/** A gap longer than this between frames is a pause (hidden page, breakpoint), not a frame. */
const PAUSE_MS = 5000;
const MB = 1024 * 1024;

function chromiumHeap(): { used: number; total: number } | null {
  const memory = (globalThis.performance as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } } | undefined)?.memory;
  return typeof memory?.usedJSHeapSize === 'number' ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize ?? memory.usedJSHeapSize } : null;
}

/** avg / min / max / p95 / last of values in arrival order. */
export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { avg: 0, min: 0, max: 0, p95: 0, last: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]!,
    last: values[values.length - 1]!,
  };
}

/**
 * The window's average frame grouped into five buckets: Scripts (game systems and behaviors:
 * fixed_update, timers and tasks, update, late_update), Physics (the physics phase), Animation
 * (model posing, the `models` plugin's render hook, and animation systems), Rendering (the rest
 * of the render phase) and Other (input, ui, scene loads, after-frame hooks).
 */
export function budgetOf(phases: Readonly<Record<FramePhase, number>>, hooks: readonly HookStat[], units: readonly UnitStat[]): BudgetSlice[] {
  const posing = hooks.filter((h) => h.point === 'render' && h.owner === 'models').reduce((a, h) => a + h.avgMs, 0);
  const animUnits = units.filter((u) => u.kind === 'system' && /anim/i.test(u.name)).reduce((a, u) => a + u.avgMs, 0);
  const scripts = phases.fixed_update + phases.timers + phases.update + phases.late_update;
  const ms: Record<BudgetBucket, number> = {
    Scripts: Math.max(0, scripts - animUnits),
    Physics: phases.physics,
    Animation: Math.min(posing, phases.render) + Math.min(animUnits, scripts),
    Rendering: Math.max(0, phases.render - posing),
    Other: phases.input + phases.ui + phases.scene_load + phases.after_frame,
  };
  const total = BUDGET_BUCKETS.reduce((a, b) => a + ms[b], 0);
  return BUDGET_BUCKETS.map((bucket) => ({ bucket, ms: ms[bucket], pct: total > 0 ? ms[bucket] / total : 0 }));
}

export class FrameStats implements KernelProbe {
  readonly #now: () => number;
  readonly #window: number;
  readonly #heap: () => { readonly used: number; readonly total: number } | null;
  readonly #consumers = new Set<string>();
  #source: FrameStatsSource | null = null;
  #kernel: Kernel | null = null;
  #lastTick: number | null = null;
  readonly #intervals: number[] = [];
  readonly #samples: FrameSample[] = [];
  readonly #heapHistory: number[] = [];

  constructor(options: FrameStatsOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#window = Math.max(2, options.window ?? 120);
    this.#heap = options.heap ?? chromiumHeap;
  }

  /** What to measure (the host: `bootBrowser` connects its loop's runtime and renderer). */
  connect(source: FrameStatsSource): void {
    this.#source = source;
    if (this.enabled) this.#follow();
  }

  get enabled(): boolean {
    return this.#consumers.size > 0;
  }

  /** Hold the stats on for `consumer` (a panel); they stay on until every consumer lets go. */
  enable(consumer = 'default'): void {
    const was = this.enabled;
    this.#consumers.add(consumer);
    if (!was) this.#follow();
  }

  disable(consumer = 'default'): void {
    if (!this.#consumers.delete(consumer) || this.enabled) return;
    this.#kernel?.setProbe(null);
    this.#kernel = null;
    this.#lastTick = null;
    this.#intervals.length = 0;
    this.#samples.length = 0;
    this.#heapHistory.length = 0;
  }

  /** Once per displayed frame, before the game steps (the loop calls it). */
  tick(): void {
    if (this.#consumers.size === 0) return;
    const now = this.#now();
    if (this.#lastTick !== null) {
      const gap = now - this.#lastTick;
      if (gap > 0 && gap < PAUSE_MS) push(this.#intervals, gap, this.#window);
    }
    this.#lastTick = now;
    this.#follow();
  }

  // KernelProbe
  now(): number {
    return this.#now();
  }

  frame(sample: FrameSample): void {
    push(this.#samples, sample, this.#window);
  }

  /** The window aggregated. Allocates; call it at a panel's rate. */
  snapshot(): PerfSnapshot {
    const samples = this.#samples;
    const n = samples.length;
    const intervals = this.#intervals;
    const frameMs = distribution(intervals);
    const cpu = samples.map((s) => s.totalMs);
    const cpuMs = distribution(cpu);

    const phaseAvg = {} as Record<FramePhase, number>;
    const phases: PhaseStat[] = FRAME_PHASES.map((name) => {
      const d = distribution(samples.map((s) => s.phases[name]));
      phaseAvg[name] = d.avg;
      return { name, avgMs: d.avg, maxMs: d.max, p95Ms: d.p95, pct: cpuMs.avg > 0 ? d.avg / cpuMs.avg : 0 };
    });

    const units = new Map<string, { kind: 'system' | 'behavior'; name: string; perFrame: Float64Array; calls: number }>();
    samples.forEach((s, i) => {
      for (const u of s.units) {
        const key = `${u.kind}:${u.id}`;
        let e = units.get(key);
        if (e === undefined) { e = { kind: u.kind, name: u.id, perFrame: new Float64Array(n), calls: 0 }; units.set(key, e); }
        e.perFrame[i]! += u.ms;
        e.calls += u.calls;
      }
    });
    const scripts: UnitStat[] = [...units.values()].map((u) => {
      const d = distribution(Array.from(u.perFrame));
      return { kind: u.kind, name: u.name, lastMs: u.perFrame[n - 1] ?? 0, avgMs: d.avg, p95Ms: d.p95, maxMs: d.max, callsPerFrame: n === 0 ? 0 : u.calls / n };
    }).sort((a, b) => b.avgMs - a.avgMs);

    const hookTotals = new Map<string, { point: string; owner: string; total: number; max: number }>();
    for (const s of samples) {
      const perFrame = new Map<string, { point: string; owner: string; ms: number }>();
      for (const h of s.hooks) {
        const key = `${h.point}:${h.owner}`;
        const e = perFrame.get(key);
        if (e === undefined) perFrame.set(key, { point: h.point, owner: h.owner, ms: h.ms });
        else e.ms += h.ms;
      }
      for (const [key, h] of perFrame) {
        const e = hookTotals.get(key) ?? { point: h.point, owner: h.owner, total: 0, max: 0 };
        e.total += h.ms;
        e.max = Math.max(e.max, h.ms);
        hookTotals.set(key, e);
      }
    }
    const hooks: HookStat[] = [...hookTotals.values()]
      .map((h) => ({ point: h.point, owner: h.owner, avgMs: n === 0 ? 0 : h.total / n, maxMs: h.max }))
      .sort((a, b) => b.avgMs - a.avgMs);

    const heap = this.#heap();
    if (heap !== null) push(this.#heapHistory, heap.used / MB, this.#window);

    let entities = 0;
    let behaviors = 0;
    const kernel = this.#kernel ?? this.#source?.kernel() ?? null;
    if (kernel !== null) {
      for (const record of kernel.world.live()) { entities++; behaviors += record.behaviors.length; }
    }

    return {
      frames: intervals.length,
      fps: frameMs.avg > 0 ? Math.round(1000 / frameMs.avg) : 0,
      frameMs,
      frameMsHistory: [...intervals],
      cpuMs,
      cpuMsHistory: cpu,
      phases,
      budget: n === 0 ? [] : budgetOf(phaseAvg, hooks, scripts),
      scripts,
      hooks,
      fixedStepsPerFrame: n === 0 ? 0 : samples.reduce((a, s) => a + s.fixedSteps, 0) / n,
      logic: samples[n - 1]?.logic ?? false,
      render: this.#source?.render() ?? null,
      counts: { entities, behaviors },
      memory: heap === null
        ? { supported: false, usedMB: 0, totalMB: 0, historyMB: [] }
        : { supported: true, usedMB: heap.used / MB, totalMB: heap.total / MB, historyMB: [...this.#heapHistory] },
    };
  }

  /** Probe the source's current kernel (a hot reload swapped it: move the probe). */
  #follow(): void {
    const kernel = this.#source?.kernel() ?? null;
    if (kernel === this.#kernel) return;
    this.#kernel?.setProbe(null);
    this.#kernel = kernel;
    kernel?.setProbe(this);
  }
}

function push<T>(ring: T[], value: T, limit: number): void {
  ring.push(value);
  if (ring.length > limit) ring.splice(0, ring.length - limit);
}
