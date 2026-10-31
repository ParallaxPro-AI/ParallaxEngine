import { fail } from './diagnostics.js';

/**
 * The delivery rule behind every event: events emitted during a phase
 * are delivered at the end of that phase, in emission order. Events emitted while
 * delivering are delivered after the current batch, in the same flush — never
 * re-entrantly, never interleaved.
 */
export class EventQueue<E> {
  #pending: E[] = [];

  emit(event: E): void {
    this.#pending.push(event);
  }

  get size(): number {
    return this.#pending.length;
  }

  /**
   * Deliver everything queued, then anything those deliveries emitted, until quiet.
   * A cascade that never settles is a bug in game logic; after `maxRounds` it stops
   * with PP3040 instead of hanging the frame. Returns the number of events delivered.
   */
  flush(deliver: (event: E) => void, maxRounds = 32): number {
    let delivered = 0;
    for (let round = 0; this.#pending.length > 0; round++) {
      if (round === maxRounds) {
        const stuck = this.#pending.length;
        this.#pending = [];
        fail('PP3040', `Events kept emitting new events for ${maxRounds} rounds (${stuck} still queued)`, {
          fix: 'Find the handler that emits the event it is handling (or a pair that emit each other).',
        });
      }
      const batch = this.#pending;
      this.#pending = [];
      for (const event of batch) {
        deliver(event);
        delivered++;
      }
    }
    return delivered;
  }
}
