/**
 * Timers (`ctx.time.after/every`): run in game time, in due order (ties: scheduling
 * order), and owned — a timer dies with the entity, system or scene that started it.
 * Running timers are not saved (SDK module docs).
 */

import type { EntityId } from '../../core/index.js';
import type { SystemDef } from './definitions.js';

/** Game time is a sum of float frame times; a timer due "at 0.1 s" must fire on the frame that reaches 0.0999…. */
const DUE_TOLERANCE = 1e-9;

export type Owner =
  | { readonly kind: 'entity'; readonly id: EntityId }
  | { readonly kind: 'system'; readonly system: SystemDef }
  | { readonly kind: 'game' };

export interface Handle {
  cancel(): void;
  readonly active: boolean;
}

interface Timer {
  due: number;
  readonly interval: number | undefined;
  readonly fn: () => void;
  readonly owner: Owner;
  readonly seq: number;
  active: boolean;
}

export class Timers {
  #timers: Timer[] = [];
  #seq = 0;

  schedule(now: number, seconds: number, fn: () => void, owner: Owner, interval?: number): Handle {
    const timer: Timer = { due: now + seconds, interval, fn, owner, seq: this.#seq++, active: true };
    this.#timers.push(timer);
    return {
      cancel: () => { timer.active = false; },
      get active() { return timer.active; },
    };
  }

  /** Run every timer due at `now`, earliest first; repeating ones are rescheduled. */
  tick(now: number, ownerAlive: (owner: Owner) => boolean): void {
    for (;;) {
      let next: Timer | undefined;
      for (const timer of this.#timers) {
        if (!timer.active || timer.due > now + DUE_TOLERANCE) continue;
        if (!ownerAlive(timer.owner)) { timer.active = false; continue; }
        if (next === undefined || timer.due < next.due || (timer.due === next.due && timer.seq < next.seq)) next = timer;
      }
      if (next === undefined) break;
      if (next.interval === undefined) next.active = false;
      else next.due += next.interval;
      next.fn();
    }
    this.#timers = this.#timers.filter((timer) => timer.active);
  }

  /** Cancel every timer whose owner matches (an entity torn down, a scene unloaded). */
  cancelWhere(matches: (owner: Owner) => boolean): void {
    for (const timer of this.#timers) if (matches(timer.owner)) timer.active = false;
  }
}
