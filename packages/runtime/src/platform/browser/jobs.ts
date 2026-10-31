/**
 * Jobs on Web Workers. One pool serves every job kind: each worker loads the engine's job
 * table (`boot/job_worker.ts`, bundled as `job_worker.js`), so there is one isolate per
 * thread, not one per kind of work.
 *
 *   dispatch   to the least-busy worker; workers start on first need (one at first, more
 *              only while every live one is busy) up to `threads`, and stop after
 *              `idleSeconds` with nothing to do
 *   memory     `transfer` buffers move both ways; `share` puts bytes several jobs read in a
 *              SharedArrayBuffer when the page is cross-origin isolated
 *   fallback   no Worker constructor, or a worker that fails to load or crashes: the
 *              runner switches to running jobs on this thread (one PP9533 warning), and a
 *              job that was in flight is re-run here when its input wasn't transferred
 *              (it is pure, so that is safe); a transferred input is gone, so that job
 *              rejects with PP9533
 *
 * A job that throws rejects with its own diagnostic (or PP9531); that is the job's
 * answer, not a crash, and the worker keeps serving.
 */

import { diagnostic, ParallaxError } from '../../core/index.js';
import type {
  Diagnostic, JobKey, JobOptions, JobRequest, JobResponse, JobRunner, JobStats, JobTable,
} from '../../core/index.js';
import { jobError, jobFailure, lookupJob, runHere, transferList } from '../headless/jobs.js';

