/**
 * Profiler feeds: the kernel's frame samples (per-phase times, per system / behavior CPU,
 * per plugin hook) kept in a rolling window, plus what the world holds (entity and
 * component counts) and what the last drawn frame costs (geometry, instances, textures,
 * draw batches). An editor panel subscribes to the stream; a test reads `stats()` and
 * asserts a budget (`checkBudget` / `assertBudget`, PP5020).
 *
 * Times are wall milliseconds on the clock given (`performance.now` by default), so
 * headless numbers are this machine's, not a phone's: budgets in tests guard against
 * regressions (a system that suddenly costs 10×), not absolute device frame rates.
 */

import { diagnostic, ParallaxError } from '@parallax/runtime/core';
import type { Diagnostic, Frame3d, Geometry3d } from '@parallax/runtime/core';
import { FRAME_PHASES } from '@parallax/runtime/kernel';
import type { FramePhase, FrameSample, Kernel, KernelProbe } from '@parallax/runtime/kernel';
import type { GameRuntime } from '@parallax/runtime/api';

export interface Summary {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface UnitStats {
  readonly kind: 'system' | 'behavior';
  readonly id: string;
  /** Milliseconds per frame (frames it didn't run in count as 0). */
  readonly meanMs: number;
  readonly maxMs: number;
  readonly callsPerFrame: number;
}

export interface HookStats {
  readonly point: string;
  readonly owner: string;
  readonly meanMs: number;
  readonly maxMs: number;
}

export interface ProfileStats {
  /** Frames in the window. */
  readonly frames: number;
  readonly frameMs: Summary;
  readonly phases: Readonly<Record<FramePhase, Summary>>;
  readonly fixedStepsPerFrame: number;
  /** Most expensive first. */
  readonly units: readonly UnitStats[];
  readonly hooks: readonly HookStats[];
}

export interface WorldCounts {
  readonly entities: number;
  /** Component id → entities with it. */
  readonly components: Readonly<Record<string, number>>;
  /** Prefab id → live instances (entities spawned without a prefab are not counted here). */
  readonly prefabs: Readonly<Record<string, number>>;
  /** Behavior id → live instances. */
  readonly behaviors: Readonly<Record<string, number>>;
}

/** Estimates from the last drawn frame (3D), and the JS heap where the platform reports one. */
export interface MemoryEstimate {
  /** Distinct geometries drawn and their vertex + index bytes (what a surface uploads once). */
  readonly geometries: number;
  readonly geometryBytes: number;
  /** Per-frame instance data (matrices, tints, bone palettes) bytes. */
  readonly instanceBytes: number;
  /** Distinct textures the drawn materials name. */
  readonly textures: number;
  /** Instanced and skinned draws (≈ draw calls before the surface's own batching). */
  readonly batches: number;
  readonly instances: number;
  /** Bytes of JS heap in use, or null where the platform doesn't say (only Chromium does). */
  readonly heapBytes: number | null;
}

export interface ProfilerOptions {
  /** Milliseconds; default `performance.now`. */
  readonly now?: () => number;
  /** Frames kept (default 300: five seconds at 60 fps). */
  readonly window?: number;
}

function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]! };
}

export class Profiler implements KernelProbe {
  readonly #now: () => number;
  readonly #window: number;
  readonly #samples: FrameSample[] = [];
  readonly #listeners = new Set<(sample: FrameSample) => void>();
  #kernel: Kernel | undefined;

  constructor(options: ProfilerOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#window = options.window ?? 300;
  }

  now(): number {
    return this.#now();
  }

