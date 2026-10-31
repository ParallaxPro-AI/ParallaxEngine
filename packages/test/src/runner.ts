/**
 * `runProjectTests(dir)`: build the project (transpiler + check), then run its tests in a
 * child Node process with module hooks for the build (child.ts). One process per
 * project: its module cache, `print` sink and patched engine hooks never touch the
 * caller. A test that runs longer than `timeout` seconds of wall time is killed and
 * reported (PP3414); a crashed process is reported (PP3415); either way a new process
 * picks up the remaining tests.
 */

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ENGINE_MODULES, gameModules, migrationModules } from '@parallax/runtime/boot';
import { diagnostic } from '@parallax/runtime/core';
import type { Diagnostic } from '@parallax/runtime/core';
import { buildForTests } from './build.js';
import type { ChildJob } from './child.js';
import { isTestModule } from './discover.js';
import type { HookData } from './hooks.js';
import type { SessionJob, SessionMessage, TestResult } from './results.js';

const RUNTIME_SRC = new URL('../../runtime/src/', import.meta.url);
const CHILD = new URL('./child.ts', import.meta.url);
const SDK_MODULE = new URL('./sdk.ts', import.meta.url);

export interface RunOptions {
  /** Where to build (kept afterwards); default a temporary directory, removed after the run. */
  readonly outDir?: string;
  /** Run only tests whose id (`tests/test_x.py::test_y`) or title contains this. */
  readonly filter?: string;
  /** Wall-clock seconds one test may take before it is killed. Default 60. */
  readonly timeout?: number;
  /** The Python that runs the transpiler. Default `python3`. */
  readonly python?: string;
  /** Called with each result as it arrives (progress output). */
  readonly onResult?: (result: TestResult) => void;
  /** Attach what each playtest's game showed at its end (`TestResult.observation`). */
  readonly observe?: boolean;
}

export interface TestSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
}

export interface ProjectTestReport {
  readonly projectDir: string;
  /** Build and check diagnostics, and run-level problems (no tests, a crashed process). */
  readonly diagnostics: readonly Diagnostic[];
  /** True when the build had no errors, so tests ran. */
  readonly built: boolean;
  readonly results: readonly TestResult[];
  readonly summary: TestSummary;
  /** Built, every test passed, and nothing went wrong around them. */
  readonly ok: boolean;
}

/** The module hook table: every engine module whose source exists, plus `parallax/test`. */
export function hookData(buildDir: string): HookData {
  const aliases: Record<string, string> = { 'parallax/test': SDK_MODULE.href };
  const missing: string[] = [];
  for (const [specifier, path] of Object.entries(ENGINE_MODULES)) {
    const url = new URL(path, RUNTIME_SRC);
    if (existsSync(url)) aliases[specifier] = url.href;
    else missing.push(specifier);
  }
  return { aliases, missing, build: pathToFileURL(`${resolve(buildDir)}/`).href };
}

function summarize(results: readonly TestResult[]): TestSummary {
  return {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    errors: results.filter((r) => r.status === 'error').length,
  };
}

type Running = Pick<TestResult, 'id' | 'file' | 'name' | 'title' | 'kind'>;

interface SessionEnd {
  /** The test that was running when the process stopped early, if any. */
  readonly running: Running | null;
  readonly problem: Diagnostic | null;
}

/** One child process over the job; resolves when it ends, finishes, hangs or crashes. */
function runChild(job: ChildJob, timeoutMs: number, onResult: (result: TestResult) => void): Promise<SessionEnd> {
  return new Promise((done) => {
    const child: ChildProcess = fork(fileURLToPath(CHILD), [], {
      execArgv: ['--enable-source-maps', '--stack-trace-limit=50', '--disable-warning=ExperimentalWarning'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout?.on('data', () => { /* engine console output is not part of the report */ });
    let running: Running | null = null;
    let finished = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (end: SessionEnd): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      done(end);
    };
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle({
          running,
          problem: diagnostic('PP3414', `${running?.id ?? 'Loading the tests'} took longer than ${timeoutMs / 1000}s of wall time and was stopped`, {
            fix: 'Look for a loop that never ends (in the game or the test), or raise the timeout.',
          }),
        });
      }, timeoutMs);
    };
    child.on('message', (message) => {
      const m = message as SessionMessage;
      if (m.kind === 'begin') { running = m.test; arm(); }
      else if (m.kind === 'result') { running = null; onResult(m.result); arm(); }
      else finished = true;
    });
    child.on('exit', (code, signal) => {
      if (finished && code === 0) { settle({ running: null, problem: null }); return; }
      const detail = stderr.trim().split('\n').slice(-6).join('\n');
      settle({
        running,
        problem: diagnostic('PP3415', `The test process stopped${running === null ? '' : ` during ${running.id}`} (exit ${String(code ?? signal)})${detail === '' ? '' : `:\n${detail}`}`, {
          fix: 'This is a harness or engine crash, not a test failure; report it with the project.',
        }),
      });
    });
    arm();
    child.send(job);
  });
}

