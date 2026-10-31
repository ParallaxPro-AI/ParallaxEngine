/**
 * @parallax/test — the headless playtest harness (sdk/parallax/test.pyi).
 *
 *   main              `parallax test <project> ...` (argv → exit code)
 *   runProjectTests   build a project and run its tests (what `main` calls)
 *   formatReport      the text report; reportJson for agents
 *   hookData          the module table a host uses to load compiled tests in Node
 *
 * `parallax/test` itself (the decorator and `GameHarness`) is `./sdk` — hosts map the
 * bare name there for test runs. `./vitest` registers a project's tests with Vitest.
 */

export { main } from './cli.js';
export { formatReport, formatResult, reportJson } from './report.js';
export type { SessionJob, TestKind, TestResult, TestStatus, TraceFrame } from './results.js';
export { hookData, runProjectTests } from './runner.js';
export type { ProjectTestReport, RunOptions, TestSummary } from './runner.js';
