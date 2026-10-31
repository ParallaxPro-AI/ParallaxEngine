/**
 * Jobs on the calling thread: deterministic, for playtests and servers, and the browser
 * adapter's fallback when workers can't run. Inputs and outputs pass through
 * `structuredClone` (transfers included), so what works here works across a worker.
 */

import { diagnostic, fail, ParallaxError } from '../../core/index.js';
import type {
  DiagnosticCode, JobDef, JobFailure, JobKey, JobOptions, JobRunner, JobStats, JobTable,
} from '../../core/index.js';

/** A table from job definitions; PP9530 on a duplicate id. */
export function jobTable(defs: readonly JobDef<never, unknown>[]): JobTable {
  const table = new Map<string, JobDef<unknown, unknown>>();
  for (const def of defs) {
    if (table.has(def.key.id)) fail('PP9530', `Two jobs are named "${def.key.id}"`, { fix: 'Give every job its own id.' });
    table.set(def.key.id, def as unknown as JobDef<unknown, unknown>);
  }
  return table;
}

export function lookupJob(table: JobTable, id: string): JobDef<unknown, unknown> {
  const def = table.get(id);
  if (def === undefined) {
    fail('PP9530', `There is no job "${id}"`, { fix: `Jobs this runner knows: ${[...table.keys()].join(', ') || 'none'}.` });
  }
  return def;
}

/** An error as it crosses a thread. */
export function jobFailure(error: unknown): JobFailure {
  if (error instanceof ParallaxError) {
    const d = error.diagnostic;
    return { message: d.message, code: d.code, ...(d.fix !== undefined && { fix: d.fix }), ...(error.stack !== undefined && { stack: error.stack }) };
  }
  const e = error instanceof Error ? error : new Error(String(error));
  return { message: `${e.name}: ${e.message}`, ...(e.stack !== undefined && { stack: e.stack }) };
}

/** The error a failed job rejects with: the job's own diagnostic, or PP9531 naming the job. */
export function jobError(job: string, failure: JobFailure): Error {
  const d = failure.code !== undefined
    ? diagnostic(failure.code as DiagnosticCode, failure.message, failure.fix !== undefined ? { fix: failure.fix } : {})
    : diagnostic('PP9531', `The job "${job}" failed: ${failure.message}`, { fix: 'This is an engine bug; the stack below shows where.' });
  const error = new ParallaxError(d);
  if (failure.stack !== undefined) error.stack = `${error.name}: ${error.message}\n${failure.stack}`;
  return error;
}

/**
 * Buffers that can be transferred, once each: a buffer listed twice, or a shared one (it
 * is never moved, only shared), would make the transfer throw.
 */
export function transferList(buffers: readonly ArrayBufferLike[] | undefined): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const buffer of buffers ?? []) {
    if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) out.add(buffer);
  }
  return [...out];
}

/** Run one job here and now, as a worker would: clone in, run, clone out. */
export function runHere(def: JobDef<unknown, unknown>, input: unknown, transfer: readonly ArrayBuffer[] | undefined): unknown {
  const received = structuredClone(input, { transfer: transferList(transfer) });
  const output = def.run(received);
  return structuredClone(output, { transfer: transferList(def.transfer?.(output)) });
}

const now = (): number => (globalThis.performance?.now() ?? Date.now()) / 1000;

export class InlineJobs implements JobRunner {
  readonly mode = 'inline';
  readonly threads = 0;
  readonly #table: JobTable;
  #stats = { completed: 0, inline: 0, inlineSeconds: 0 };
  #disposed = false;

  constructor(table: JobTable) {
    this.#table = table;
  }

  get stats(): JobStats {
    return { ...this.#stats };
  }

  run<I, O>(key: JobKey<I, O>, input: I, options: JobOptions = {}): Promise<O> {
    if (this.#disposed) return Promise.reject(new ParallaxError(diagnostic('PP9532', `The job "${key.id}" was started after the runner was disposed`)));
    // Settle on a microtask, like a worker's reply, so callers never depend on a sync result.
    return Promise.resolve().then(() => {
      const def = lookupJob(this.#table, key.id);
      const start = now();
      try {
        return runHere(def, input, options.transfer) as O;
      } catch (error) {
        throw jobError(key.id, jobFailure(error));
      } finally {
        this.#stats.completed++;
        this.#stats.inline++;
        this.#stats.inlineSeconds += now() - start;
      }
    });
  }

  all<I, O>(key: JobKey<I, O>, inputs: readonly I[], transfer?: (input: I) => readonly ArrayBuffer[]): Promise<O[]> {
    return Promise.all(inputs.map((input) => this.run(key, input, transfer === undefined ? {} : { transfer: transfer(input) })));
  }

  share(bytes: Uint8Array): Uint8Array {
    return bytes;
  }

  dispose(): void {
    this.#disposed = true;
  }
}
