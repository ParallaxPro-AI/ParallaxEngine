import { describe, expect, it } from 'vitest';
import { Cell, Cell3, Color, SeededRandom, Vec2, Vec3 } from '../../core/index.js';
import type { EntityId, ProjectFiles, RandomState } from '../../core/index.js';
import { loadProject } from '../../resource/index.js';
import type { Json } from '../../resource/index.js';
import type { BehaviorDef, GameDefinition, KernelPlugin, LogicInstance, SystemDef } from './definitions.js';
import { Kernel, KERNEL_EVENTS } from './kernel.js';
import { COPY, decode, encode, t } from './schema.js';
import type { EntityCodec, FieldType, Schema } from './schema.js';
import type { Snapshot } from './snapshot.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function game(overrides: Partial<GameDefinition>): GameDefinition {
  return { components: [], resources: [], events: [], behaviors: [], systems: [], ...overrides };
}

/** Value types compare by content; JSON.stringify can't see their private fields. */
function plain(_key: string, value: unknown): unknown {
  if (value instanceof Vec3) return { vec3: [value.x, value.y, value.z] };
  if (value instanceof Vec2) return { vec2: [value.x, value.y] };
  if (value instanceof Color) return { color: [value.r, value.g, value.b, value.a] };
  return value;
}

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Entity handles in these tests are bare ids (the kernel's identity handles). */
const IDS: EntityCodec = {
  encode: (handle) => handle as number,
  decode: (value) => value,
};

// ── The test game: movement, spawning, despawning, modifiers, hierarchy, a plugin ──

interface Ctx { k: Kernel; starts: number; ends: number }

const BODY: Schema = {
  vel: t.vec3({ default: new Vec3(1, 0.5, 0) }),
  hp: t.int({ default: 100, min: 0, max: 1000, modifiable: true }),
  tint: t.color({ default: Color.WHITE }),
  target: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null },
  path: t.list({ kind: 'vec2' }, { default: [] }),
  inv: { type: { kind: 'dict', of: { kind: 'int' } }, default: {} },
  meta: t.json({ default: { note: 'x', n: [1, 2] } }),
  stats: {
    type: { kind: 'record', fields: { armor: t.number({ default: 0 }), kinds: t.list({ kind: 'tag' }, { default: [] }) } },
    default: { armor: 0, kinds: [] },
  },
};

function mover(): BehaviorDef {
  return {
    id: 'mover',
    params: { speed: t.number({ default: 1 }) },
    state: {
      travelled: t.number({ default: 0 }),
      phase: t.enum(['a', 'b'], { default: 'a' }),
      next_spawn: t.number({ default: 0 }),
      spawned: t.list({ kind: 'entity' }, { default: [] }),
    },
    requires: ['body'],
    handlers: [],
    create: () => ({
      start(this: LogicInstance, ctx: Ctx) { ctx.starts++; },
      end(this: LogicInstance, ctx: Ctx) { ctx.ends++; },
      update(this: LogicInstance & Record<string, unknown>, ctx: Ctx, dt: number) {
        const { k } = ctx;
        const id = this['entity'] as EntityId;
        const record = k.world.require(id);
        const body = record.components.get('body')!;
        const vel = body['vel'] as Vec3;
        const step = (this['speed'] as number) * dt;
        record.transform.position = record.transform.position.__add__(new Vec3(vel.x * step, vel.y * step, 0));
        this['travelled'] = (this['travelled'] as number) + step;
        this['phase'] = this['phase'] === 'a' ? 'b' : 'a';
        body['hp'] = (body['hp'] as number) - 1;
        (body['path'] as Vec2[]).push(new Vec2(k.time.frame, step));
        const inv = body['inv'] as Record<string, number>;
        inv['frames'] = (inv['frames'] ?? 0) + 1;
        (body['stats'] as { armor: number }).armor += 0.5;
        if (k.time.frame % 25 === 0) k.modify(id, 'body', 'hp', { key: 'haste', multiply: 1.5, seconds: 0.3 });
        if (k.time.frame % 40 === 0) k.modify(id, 'body', 'hp', { add: 2, stack: true });
        if (k.time.now >= (this['next_spawn'] as number)) {
          const pos = record.transform.position;
          const bullet = k.spawn('bullet', { at: [pos.x, pos.y] });
          const spawned = this['spawned'] as EntityId[];
          spawned.push(bullet.id);
          if (spawned.length > 3) spawned.shift();
          body['target'] = bullet.id;
          this['next_spawn'] = k.time.now + 0.2;
        }
      },
    }),
  };
}

