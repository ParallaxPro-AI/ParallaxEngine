import type { Clock } from '../../core/index.js';

/** `performance.now()` in seconds: monotonic, unaffected by changes to the wall clock. */
export class PerformanceClock implements Clock {
  readonly #performance: { now(): number };

  constructor(performance: { now(): number } = globalThis.performance) {
    this.#performance = performance;
  }

  now(): number {
    return this.#performance.now() / 1000;
  }
}
