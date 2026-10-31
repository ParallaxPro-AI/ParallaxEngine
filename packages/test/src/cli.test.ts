import { describe, expect, it } from 'vitest';
import { main } from './cli.js';

describe('parallax test (main)', () => {
  it('refuses bad arguments with exit code 2 before running anything', async () => {
    expect(await main([])).toBe(2);
    expect(await main(['examples/paddle_duel', 'examples/chess'])).toBe(2);
    expect(await main(['examples/paddle_duel', '--timeout', '0'])).toBe(2);
    expect(await main(['examples/paddle_duel', '--filter'])).toBe(2);
    expect(await main(['examples/paddle_duel', '--frobnicate'])).toBe(2);
  });
});
