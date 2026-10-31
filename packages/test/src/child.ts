/**
 * Entry of a playtest process (forked by runner.ts). Registers the module hooks for the
 * job's build, then runs the session and reports over IPC. Imports only Node built-ins
 * statically: everything else loads after the hooks are in place.
 */

import { register } from 'node:module';
import process from 'node:process';
import type { HookData } from './hooks.js';
import type { SessionJob, SessionMessage } from './results.js';

export interface ChildJob extends SessionJob {
  readonly hooks: HookData;
}

async function main(job: ChildJob, send: (message: SessionMessage) => void): Promise<void> {
  register(new URL('./hooks.ts', import.meta.url).href, { data: job.hooks });
  const { runSession } = await import('./session.js') as typeof import('./session.js');
  await runSession(job, send);
}

if (process.send === undefined) throw new Error('child.ts runs as a process forked by runProjectTests (it needs an IPC channel)');

function send(message: SessionMessage): void {
  process.send!(message);
}

process.once('message', (job) => {
  main(job as ChildJob, send).then(
    () => { process.disconnect!(); },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
});
