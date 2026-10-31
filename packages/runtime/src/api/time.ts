/**
 * Time, timers, tasks and tweens (SDK `Time`, `Task`, `Handle`, `ctx.tween`). Every
 * timer, task and tween belongs to whoever started it — the behavior's entity, the
 * system, or the game — and is cancelled with it (kernel `Owner`).
 */

import { fail } from '../core/index.js';
import { waits } from '../function/kernel/index.js';
import type { Handle as KernelHandle, Kernel, KernelPlugin, TaskBody, Wait } from '../function/kernel/index.js';
import type { Json, JsonObject } from '../resource/index.js';
import { eventDefOf } from './declarations.js';
import { bindArgs } from './kwargs.js';
import { easing } from './math.js';
import { truthy } from './py.js';
import type { GameRuntime } from './runtime.js';

/** A timer, tween or task. */
export class Handle {
  /** A field type for resources and state() that is never saved (types.ts `live`). */
  static readonly __live__ = true;
  readonly #inner: KernelHandle;

  constructor(inner: KernelHandle) {
    this.#inner = inner;
  }

  cancel(): void { this.#inner.cancel(); }
  get active(): boolean { return this.#inner.active; }
  /** `await handle.wait()` inside a task. */
  wait(): Wait { return waits.all(this.#inner); }
}

function inner(handles: readonly unknown[], where: string): KernelHandle[] {
  return handles.map((h) => {
    if (!(h instanceof Handle)) fail('PP3035', `${where} takes handles (from tweens, timers or ctx.run), got ${String(h)}`);
    return h;
  });
}

/** The handle passed to a task: `await task.seconds(1)` → `yield task.seconds(1)`. */
export class Task {
  readonly #rt: GameRuntime;

  constructor(rt: GameRuntime) {
    this.#rt = rt;
  }

  seconds(s: number): Wait { return waits.seconds(s); }
  frames(n: number): Wait { return waits.frames(n); }

  until(eventType: unknown, where?: ((event: unknown) => unknown) | null): Wait {
    const def = eventDefOf(eventType, 'task.until');
    if (where === undefined || where === null) return waits.event(def);
    return waits.event(def, (payload) => truthy(where(this.#rt.payload(def, payload))));
  }

  until_true(condition: () => unknown): Wait { return waits.condition(() => truthy(condition())); }
  all(...handles: unknown[]): Wait { return waits.all(...inner(handles, 'task.all')); }
  any(...handles: unknown[]): Wait { return waits.any(...inner(handles, 'task.any')); }
}

export class Time {
  readonly #rt: GameRuntime;

  constructor(rt: GameRuntime) {
    this.#rt = rt;
  }

  get dt(): number { return this.#rt.kernel.time.dt; }
  get now(): number { return this.#rt.kernel.time.now; }
  get scene_time(): number { const t = this.#rt.kernel.time; return t.now - t.sceneStart; }
  get real_now(): number { return this.#rt.kernel.time.realNow; }
  get frame(): number { return this.#rt.kernel.time.frame; }
  get frozen(): boolean { return this.#rt.kernel.time.frozen; }
  get scale(): number { return this.#rt.kernel.time.scale; }
  set scale(value: number) {
    if (typeof value !== 'number' || !(value >= 0)) fail('PP3036', `time.scale must be a number >= 0, got ${String(value)}`);
    // Setting the scale outright ends a ramp under way: the last word wins.
    RAMPS.get(this.#rt.kernel)?.cancel();
    this.#rt.kernel.time.scale = value;
  }

  /**
   * `ramp(scale, seconds, ease="in_out_quad")`: ease the time scale from where it is to
   * `scale` over `seconds` of REAL time (so a ramp into a freeze finishes). A new ramp
   * replaces one under way; assigning `scale` cancels it. Saved in snapshots.
   */
  ramp(...args: unknown[]): Handle {
    const a = bindArgs('ramp', args, { positional: ['scale', 'seconds', 'ease'], required: ['scale', 'seconds'] }).args;
    const scale = a['scale'];
    const seconds = a['seconds'];
    if (typeof scale !== 'number' || !(scale >= 0) || !Number.isFinite(scale)) fail('PP3036', `time.ramp() scale must be a number >= 0, got ${String(scale)}`);
    if (typeof seconds !== 'number' || !(seconds >= 0) || !Number.isFinite(seconds)) fail('PP3036', `time.ramp() seconds must be a number >= 0, got ${String(seconds)}`);
    const ease = a['ease'] ?? 'in_out_quad';
    easing(ease);
    const ramp = RAMPS.get(this.#rt.kernel);
    if (ramp === undefined) {
      fail('PP9036', 'time.ramp() needs the engine\'s time ramp (timeRampPlugin), which this runtime did not install', {
        fix: 'Run the game on an engine build whose runtime installs timeRampPlugin() (api/time.ts).',
      });
    }
    return new Handle(ramp.start(this.#rt.kernel, scale, seconds, ease as string));
  }

  after(seconds: number, fn: () => void): Handle {
    return new Handle(this.#rt.kernel.after(this.#rt.owner, seconds, this.#rt.owned(fn)));
  }

  every(seconds: number, fn: () => void): Handle {
    return new Handle(this.#rt.kernel.every(this.#rt.owner, seconds, this.#rt.owned(fn)));
  }

  /** Freeze the simulation for `seconds` of real time. */
  hitstop(seconds: number): void {
    if (typeof seconds !== 'number' || !(seconds >= 0)) fail('PP3036', `hitstop() needs seconds >= 0, got ${String(seconds)}`);
    this.#rt.hitstop(seconds);
  }
}

// ── Time-scale ramps ───────────────────────────────────────────────────────────

interface RampState {
  readonly from: number;
  readonly to: number;
  /** Real time it began, and its length in real seconds. */
  readonly start: number;
  readonly seconds: number;
  readonly ease: string;
  /** Increases with every ramp, so a handle knows whether it is still the one running. */
  readonly serial: number;
}

/** The ramp each kernel runs, found by `ctx.time.ramp` (installed by `timeRampPlugin`). */
const RAMPS = new WeakMap<Kernel, TimeRamp>();

/**
 * The time scale eased toward a target over real seconds. Driven from the kernel's 'input'
 * hook, it sets `time.scale` for the frame's fixed steps; a frame's game time is
 * `real dt × scale` with the scale the previous frame's hook left (the kernel scales dt
 * before any hook runs).
 */
export class TimeRamp {
  #state: RampState | null = null;
  #serial = 0;

  get active(): boolean { return this.#state !== null; }

  start(kernel: Kernel, to: number, seconds: number, ease: string): KernelHandle {
    const serial = ++this.#serial;
    this.#state = { from: kernel.time.scale, to, start: kernel.time.realNow, seconds, ease, serial };
    if (seconds === 0) this.step(kernel);
    const ramp = this;
    return {
      cancel: () => { if (ramp.#state?.serial === serial) ramp.#state = null; },
      get active() { return ramp.#state?.serial === serial; },
    };
  }

  cancel(): void {
    this.#state = null;
  }

  /** Set the scale for now; the ramp ends when its time is up. */
  step(kernel: Kernel): void {
    const s = this.#state;
    if (s === null) return;
    // Frame times summing to the ramp's length finish it on that frame (as tweens do).
    const k = s.seconds <= 0 ? 1 : Math.min(1, (kernel.time.realNow - s.start + 1e-9) / s.seconds);
    kernel.time.scale = k >= 1 ? s.to : s.from + (s.to - s.from) * easing(s.ease)(k);
    if (k >= 1) this.#state = null;
  }

  snapshot(): Json {
    const s = this.#state;
    return s === null ? null : { ...s };
  }

  restore(state: Json): void {
    this.#state = state === null ? null : (state as JsonObject as unknown as RampState);
    if (this.#state !== null) this.#serial = Math.max(this.#serial, this.#state.serial);
  }
}

/** The kernel plugin behind `ctx.time.ramp`: the runtime lists it with its own plugins. */
export function timeRampPlugin(): KernelPlugin & { readonly ramp: TimeRamp } {
  const ramp = new TimeRamp();
  return {
    id: 'time_ramp',
    ramp,
    install(kernel) {
      RAMPS.set(kernel, ramp);
      kernel.addHook('input', () => ramp.step(kernel));
    },
    snapshot: () => ramp.snapshot(),
    restore: (_kernel, state) => ramp.restore(state),
  };
}

/** Float frame times summing to a tween's length must finish it on that frame. */
const DUE_TOLERANCE = 1e-9;

/** Interpolate floats, or anything with `.lerp(o, t)` (Vec2, Vec3, Color). */
function interpolate(start: unknown, end: unknown, t: number): unknown {
  if (typeof start === 'number' && typeof end === 'number') return start + (end - start) * t;
  if (typeof start === 'object' && start !== null && typeof (start as { lerp?: unknown }).lerp === 'function') {
    return (start as { lerp(o: unknown, t: number): unknown }).lerp(end, t);
  }
  return fail('PP3037', `Can't tween ${String(start)}`, { fix: 'Tween a float, Vec2, Vec3 or Color.' });
}

/** A tween owned by the current owner, updated once per frame (before `update`). */
export function startTween(
  rt: GameRuntime, start: unknown, end: unknown, seconds: number, apply: (value: unknown) => void, ease: unknown,
): Handle {
  const curve = easing(ease);
  interpolate(start, end, 0);
  const owner = rt.owner;
  const time = rt.kernel.time;
  const body = function* (): TaskBody {
    const began = time.now;
    if (!(seconds > 0)) { apply(end); return; }
    apply(start);
    for (;;) {
      yield waits.frames(1);
      const t = Math.min(1, (time.now - began + DUE_TOLERANCE) / seconds);
      apply(t >= 1 ? end : interpolate(start, end, curve(t)));
      if (t >= 1) return;
    }
  };
  return new Handle(rt.kernel.run(owner, rt.ownedTask(owner, body())));
}

/** `ctx.tween(start, end, seconds, on_update, ease="linear")`. */
export function tween(rt: GameRuntime, args: readonly unknown[]): Handle {
  const a = bindArgs('tween', args, {
    positional: ['start', 'end', 'seconds', 'on_update'], keyword: ['ease'], required: ['start', 'end', 'seconds', 'on_update'],
  }).args;
  const onUpdate = a['on_update'];
  if (typeof onUpdate !== 'function') fail('PP3037', 'tween() on_update must be a function');
  return startTween(rt, a['start'], a['end'], a['seconds'] as number, (v) => { (onUpdate as (v: unknown) => void)(v); }, a['ease'] ?? 'linear');
}