function bullet(): BehaviorDef {
  return {
    id: 'bullet',
    params: {},
    state: { die_at: t.number({ default: 0 }) },
    requires: [],
    handlers: [],
    create: () => ({
      start(this: LogicInstance & Record<string, unknown>, ctx: Ctx) { this['die_at'] = ctx.k.time.now + 0.35; },
      update(this: LogicInstance & Record<string, unknown>, ctx: Ctx, dt: number) {
        const record = ctx.k.world.require(this['entity'] as EntityId);
        record.transform.position = record.transform.position.__add__(new Vec3(0, 3 * dt, 0));
        if (ctx.k.time.now >= (this['die_at'] as number)) ctx.k.destroy(record.id);
      },
    }),
  };
}

const scorer: SystemDef = {
  id: 'scorer',
  scenes: [],
  handlers: [{ event: KERNEL_EVENTS.spawned, method: 'counted' }],
  create: () => ({
    counted(ctx: Ctx) {
      const score = ctx.k.resource('score');
      score['value'] = (score['value'] as number) + 1;
      score['best'] = Math.max(score['best'] as number, score['value'] as number);
    },
  }),
};

/** A plugin with state outside components: a random stream feeding a resource. */
function noisePlugin(seed: number): KernelPlugin {
  const rng = new SeededRandom(seed);
  return {
    id: 'noise',
    install: (k) => { k.addHook('physics', () => { k.resource('score')['noise'] = rng.next(); }); },
    snapshot: () => [...rng.state()],
    restore: (_k, state) => { rng.restore(state as unknown as RandomState); },
  };
}

const DATA = {
  'prefabs/ship.prefab.json': {
    components: { body: { hp: 50, tint: '#ff8800' } },
    behaviors: { mover: { speed: 2 } },
    children: [{ name: 'gun', at: [0, 1], components: { body: { hp: 5 } } }],
    tags: ['ship'],
  },
  'prefabs/bullet.prefab.json': { behaviors: { bullet: {} }, tags: ['bullet'] },
  'scenes/main/scene.json': {
    entities: [{ prefab: 'ship', id: 'hero', at: [0, 0] }, { prefab: 'ship', id: 'rival', at: [5, 5], params: { mover: { speed: 3 } } }],
  },
  'scenes/other/scene.json': { entities: [] },
};

const GAME = game({
  components: [{ id: 'body', schema: BODY }],
  resources: [{
    id: 'score',
    schema: {
      value: t.int({ default: 0 }),
      best: t.int({ default: 0, keep: 'profile' }),
      mode: t.string({ default: 'normal', keep: 'session' }),
      noise: t.number({ default: 0, keep: 'scene' }),
      mult: t.number({ default: 1, modifiable: true }),
    },
  }],
  behaviors: [mover(), bullet()],
  systems: [scorer],
});

function build(plugins: KernelPlugin[] = [noisePlugin(42)]): { k: Kernel; ctx: Ctx } {
  const project = loadProject(files(DATA));
  expect(project.diagnostics).toEqual([]);
  const ctx = { starts: 0, ends: 0 } as Ctx;
  const k = new Kernel({ project, game: GAME, plugins, context: ctx });
  ctx.k = k;
  return { k, ctx };
}

/** Everything observable, read from live state (effective values, not the snapshot). */
function digest(k: Kernel): string {
  return JSON.stringify({
    time: [k.time.now, k.time.frame, k.time.dt],
    score: k.resource('score'),
    entities: [...k.world.live()].map((r) => ({
      id: r.id, prefab: r.prefab, placed: r.placedId, child: r.childName, parent: r.parent, children: r.children,
      tags: [...r.tags], visible: r.visible,
      at: [r.transform.position, r.transform.worldPosition(), r.transform.rotation.x, r.transform.scale],
      components: Object.fromEntries(r.components),
      behaviors: r.behaviors.map((b) => b.instance),
    })),
  }, plain);
}

function run(k: Kernel, frames: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < frames; i++) {
    k.step(1 / 50);
    out.push(digest(k));
  }
  return out;
}

// ── Determinism ────────────────────────────────────────────────────────────────

