/**
 * Running a behavior tree, one brain at a time. Each tick walks the tree from the root and
 * returns success, failure or running; a node that returns running keeps a small state
 * (which child, until when, which plan step) and resumes from it next tick. Everything
 * the runner keeps is plain data, so a brain snapshots mid-behavior and resumes exactly.
 *
 *   sequence   resumes its running child, re-testing the `check` children before it first
 *              (a failed check interrupts the running child)
 *   selector   reactive: re-evaluates from its first child every tick, and a higher child
 *              that stops failing interrupts the running lower one; `memory` resumes instead
 *   parallel   ticks every unfinished child; `fail` / `succeed` policies decide ("any" or
 *              "all", failure first); finishing interrupts the children still running;
 *              all finished with neither policy met is a failure
 *   random     picks one child by weight (the AI's seeded stream) when entered
 *   repeat     one iteration per tick at most (a loop never stalls a frame); without `until`
 *              a failure fails it, with `until` that status ends it in success; after
 *              `times` iterations it succeeds (without `until`) or fails (with)
 *   retry      re-runs the child after a failure, up to `times` more attempts
 *   cooldown   after its child ends, fails for `seconds` without running it
 *   timeout    interrupts its child and fails once it has run `seconds`
 *   guard      re-tests `if` every tick; false interrupts the child and fails
 *   wait       seconds of AI clock (a [lo, hi] range is picked once, when entered)
 *   do         the task's `start` on entry, `tick` every tick, `stop` when it ends for any
 *              reason (finished or interrupted)
 *   move_to    moves the NavAgent to the blackboard value (Vec3 or entity), re-issued when
 *              the value changes; succeeds on arrival, fails when unreachable or absent
 *   utility    runs the best-scoring option (hysteresis keeps the current one on near ties),
 *              switching interrupts the old one; fails when every score is 0
 *   plan       plans from the blackboard, runs each action's child in turn, writes its
 *              effects into the blackboard when it succeeds, and re-plans when the next
 *              action's preconditions no longer hold; fails when no plan reaches the goal
 *
 * Interrupting a node ("abort") stops every running node under it, so tasks get `stop`
 * and moves are cancelled. The runner never swallows a task's error.
 */

import { fail } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { decodeValue, encodeValue, sameValue } from './blackboard.js';
import type { Value } from './blackboard.js';
import { plan } from './planner.js';
import { describeCheck, testCheck } from './tree.js';
import type { Node, Status, TreeDef } from './tree.js';
import { chooseOption, optionScore } from './utility.js';

/** What a running tree needs from its brain and the world. */
export interface RunHost {
  /** AI clock (seconds of fixed steps since the scene loaded). */
  readonly now: number;
  /** Seconds since this brain last ticked. */
  readonly dt: number;
  random(): number;
  read(key: string): Value | undefined;
  write(key: string, value: Value, ttl: number | null): void;
  remove(key: string): void;
  /** Run a registered task's hook; `tick` returns its status. */
  task(node: Extract<Node, { type: 'do' }>, hook: 'start' | 'tick' | 'stop', elapsed: number): Status;
  /** Start moving to a blackboard value; false when it is unreachable or not a place. */
  move(target: Value, stoppingDistance: number | null, speed: number | null): boolean;
  moving(): boolean;
  stopMove(): void;
}

type NodeState = Record<string, Json>;

export interface TraceLine {
  readonly depth: number;
  readonly label: string;
  readonly type: string;
  status: Status;
  readonly detail?: string;
}

function childrenOf(node: Node): readonly Node[] {
  switch (node.type) {
    case 'sequence': case 'selector': case 'parallel': case 'random': return node.children;
    case 'invert': case 'succeed': case 'fail': case 'repeat': case 'retry': case 'cooldown': case 'timeout': case 'guard': return [node.child];
    case 'utility': return node.options.map((o) => o.child);
    case 'plan': return node.actions.map((a) => a.child);
    default: return [];
  }
}

