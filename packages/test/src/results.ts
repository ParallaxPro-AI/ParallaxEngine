/** What a playtest run reports: plain JSON, so it crosses the process boundary as is. */

import type { Diagnostic } from '@parallax/runtime/core';
import type { Observation } from '@parallax/editor/session';

/** passed; failed = an assertion did not hold; error = the test or the game raised. */
export type TestStatus = 'passed' | 'failed' | 'error';

/** `playtest` and `test` are collected functions; `module` is a test file that failed to import. */
export type TestKind = 'playtest' | 'test' | 'module';

/** One frame of a Python-side traceback: the .py file and line, and where in its compiled module. */
export interface TraceFrame {
  /** Project path of the Python source (`tests/test_duel.py`). */
  readonly source: string;
  /** The .py line (1-based), from the module's source map; absent when the map doesn't cover the frame. */
  readonly line?: number;
  /** Build path of the compiled module (`tests/test_duel.js`). */
  readonly compiled: string;
  /** The compiled line, when the stack named it (source-mapped stacks name the .py line only). */
  readonly compiledLine?: number;
  /** Column in the stack's frame (of the .py line when source-mapped, else of the compiled line). */
  readonly column: number;
  /** The .py line's text (the compiled line's when `line` is absent). */
  readonly code?: string;
}

export interface TestResult {
  /** `tests/test_duel.py::test_serve` (the module's path alone for kind "module"). */
  readonly id: string;
  /** Project path of the test file. */
  readonly file: string;
  /** The function's name ('' for kind "module"). */
  readonly name: string;
  /** The @playtest name, or the function name for plain tests. */
  readonly title: string;
  readonly kind: TestKind;
  readonly status: TestStatus;
  readonly ms: number;
  /** Why it failed (empty when it passed). */
  readonly diagnostics: readonly Diagnostic[];
  /** Outermost call first, like Python. */
  readonly traceback: readonly TraceFrame[];
  /** Everything the test and the game print()ed. */
  readonly output: string;
  /** Load warnings (project data) from the game this test started. */
  readonly warnings: readonly Diagnostic[];
  /**
   * With `--observe`: what the game showed when the playtest ended (camera, entities with
   * their screen boxes, open panels; `contracts/observation.schema.json`),
   * or null when the test never started a game. Absent without `--observe`.
   */
  readonly observation?: Observation | null;
}

/** Child → parent messages. */
export type SessionMessage =
  | { readonly kind: 'begin'; readonly test: Pick<TestResult, 'id' | 'file' | 'name' | 'title' | 'kind'> }
  | { readonly kind: 'result'; readonly result: TestResult }
  | { readonly kind: 'end' };

/** Parent → child: one project's test run. */
export interface SessionJob {
  readonly projectDir: string;
  readonly buildDir: string;
  /** Compiled test modules: project source path and build output path. */
  readonly files: readonly { readonly source: string; readonly output: string }[];
  /** Build path of the entry (`game/main.js`), or null when there is none. */
  readonly entry: string | null;
  /**
   * Every game module to load before the entry: the save migrations (`migrationModules`),
   * then `gameModules(manifest)` (manifest order, no tests/ or migrations/) — declarations
   * and `@migration` steps register when their module loads.
   */
  readonly modules: readonly string[];
  /** Build output → project source, for tracebacks. */
  readonly sources: Readonly<Record<string, string>>;
  /** Run only tests whose id or title contains this. */
  readonly filter: string | null;
  /** Ids already reported (a restarted session skips them). */
  readonly skip: readonly string[];
  /** Attach each playtest's final observation to its result. */
  readonly observe: boolean;
}