/** Build `dir` and run every test it has. */
export async function runProjectTests(dir: string, options: RunOptions = {}): Promise<ProjectTestReport> {
  const projectDir = resolve(dir);
  const temporary = options.outDir === undefined;
  if (options.outDir !== undefined) mkdirSync(options.outDir, { recursive: true });
  // Real paths: Node reports module URLs by real path, and the hooks match the build by prefix.
  const buildDir = realpathSync(options.outDir ?? mkdtempSync(`${tmpdir()}/parallax-test-`));
  try {
    return await run(projectDir, buildDir, options);
  } finally {
    if (temporary) rmSync(buildDir, { recursive: true, force: true });
  }
}

async function run(projectDir: string, buildDir: string, options: RunOptions): Promise<ProjectTestReport> {
  const diagnostics: Diagnostic[] = [];
  const results: TestResult[] = [];
  const report = (built: boolean): ProjectTestReport => {
    const summary = summarize(results);
    const ok = built && summary.failed === 0 && summary.errors === 0 && !diagnostics.some((d) => d.severity === 'error');
    return { projectDir, diagnostics, built, results, summary, ok };
  };
  const add = (result: TestResult): void => { results.push(result); options.onResult?.(result); };

  if (!existsSync(`${projectDir}/game`) && !existsSync(`${projectDir}/tests`)) {
    diagnostics.push(diagnostic('PP9512', `There is no project at ${projectDir}`, { fix: 'Pass the folder that holds game/ and tests/.' }));
    return report(false);
  }
  const build = buildForTests(projectDir, buildDir, options.python ?? 'python3');
  const inTests = (d: Diagnostic): boolean => d.path !== undefined && isTestModule(d.path);
  diagnostics.push(...build.diagnostics.filter((d) => !inTests(d)));
  if (build.manifest === undefined || diagnostics.some((d) => d.severity === 'error')) return report(false);

  const files: { source: string; output: string }[] = [];
  const sources: Record<string, string> = {};
  for (const m of build.manifest.modules) {
    if (m.output !== null) sources[m.output] = m.source;
    if (!isTestModule(m.source)) continue;
    const errors = build.diagnostics.filter((d) => d.path === m.source && d.severity === 'error');
    if (m.output === null || errors.length > 0) {
      add({
        id: m.source, file: m.source, name: '', title: m.source, kind: 'module', status: 'error', ms: 0,
        diagnostics: errors, traceback: [], output: '', warnings: [],
      });
    } else {
      files.push({ source: m.source, output: m.output });
    }
  }
  if (files.length === 0 && results.length === 0) {
    diagnostics.push(diagnostic('PP3412', 'The project has no tests', {
      severity: 'warning', fix: 'Add tests/test_<topic>.py with @playtest functions (sdk/parallax/test.pyi).',
    }));
    return report(true);
  }

  const session: SessionJob = {
    projectDir, buildDir, files, entry: build.manifest.entry,
    // Save migrations register before the game, so an old save loads.
    modules: [...migrationModules(build.manifest), ...gameModules(build.manifest)],
    sources, filter: options.filter ?? null, skip: [], observe: options.observe === true,
  };
  const hooks = hookData(buildDir);
  const timeoutMs = (options.timeout ?? 60) * 1000;
  const reported = new Set(results.map((r) => r.id));
  for (;;) {
    const end = await runChild({ ...session, skip: [...reported], hooks }, timeoutMs, (result) => {
      reported.add(result.id);
      add(result);
    });
    if (end.problem === null) break;
    if (end.running === null) {
      // Not inside a test: loading failed, and a new process would fail the same way.
      diagnostics.push(end.problem);
      break;
    }
    reported.add(end.running.id);
    add({ ...end.running, status: 'error', ms: 0, diagnostics: [end.problem], traceback: [], output: '', warnings: [] });
  }
  return report(true);
}
