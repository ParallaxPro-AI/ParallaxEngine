import { describe, expect, it } from 'vitest';
import { fail, jobKey, ParallaxError } from '../../core/index.js';
import type { Diagnostic, JobRequest, JobResponse, JobTable } from '../../core/index.js';
import { InlineJobs, jobTable } from '../headless/jobs.js';
import { serveJobs, WorkerJobs } from './jobs.js';
import type { WorkerLike } from './jobs.js';

const SUM = jobKey<{ readonly values: Float64Array }, { readonly total: number; readonly doubled: Float64Array }>('test.sum');
const BOOM = jobKey<null, never>('test.boom');
const TABLE: JobTable = jobTable([
  {
    key: SUM,
    run: ({ values }: { values: Float64Array }) => ({ total: values.reduce((a, b) => a + b, 0), doubled: values.map((v) => v * 2) }),
    transfer: (out: { doubled: Float64Array }) => [out.doubled.buffer as ArrayBuffer],
  },
  { key: BOOM, run: () => fail('PP3999', 'the job said no', { fix: 'Ask nicely.' }) },
] as never);

interface Fake {
  readonly worker: WorkerLike;
  readonly posted: JobRequest[];
  /** Fail as a broken worker script does. */
  crash(message: string): void;
}

function fakeWorker(table: JobTable, hold = false): Fake {
  const scope: Parameters<typeof serveJobs>[0] = { onmessage: null, postMessage: () => {} };
  const posted: JobRequest[] = [];
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: () => {},
    postMessage: (message, transfer) => {
      const sent = structuredClone(message, { transfer: [...transfer] });
      posted.push(sent);
      if (!hold) setTimeout(() => scope.onmessage?.({ data: sent }), 0);
    },
  };
  scope.postMessage = (response: JobResponse, transfer) => {
    const back = structuredClone(response, { transfer });
    setTimeout(() => worker.onmessage?.({ data: back }), 0);
  };
  serveJobs(scope, table);
  return { worker, posted, crash: (message) => worker.onerror?.({ message }) };
}

const values = (...v: number[]): Float64Array => Float64Array.from(v);

describe('InlineJobs', () => {
  it('clones in and out: the caller keeps its input, and a transferred buffer is gone', async () => {
    const jobs = new InlineJobs(TABLE);
    const kept = values(1, 2, 3);
    expect((await jobs.run(SUM, { values: kept })).total).toBe(6);
    expect(kept.length).toBe(3);
    const moved = values(4, 5);
    const out = await jobs.run(SUM, { values: moved }, { transfer: [moved.buffer as ArrayBuffer] });
    expect(moved.length).toBe(0);
    expect([...out.doubled]).toEqual([8, 10]);
    expect(jobs.stats.completed).toBe(2);
  });

  it('never settles synchronously, and `all` keeps input order', async () => {
    const jobs = new InlineJobs(TABLE);
    let settled = false;
    const pending = jobs.run(SUM, { values: values(1) }).then(() => { settled = true; });
    expect(settled).toBe(false);
    await pending;
    expect((await jobs.all(SUM, [values(1), values(2, 2), values(3, 3, 3)].map((v) => ({ values: v })))).map((r) => r.total)).toEqual([1, 4, 9]);
  });

  it('a job\'s own diagnostic rejects the job; an unknown job and a disposed runner are coded', async () => {
    const jobs = new InlineJobs(TABLE);
    await expect(jobs.run(BOOM, null)).rejects.toMatchObject({ diagnostic: { code: 'PP3999', fix: 'Ask nicely.' } });
    await expect(jobs.run(jobKey('nope'), null)).rejects.toThrow(/PP9530.*no job "nope"/s);
    await expect(new WorkerJobs({ create: undefined, table: TABLE, onProblem: () => {} }).run(jobKey('nope'), null)).rejects.toThrow(/PP9530/);
    const notCloneable = jobs.run(SUM, { values: values(1), fn: () => 1 } as never);
    await expect(notCloneable).rejects.toBeInstanceOf(ParallaxError);
    jobs.dispose();
    await expect(jobs.run(SUM, { values: values(1) })).rejects.toMatchObject({ diagnostic: { code: 'PP9532' } });
  });

  it('rejects two jobs with one id', () => {
    expect(() => jobTable([{ key: SUM, run: () => 0 }, { key: SUM, run: () => 1 }] as never)).toThrow(/PP9530/);
  });
});

