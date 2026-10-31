import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { FakePaymentHost } from '../../../platform/headless/payments.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, Fields, LogicInstance, SystemDef } from '../../kernel/index.js';
import { PAYMENT_EVENTS, payments } from './index.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function make(host: FakePaymentHost | undefined, onCompleted?: (e: Fields) => void) {
  const project = loadProject(files({
    'content/product/gems.json': { name: 'Gem pouch', kind: 'consumable', price: 100 },
    'content/product/no_ads.json': { name: 'No ads', kind: 'permanent', price: 300 },
    'scenes/main/scene.json': { entities: [] },
  }));
  expect(project.diagnostics).toEqual([]);
  const log: { event: string; payload: Fields }[] = [];
  const plugin = payments({ host: { product: (_k, id) => `ref:${id}`, describe: (_k, id) => ({ name: id, description: '' }) } });
  if (host !== undefined) plugin.connect(host);
  const system: SystemDef = {
    id: 'shop', scenes: [], runsWhileFrozen: false,
    handlers: [{ event: PAYMENT_EVENTS.completed, method: 'completed' }, { event: PAYMENT_EVENTS.failed, method: 'failed' }],
    create: () => ({
      completed: (_ctx: unknown, e: Fields) => { log.push({ event: 'completed', payload: e }); onCompleted?.(e); },
      failed: (_ctx: unknown, e: Fields) => { log.push({ event: 'failed', payload: e }); },
    }) as LogicInstance,
  };
  const behaviors: BehaviorDef[] = [];
  const kernel = new Kernel({ project, plugins: [plugin], context: {}, game: { components: [], resources: [], events: [], behaviors, systems: [system] } });
  kernel.start('main');
  return { kernel, engine: plugin.engine, log, step: () => kernel.step(1 / 60) };
}

describe('payments', () => {
  it('reads the catalog, sells a consumable, grants it in a frame and confirms it after', async () => {
    const host = new FakePaymentHost();
    const g = make(host);
    g.step();
    await tick();
    g.step();
    expect(g.engine.ready).toBe(true);
    expect(g.engine.price('gems')).toBe('100 Plux');
    expect(g.engine.buy('gems')).toBe(true);
    expect(g.engine.pending('gems')).toBe(true);
    expect(g.engine.buy('gems')).toBe(false);
    await tick();
    g.step();
    expect(g.engine.pending('gems')).toBe(false);
    expect(g.log).toEqual([{ event: 'completed', payload: { product: 'ref:gems', purchase: 'test-1' } }]);
    expect(host.confirmed).toEqual(['test-1']);
    // Consumables can be bought again; they are never "owned".
    expect(g.engine.owns('gems')).toBe(false);
    expect(g.engine.buy('gems')).toBe(true);
  });

  it('permanent products are owned once; a second buy is already_owned', async () => {
    const host = new FakePaymentHost();
    const g = make(host);
    g.step();
    g.engine.buy('no_ads');
    await tick();
    g.step();
    expect(g.engine.owns('no_ads')).toBe(true);
    expect(g.engine.buy('no_ads')).toBe(false);
    g.step();
    expect(g.log.map((l) => [l.event, l.payload['reason'] ?? null])).toEqual([['completed', null], ['failed', 'already_owned']]);
    // Ownership is in snapshots.
    const snap = g.kernel.snapshot();
    const fresh = make(new FakePaymentHost());
    fresh.kernel.restore(snap);
    expect(fresh.engine.owns('no_ads')).toBe(true);
  });

  it('restores entitlements from the host, reports cancels, and is unavailable without a host', async () => {
    const owned = make(new FakePaymentHost({ owned: ['no_ads'], answer: () => 'cancelled' }));
    owned.step();
    await tick();
    owned.step();
    expect(owned.engine.owns('no_ads')).toBe(true);
    owned.engine.buy('gems');
    await tick();
    owned.step();
    expect(owned.log).toEqual([{ event: 'failed', payload: { product: 'ref:gems', reason: 'cancelled', message: '' } }]);
    const none = make(undefined);
    expect(none.engine.available).toBe(false);
    expect(none.engine.buy('gems')).toBe(false);
    none.step();
    expect(none.log[0]!.payload['reason']).toBe('unavailable');
  });

  it('a handler that crashes leaves the purchase unconfirmed; the next session grants it', async () => {
    const host = new FakePaymentHost();
    const crashing = make(host, () => { throw new Error('boom'); });
    crashing.step();
    crashing.engine.buy('gems');
    await tick();
    expect(() => crashing.step()).toThrow('boom');
    expect(host.confirmed).toEqual([]);
    host.restart();
    const next = make(host);
    next.step();
    expect(next.log.map((l) => l.event)).toEqual(['completed']);
    expect(host.confirmed).toEqual(['test-1']);
  });

  it('an unknown product is PP3345', () => {
    const g = make(new FakePaymentHost());
    let code = '';
    try { g.engine.buy('gold'); } catch (e) { code = (e as ParallaxError).diagnostic.code; }
    expect(code).toBe('PP3345');
  });
});
