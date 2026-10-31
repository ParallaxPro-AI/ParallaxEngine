/**
 * The game's random source. Python's `random` module (implemented in pyrt) and
 * `scatter` draw from the running game's `SeededRandom`, which the context owns and
 * reseeds on every scene load (`ctx.seed`) — so replays and headless playtests repeat.
 */

import { fail } from '../core/index.js';
import type { SeededRandom } from '../core/index.js';

let active: SeededRandom | undefined;

/** Made current by the running game (one game per module realm). */
export function setActiveRandom(random: SeededRandom): void {
  active = random;
}

/** The running game's random source (what pyrt's `random` module draws from). */
export function activeRandom(): SeededRandom {
  if (active === undefined) {
    fail('PP3032', 'random was used before the game started', { fix: 'Draw random numbers inside hooks, handlers or tasks.' });
  }
  return active;
}
