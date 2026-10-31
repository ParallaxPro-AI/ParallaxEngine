import type { Clock } from '../../core/index.js';

/** A clock that only moves when told to: deterministic playtests and servers stepping time. */
export class ManualClock implements Clock {
  #seconds = 0;

  now(): number {
    return this.#seconds;
  }

  advance(seconds: number): void {
    if (seconds < 0) throw new RangeError('A clock cannot go backwards');
    this.#seconds += seconds;
  }
}
