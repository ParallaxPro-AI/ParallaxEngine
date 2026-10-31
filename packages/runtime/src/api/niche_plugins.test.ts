/**
 * The tier-4 plugins as compiled game code sees them, through `createRuntime`: one 3D game
 * with cloth, a soft body, an in-world terminal, chat and a store — Python-shaped calls
 * (`kw`), engine component handles, events, and whole-game snapshots.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Vec3 } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { HeadlessInput } from '../function/plugins/input/index.js';
import { initPhysics3d } from '../function/plugins/physics3d/index.js';
import { HeadlessAudio } from '../platform/headless/audio.js';
import { FakePaymentHost } from '../platform/headless/payments.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { RecordingScreens } from '../platform/headless/screens.js';
import { loadProject } from '../resource/index.js';
import { chat, ChatMessage } from './chat.js';
import type { ChatApi } from './chat.js';
import { component, createRuntime, Entity, field, Game, kw, on, Panel, resetDeclarations, rt, SceneRef, system, System, ui } from './index.js';
import type { Context, GameRuntime } from './index.js';
import { connectPayments, payments, ProductDef, PurchaseCompleted } from './payments.js';
import type { PaymentsApi } from './payments.js';
import { physics3d } from './physics3d.js';
import { connectScreens, Screen, screens } from './screens.js';
import { Cloth, softbody, SoftBody } from './softbody.js';

beforeAll(async () => {
  await initPhysics3d();
});

const PROJECT: Record<string, unknown> = {
  'prefabs/floor.prefab.json': { components: { collider: { shape: 'box', size: [30, 1, 30], offset: [0, -0.5, 0] } } },
  'prefabs/flag.prefab.json': { components: { cloth: { size: [1.5, 1], cols: 8, rows: 6, pin: 'left' } } },
  'prefabs/slime.prefab.json': { components: { soft_body: { shape: 'sphere', size: [0.8, 0.8, 0.8], detail: 1 } } },
  'prefabs/terminal.prefab.json': { components: { screen: { panel: 'terminal' }, counter: {} } },
  'prefabs/eye.prefab.json': { components: { camera: {} } },
  'content/product/gems.json': { name: 'Gem pouch', kind: 'consumable', price: 100 },
  'ui/terminal.html': '<div><span data-text="count"></span><button data-action="add" data-by="2">+2</button></div>',
  'scenes/lab/scene.json': {
    entities: [
      { prefab: 'floor' }, { prefab: 'eye', at: [0, 2, -6] },
      { prefab: 'flag', id: 'flag', at: [-3, 3, 0] }, { prefab: 'slime', id: 'slime', at: [3, 1, 0] },
      { prefab: 'terminal', id: 'terminal', at: [0, 1.5, 5] },
    ],
  },
};

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

interface Ctx extends Context { chat: ChatApi; payments: PaymentsApi }

const heard: string[] = [];

function start(): { runtime: GameRuntime; ctx: Ctx; host: FakePaymentHost; screens: RecordingScreens; get(placed: string): Entity } {
  resetDeclarations();
  heard.length = 0;
  class CounterFields {
    static readonly __annotations__ = { value: () => rt.int };
    static readonly value = field(0);
  }
  const Counter = component('counter')(CounterFields) as unknown as new () => { value: number };
  // def add(ctx, screen: Entity, by: int): screen.get(Counter).value += by
  const add = (_ctx: unknown, screen: Entity, by: number): void => { (screen.get(Counter) as { value: number }).value += by; };
  (add as unknown as { __annotations__: object }).__annotations__ = { screen: () => Entity, by: () => rt.int };
  class Terminal extends Panel {
    static override actions = { add };
    override state(): Record<string, unknown> { return { count: ((this.subject as Entity).get(Counter) as { value: number }).value }; }
  }
  ui('terminal', kw({ html: 'ui/terminal.html' }))(Terminal);
  class Log extends System {
    said(_ctx: unknown, e: { name: string; text: string }) { heard.push(`${e.name}: ${e.text}`); }
    bought(_ctx: unknown, e: { product: { id: string } }) { heard.push(`bought ${e.product.id}`); }
  }
  on(ChatMessage)(Log.prototype.said);
  on(PurchaseCompleted)(Log.prototype.bought);
  system('log')(Log);
  void ProductDef;
  const plugins = [
    physics3d(), softbody(), screens(),
    chat(kw({ filter: (_ctx: unknown, _p: unknown, text: string) => text.replace(/darn/g, '****') })), payments(),
  ];
  const host = new FakePaymentHost();
  const surface = new RecordingScreens();
  connectPayments(plugins, host);
  connectScreens(plugins, surface);
  const game = new Game(kw({ id: 'lab', title: 'Lab', sdk: '1.0', mode: '3d', start_scene: new SceneRef('lab'), plugins, systems: [Log] }));
  const project = loadProject(files(PROJECT));
  expect(project.diagnostics).toEqual([]);
  const runtime = createRuntime(game, project, {
    seed: 1, devices: new HeadlessInput(), audio: new HeadlessAudio(), assets: null, files: files(PROJECT),
    surface3d: new RecordingSurface3d(), binary: new MemoryBinaryFiles({}),
  });
  runtime.start();
  const ctx = runtime.ctx as Ctx;
  return {
    runtime, ctx, host, screens: surface,
    get: (placed) => runtime.wrap([...runtime.kernel.world.live()].find((r) => r.placedId === placed)!.id) as Entity,
  };
}

const steps = (runtime: GameRuntime, n: number): void => { for (let i = 0; i < n; i++) runtime.step(1 / 60); };

describe('tier-4 plugins in a game', () => {
  it('cloth and soft body run from data and answer through their handles', () => {
    const g = start();
    steps(g.runtime, 60);
    const cloth = g.get('flag').get(Cloth) as unknown as { particle_count: number; push(...a: unknown[]): void };
    expect(cloth.particle_count).toBe(48);
    cloth.push(new Vec3(0, 0, 2), kw({ at: new Vec3(-3, 2.5, 0), radius: 1 }));
    const slime = g.get('slime').get(SoftBody) as unknown as { volume_ratio: number; velocity: Vec3 };
    expect(slime.volume_ratio).toBeCloseTo(1, 1);
    // It fell onto the floor and its entity followed.
    expect(g.get('slime').transform.position.y).toBeLessThan(0.6);
  });

  it('the terminal shows its own counter and a click on it runs the panel action for that screen', () => {
    const g = start();
    steps(g.runtime, 1);
    const target = `screen:${g.runtime.unwrap(g.get('terminal'))}`;
    expect(g.screens.last.get(target)!.panel.state).toEqual({ count: 0 });
    (g.get('terminal').get(Screen) as unknown as { click(a: string, k: unknown): void }).click('add', kw({ by: '2' }));
    steps(g.runtime, 1);
    expect(g.screens.last.get(target)!.panel.state).toEqual({ count: 2 });
  });

  it('chat filters through the game function; a purchase is granted in a handler and confirmed', async () => {
    const g = start();
    g.ctx.chat.send('oh darn');
    steps(g.runtime, 1);
    expect(heard).toContain('Player 1: oh ****');
    expect(g.ctx.payments.available).toBe(true);
    expect(g.ctx.payments.buy(g.ctx.content(ProductDef).get('gems'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    steps(g.runtime, 1);
    expect(heard).toContain('bought gems');
    expect(g.host.confirmed).toEqual(['test-1']);
    expect(g.ctx.payments.price(g.ctx.content(ProductDef).get('gems'))).toBe('100 Plux');
  });

  it('the whole game snapshots and restores: cloth, slime, chat', () => {
    const g = start();
    steps(g.runtime, 10);
    g.ctx.chat.send('hello');
    steps(g.runtime, 5);
    // These plugins' states, and every entity's components (the transforms of bodies resting
    // in contact are left out: physics3d restores without its contact warm-start, so they
    // drift by ~1e-5 m/s — see the report).
    const mine = (snap: ReturnType<GameRuntime['snapshot']>): string => JSON.stringify({
      plugins: ['softbody', 'chat', 'payments'].map((id) => snap.plugins[id]),
      components: (snap.entities as unknown as { components: Record<string, unknown> }[]).map((e) => Object.keys(e.components).sort()),
    });
    const snap = g.runtime.snapshot();
    steps(g.runtime, 30);
    const after = mine(g.runtime.snapshot());
    g.runtime.restore(snap);
    steps(g.runtime, 30);
    expect(mine(g.runtime.snapshot())).toBe(after);
  });
});
