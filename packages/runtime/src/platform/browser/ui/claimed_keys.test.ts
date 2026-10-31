import { describe, expect, it } from 'vitest';
import { ClaimedKeys } from './claimed_keys.js';
import type { ClaimableKey } from './claimed_keys.js';

class Key implements ClaimableKey {
  prevented = false;
  stopped = false;
  constructor(readonly code: string, readonly repeat = false) {}
  preventDefault(): void { this.prevented = true; }
  stopPropagation(): void { this.stopped = true; }
}

describe('ClaimedKeys', () => {
  it('stops a shortcut key and its repeats from reaching the game, until a fresh press', () => {
    const claimed = new ClaimedKeys();
    const press = new Key('KeyP');
    claimed.claim(press);
    expect([press.prevented, press.stopped]).toEqual([true, true]);

    const repeat = new Key('KeyP', true);
    expect(claimed.swallow(repeat)).toBe(true);
    expect(repeat.stopped).toBe(true);

    const other = new Key('KeyW', true);
    expect(claimed.swallow(other)).toBe(false);
    expect(other.stopped).toBe(false);

    // Released and pressed again (or focus lost before the keyup): the game hears it.
    const again = new Key('KeyP');
    expect(claimed.swallow(again)).toBe(false);
    expect(again.stopped).toBe(false);
    expect(claimed.swallow(new Key('KeyP', true))).toBe(false);
  });
});
