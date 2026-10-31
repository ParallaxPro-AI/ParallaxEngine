import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'threads',
    // vitest 2: set both, or minThreads defaults to cores - 1 and tinypool rejects it.
    // The laptop is shared; the root `pnpm test` tightens this further via env.
    poolOptions: { threads: { maxThreads: 2, minThreads: 1 } },
    testTimeout: 60000,
  },
});
