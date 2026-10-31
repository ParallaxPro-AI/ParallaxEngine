/**
 * The job worker: a module Web Worker that answers `JobRequest`s from the engine's job
 * table. Bundled as `job_worker.js` next to `boot.js`; `bootBrowser` starts it through
 * `WorkerJobs`.
 */

import { serveJobs } from '../platform/index.js';
import { ENGINE_JOBS } from './jobs.js';

serveJobs(globalThis as unknown as Parameters<typeof serveJobs>[0], ENGINE_JOBS);
