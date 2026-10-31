/**
 * Frame probes: how long each part of a frame took, for profilers (the editor's profiler
 * panel, budget asserts in tests). Off by default — a kernel without a probe measures
 * nothing. With one (`kernel.setProbe`), every `step` ends by handing the probe one
 * `FrameSample`:
 *
 *   phases   wall milliseconds per frame phase (events delivered and entities torn down
 *            at a phase's end count toward that phase)
 *   units    per system / behavior definition: milliseconds and calls of its hooks and
 *            event handlers this frame (all entities of one behavior summed)
 *   hooks    per plugin hook: the hook point, the plugin that added it, milliseconds
 *
 * The clock is the probe's (`now()`, milliseconds): the kernel never reads a platform clock.
 */

/** The parts of a frame, in the order they run. */
export const FRAME_PHASES = [
  'input', 'fixed_update', 'physics', 'timers', 'update', 'late_update', 'ui', 'render', 'scene_load', 'after_frame',
] as const;
export type FramePhase = (typeof FRAME_PHASES)[number];

export interface UnitSample {
  readonly kind: 'system' | 'behavior';
  /** The system's or behavior's id. */
  readonly id: string;
  readonly ms: number;
  /** Hook and handler calls this frame. */
  readonly calls: number;
}

export interface HookSample {
  readonly point: 'input' | 'physics' | 'ui' | 'render' | 'after_frame';
  /** The plugin that added the hook (`addHook(..., { owner })`, else the plugin installing then, else "host"). */
  readonly owner: string;
  readonly ms: number;
}

export interface FrameSample {
  readonly frame: number;
  /** Wall milliseconds of the whole step, `afterFrame` included. */
  readonly totalMs: number;
  readonly phases: Readonly<Record<FramePhase, number>>;
  /** Fixed steps run this frame. */
  readonly fixedSteps: number;
  /** False while the kernel's logic is off (edit mode, paused): only input, ui and render ran. */
  readonly logic: boolean;
  readonly units: readonly UnitSample[];
  readonly hooks: readonly HookSample[];
}

export interface KernelProbe {
  /** Milliseconds on any monotonic clock. */
  now(): number;
  /** One finished frame. The sample is the probe's to keep. */
  frame(sample: FrameSample): void;
}

function zeroPhases(): Record<FramePhase, number> {
  return Object.fromEntries(FRAME_PHASES.map((p) => [p, 0])) as Record<FramePhase, number>;
}

/** Collects one frame for a probe (the kernel's side). */
export class FrameRecorder {
  readonly probe: KernelProbe;
  #phases = zeroPhases();
  #units = new Map<string, { kind: 'system' | 'behavior'; id: string; ms: number; calls: number }>();
  #hooks: HookSample[] = [];
  #begin = 0;
  #lap = 0;

  constructor(probe: KernelProbe) {
    this.probe = probe;
  }

  now(): number {
    return this.probe.now();
  }

  begin(): void {
    this.#phases = zeroPhases();
    this.#units = new Map();
    this.#hooks = [];
    this.#begin = this.#lap = this.probe.now();
  }

  /** Charge the time since the last lap to `phase`. */
  lap(phase: FramePhase): void {
    const now = this.probe.now();
    this.#phases[phase] += now - this.#lap;
    this.#lap = now;
  }

  unit(kind: 'system' | 'behavior', id: string, ms: number): void {
    const key = `${kind}:${id}`;
    const entry = this.#units.get(key);
    if (entry === undefined) this.#units.set(key, { kind, id, ms, calls: 1 });
    else { entry.ms += ms; entry.calls++; }
  }

  hook(point: HookSample['point'], owner: string, ms: number): void {
    this.#hooks.push({ point, owner, ms });
  }

  finish(frame: number, fixedSteps: number, logic: boolean): void {
    const now = this.probe.now();
    this.probe.frame({
      frame,
      totalMs: now - this.#begin,
      phases: this.#phases,
      fixedSteps,
      logic,
      units: [...this.#units.values()],
      hooks: this.#hooks,
    });
  }
}
