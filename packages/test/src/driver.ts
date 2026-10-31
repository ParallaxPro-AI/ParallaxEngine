/**
 * Running one collected test function. A playtest is a compiled `async def` — a
 * generator — driven here: each value it yields is a harness `Command`, run (awaiting
 * boot when needed) and its result sent back, or its error thrown back in so the test's
 * own `try/except` applies. Anything else it awaits is a misuse (PP3447). A plain
 * `test_*` function is called with no arguments (and driven the same way if async).
 */

import { BootFailure, diagnosticsOf } from '@parallax/runtime/boot';
import { diagnostic, ParallaxError } from '@parallax/runtime/core';
import type { Diagnostic } from '@parallax/runtime/core';
import { Command, ERROR_SITE, GameHarness } from './harness.js';
import { AssertionError, BaseException, isCoroutine, str } from './internals.js';
import type { TestStatus } from './results.js';

export interface Outcome {
  readonly status: TestStatus;
  readonly diagnostics: readonly Diagnostic[];
  /** The error's stack, for the traceback. */
  readonly stack?: string;
  /** Where the test called the harness method that raised, when it did. */
  readonly site?: string;
}

const PASSED: Outcome = { status: 'passed', diagnostics: [] };

/** Waits that ran out: the game never did what the test waited for — a failure, like an assert. */
const WAIT_TIMEOUTS = new Set(['PP3444', 'PP3445']);

/** What a raised value means for the test. */
export function outcomeOf(error: unknown): Outcome {
  const stack = error instanceof Error ? error.stack ?? '' : '';
  const site = typeof error === 'object' && error !== null ? ERROR_SITE.get(error) : undefined;
  const at = { stack, ...(site !== undefined && { site }) };
  if (error instanceof AssertionError) {
    const detail = str(error);
    return {
      status: 'failed',
      diagnostics: [diagnostic('PP3452', detail === '' ? 'assertion failed' : `assertion failed: ${detail}`, {
        fix: 'The game did not reach the asserted state; the traceback shows which assert.',
      })],
      ...at,
    };
  }
  if (error instanceof ParallaxError) {
    return { status: WAIT_TIMEOUTS.has(error.diagnostic.code) ? 'failed' : 'error', diagnostics: [error.diagnostic], ...at };
  }
  if (error instanceof BootFailure) return { status: 'error', diagnostics: error.diagnostics, ...at };
  if (error instanceof BaseException) {
    const detail = str(error);
    return {
      status: 'error',
      diagnostics: [diagnostic('PP3453', `${error.constructor.name}${detail === '' ? '' : `: ${detail}`}`, {
        fix: 'The test or the game raised this exception; the traceback shows where.',
      })],
      ...at,
    };
  }
  return { status: 'error', diagnostics: diagnosticsOf(error), ...at };
}

type Coroutine = Generator<unknown, unknown, unknown>;

function stray(command: Command): ParallaxError {
  const error = new ParallaxError(diagnostic('PP3446', `game.${command.label} was called without await, so it never ran`, {
    fix: `Write \`await game.${command.label.replace('()', '(...)')}\`.`,
  }));
  ERROR_SITE.set(error, command.site);
  return error;
}

async function drive(coroutine: Coroutine, harness: GameHarness | null): Promise<void> {
  let send: { ok: true; value: unknown } | { ok: false; error: unknown } = { ok: true, value: undefined };
  for (;;) {
    const step: IteratorResult<unknown, unknown> = send.ok ? coroutine.next(send.value) : coroutine.throw(send.error);
    if (step.done === true) break;
    const command: unknown = step.value;
    if (!(command instanceof Command)) {
      coroutine.return(undefined);
      throw new ParallaxError(diagnostic('PP3447', `A test awaited ${String(command)}, which is not a game harness call`, {
        fix: 'Tests await GameHarness methods (game.advance, game.press, …) and their own async helpers only.',
      }));
    }
    const missed = harness?.strays(command)[0];
    if (missed !== undefined) {
      coroutine.return(undefined);
      throw stray(missed);
    }
    try {
      send = { ok: true, value: await command.run() };
    } catch (error) {
      if (typeof error === 'object' && error !== null && !ERROR_SITE.has(error)) ERROR_SITE.set(error, command.site);
      send = { ok: false, error };
    }
    harness?.settle();
  }
  const missed = harness?.strays()[0];
  if (missed !== undefined) throw stray(missed);
}

/** Run a `@playtest` function with a fresh harness. */
export async function runPlaytest(fn: Function, name: string, harness: GameHarness): Promise<Outcome> {
  try {
    const coroutine = fn(harness) as unknown;
    if (!isCoroutine(coroutine)) {
      return outcomeOf(new ParallaxError(diagnostic('PP3450', `Playtest ${name} is not an async def`, {
        fix: `Write \`async def ${name}(game):\` and await the harness calls.`,
      })));
    }
    await drive(coroutine as Coroutine, harness);
    return PASSED;
  } catch (error) {
    return outcomeOf(error);
  }
}

/** Run a plain `test_*` function: no arguments, no harness. */
export async function runPlainTest(fn: Function): Promise<Outcome> {
  try {
    const result = fn() as unknown;
    if (isCoroutine(result)) await drive(result as Coroutine, null);
    return PASSED;
  } catch (error) {
    return outcomeOf(error);
  }
}
