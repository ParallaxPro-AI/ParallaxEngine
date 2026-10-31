/**
 * The `jobs` service: the platform's `JobRunner` (core port) as plugins reach it, to run
 * pure work off the main thread (`boot/jobs.ts` lists the engine's jobs). Provided by boot
 * — workers in a browser, inline headless — before the game starts; look it up at use,
 * with `kernel.tryService` where a plugin also works without it.
 */

import type { JobRunner } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export const JOBS_SERVICE: ServiceKey<JobRunner> = serviceKey<JobRunner>(
  'jobs', 'Start the game through boot (bootBrowser / bootHeadless), which provides the job runner.',
);