describe('WorkerJobs', () => {
  it('runs on workers, starting one more only while all are busy, up to the thread limit', async () => {
    const fakes: Fake[] = [];
    const jobs = new WorkerJobs({ create: () => { const f = fakeWorker(TABLE); fakes.push(f); return f.worker; }, table: TABLE, threads: 2, idleSeconds: 0, onProblem: () => {} });
    expect(jobs.mode).toBe('workers');
    expect(await jobs.run(SUM, { values: values(2, 3) })).toMatchObject({ total: 5 });
    expect(fakes.length).toBe(1);
    const results = await jobs.all(SUM, [1, 2, 3, 4].map((n) => ({ values: values(n) })));
    expect(results.map((r) => r.total)).toEqual([1, 2, 3, 4]);
    expect(fakes.length).toBe(2);
    expect(jobs.stats).toEqual({ completed: 5, inline: 0, inlineSeconds: 0 });
  });

  it('carries the job\'s diagnostic back from the worker', async () => {
    const jobs = new WorkerJobs({ create: () => fakeWorker(TABLE).worker, table: TABLE, threads: 1, idleSeconds: 0, onProblem: () => {} });
    await expect(jobs.run(BOOM, null)).rejects.toMatchObject({ diagnostic: { code: 'PP3999', message: 'the job said no' } });
    expect((await jobs.run(SUM, { values: values(1) })).total).toBe(1);
  });

  it('without workers runs inline; a crashed worker re-runs its untransferred jobs here, once warned', async () => {
    const none = new WorkerJobs({ create: undefined, table: TABLE, onProblem: () => {} });
    expect(none.mode).toBe('inline');
    expect((await none.run(SUM, { values: values(7) })).total).toBe(7);
    expect(none.stats.inline).toBe(1);

    const problems: Diagnostic[] = [];
    const held = fakeWorker(TABLE, true);
    const jobs = new WorkerJobs({ create: () => held.worker, table: TABLE, threads: 1, idleSeconds: 0, onProblem: (d) => problems.push(d) });
    const kept = jobs.run(SUM, { values: values(1, 1) });
    const moved = values(5);
    const lost = jobs.run(SUM, { values: moved }, { transfer: [moved.buffer as ArrayBuffer] });
    expect(held.posted.length).toBe(2);
    held.crash('job_worker.js 404');
    expect((await kept).total).toBe(2);
    await expect(lost).rejects.toMatchObject({ diagnostic: { code: 'PP9533' } });
    expect(problems.map((p) => [p.code, p.severity])).toEqual([['PP9533', 'warning']]);
    expect(jobs.mode).toBe('inline');
    expect((await jobs.run(SUM, { values: values(3) })).total).toBe(3);
  });

  it('stops idle workers and starts them again on demand', async () => {
    let timer: (() => void) | undefined;
    let created = 0;
    const jobs = new WorkerJobs({
      create: () => { created++; return fakeWorker(TABLE).worker; }, table: TABLE, threads: 1, idleSeconds: 5, onProblem: () => {},
      setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => { timer = undefined; },
    });
    await jobs.run(SUM, { values: values(1) });
    expect(jobs.live).toBe(1);
    timer!();
    expect(jobs.live).toBe(0);
    await jobs.run(SUM, { values: values(1) });
    expect(created).toBe(2);
  });

  it('shares bytes through SharedArrayBuffer only when the page is cross-origin isolated', () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(new WorkerJobs({ create: undefined, table: TABLE, onProblem: () => {} }).share(bytes)).toBe(bytes);
    const shared = new WorkerJobs({ create: undefined, table: TABLE, isolated: true, onProblem: () => {} }).share(bytes);
    expect(shared.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect([...shared]).toEqual([1, 2, 3]);
  });

  it('rejects in-flight jobs when disposed', async () => {
    const held = fakeWorker(TABLE, true);
    const jobs = new WorkerJobs({ create: () => held.worker, table: TABLE, threads: 1, idleSeconds: 0, onProblem: () => {} });
    const pending = jobs.run(SUM, { values: values(1) });
    jobs.dispose();
    await expect(pending).rejects.toMatchObject({ diagnostic: { code: 'PP9532' } });
  });
});