export class TreeRun {
  readonly tree: TreeDef;
  readonly #states = new Map<number, NodeState>();
  /** Cooldown ends (AI clock), by node index: kept after the node finishes. */
  readonly #memo = new Map<number, number>();
  #host: RunHost | undefined;
  /** The last tick's walk, for `Brain.describe()`. */
  trace: TraceLine[] = [];
  status: Status | 'idle' = 'idle';

  constructor(tree: TreeDef) {
    this.tree = tree;
  }

  tick(host: RunHost): Status {
    this.#host = host;
    this.trace = [];
    try {
      this.status = this.#tick(this.tree.root, 0);
    } finally {
      this.#host = undefined;
    }
    return this.status;
  }

  /** Interrupt everything running (a new tree, `Brain.restart()`, the brain disabled). */
  abortAll(host: RunHost): void {
    this.#host = host;
    try {
      this.#abort(this.tree.root);
    } finally {
      this.#host = undefined;
    }
    this.#states.clear();
    this.status = 'idle';
  }

  /** Paths ("root/combat/shoot") of the running leaves, in tree order. */
  running(): string[] {
    const out: string[] = [];
    const walk = (node: Node, path: string): void => {
      if (!this.#states.has(node.index)) return;
      const here = path === '' ? node.label : `${path}/${node.label}`;
      const live = childrenOf(node).filter((c) => this.#states.has(c.index));
      if (live.length === 0) out.push(here);
      for (const c of live) walk(c, here);
    };
    walk(this.tree.root, '');
    return out;
  }

  describe(): string {
    if (this.trace.length === 0) return `${this.tree.id}: not ticked yet`;
    return [`${this.tree.id}: ${this.status}`, ...this.trace.map((t) => `${'  '.repeat(t.depth + 1)}${t.label}${t.label !== t.type ? ` (${t.type})` : ''}${t.detail !== undefined ? ` ${t.detail}` : ''}: ${t.status}`)].join('\n');
  }

  get #h(): RunHost {
    return this.#host!;
  }

  #tick(node: Node, depth: number, detail?: string): Status {
    const note = detail ?? (node.type === 'check' ? describeCheck(node) : node.type === 'do' && node.label !== node.task ? node.task : undefined);
    const line: TraceLine = { depth, label: node.label, type: node.type, status: 'running', ...(note !== undefined && { detail: note }) };
    this.trace.push(line);
    const status = this.#run(node, depth);
    line.status = status;
    if (status !== 'running') this.#states.delete(node.index);
    return status;
  }

  #abort(node: Node): void {
    if (!this.#states.has(node.index)) return;
    for (const child of childrenOf(node)) this.#abort(child);
    const state = this.#states.get(node.index)!;
    this.#states.delete(node.index);
    if (node.type === 'do') this.#h.task(node, 'stop', this.#h.now - (state['since'] as number));
    if (node.type === 'move_to') this.#h.stopMove();
  }