describe('snapshot / restore determinism', () => {
  it('replays identically from a snapshot, in place and in a fresh kernel via JSON', () => {
    const { k, ctx } = build();
    k.start('main');
    k.modifyResource('score', 'mult', { key: 'combo', add: 1, seconds: 0.5 });
    // 31 frames of 1/50 s leave a partial fixed step in the accumulator.
    run(k, 31);
    const snap = k.snapshot();
    const json = JSON.stringify(snap);
    const before = digest(k);
    const first = run(k, 60);
    expect(new Set(first).size).toBe(60);

    const starts = ctx.starts;
    const ends = ctx.ends;
    k.restore(snap);
    expect(digest(k)).toBe(before);
    expect([ctx.starts, ctx.ends]).toEqual([starts, ends]);
    expect(run(k, 60)).toEqual(first);
    // The snapshot was not aliased by the restored state: restoring again replays again.
    k.restore(snap);
    expect(run(k, 60)).toEqual(first);
    expect(JSON.stringify(snap)).toBe(json);

    const fresh = build();
    fresh.k.restore(JSON.parse(json) as Snapshot);
    expect(fresh.ctx.starts).toBe(0);
    expect(digest(fresh.k)).toBe(before);
    expect(run(fresh.k, 60)).toEqual(first);
  });

  it('exercises entity churn: generations and the free list come back exactly', () => {
    const { k } = build();
    k.start('main');
    run(k, 40);
    const snap = k.snapshot();
    expect(snap.ids.free.length).toBeGreaterThan(0);
    expect(snap.ids.generations.some((g) => g > 0)).toBe(true);
    const ids = (frames: number): number[][] => {
      const out: number[][] = [];
      for (let i = 0; i < frames; i++) { k.step(1 / 50); out.push([...k.world.live()].map((r) => r.id)); }
      return out;
    };
    const first = ids(50);
    k.restore(snap);
    expect(ids(50)).toEqual(first);
  });

  it('round-trips the snapshot itself: snapshot(restore(s)) == s', () => {
    const { k } = build();
    k.start('main');
    k.modifyResource('score', 'mult', { add: 3, stack: true });
    run(k, 37);
    const snap = viaJson(k.snapshot());
    const other = build().k;
    other.restore(snap);
    expect(viaJson(other.snapshot())).toEqual(snap);
  });
});

// ── Restore semantics ─────────────────────────────────────────────────────────

describe('restore semantics', () => {
  it('keeps stored entity ids valid and stale ones stale', () => {
    const { k } = build();
    k.start('main');
    run(k, 30);
    const doomed = [...k.world.live()].find((r) => r.tags.has('bullet'))!.id;
    k.destroy(doomed);
    k.step(1 / 50);
    const hero = [...k.world.live()].find((r) => r.placedId === 'hero')!.id;
    const snap = k.snapshot();
    run(k, 40);
    k.destroy(hero);
    k.step(1 / 50);
    expect(k.world.isAlive(hero)).toBe(false);
    k.restore(snap);
    expect(k.world.isAlive(hero)).toBe(true);
    expect(k.world.isAlive(doomed)).toBe(false);
    expect(() => k.world.require(doomed)).toThrow(/PP3002/);
  });

  it('drops running timers and tasks; their handles read inactive', () => {
    const { k } = build();
    k.start('main');
    const fired: string[] = [];
    const snap = k.snapshot();
    const timer = k.every({ kind: 'game' }, 0.05, () => fired.push('timer'));
    const task = k.run({ kind: 'game' }, (function* body() {
      for (;;) { yield { kind: 'frames', frames: 1 }; fired.push('task'); }
    })());
    k.step(1 / 50);
    expect(fired).toContain('task');
    k.restore(snap);
    expect([timer.active, task.active]).toEqual([false, false]);
    fired.length = 0;
    run(k, 10);
    expect(fired).toEqual([]);
  });

  it('keeps resource objects, restores modifiers exactly, and lets timed ones expire on schedule', () => {
    const { k } = build();
    k.start('main');
    const score = k.resource('score');
    k.modifyResource('score', 'mult', { key: 'combo', multiply: 2, seconds: 0.1 });
    score['mult'] = 3;
    const snap = k.snapshot();
    k.unmodifyResource('score', 'combo');
    score['mult'] = 1;
    expect(score['mult']).toBe(1);
    k.restore(snap);
    expect(k.resource('score')).toBe(score);
    expect(score['mult']).toBe(6);
    expect(k.resourceBase('score', 'mult')).toBe(3);
    run(k, 5);
    expect(score['mult']).toBe(3);
  });

  it('restores the scene and its scoped systems without starting them', () => {
    const log: string[] = [];
    const scoped: SystemDef = {
      id: 'scoped', scenes: [{ scene: 'other' }], handlers: [],
      create: () => ({ start: () => log.push('start'), update: () => log.push('update') }),
    };
    const project = loadProject(files(DATA));
    const k1 = new Kernel({ project, game: { ...GAME, systems: [scorer, scoped] }, plugins: [noisePlugin(1)], context: {} });
    k1.start('other');
    const snap = k1.snapshot();
    const ctx = { starts: 0, ends: 0 } as Ctx;
    const k2 = new Kernel({ project, game: { ...GAME, systems: [scorer, scoped] }, plugins: [noisePlugin(1)], context: ctx });
    ctx.k = k2;
    k2.start('main');
    log.length = 0;
    k2.restore(snap);
    expect(k2.scene?.id).toBe('other');
    expect(k2.world.count).toBe(0);
    k2.step(1 / 50);
    expect(log).toEqual(['update']);
  });

  it('records the spawning player as owner, inherited by children, through snapshots', () => {
    const { k } = build();
    k.start('main');
    const ship = k.spawn('ship', { at: [1, 1] }, { owner: 2 });
    const gun = k.world.get(ship.children[0]!)!;
    expect([ship.owner, gun.owner]).toEqual([2, 2]);
    expect([...k.world.live()].find((r) => r.placedId === 'hero')!.owner).toBeUndefined();
    k.step(1 / 50);
    const other = build().k;
    other.restore(k.snapshot());
    expect(other.world.get(ship.id)!.owner).toBe(2);
    expect(other.world.get(gun.id)!.owner).toBe(2);
  });
});

