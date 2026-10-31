/**
 * The Python-facing net options added for netcode: `net(predict=, interpolation=, rejoin=,
 * rewind=)`, `PlayerRejoined`, and `ctx.net.raycast` / `seen_position` argument handling.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ParallaxError } from '../core/index.js';
import { kw, PrefabRef, resetDeclarations } from './index.js';
import { net, NetApi, PlayerRejoined } from './net.js';

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return error instanceof ParallaxError ? error.diagnostic.code : String(error); }
  return undefined;
}

class Walker { static readonly __behavior_id__ = 'walker'; }

beforeEach(() => resetDeclarations());

describe('net(...) netcode options', () => {
  it('reads predict, interpolation, rejoin and rewind', () => {
    const p = net(kw({ max_players: 4, player_prefab: new PrefabRef('hero'), predict: [Walker], interpolation: 0.1, rejoin: 0, rewind: 0.25 }));
    expect(p.options).toMatchObject({ predict: ['walker'], interpolation: 0.1, rejoinSeconds: 0, rewindWindow: 0.25 });
    const plain = net(kw({ max_players: 4, player_prefab: new PrefabRef('hero') }));
    expect(plain.options.predict).toBeUndefined();
  });

  it('rejects what it cannot use, with codes', () => {
    const base = { max_players: 4, player_prefab: new PrefabRef('hero') };
    expect(code(() => net(kw({ ...base, predict: [class NotABehavior {}] })))).toBe('PP3350');
    expect(code(() => net(kw({ ...base, predict: Walker })))).toBe('PP3350');
    expect(code(() => net(kw({ ...base, interpolation: 2 })))).toBe('PP3350');
    expect(code(() => net(kw({ ...base, rewind: -1 })))).toBe('PP3350');
    expect(code(() => net(kw({ ...base, rejoin: 'soon' })))).toBe('PP3350');
  });

  it('PlayerRejoined is an event handle; the lag-compensated queries check their arguments', () => {
    expect((PlayerRejoined as unknown as { __event_id__: string }).__event_id__).toBe('player_rejoined');
    const p = net(kw({ max_players: 2, player_prefab: new PrefabRef('hero') }));
    const api = new NetApi(p);
    expect(code(() => api.raycast('not a player', null, null))).toBe('PP3352');
    expect(code(() => api.seen_position('not an entity', 'nor a player'))).toBe('PP3352');
  });
});
