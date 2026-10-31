import { describe, expect, it } from 'vitest';
import { main } from './cli.js';

describe('parallax command line', () => {
  it('rejects unknown commands and options with usage (exit 2)', async () => {
    expect(await main(['launch'])).toBe(2);
    expect(await main(['build', '.', '--fast'])).toBe(2);
    expect(await main(['edit', '.', '--port', 'abc'])).toBe(2);
    expect(await main(['dev', '.'])).toBe(2);
    expect(await main([])).toBe(2);
    expect(await main(['export'])).toBe(2);
    expect(await main(['export', 'zip', '.', 'out'])).toBe(2);
    expect(await main(['export', 'web', '.'])).toBe(2);
    expect(await main(['serve', '.', '--port', '99999'])).toBe(2);
    expect(await main(['serve', '.', '--ticket-secret-env', 'PARALLAX_TEST_UNSET_SECRET', '--match', 'm'])).toBe(2);
    expect(await main(['serve-relay', 'extra'])).toBe(2);
  });

  it('fails a build of a folder that is not a project (PP9512)', async () => {
    expect(await main(['build', '/nonexistent/parallax-project', '--json'])).toBe(1);
  });
});