// ── Guards ─────────────────────────────────────────────────────────────────────

describe('snapshot / restore guards', () => {
  it('refuses during a frame and with work pending', () => {
    const { k } = build();
    const seen: string[] = [];
    k.addHook('ui', () => {
      try { k.snapshot(); } catch (e) { seen.push(String(e)); }
    });
    k.start('main');
    k.step(1 / 50);
    expect(seen.join()).toMatch(/PP3061/);
    k.spawn('bullet');
    expect(() => k.snapshot()).toThrow(/PP3061[\s\S]*pending/);
    k.step(1 / 50);
    expect(() => k.snapshot()).not.toThrow();
  });

  it('checks plugins define snapshot and restore together, and that plugin state matches', () => {
    const project = loadProject(files(DATA));
    expect(() => new Kernel({ project, game: GAME, plugins: [{ id: 'half', snapshot: () => 1 }] })).toThrow(/PP9003/);
    const { k } = build();
    k.start('main');
    const snap = k.snapshot();
    expect(() => build([]).k.restore(snap)).toThrow(/PP9002[\s\S]*noise/);
    expect(() => k.restore({ ...snap, plugins: {} })).toThrow(/PP9002[\s\S]*noise/);
    expect(() => k.restore({ ...snap, format: 99 })).toThrow(/PP9002/);
  });

  it('fails a bad snapshot without touching the running game', () => {
    const { k } = build();
    k.start('main');
    run(k, 10);
    const snap = viaJson(k.snapshot());
    run(k, 5);
    const now = digest(k);
    const broken = viaJson(snap) as unknown as { entities: Array<{ components: Record<string, { fields: Record<string, Json> }> }> };
    broken.entities[0]!.components['body']!.fields['hp'] = 'lots';
    expect(() => k.restore(broken as unknown as Snapshot)).toThrow(/PP4102/);
    expect(digest(k)).toBe(now);
  });

  it('refuses values a save cannot hold', () => {
    const { k } = build();
    k.start('main');
    const hero = [...k.world.live()].find((r) => r.placedId === 'hero')!;
    hero.components.get('body')!['meta'] = { when: new Vec3(1, 2, 3) };
    expect(() => k.snapshot()).toThrow(/PP4108[\s\S]*meta\.when/);
    // A game-side container (it has COPY) saves as the plain data it stands for.
    hero.components.get('body')!['meta'] = { [COPY]: () => ({}), toJSON: () => ({ hp: 3, tags: ['a'] }) };
    expect(k.snapshot().entities.find((e) => e.placedId === 'hero')!.components['body']!.fields['meta']).toEqual({ hp: 3, tags: ['a'] });
    hero.components.get('body')!['meta'] = {};
    hero.components.get('body')!['vel'] = new Vec3(Number.NaN, 0, 0);
    expect(() => k.snapshot()).toThrow(/PP4108[\s\S]*NaN/);
  });
});

