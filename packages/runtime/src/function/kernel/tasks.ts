/**
 * Tasks: async sequences (`ctx.run(async def f(ctx, task))`). The transpiler turns a
 * Python `async def` into a generator and every `await task.x(...)` into a `yield` of a
 * `Wait`, so a task is resumed synchronously, inside the frame — deterministic in
 * headless tests and replays, where promise continuations would run after the step.
 *
 * Rules:
 *   - `run` executes the task immediately up to its first wait.
 *   - Waiting tasks resume once per frame, right after timers, in start order.
 *   - A wait satisfied this frame resumes this frame; a new wait is checked next frame.
 *   - Tasks are owned and cancelled with their owner; they don't advance while frozen.
 *   - Running tasks are not saved (SDK `Task` docs).
 */

import type { EventDef } from './definitions.js';
import type { Fields } from './schema.js';
import type { Handle, Owner } from './timers.js';

export type Wait =
  | { readonly kind: 'seconds'; readonly seconds: number }
  | { readonly kind: 'frames'; readonly frames: number }
  | { readonly kind: 'event'; readonly event: EventDef; readonly where?: (payload: Fields) => boolean }
  | { readonly kind: 'condition'; readonly test: () => boolean }
  | { readonly kind: 'all' | 'any'; readonly handles: readonly Handle[] };

/** What compiled tasks yield. */
export const waits = {
  seconds: (seconds: number): Wait => ({ kind: 'seconds', seconds }),
  frames: (frames: number): Wait => ({ kind: 'frames', frames }),
  event: (event: EventDef, where?: (payload: Fields) => boolean): Wait =>
    (where === undefined ? { kind: 'event', event } : { kind: 'event', event, where }),
  condition: (test: () => boolean): Wait => ({ kind: 'condition', test }),
  all: (...handles: Handle[]): Wait => ({ kind: 'all', handles }),
  any: (...handles: Handle[]): Wait => ({ kind: 'any', handles }),
};

export type TaskBody = Generator<Wait, void, unknown>;

/** The clock a wait is measured against. */
export interface TaskClock {
  readonly now: number;
  readonly frame: number;
}

interface Running {
  readonly body: TaskBody;
  readonly owner: Owner;
  active: boolean;
  wait: Wait | undefined;
  startedAt: TaskClock;
  /** The first matching event delivered since an event wait began. */
  caught: Fields | undefined;
}

const DUE_TOLERANCE = 1e-9;

/** Callers pass the kernel's live clock; a wait must remember when it began. */
function snapshot(clock: TaskClock): TaskClock {
  return { now: clock.now, frame: clock.frame };
}

export class Tasks {
  #tasks: Running[] = [];

  /** Start a task: it runs now, up to its first wait. */
  run(body: TaskBody, owner: Owner, clock: TaskClock): Handle {
    const task: Running = { body, owner, active: true, wait: undefined, startedAt: snapshot(clock), caught: undefined };
    this.#tasks.push(task);
    this.#advance(task, undefined, clock);
    return {
      cancel: () => { task.active = false; },
      get active() { return task.active; },
    };
  }

  /** Record a delivered event for tasks waiting on it. */
  notify(type: EventDef, payload: Fields): void {
    for (const task of this.#tasks) {
      const wait = task.wait;
      if (!task.active || wait?.kind !== 'event' || task.caught !== undefined || wait.event !== type) continue;
      if (wait.where === undefined || wait.where(payload)) task.caught = payload;
    }
  }

  /** Resume every task whose wait is satisfied, in start order. */
  resume(clock: TaskClock, ownerAlive: (owner: Owner) => boolean): void {
    for (const task of [...this.#tasks]) {
      if (!task.active) continue;
      if (!ownerAlive(task.owner)) { task.active = false; continue; }
      const result = this.#ready(task, clock);
      if (result.ready) this.#advance(task, result.value, clock);
    }
    this.#tasks = this.#tasks.filter((task) => task.active);
  }

  cancelWhere(matches: (owner: Owner) => boolean): void {
    for (const task of this.#tasks) if (matches(task.owner)) task.active = false;
  }

  #advance(task: Running, value: unknown, clock: TaskClock): void {
    const step = task.body.next(value);
    if (step.done === true) {
      task.active = false;
      return;
    }
    task.wait = step.value;
    task.startedAt = snapshot(clock);
    task.caught = undefined;
  }

  #ready(task: Running, clock: TaskClock): { ready: boolean; value?: unknown } {
    const wait = task.wait!;
    switch (wait.kind) {
      case 'seconds':
        return { ready: clock.now + DUE_TOLERANCE >= task.startedAt.now + wait.seconds };
      case 'frames':
        return { ready: clock.frame >= task.startedAt.frame + wait.frames };
      case 'event':
        return task.caught === undefined ? { ready: false } : { ready: true, value: task.caught };
      case 'condition':
        return { ready: wait.test() };
      case 'all':
        return { ready: wait.handles.every((h) => !h.active) };
      case 'any': {
        const index = wait.handles.findIndex((h) => !h.active);
        return index < 0 ? { ready: false } : { ready: true, value: index };
      }
    }
  }
}
