/**
 * Deterministic random numbers (sfc32, seeded through splitmix32). Same seed, same
 * sequence, on every platform — what replays, lockstep multiplayer and deterministic
 * playtests rely on. The game-facing `random` module is built on this in `api/`.
 */

export type RandomState = readonly [number, number, number, number];

export class SeededRandom {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.#a = next();
    this.#b = next();
    this.#c = next();
    this.#d = next();
  }

  /** A float in [0, 1). */
  next(): number {
    const t = (((this.#a + this.#b) >>> 0) + this.#d) >>> 0;
    this.#d = (this.#d + 1) >>> 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) >>> 0;
    this.#c = ((this.#c << 21) | (this.#c >>> 11)) >>> 0;
    this.#c = (this.#c + t) >>> 0;
    return t / 4294967296;
  }

  /** An integer in [lo, hi], inclusive at both ends. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** The generator's full state, for snapshots and saves. */
  state(): RandomState {
    return [this.#a, this.#b, this.#c, this.#d];
  }

  restore(state: RandomState): void {
    [this.#a, this.#b, this.#c, this.#d] = state;
  }
}