// ── Resource saves ─────────────────────────────────────────────────────────────

describe('saveResources / loadResources', () => {
  const SAVES = game({
    resources: [{
      id: 'run',
      schema: {
        gold: t.int({ default: 0, modifiable: true }),
        rival: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null },
        unlocked: t.list({ kind: 'string' }, { default: [], keep: 'profile' }),
        volume: t.number({ default: 1, keep: 'session' }),
      },
    }],
  });
  const PROJECT = { 'prefabs/p.prefab.json': {}, 'scenes/main/scene.json': { entities: [{ prefab: 'p', id: 'boss' }] } };

  function saves(): Kernel {
    const k = new Kernel({ project: loadProject(files(PROJECT)), game: SAVES });
    k.start('main');
    return k;
  }

  it('saves only the chosen lifetimes, as SaveData shapes, with modifiers on a new clock', () => {
    const k = saves();
    const run = k.resource('run');
    run['gold'] = 10;
    run['unlocked'] = ['forest'];
    run['volume'] = 0.3;
    run['rival'] = [...k.world.live()][0]!.id;
    k.modifyResource('run', 'gold', { key: 'luck', add: 5, seconds: 2 });
    k.modifyResource('run', 'gold', { add: 1, stack: true });
    for (let i = 0; i < 25; i++) k.step(1 / 50);

    const slot = viaJson(k.saveResources(['run']));
    expect(slot.resources).toEqual({ run: { gold: 10, rival: 'boss' } });
    expect(slot.modifiers['run']!['gold']).toEqual([
      { key: 'luck', add: 5, multiply: 1, seconds: expect.closeTo(1.5, 9) as number },
      { add: 1, multiply: 1 },
    ]);
    expect(viaJson(k.saveResources(['profile']))).toEqual({ resources: { run: { unlocked: ['forest'] } }, modifiers: {} });

    const fresh = saves();
    fresh.loadResources(slot);
    const loaded = fresh.resource('run');
    expect([loaded['gold'], fresh.resourceBase('run', 'gold'), loaded['volume'], loaded['unlocked']]).toEqual([16, 10, 1, []]);
    expect(loaded['rival']).toBe([...fresh.world.live()][0]!.id);
    for (let i = 0; i < 74; i++) fresh.step(1 / 50);
    expect(loaded['gold']).toBe(16);
    for (let i = 0; i < 2; i++) fresh.step(1 / 50);
    expect(loaded['gold']).toBe(11);
  });

  it('refuses spawned-entity references and unknown fields', () => {
    const k = saves();
    k.resource('run')['rival'] = k.spawn('p').id;
    expect(() => k.saveResources(['run'])).toThrow(/PP4108[\s\S]*spawned/);
    expect(() => k.loadResources({ resources: { run: { coins: 1 } }, modifiers: {} })).toThrow(/PP4104[\s\S]*migration/);
  });
});

// ── encode / decode round trips ───────────────────────────────────────────────