/** The parts of a Worker this adapter uses (a real one, or a test double). */
export interface WorkerLike {
  postMessage(message: JobRequest, transfer: readonly ArrayBuffer[]): void;
  terminate(): void;
  onmessage: ((event: { readonly data: JobResponse }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
}

export interface WorkerJobsOptions {
  /** Start one worker (`new Worker(url, { type: 'module' })`); absent: no workers, run inline. */
  readonly create: (() => WorkerLike) | undefined;
  /** The same table the workers load: for the fallback, and to reject unknown jobs early. */
  readonly table: JobTable;
  /** Default: hardware threads − 1, clamped to 1..4. */
  readonly threads?: number;
  /** `globalThis.crossOriginIsolated`: SharedArrayBuffer is usable. */
  readonly isolated?: boolean;
  /** Stop idle workers after this long (default 10 s); 0 keeps them. */
  readonly idleSeconds?: number;
  readonly onProblem: (d: Diagnostic) => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

interface Pending {
  readonly job: string;
  readonly input: unknown;
  /** The input was moved to the worker: it can't be re-run here. */
  readonly moved: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface Slot {
  readonly worker: WorkerLike;
  readonly inflight: Map<number, Pending>;
}

export function defaultThreads(): number {
  const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(4, cores - 1));
}

const now = (): number => (globalThis.performance?.now() ?? Date.now()) / 1000;

export class WorkerJobs implements JobRunner {
  readonly #options: WorkerJobsOptions;
  readonly #slots: Slot[] = [];
  readonly #threads: number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #nextId = 1;
  #broken: string | null;
  #disposed = false;
  #idle: unknown;
  #stats = { completed: 0, inline: 0, inlineSeconds: 0 };

  constructor(options: WorkerJobsOptions) {
    this.#options = options;
    this.#threads = Math.max(1, options.threads ?? defaultThreads());
    this.#broken = options.create === undefined ? 'this page has no Web Workers' : null;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get mode(): 'inline' | 'workers' {
    return this.#broken === null ? 'workers' : 'inline';
  }

  get threads(): number {
    return this.#broken === null ? this.#threads : 0;
  }

  /** Workers running now. */
  get live(): number {
    return this.#slots.length;
  }

  get stats(): JobStats {
    return { ...this.#stats };
  }

  run<I, O>(key: JobKey<I, O>, input: I, options: JobOptions = {}): Promise<O> {
    if (this.#disposed) return Promise.reject(new ParallaxError(diagnostic('PP9532', `The job "${key.id}" was started after the runner was disposed`)));
    if (!this.#options.table.has(key.id)) return Promise.resolve().then(() => lookupJob(this.#options.table, key.id) as never);
    if (this.#broken !== null) return this.#inline(key.id, input, options.transfer) as Promise<O>;
    return new Promise<O>((resolve, reject) => {
      const slot = this.#pick();
      const id = this.#nextId++;
      const transfer = transferList(options.transfer);
      slot.inflight.set(id, { job: key.id, input, moved: transfer.length > 0, resolve: resolve as (v: unknown) => void, reject });
      this.#armIdle();
      try {
        slot.worker.postMessage({ id, job: key.id, input }, transfer);
      } catch (error) {
        // Not cloneable: the same error the inline adapter gives.
        slot.inflight.delete(id);
        reject(jobError(key.id, jobFailure(error)));
      }
    });
  }

  all<I, O>(key: JobKey<I, O>, inputs: readonly I[], transfer?: (input: I) => readonly ArrayBuffer[]): Promise<O[]> {
    return Promise.all(inputs.map((input) => this.run(key, input, transfer === undefined ? {} : { transfer: transfer(input) })));
  }

  share(bytes: Uint8Array): Uint8Array {
    if (this.#options.isolated !== true || typeof SharedArrayBuffer === 'undefined' || bytes.buffer instanceof SharedArrayBuffer) return bytes;
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
    shared.set(bytes);
    return shared;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#idle !== undefined) this.#clearTimer(this.#idle);
    for (const slot of this.#slots.splice(0)) {
      slot.worker.terminate();
      for (const pending of slot.inflight.values()) {
        pending.reject(new ParallaxError(diagnostic('PP9532', `The job "${pending.job}" was cancelled: the runner was disposed`)));
      }
    }
  }

  #inline(job: string, input: unknown, transfer: readonly ArrayBuffer[] | undefined): Promise<unknown> {
    return Promise.resolve().then(() => {
      const start = now();
      try {
        return runHere(lookupJob(this.#options.table, job), input, transfer);
      } catch (error) {
        throw jobError(job, jobFailure(error));
      } finally {
        this.#stats.completed++;
        this.#stats.inline++;
        this.#stats.inlineSeconds += now() - start;
      }
    });
  }

  #pick(): Slot {
    const idle = this.#slots.find((s) => s.inflight.size === 0);
    if (idle !== undefined) return idle;
    if (this.#slots.length < this.#threads) return this.#spawn();
    return this.#slots.reduce((a, b) => (b.inflight.size < a.inflight.size ? b : a));
  }

  #spawn(): Slot {
    const worker = this.#options.create!();
    const slot: Slot = { worker, inflight: new Map() };
    worker.onmessage = (event) => this.#reply(slot, event.data);
    worker.onerror = (event) => this.#crash(slot, event.message ?? 'the worker failed to load or crashed');
    this.#slots.push(slot);
    return slot;
  }

  #reply(slot: Slot, message: JobResponse): void {
    const pending = slot.inflight.get(message.id);
    if (pending === undefined) return;
    slot.inflight.delete(message.id);
    this.#stats.completed++;
    if (message.ok) pending.resolve(message.output);
    else pending.reject(jobError(pending.job, message.error));
    this.#armIdle();
  }

  /** A worker died: every worker goes, and jobs run here from now on. */
  #crash(_slot: Slot, reason: string): void {
    if (this.#broken !== null) return;
    this.#broken = reason;
    this.#options.onProblem(diagnostic('PP9533', `Background workers stopped (${reason}); jobs run on the main thread from now on`, {
      severity: 'warning',
      fix: 'Check that job_worker.js is served next to boot.js (a module worker), and the console for the worker\'s own error.',
    }));
    for (const slot of this.#slots.splice(0)) {
      slot.worker.terminate();
      for (const pending of slot.inflight.values()) {
        if (pending.moved) {
          pending.reject(new ParallaxError(diagnostic('PP9533', `The job "${pending.job}" was lost with its worker (its input had been transferred)`, {
            fix: 'Retry the operation; it now runs on the main thread.',
          })));
        } else {
          this.#inline(pending.job, pending.input, undefined).then(pending.resolve, pending.reject);
        }
      }
    }
  }

  #armIdle(): void {
    const seconds = this.#options.idleSeconds ?? 10;
    if (seconds <= 0) return;
    if (this.#idle !== undefined) this.#clearTimer(this.#idle);
    this.#idle = undefined;
    if (this.#slots.some((s) => s.inflight.size > 0)) return;
    this.#idle = this.#setTimer(() => {
      this.#idle = undefined;
      if (this.#slots.some((s) => s.inflight.size > 0)) return;
      for (const slot of this.#slots.splice(0)) slot.worker.terminate();
    }, seconds * 1000);
  }
}

/** The worker side: answer job requests from `table` (a module worker's `self`). */
export function serveJobs(
  scope: { onmessage: ((event: { readonly data: JobRequest }) => void) | null; postMessage(message: JobResponse, transfer: ArrayBuffer[]): void },
  table: JobTable,
): void {
  scope.onmessage = (event) => {
    const { id, job, input } = event.data;
    let response: JobResponse;
    let transfer: ArrayBuffer[] = [];
    try {
      const def = lookupJob(table, job);
      const output = def.run(input);
      transfer = transferList(def.transfer?.(output));
      response = { id, ok: true, output };
    } catch (error) {
      response = { id, ok: false, error: jobFailure(error) };
    }
    scope.postMessage(response, transfer);
  };
}
