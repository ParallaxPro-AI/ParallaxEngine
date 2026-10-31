/**
 * The `parallax/test` module compiled playtests import (sdk/parallax/test.pyi): the
 * `@playtest("name")` decorator and the `GameHarness` type. Hosts map the bare name to
 * this file for test runs only; it never ships in a game bundle.
 */

import { fail } from '@parallax/runtime/core';

export { GameHarness } from './harness.js';

/** Set on a function `@playtest` decorated: its display name and decoration order. */
export const PLAYTEST = Symbol.for('parallax.playtest');

export interface PlaytestMark {
  readonly name: string;
  /** Global decoration order: playtests run in the order they are defined. */
  readonly order: number;
}

let decorated = 0;

export function playtestMark(fn: unknown): PlaytestMark | undefined {
  return typeof fn === 'function' ? (fn as unknown as Record<symbol, PlaytestMark | undefined>)[PLAYTEST] : undefined;
}

/** `@playtest("what it proves")` over `async def test_x(game)`. */
export function playtest(...args: unknown[]): (fn: unknown) => unknown {
  const name = args[0];
  if (args.length !== 1 || typeof name !== 'string' || name.trim() === '') {
    fail('PP3450', '@playtest takes one argument: a non-empty name saying what the test proves', {
      fix: '@playtest("the ball serves itself after the delay")',
    });
  }
  return (fn: unknown) => {
    if (typeof fn !== 'function') fail('PP3450', `@playtest("${name}") decorates a function, got ${String(fn)}`);
    Object.defineProperty(fn, PLAYTEST, { value: { name, order: decorated++ } satisfies PlaytestMark });
    return fn;
  };
}