  #run(node: Node, depth: number): Status {
    const h = this.#h;
    const st = this.#states.get(node.index);
    const keep = (state: NodeState): Status => {
      this.#states.set(node.index, state);
      return 'running';
    };
    switch (node.type) {
      case 'sequence': {
        const from = (st?.['child'] as number | undefined) ?? 0;
        for (let c = 0; c < from; c++) {
          const child = node.children[c]!;
          if (child.type === 'check' && this.#tick(child, depth + 1) === 'failure') {
            this.#abort(node.children[from]!);
            return 'failure';
          }
        }
        for (let c = from; c < node.children.length; c++) {
          const s = this.#tick(node.children[c]!, depth + 1);
          if (s === 'running') return keep({ child: c });
          if (s === 'failure') return 'failure';
        }
        return 'success';
      }
      case 'selector': {
        const prev = st?.['child'] as number | undefined;
        const from = node.memory ? (prev ?? 0) : 0;
        for (let c = from; c < node.children.length; c++) {
          const s = this.#tick(node.children[c]!, depth + 1);
          if (s === 'failure') continue;
          if (prev !== undefined && prev !== c) this.#abort(node.children[prev]!);
          return s === 'running' ? keep({ child: c }) : s;
        }
        return 'failure';
      }
      case 'parallel': {
        const done = ((st?.['done'] as (Status | null)[] | undefined) ?? node.children.map(() => null)).slice();
        node.children.forEach((child, c) => {
          if (done[c] !== null) return;
          const s = this.#tick(child, depth + 1);
          if (s !== 'running') done[c] = s;
        });
        const failures = done.filter((d) => d === 'failure').length;
        const successes = done.filter((d) => d === 'success').length;
        const n = node.children.length;
        const failed = node.fail === 'any' ? failures > 0 : failures === n;
        const succeeded = node.succeed === 'any' ? successes > 0 : successes === n;
        if (failed || succeeded || failures + successes === n) {
          for (const child of node.children) this.#abort(child);
          return failed || !succeeded ? 'failure' : 'success';
        }
        return keep({ done });
      }
      case 'random': {
        let child = st?.['child'] as number | undefined;
        if (child === undefined) {
          const total = node.weights.reduce((a, b) => a + b, 0);
          let roll = h.random() * total;
          child = node.weights.findIndex((w) => (roll -= w) < 0);
          if (child < 0) child = node.weights.length - 1 - [...node.weights].reverse().findIndex((w) => w > 0);
        }
        const s = this.#tick(node.children[child]!, depth + 1);
        return s === 'running' ? keep({ child }) : s;
      }
      case 'invert': case 'succeed': case 'fail': {
        const s = this.#tick(node.child, depth + 1);
        if (s === 'running') return keep({});
        if (node.type === 'succeed') return 'success';
        if (node.type === 'fail') return 'failure';
        return s === 'success' ? 'failure' : 'success';
      }
      case 'repeat': {
        const count = (st?.['count'] as number | undefined) ?? 0;
        const s = this.#tick(node.child, depth + 1);
        if (s === 'running') return keep({ count });
        if (node.until !== null && s === node.until) return 'success';
        if (node.until === null && s === 'failure') return 'failure';
        if (node.times !== null && count + 1 >= node.times) return node.until === null ? 'success' : 'failure';
        return keep({ count: count + 1 });
      }
      case 'retry': {
        const failures = (st?.['count'] as number | undefined) ?? 0;
        const s = this.#tick(node.child, depth + 1);
        if (s === 'running') return keep({ count: failures });
        if (s === 'success') return 'success';
        return failures + 1 > node.times ? 'failure' : keep({ count: failures + 1 });
      }
      case 'cooldown': {
        if (st === undefined && (this.#memo.get(node.index) ?? -Infinity) > h.now) return 'failure';
        const s = this.#tick(node.child, depth + 1);
        if (s === 'running') return keep({});
        this.#memo.set(node.index, h.now + node.seconds);
        return s;
      }
      case 'timeout': {
        const until = (st?.['until'] as number | undefined) ?? h.now + node.seconds;
        if (h.now >= until) {
          this.#abort(node.child);
          return 'failure';
        }
        const s = this.#tick(node.child, depth + 1);
        return s === 'running' ? keep({ until }) : s;
      }
      case 'guard': {
        if (!testCheck(node.test, h.read(node.test.key))) {
          this.#abort(node.child);
          return 'failure';
        }
        const s = this.#tick(node.child, depth + 1);
        return s === 'running' ? keep({}) : s;
      }
      case 'check':
        return testCheck(node, h.read(node.key)) ? 'success' : 'failure';
      case 'wait': {
        let until = st?.['until'] as number | undefined;
        if (until === undefined) {
          const s = node.seconds;
          until = h.now + (typeof s === 'number' ? s : s[0] + h.random() * (s[1] - s[0]));
        }
        return h.now >= until ? 'success' : keep({ until });
      }
      case 'set':
        h.write(node.key, node.value, node.ttl);
        return 'success';
      case 'add': {
        const current = h.read(node.key) ?? 0;
        if (typeof current !== 'number') {
          fail('PP3254', `tree "${this.tree.id}": "add" on blackboard key "${node.key}", which holds ${JSON.stringify(encodeValue(current))}, not a number`);
        }
        h.write(node.key, current + node.value, null);
        return 'success';
      }
      case 'clear':
        h.remove(node.key);
        return 'success';
      case 'do': {
        const since = (st?.['since'] as number | undefined) ?? h.now;
        if (st === undefined) h.task(node, 'start', 0);
        const s = h.task(node, 'tick', h.now - since);
        if (s === 'running') return keep({ since });
        h.task(node, 'stop', h.now - since);
        return s;
      }
      case 'move_to': {
        const target = h.read(node.key);
        if (st === undefined) {
          if (target === undefined || target === null) return 'failure';
          if (!h.move(target, node.stoppingDistance, node.speed)) return 'failure';
          return keep({ target: encodeValue(target) });
        }
        if (target === undefined || target === null) {
          h.stopMove();
          return 'failure';
        }
        if (!sameValue(decodeValue(st['target']!), target)) {
          if (!h.move(target, node.stoppingDistance, node.speed)) return 'failure';
          return keep({ target: encodeValue(target) });
        }
        return h.moving() ? 'running' : 'success';
      }
      case 'utility': {
        const current = st?.['option'] as number | undefined;
        const scores = node.options.map((o) => optionScore(o.base, o.considerations, (k) => h.read(k)));
        const chosen = chooseOption(scores, current, node.hysteresis);
        if (current !== undefined && current !== chosen) this.#abort(node.options[current]!.child);
        if (chosen < 0) return 'failure';
        const s = this.#tick(node.options[chosen]!.child, depth + 1, `score ${scores[chosen]!.toFixed(2)}`);
        return s === 'running' ? keep({ option: chosen }) : s;
      }
      case 'plan': {
        const read = (k: string): Value | undefined => h.read(k);
        let steps = st?.['steps'] as number[] | undefined;
        let at = (st?.['at'] as number | undefined) ?? 0;
        const replan = (): Status | null => {
          const found = plan(node.goal, node.actions, read, node.maxDepth);
          if (found === null) return 'failure';
          if (found.length === 0) return 'success';
          steps = found;
          at = 0;
          return null;
        };
        if (steps === undefined) {
          const done = replan();
          if (done !== null) return done;
        }
        const action = node.actions[steps![at]!]!;
        const running = this.#states.has(action.child.index);
        if (!running && !action.pre.every((c) => testCheck(c, read(c.key)))) {
          const done = replan();
          if (done !== null) return done;
        }
        const step = node.actions[steps![at]!]!;
        const s = this.#tick(step.child, depth + 1, `step ${at + 1}/${steps!.length}: ${step.name}`);
        if (s === 'running') return keep({ steps: steps!, at });
        if (s === 'failure') return 'failure';
        for (const [k, v] of Object.entries(step.effects)) h.write(k, v, null);
        if (at + 1 >= steps!.length) return node.goal.every((c) => testCheck(c, read(c.key))) ? 'success' : 'failure';
        return keep({ steps: steps!, at: at + 1 });
      }
    }
  }

  snapshot(): Json {
    return {
      status: this.status,
      states: [...this.#states].map(([i, s]) => [i, s as JsonObject]),
      memo: [...this.#memo].map(([i, t]) => [i, t]),
    };
  }

  restore(json: Json): void {
    const o = json as JsonObject;
    this.status = o['status'] as Status | 'idle';
    this.#states.clear();
    this.#memo.clear();
    // A tree edited since the snapshot (same id, other shape) keeps only states that still fit.
    const n = this.tree.nodes.length;
    for (const [i, s] of o['states'] as [number, NodeState][]) if (i < n) this.#states.set(i, s);
    for (const [i, t] of o['memo'] as [number, number][]) if (i < n) this.#memo.set(i, t);
    this.trace = [];
  }
}