  frame(sample: FrameSample): void {
    this.#samples.push(sample);
    if (this.#samples.length > this.#window) this.#samples.shift();
    for (const listener of this.#listeners) listener(sample);
  }

  /** Start sampling a kernel (one at a time: attaching elsewhere detaches here). */
  attach(kernel: Kernel): void {
    if (this.#kernel === kernel) return;
    this.#kernel?.setProbe(null);
    this.#kernel = kernel;
    kernel.setProbe(this);
  }

  detach(): void {
    this.#kernel?.setProbe(null);
    this.#kernel = undefined;
  }

  /** Every frame as it finishes (the editor's live panel). */
  subscribe(listener: (sample: FrameSample) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  get samples(): readonly FrameSample[] {
    return this.#samples;
  }

  clear(): void {
    this.#samples.length = 0;
  }

  /** The window summarized; `logicOnly` leaves out frames run with logic off (edit mode, paused). */
  stats(options: { readonly logicOnly?: boolean } = {}): ProfileStats {
    const samples = options.logicOnly === true ? this.#samples.filter((s) => s.logic) : this.#samples;
    const n = samples.length;
    const phases = Object.fromEntries(FRAME_PHASES.map((p) => [p, summarize(samples.map((s) => s.phases[p]))])) as Record<FramePhase, Summary>;
    const units = new Map<string, { kind: 'system' | 'behavior'; id: string; total: number; max: number; calls: number }>();
    const hooks = new Map<string, { point: string; owner: string; total: number; max: number }>();
    for (const s of samples) {
      for (const u of s.units) {
        const key = `${u.kind}:${u.id}`;
        const e = units.get(key) ?? { kind: u.kind, id: u.id, total: 0, max: 0, calls: 0 };
        e.total += u.ms; e.max = Math.max(e.max, u.ms); e.calls += u.calls;
        units.set(key, e);
      }
      const perFrame = new Map<string, { point: string; owner: string; ms: number }>();
      for (const h of s.hooks) {
        const key = `${h.point}:${h.owner}`;
        const e = perFrame.get(key) ?? { point: h.point, owner: h.owner, ms: 0 };
        e.ms += h.ms;
        perFrame.set(key, e);
      }
      for (const [key, h] of perFrame) {
        const e = hooks.get(key) ?? { point: h.point, owner: h.owner, total: 0, max: 0 };
        e.total += h.ms; e.max = Math.max(e.max, h.ms);
        hooks.set(key, e);
      }
    }
    const per = (v: number): number => (n === 0 ? 0 : v / n);
    return {
      frames: n,
      frameMs: summarize(samples.map((s) => s.totalMs)),
      phases,
      fixedStepsPerFrame: per(samples.reduce((a, s) => a + s.fixedSteps, 0)),
      units: [...units.values()].map((u) => ({ kind: u.kind, id: u.id, meanMs: per(u.total), maxMs: u.max, callsPerFrame: per(u.calls) }))
        .sort((a, b) => b.meanMs - a.meanMs),
      hooks: [...hooks.values()].map((h) => ({ point: h.point, owner: h.owner, meanMs: per(h.total), maxMs: h.max })).sort((a, b) => b.meanMs - a.meanMs),
    };
  }
}

/** What the world holds now. */
export function worldCounts(kernel: Kernel): WorldCounts {
  const components: Record<string, number> = {};
  const prefabs: Record<string, number> = {};
  const behaviors: Record<string, number> = {};
  let entities = 0;
  for (const record of kernel.world.live()) {
    entities++;
    for (const id of record.components.keys()) components[id] = (components[id] ?? 0) + 1;
    if (record.prefab !== undefined) prefabs[record.prefab] = (prefabs[record.prefab] ?? 0) + 1;
    for (const slot of record.behaviors) behaviors[slot.def.id] = (behaviors[slot.def.id] ?? 0) + 1;
  }
  return { entities, components, prefabs, behaviors };
}

function geometryBytes(g: Geometry3d): number {
  return g.positions.byteLength + g.normals.byteLength + g.uvs.byteLength + g.indices.byteLength
    + (g.joints?.byteLength ?? 0) + (g.weights?.byteLength ?? 0) + (g.colors?.byteLength ?? 0);
}

/** Memory estimates from a 3D frame (`runtime.render3d.lastFrame`) and the platform's heap reading. */
export function memoryEstimate(frame: Frame3d | undefined, heapBytes: number | null = chromiumHeap()): MemoryEstimate {
  const geometries = new Set<Geometry3d>();
  const textures = new Set<string>();
  let instanceBytes = 0;
  let batches = 0;
  let instances = 0;
  const material = (m: { baseColorTexture: { id: string } | null; metallicRoughnessTexture: { id: string } | null; emissiveTexture: { id: string } | null; normalTexture?: { id: string } | null; occlusionTexture?: { id: string } | null }): void => {
    for (const t of [m.baseColorTexture, m.metallicRoughnessTexture, m.emissiveTexture, m.normalTexture, m.occlusionTexture]) if (t != null) textures.add(t.id);
  };
  for (const batch of frame?.meshes ?? []) {
    geometries.add(batch.geometry);
    material(batch.material);
    instanceBytes += batch.instances.byteLength;
    batches++;
    instances += batch.count;
  }
  for (const draw of frame?.skinned ?? []) {
    geometries.add(draw.geometry);
    material(draw.material);
    instanceBytes += draw.palette.byteLength + 64;
    batches++;
    instances++;
  }
  for (const tile of frame?.terrain?.tiles ?? []) geometries.add(tile.geometry);
  let bytes = 0;
  for (const g of geometries) bytes += geometryBytes(g);
  return { geometries: geometries.size, geometryBytes: bytes, instanceBytes, textures: textures.size, batches, instances, heapBytes };
}

function chromiumHeap(): number | null {
  const memory = (globalThis.performance as { memory?: { usedJSHeapSize?: number } } | undefined)?.memory;
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null;
}

/** Memory estimate of a running game (3D: from its last frame; 2D: heap only). */
export function runtimeMemory(runtime: GameRuntime): MemoryEstimate {
  return memoryEstimate(runtime.render3d?.lastFrame);
}

// ── Budgets ────────────────────────────────────────────────────────────────────

export interface Limit {
  readonly mean?: number;
  readonly p95?: number;
  readonly max?: number;
}

export interface Budget {
  /** Whole-frame milliseconds. */
  readonly frameMs?: Limit;
  readonly phases?: Partial<Readonly<Record<FramePhase, Limit>>>;
  /** System or behavior id → mean milliseconds per frame at most. */
  readonly units?: Readonly<Record<string, number>>;
  readonly entities?: number;
  /** Component id → entities with it, at most. */
  readonly components?: Readonly<Record<string, number>>;
  readonly memory?: { readonly geometryBytes?: number; readonly instanceBytes?: number; readonly batches?: number; readonly heapBytes?: number };
}

export interface Measured {
  readonly stats?: ProfileStats;
  readonly counts?: WorldCounts;
  readonly memory?: MemoryEstimate;
}

function overLimit(out: Diagnostic[], what: string, summary: Summary, limit: Limit, unit: string): void {
  for (const key of ['mean', 'p95', 'max'] as const) {
    const cap = limit[key];
    if (cap !== undefined && summary[key] > cap) {
      out.push(diagnostic('PP5020', `${what} ${key} is ${summary[key].toFixed(2)} ${unit}, over the budget of ${cap} ${unit}`, {
        fix: 'Find the cost in the profiler (units and hooks, most expensive first), or raise the budget if the scene grew on purpose.',
      }));
    }
  }
}

/** Every budget the measurements exceed, as PP5020 diagnostics (empty: within budget). */
export function checkBudget(measured: Measured, budget: Budget): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { stats, counts, memory } = measured;
  if (stats !== undefined) {
    if (budget.frameMs !== undefined) overLimit(out, 'Frame time', stats.frameMs, budget.frameMs, 'ms');
    for (const [phase, limit] of Object.entries(budget.phases ?? {})) {
      overLimit(out, `The "${phase}" phase`, stats.phases[phase as FramePhase], limit!, 'ms');
    }
    for (const [id, cap] of Object.entries(budget.units ?? {})) {
      const unit = stats.units.find((u) => u.id === id);
      if (unit !== undefined && unit.meanMs > cap) {
        out.push(diagnostic('PP5020', `${unit.kind} "${id}" takes ${unit.meanMs.toFixed(3)} ms per frame, over the budget of ${cap} ms`, {
          fix: 'Do less per frame (tick="significance", hz(…), events instead of polling), or raise the budget.',
        }));
      }
    }
  }
  if (counts !== undefined) {
    if (budget.entities !== undefined && counts.entities > budget.entities) {
      out.push(diagnostic('PP5020', `${counts.entities} entities, over the budget of ${budget.entities}`, { fix: 'Pool, stream or merge entities, or raise the budget.' }));
    }
    for (const [id, cap] of Object.entries(budget.components ?? {})) {
      const n = counts.components[id] ?? 0;
      if (n > cap) out.push(diagnostic('PP5020', `${n} entities have "${id}", over the budget of ${cap}`, { fix: 'Use fewer of them, or raise the budget.' }));
    }
  }
  if (memory !== undefined) {
    for (const [key, cap] of Object.entries(budget.memory ?? {})) {
      const value = memory[key as keyof MemoryEstimate];
      if (typeof value === 'number' && cap !== undefined && value > cap) {
        out.push(diagnostic('PP5020', `${key} is ${value}, over the budget of ${cap}`, { fix: 'Share geometry, lower model detail or texture sizes, or raise the budget.' }));
      }
    }
  }
  return out;
}

/** Throw PP5020 (every violation in the message) when a budget is exceeded. */
export function assertBudget(measured: Measured, budget: Budget): void {
  const over = checkBudget(measured, budget);
  if (over.length === 0) return;
  throw new ParallaxError(diagnostic('PP5020', `Over budget:\n${over.map((d) => `  ${d.message}`).join('\n')}`, {
    fix: over[0]!.fix ?? 'Raise the budget, or make the frame cheaper.',
  }));
}
