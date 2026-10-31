/**
 * The jobs port: pure work the engine may run off the main thread — parsing a model,
 * meshing a voxel chunk, building a terrain field, unpacking a bundle. A job is a named pure
 * function of structured-cloneable data (`JobDef`); the engine never knows where it runs:
 *
 *   inline   the same thread, one job after another (headless: playtests, servers) — the
 *            input and output still go through `structuredClone`, so a job that would not
 *            survive a worker fails headless exactly as it would in the browser
 *   workers  a pool of Web Workers, each loading the same job table (the browser)
 *
 * Determinism. A job's output depends only on its input, so the result is the same on
 * every adapter. `all` returns results in input order whatever order they finish in; a
 * caller that applies results as they come must order them itself (by input, not by time).
 *
 * Memory. `transfer` moves input buffers to the job (the caller's views are detached
 * afterwards; zero copies); a job's `transfer` moves its output buffers back. Bytes that
 * several jobs read go through `share` once: shared memory when the page is cross-origin
 * isolated, otherwise a plain copy per job.
 */

/** A job's name, carrying its input and output types. */
export interface JobKey<I, O> {
  readonly id: string;
  /** Type-only. */
  readonly __job?: (input: I) => O;
}

export function jobKey<I, O>(id: string): JobKey<I, O> {
  return { id };
}

/** One job: a pure function, and which of its output's buffers to move back to the caller. */
export interface JobDef<I, O> {
  readonly key: JobKey<I, O>;
  readonly run: (input: I) => O;
  /** Output buffers to transfer instead of copying (typed arrays' `.buffer`s). */
  readonly transfer?: (output: O) => readonly ArrayBuffer[];
}

/** Every job a runner can run, by id (the worker loads the same table). */
export type JobTable = ReadonlyMap<string, JobDef<unknown, unknown>>;

export interface JobOptions {
  /** Input buffers to move to the job; the caller must not use them afterwards. */
  readonly transfer?: readonly ArrayBuffer[];
}

export interface JobStats {
  /** Jobs finished (or failed) so far. */
  readonly completed: number;
  /** Jobs that ran on this thread (inline adapter, or the workers' fallback). */
  readonly inline: number;
  /** Seconds this thread spent inside job functions (the work a worker would have saved). */
  readonly inlineSeconds: number;
}

export interface JobRunner {
  readonly mode: 'inline' | 'workers';
  /** Worker threads the runner may use (0 inline). */
  readonly threads: number;
  run<I, O>(key: JobKey<I, O>, input: I, options?: JobOptions): Promise<O>;
  /** Fork/join: every input through one job; results in input order. */
  all<I, O>(key: JobKey<I, O>, inputs: readonly I[], transfer?: (input: I) => readonly ArrayBuffer[]): Promise<O[]>;
  /** Bytes several jobs read: in shared memory when the page allows it, else unchanged. */
  share(bytes: Uint8Array): Uint8Array;
  readonly stats: JobStats;
  /** Stop the workers; jobs in flight reject. */
  dispose(): void;
}

/** A failed job's error, as it crosses a thread: a diagnostic's parts when the job threw one. */
export interface JobFailure {
  readonly message: string;
  readonly code?: string;
  readonly fix?: string;
  readonly stack?: string;
}

/** Request/response messages between a runner and a worker (`platform/browser/jobs.ts`). */
export type JobRequest = { readonly id: number; readonly job: string; readonly input: unknown };
export type JobResponse =
  | { readonly id: number; readonly ok: true; readonly output: unknown }
  | { readonly id: number; readonly ok: false; readonly error: JobFailure };
