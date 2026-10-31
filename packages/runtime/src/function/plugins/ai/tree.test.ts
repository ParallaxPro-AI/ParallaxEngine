import { describe, expect, it } from 'vitest';
import { SeededRandom, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { Blackboard, EntityRef } from './blackboard.js';
import type { Value } from './blackboard.js';
import { formationOffsets, assignSlots, placeSlots } from './formations.js';
import { plan } from './planner.js';
import { TreeRun } from './runner.js';
import type { RunHost } from './runner.js';
import { parseTree } from './tree.js';
import type { Status } from './tree.js';
import { Director, DIRECTOR_DEFAULTS } from './director.js';

type TaskFn = (elapsed: number) => Status;

function harness(doc: unknown, tasks: Record<string, TaskFn> = {}, others: Record<string, unknown> = {}) {
  const { tree, diagnostics } = parseTree('t', doc, { tree: (id) => others[id], treeIds: () => Object.keys(others) });
  if (tree === undefined) throw new Error(diagnostics.map((d) => `${d.pointer}: ${d.message}`).join('\n'));
  const bb = new Blackboard(() => true);
  for (const [k, v] of Object.entries(tree.blackboard)) bb.set(k, v, 0);
  const log: string[] = [];
  const rng = new SeededRandom(7);
  const run = new TreeRun(tree);
  const h = {
    now: 0,
    moving: false,
    tick(): Status {
      const host: RunHost = {
        now: h.now, dt: 0.1, random: () => rng.next(),
        read: (k) => bb.get(k, h.now), write: (k, v, ttl) => bb.set(k, v, h.now, ttl), remove: (k) => bb.delete(k),
        task: (node, hook, elapsed) => {
          log.push(`${hook} ${node.task}`);
          return hook === 'tick' ? tasks[node.task]!(elapsed) : 'success';
        },
        move: (target) => { log.push(`move ${target instanceof Vec3 ? target.x : String(target)}`); h.moving = true; return true; },
        moving: () => h.moving,
        stopMove: () => { log.push('stop move'); h.moving = false; },
      };
      const s = run.tick(host);
      h.now = Math.round((h.now + 0.1) * 1e9) / 1e9;
      return s;
    },
  };
  return { h, bb, log, run, tree, rng };
}

const check = (key: string, op?: string, value?: Value): object => ({ type: 'check', key, ...(op !== undefined && { op }), ...(value !== undefined && { value }) });
const doTask = (task: string, args?: object): object => ({ type: 'do', task, ...(args !== undefined && { args }) });

describe('behavior tree parsing', () => {
  it('reports unknown types, keys and ops with suggestions and JSON pointers', () => {
    const { diagnostics } = parseTree('guard', {
      root: { type: 'sequense', children: [] },
    });
    expect(diagnostics.map((d) => [d.code, d.pointer, d.fix])).toEqual([['PP3252', '/root/type', 'Did you mean "sequence"?']]);
    const bad = parseTree('guard', {
      tick: -1,
      root: { type: 'selector', childs: [], children: [check('hp', '=<', 3), { type: 'wait', seconds: [3, 1] }, { type: 'do' }] },
    }).diagnostics.map((d) => d.pointer);
    expect(bad).toEqual(['/tick', '/root/childs', '/root/children/0/op', '/root/children/1/seconds', '/root/children/2/task']);
    expect(parseTree('x', { root: check('a', '<', 'high') }).diagnostics[0]!.message).toContain('compares numbers');
    expect(parseTree('x', { root: check('a', 'truthy', 1) }).diagnostics[0]!.message).toContain('takes no "value"');
  });

  it('inlines subtrees, reports unknown ones and cycles', () => {
    const others = { patrol: { root: { type: 'sequence', children: [doTask('walk'), { type: 'wait', seconds: 1 }] } }, loop: { root: { type: 'subtree', tree: 'loop' } } };
    const { tree } = parseTree('main', { root: { type: 'selector', children: [check('enemy'), { type: 'subtree', tree: 'patrol' }] } }, { tree: (id) => (others as Record<string, unknown>)[id] });
    expect(tree!.nodes.map((n) => n.type)).toEqual(['selector', 'check', 'sequence', 'do', 'wait']);
    expect(tree!.nodes.map((n) => n.index)).toEqual([0, 1, 2, 3, 4]);
    expect([...tree!.tasks]).toEqual(['walk']);
    const missing = parseTree('main', { root: { type: 'subtree', tree: 'patrl' } }, { tree: (id) => (others as Record<string, unknown>)[id], treeIds: () => Object.keys(others) });
    expect(missing.diagnostics[0]!.fix).toBe('Did you mean "patrol"?');
    const cycle = parseTree('loop', others.loop, { tree: (id) => (others as Record<string, unknown>)[id] });
    expect(cycle.diagnostics[0]!.message).toContain('includes itself');
  });
});

describe('behavior tree semantics', () => {
  it('a sequence resumes its running child and re-tests the checks before it', () => {
    let left = 3;
    const { h, bb, log } = harness({ root: { type: 'sequence', children: [check('enemy'), doTask('aim'), doTask('shoot')] } }, {
      aim: () => 'success',
      shoot: () => (--left > 0 ? 'running' : 'success'),
    });
    expect(h.tick()).toBe('failure');
    bb.set('enemy', true, 0);
    expect(h.tick()).toBe('running');
    expect(h.tick()).toBe('running');
    // aim ran once: the sequence resumed at shoot.
    expect(log.filter((l) => l === 'tick aim')).toHaveLength(1);
    bb.delete('enemy');
    expect(h.tick()).toBe('failure');
    // The failed check interrupted shoot: its stop ran.
    expect(log.slice(-1)).toEqual(['stop shoot']);
  });

  it('a selector is reactive: a higher priority interrupts a running lower one', () => {
    const { h, bb, log, run } = harness({
      root: { type: 'selector', children: [{ type: 'sequence', name: 'fight', children: [check('enemy'), doTask('attack')] }, doTask('patrol')] },
    }, { attack: () => 'running', patrol: () => 'running' });
    expect(h.tick()).toBe('running');
    expect(run.running()).toEqual(['selector/patrol']);
    bb.set('enemy', true, 0);
    expect(h.tick()).toBe('running');
    expect(run.running()).toEqual(['selector/fight/attack']);
    expect(log).toEqual(['start patrol', 'tick patrol', 'start attack', 'tick attack', 'stop patrol']);
    expect(run.describe()).toContain('check enemy truthy: success');
    expect(run.describe()).toContain('fight (sequence): running');
  });

  it('a memory selector resumes instead', () => {
    let first = 0;
    const { h } = harness({ root: { type: 'selector', memory: true, children: [doTask('a'), doTask('b')] } }, {
      a: () => (first++ === 0 ? 'failure' : 'success'),
      b: () => 'running',
    });
    h.tick();
    h.tick();
    expect(first).toBe(1);
  });

  it('parallel policies, invert, repeat, retry', () => {
    let n = 0;
    const p = harness({ root: { type: 'parallel', succeed: 'any', children: [doTask('slow'), doTask('quick')] } }, {
      slow: () => 'running', quick: () => (++n >= 2 ? 'success' : 'running'),
    });
    expect(p.h.tick()).toBe('running');
    expect(p.h.tick()).toBe('success');
    expect(p.log.slice(-1)).toEqual(['stop slow']);

    let ticks = 0;
    const r = harness({ root: { type: 'repeat', times: 3, child: doTask('step') } }, { step: () => { ticks++; return 'success'; } });
    expect([r.h.tick(), r.h.tick(), r.h.tick()]).toEqual(['running', 'running', 'success']);
    expect(ticks).toBe(3);

    let tries = 0;
    const t = harness({ root: { type: 'retry', times: 2, child: doTask('open') } }, { open: () => (++tries === 3 ? 'success' : 'failure') });
    expect([t.h.tick(), t.h.tick(), t.h.tick()]).toEqual(['running', 'running', 'success']);
    const u = harness({ root: { type: 'repeat', until: 'failure', child: { type: 'invert', child: check('done') } } });
    u.bb.set('done', false, 0);
    expect(u.h.tick()).toBe('running');
    u.bb.set('done', true, 0);
    expect(u.h.tick()).toBe('success');
  });

  it('wait, cooldown and timeout run on the AI clock; guard interrupts', () => {
    const w = harness({ root: { type: 'sequence', children: [{ type: 'wait', seconds: 0.25 }, { type: 'set', key: 'done', value: true }] } });
    expect([w.h.tick(), w.h.tick(), w.h.tick(), w.h.tick()]).toEqual(['running', 'running', 'running', 'success']);
    expect(w.bb.get('done', 1)).toBe(true);

    const c = harness({ root: { type: 'cooldown', seconds: 0.3, child: doTask('fire') } }, { fire: () => 'success' });
    expect([c.h.tick(), c.h.tick(), c.h.tick(), c.h.tick()]).toEqual(['success', 'failure', 'failure', 'success']);

    const t = harness({ root: { type: 'timeout', seconds: 0.2, child: doTask('dig') } }, { dig: () => 'running' });
    expect([t.h.tick(), t.h.tick(), t.h.tick()]).toEqual(['running', 'running', 'failure']);
    expect(t.log.slice(-1)).toEqual(['stop dig']);

    const g = harness({ root: { type: 'guard', if: { key: 'hp', op: '>', value: 20 }, child: doTask('charge') } }, { charge: () => 'running' });
    g.bb.set('hp', 50, 0);
    expect(g.h.tick()).toBe('running');
    g.bb.set('hp', 10, 0);
    expect(g.h.tick()).toBe('failure');
    expect(g.log.slice(-1)).toEqual(['stop charge']);
  });

  it('random picks deterministically by weight; add counts; ttl expires', () => {
    const picks = (): string[] => {
      const out: string[] = [];
      const r = harness({ root: { type: 'random', weights: [1, 0, 3], children: [doTask('a'), doTask('b'), doTask('c')] } }, {
        a: () => { out.push('a'); return 'success'; }, b: () => { out.push('b'); return 'success'; }, c: () => { out.push('c'); return 'success'; },
      });
      for (let i = 0; i < 40; i++) r.h.tick();
      return out;
    };
    const one = picks();
    expect(one).toEqual(picks());
    expect(one).not.toContain('b');
    expect(one.filter((x) => x === 'c').length).toBeGreaterThan(one.filter((x) => x === 'a').length);

    const a = harness({ root: { type: 'sequence', children: [{ type: 'add', key: 'n', value: 2 }, { type: 'set', key: 'seen', value: true, ttl: 0.15 }] } });
    a.h.tick();
    a.h.tick();
    expect(a.bb.get('n', a.h.now)).toBe(4);
    expect(a.bb.get('seen', a.h.now + 0.2)).toBeUndefined();
  });

  it('move_to follows the blackboard value, succeeds on arrival, re-issues on change', () => {
    const m = harness({ root: { type: 'move_to', key: 'goal' } });
    expect(m.h.tick()).toBe('failure');
    m.bb.set('goal', new Vec3(5, 0, 0), 0);
    expect(m.h.tick()).toBe('running');
    m.bb.set('goal', new Vec3(7, 0, 0), 0);
    expect(m.h.tick()).toBe('running');
    m.h.moving = false;
    expect(m.h.tick()).toBe('success');
    expect(m.log).toEqual(['move 5', 'move 7']);
  });

  it('utility runs the best option, keeps it on near ties, and interrupts on a switch', () => {
    const u = harness({
      root: {
        type: 'utility', hysteresis: 0.1, options: [
          { child: doTask('flee'), considerations: [{ key: 'hp', curve: 'inverse', min: 0, max: 100 }] },
          { child: doTask('fight'), considerations: [{ key: 'hp', curve: 'linear', min: 0, max: 100 }] },
        ],
      },
    }, { flee: () => 'running', fight: () => 'running' });
    u.bb.set('hp', 80, 0);
    u.h.tick();
    expect(u.run.running()).toEqual(['utility/fight']);
    u.bb.set('hp', 47, 0);
    u.h.tick();
    expect(u.run.running()).toEqual(['utility/fight']);
    u.bb.set('hp', 20, 0);
    u.h.tick();
    expect(u.run.running()).toEqual(['utility/flee']);
    expect(u.log).toContain('stop fight');
  });

  it('plan finds the cheapest chain, writes effects, and re-plans when preconditions break', () => {
    const steps = [
      { name: 'buy_axe', cost: 3, pre: { gold: true }, effects: { has_axe: true, gold: false }, child: doTask('buy') },
      { name: 'grab_axe', cost: 5, effects: { has_axe: true }, child: doTask('grab') },
      { name: 'chop', cost: 1, pre: { has_axe: true }, effects: { has_wood: true }, child: doTask('chop') },
    ];
    const p = harness({ root: { type: 'plan', goal: { has_wood: true }, actions: steps } }, { buy: () => 'success', grab: () => 'success', chop: () => 'success' });
    p.bb.set('gold', true, 0);
    expect(p.h.tick()).toBe('running');
    expect(p.h.tick()).toBe('success');
    expect(p.log.filter((l) => l.startsWith('tick'))).toEqual(['tick buy', 'tick chop']);
    expect(p.bb.get('has_wood', 1)).toBe(true);

    const { tree } = parseTree('p', { root: { type: 'plan', goal: { has_wood: true }, actions: steps } });
    const node = tree!.root as Extract<typeof tree extends undefined ? never : NonNullable<typeof tree>['root'], { type: 'plan' }>;
    expect(plan(node.goal, node.actions, (k) => (k === 'gold' ? false : undefined), 6)).toEqual([1, 2]);
    expect(plan(node.goal, node.actions, (k) => (k === 'has_wood' ? true : undefined), 6)).toEqual([]);

    // Gold is spent by someone else between planning and buying: it re-plans to grab.
    const q = harness({ root: { type: 'plan', goal: { has_wood: true }, actions: [
      { name: 'walk', cost: 1, effects: { at_shop: true }, child: doTask('walk') }, ...steps.map((s) => s.name === 'buy_axe' ? { ...s, pre: { gold: true, at_shop: true } } : s),
    ] } }, { walk: () => 'success', buy: () => 'success', grab: () => 'success', chop: () => 'success' });
    q.bb.set('gold', true, 0);
    q.h.tick();
    q.bb.set('gold', false, 0);
    q.h.tick();
    q.h.tick();
    expect(q.log.filter((l) => l.startsWith('tick'))).toEqual(['tick walk', 'tick grab', 'tick chop']);
  });

  it('snapshots mid-behavior and resumes identically', () => {
    const doc = { root: { type: 'sequence', children: [{ type: 'wait', seconds: [0.2, 0.6] }, doTask('work'), { type: 'add', key: 'n' }] } };
    const runTo = (n: number) => {
      const x = harness(doc, { work: (e) => (e >= 0.3 ? 'success' : 'running') });
      for (let i = 0; i < n; i++) x.h.tick();
      return x;
    };
    const a = runTo(5);
    const saved = JSON.stringify(a.run.snapshot());
    const b = harness(doc, { work: (e) => (e >= 0.3 ? 'success' : 'running') });
    b.run.restore(JSON.parse(saved));
    b.rng.restore(a.rng.state());
    b.h.now = a.h.now;
    for (const [k] of [['n']]) if (a.bb.has(k!, a.h.now)) b.bb.set(k!, a.bb.get(k!, a.h.now)!, 0);
    const seqA: string[] = [];
    const seqB: string[] = [];
    for (let i = 0; i < 20; i++) {
      seqA.push(a.h.tick());
      seqB.push(b.h.tick());
    }
    expect(seqB).toEqual(seqA);
  });
});

describe('blackboard values', () => {
  it('entities read as absent once destroyed; values encode and decode', () => {
    const id = 3 as EntityId;
    const alive = new Set([id]);
    const bb = new Blackboard((id) => alive.has(id));
    bb.set('target', new EntityRef(id), 0);
    bb.set('route', [new Vec3(1, 2, 3), 'x', null], 0);
    const copy = new Blackboard(() => true);
    copy.restore(JSON.parse(JSON.stringify(bb.encode())));
    expect(copy.get('route', 0)).toEqual([new Vec3(1, 2, 3), 'x', null]);
    alive.delete(id);
    expect(bb.get('target', 0)).toBeUndefined();
  });
});

describe('formations', () => {
  it('shapes, placement facing and slot assignment', () => {
    expect(formationOffsets('line', 3, 2)).toEqual([{ x: -2, z: 0 }, { x: 0, z: 0 }, { x: 2, z: 0 }]);
    expect(formationOffsets('wedge', 3, 1)).toEqual([{ x: 0, z: 0 }, { x: -1, z: 1 }, { x: 1, z: 1 }]);
    expect(formationOffsets('box', 4, 1).map((o) => [o.x, o.z])).toEqual([[-0.5, 0], [0.5, 0], [-0.5, 1], [0.5, 1]]);
    // Facing +x, a line runs along z (right of +x is -z).
    const slots = placeSlots(new Vec3(10, 0, 0), { x: 1, z: 0 }, formationOffsets('line', 2, 2), true);
    expect(slots.map((s) => [s.x, s.z])).toEqual([[10, 1], [10, -1]]);
    expect(assignSlots([new Vec3(0, 0, 5), new Vec3(0, 0, -5)], [new Vec3(0, 0, -4), new Vec3(0, 0, 4)])).toEqual([1, 0]);
  });
});

describe('combat director', () => {
  it('builds to a peak, relaxes without spawns, then builds again', () => {
    const d = new Director({ ...DIRECTOR_DEFAULTS, budgetPerMinute: 60, budgetCap: 3, maxAlive: 2, peakSeconds: 2, relaxSeconds: 3, relaxBelow: 0.3, decay: 0.1 });
    expect(d.canSpawn(1)).toBe(true);
    d.spawned(1 as EntityId, 1);
    d.spawned(2 as EntityId, 1);
    expect(d.canSpawn(1)).toBe(false);
    d.alive.delete(1 as EntityId);
    expect(d.canSpawn(1)).toBe(true);
    const phases: string[] = [];
    d.report(0.9);
    for (let i = 0; i < 100; i++) {
      const p = d.step(0.1);
      if (p !== null) phases.push(`${p}@${Math.round((i + 1) / 10 * 10) / 10}`);
      if (d.phase === 'relax') expect(d.canSpawn(0)).toBe(false);
    }
    expect(phases[0]).toBe('peak@0.1');
    expect(phases[1]).toBe('relax@2.1');
    // Relax lasts 3 s and until intensity <= 0.3 (0.9 decays at 0.1/s → 6 s after the report).
    expect(phases[2]).toMatch(/^build@6(\.1)?$/);
    expect(d.budget).toBeLessThanOrEqual(3);
  });
});