describe('encode is the inverse of decode', () => {
  const RECORD: FieldType = {
    kind: 'record',
    fields: { name: t.string({ default: '' }), at: t.vec2({ default: Vec2.ZERO }), hits: t.list({ kind: 'int' }, { default: [] }) },
  };
  const TYPES: FieldType[] = [
    { kind: 'number' }, { kind: 'int' }, { kind: 'bool' }, { kind: 'string' }, { kind: 'tag' }, { kind: 'ref', to: 'prefab' },
    { kind: 'enum', values: ['low', 'high'] }, { kind: 'vec2' }, { kind: 'vec3' }, { kind: 'color' }, { kind: 'entity' },
    { kind: 'json' }, { kind: 'optional', of: { kind: 'vec3' } }, { kind: 'list', of: { kind: 'color' } },
    { kind: 'dict', of: { kind: 'list', of: { kind: 'optional', of: { kind: 'entity' } } } }, RECORD,
    { kind: 'list', of: RECORD }, { kind: 'dict', of: { kind: 'optional', of: RECORD } },
    { kind: 'cell' }, { kind: 'cell3' }, { kind: 'tuple', of: [{ kind: 'number' }, { kind: 'color' }] },
    { kind: 'union', of: [{ kind: 'entity' }, { kind: 'list', of: { kind: 'entity' } }] },
  ];

  /** A random runtime value of `type`. */
  function sample(type: FieldType, rng: SeededRandom, depth = 0): unknown {
    const n = (): number => (rng.next() - 0.5) * 10 ** rng.int(-3, 6);
    const str = (): string => ['', 'a', 'héllo', 'with "quotes"', '日本'][rng.int(0, 4)]!;
    const many = <T>(f: () => T): T[] => Array.from({ length: depth > 2 ? 0 : rng.int(0, 3) }, f);
    switch (type.kind) {
      case 'number': return n();
      case 'int': return rng.int(-1000, 1000);
      case 'bool': return rng.next() < 0.5;
      case 'string': case 'tag': case 'ref': return str();
      case 'enum': return type.values[rng.int(0, type.values.length - 1)];
      case 'vec2': return new Vec2(n(), n());
      case 'vec3': return new Vec3(n(), n(), n());
      case 'color': return new Color(rng.next(), rng.next(), rng.next(), rng.next());
      case 'entity': return rng.next() < 0.2 ? 'local_player' : rng.int(0, 2 ** 40);
      case 'json': return { k: many(() => n()), s: str(), nested: { ok: rng.next() < 0.5, none: null } };
      case 'optional': return rng.next() < 0.3 ? null : sample(type.of, rng, depth + 1);
      case 'list': return many(() => sample(type.of, rng, depth + 1));
      case 'dict': return Object.fromEntries(many(() => [str() + String(rng.int(0, 99)), sample(type.of, rng, depth + 1)]));
      case 'record': return Object.fromEntries(Object.entries(type.fields).map(([k, spec]) => [k, sample(spec.type, rng, depth + 1)]));
      case 'cell': return new Cell(rng.int(-50, 50), rng.int(-50, 50));
      case 'cell3': return new Cell3(rng.int(-50, 50), rng.int(-50, 50), rng.int(-50, 50));
      case 'tuple': return Object.freeze(type.of.map((t) => sample(t, rng, depth + 1)));
      case 'union': return sample(type.of[rng.int(0, type.of.length - 1)]!, rng, depth + 1);
    }
  }

  it('round-trips random values of every field type through JSON text', () => {
    const rng = new SeededRandom(2024);
    for (const type of TYPES) {
      for (let i = 0; i < 200; i++) {
        const value = sample(type, rng);
        const encoded = encode(type, value, 'v', IDS);
        const decoded = decode(type, viaJson(encoded), 'v', IDS);
        expect(JSON.stringify(decoded, plain)).toBe(JSON.stringify(value, plain));
        expect(encode(type, decoded, 'v', IDS)).toEqual(encoded);
      }
    }
  });

  it('decodes value types to their classes, and never aliases its input', () => {
    expect(decode({ kind: 'vec3' }, [1, 2, 3], 'v', IDS)).toBeInstanceOf(Vec3);
    expect(decode({ kind: 'color' }, [1, 0, 0, 1], 'v', IDS)).toBeInstanceOf(Color);
    const data = { list: [1] };
    const json = decode({ kind: 'json' }, data, 'v') as { list: number[] };
    json.list.push(2);
    expect(data.list).toEqual([1]);
  });

  it('names the exact path of a value it cannot encode', () => {
    const type: FieldType = { kind: 'list', of: RECORD };
    expect(() => encode(type, [{ name: 'a', at: new Vec3(1, 2, 3), hits: [] }], 'waves', IDS)).toThrow(/PP4108[\s\S]*waves\[0\]\.at must hold a Vec2/);
    expect(() => encode({ kind: 'int' }, 1.5, 'n')).toThrow(/PP4108/);
    expect(() => encode({ kind: 'number' }, Infinity, 'n')).toThrow(/PP4108[\s\S]*Infinity/);
    expect(() => encode({ kind: 'enum', values: ['a'] }, 'b', 'n')).toThrow(/PP4108/);
    expect(() => encode({ kind: 'entity' }, 7, 'e')).toThrow(/PP4108/);
  });
});
