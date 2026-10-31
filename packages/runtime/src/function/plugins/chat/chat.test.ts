import { describe, expect, it } from 'vitest';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields, KernelPlugin, LogicInstance, SystemDef } from '../../kernel/index.js';
import { CHAT_EVENTS, chat } from './index.js';
import type { ChatHost } from './index.js';
import { LoopbackChannels, matchPlugin } from './testing.js';

function make(match: KernelPlugin | null, host: Partial<ChatHost> = {}, options: Partial<{ perSecond: number; burst: number; maxLength: number }> = {}) {
  const project = loadProject({ list: () => ['scenes/main/scene.json'], read: () => JSON.stringify({ entities: [] }) });
  const log: { event: string; payload: Fields }[] = [];
  const plugin = chat({ maxLength: options.maxLength ?? 40, perSecond: options.perSecond ?? 1, burst: options.burst ?? 3, history: 5, host: { player: (_k, seat) => `P${seat}`, ...host } });
  const system: SystemDef = {
    id: 'watch', scenes: [], runsWhileFrozen: false,
    handlers: [{ event: CHAT_EVENTS.message, method: 'message' }, { event: CHAT_EVENTS.rejected, method: 'rejected' }],
    create: () => ({
      message: (_c: unknown, e: Fields) => { log.push({ event: 'message', payload: e }); },
      rejected: (_c: unknown, e: Fields) => { log.push({ event: 'rejected', payload: e }); },
    }) as LogicInstance,
  };
  const kernel = new Kernel({ project, plugins: [...(match === null ? [] : [match]), plugin], context: {}, game: { components: [], resources: [], events: [], behaviors: [], systems: [system] } });
  kernel.start('main');
  return { kernel, engine: plugin.engine, log, step: () => kernel.step(1 / 60) };
}

describe('chat, single player', () => {
  it('accepts lines, refuses empty and long ones, rate-limits, and keeps a bounded history', () => {
    const g = make(null);
    expect(g.engine.send(0, '  hello  ')).toBe(true);
    expect(g.engine.send(0, '   ')).toBe(false);
    expect(g.engine.send(0, 'x'.repeat(41))).toBe(false);
    g.step();
    expect(g.log.map((l) => [l.event, l.payload['text'], l.payload['reason'] ?? null])).toEqual([
      ['message', 'hello', null], ['rejected', '   ', 'empty'], ['rejected', 'x'.repeat(41), 'too_long'],
    ]);
    // Burst of 3: two more pass, the fourth is refused; after a second a token is back.
    g.engine.send(0, 'b');
    g.engine.send(0, 'c');
    g.engine.send(0, 'd');
    g.step();
    expect(g.log.slice(3).map((l) => l.payload['reason'] ?? l.payload['text'])).toEqual(['b', 'c', 'rate']);
    for (let i = 0; i < 60; i++) g.step();
    for (const t of ['e', 'f', 'g']) g.engine.send(0, t);
    // One token came back over the second: e passes, f and g are refused.
    expect(g.engine.lines().map((l) => l.text)).toEqual(['hello', 'b', 'c', 'e']);
    for (let i = 0; i < 180; i++) g.step();
    for (const t of ['h', 'i']) g.engine.send(0, t);
    // History keeps the last 5.
    expect(g.engine.lines().map((l) => l.text)).toEqual(['b', 'c', 'e', 'h', 'i']);
  });

  it('the profanity hook masks or refuses, and muting hides a player', () => {
    const g = make(null, { filter: (_k, _p, text) => (text.includes('heck') ? null : text.replace(/darn/g, '****')) });
    g.engine.send(0, 'oh darn it');
    g.engine.send(0, 'what the heck');
    g.step();
    expect(g.log.map((l) => l.payload['reason'] ?? l.payload['text'])).toEqual(['oh **** it', 'filtered']);
    g.engine.mute('player-0', true);
    expect(g.engine.lines()).toEqual([]);
    expect(g.engine.muted('player-0')).toBe(true);
  });

  it('the log rides in snapshots', () => {
    const g = make(null);
    g.engine.send(0, 'one');
    g.step();
    const snap = g.kernel.snapshot();
    g.engine.send(0, 'two');
    g.kernel.restore(snap);
    expect(g.engine.lines().map((l) => l.text)).toEqual(['one']);
  });
});

describe('chat over the loopback net', () => {
  it('a client line goes to the server, is checked there, and reaches every client in order', () => {
    const hub = new LoopbackChannels();
    const seats = [{ index: 0, name: 'Host', local: true }, { index: 1, name: 'Ana', local: false }, { index: 2, name: 'Bo', local: false }];
    const server = make(matchPlugin(hub.server([1, 2]), seats), { filter: (_k, _p, t) => (t === 'bad' ? null : t) });
    const ana = make(matchPlugin(hub.client(1), seats.map((s) => ({ ...s, local: s.index === 1 }))));
    const bo = make(matchPlugin(hub.client(2), seats.map((s) => ({ ...s, local: s.index === 2 }))));
    expect(ana.engine.send(ana.engine.localSeat(), 'hi all')).toBe(true);
    // Nothing shows on the client until the server accepted it.
    ana.step();
    expect(ana.engine.lines()).toEqual([]);
    server.step();
    server.engine.send(0, 'welcome');
    ana.step();
    bo.step();
    for (const g of [server, ana, bo]) expect(g.engine.lines().map((l) => `${l.name}: ${l.text}`)).toEqual(['Ana: hi all', 'Host: welcome']);
    // A refused line comes back to its sender only.
    bo.engine.send(2, 'bad');
    bo.step();
    server.step();
    bo.step();
    ana.step();
    expect(bo.log.at(-1)!.payload).toMatchObject({ reason: 'filtered', text: 'bad' });
    expect(ana.log.map((l) => l.event)).toEqual(['message', 'message']);
    // The client sent only text; the wire never carries a name or seat it chose itself.
    expect(hub.sent.filter(([from]) => from !== 'server').map(([, , , payload]) => payload)).toEqual([{ text: 'hi all' }, { text: 'bad' }]);
  });
});
