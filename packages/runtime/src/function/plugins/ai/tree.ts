/**
 * Behavior trees as data: the one parser both the runtime and `parallax check` use, so a
 * tree that checks is a tree that runs. A tree document (a `behavior_tree` content entry,
 * or the same shape built in Python by `parallax.ai`'s node constructors):
 *
 *   { "tick": 0.1, "blackboard": {"patrol_index": 0}, "root": <node> }
 *
 * Every node is `{"type": ..., "name"?: ...}` plus its own keys:
 *
 *   composites   sequence {children}                 run in order; fail on the first failure
 *                selector {children, memory?}         first child that doesn't fail (reactive)
 *                parallel {children, succeed?, fail?} all at once; "all" | "any" policies
 *                random   {children, weights?}        one child, picked (seeded) when entered
 *   decorators   invert / succeed / fail {child}
 *                repeat   {child, times?, until?}     loop (forever, or n times, or until a status)
 *                retry    {child, times}              run again after a failure, up to n times
 *                cooldown {child, seconds}            fails for `seconds` after the child ends
 *                timeout  {child, seconds}            fails (interrupting it) after `seconds`
 *                guard    {if, child}                 `if` (a check) is re-tested every tick
 *   leaves       check    {key, op?, value?}          a blackboard test
 *                wait     {seconds}                   seconds, or [lo, hi] picked when entered
 *                set      {key, value, ttl?} · add {key, value} · clear {key}
 *                do       {task, args?}               a task the game registered: ai(tasks=[...])
 *                move_to  {key, stopping_distance?, speed?}   nav to a Vec3 / entity in the blackboard
 *                utility  {options: [{child, base?, considerations}], hysteresis?}
 *                plan     {goal, actions: [{name, child, cost?, pre?, effects?}], max_depth?}
 *                subtree  {tree}                      another tree's root, inlined
 *
 * Semantics (runner.ts): a sequence resumes its running child but re-tests the `check`
 * children before it every tick; a selector re-evaluates from its first child every tick
 * (a higher priority that stops failing interrupts a lower one) unless `memory` is set.
 */

import { closestMatch, diagnostic, Vec2, Vec3 } from '../../../core/index.js';
import type { Diagnostic, DiagnosticCode, DiagnosticInit } from '../../../core/index.js';
import { describeValue, EntityRef, sameValue, truthy } from './blackboard.js';
import type { Value } from './blackboard.js';
import { CURVES } from './utility.js';
import type { Consideration, Curve } from './utility.js';

export type Status = 'success' | 'failure' | 'running';
export const OPS = ['truthy', 'falsy', 'exists', 'missing', '==', '!=', '<', '<=', '>', '>='] as const;
export type Op = (typeof OPS)[number];

export interface Check {
  readonly key: string;
  readonly op: Op;
  readonly value: Value;
}

interface Base {
  /** Pre-order index in its tree (runtime state is keyed by it). */
  readonly index: number;
  /** `name` when given, else the task (a `do`) or the type: what traces and `Brain.running` show. */
  readonly label: string;
}

export interface UtilityOption {
  readonly child: Node;
  readonly base: number;
  readonly considerations: readonly Consideration[];
}

export interface PlanAction {
  readonly name: string;
  readonly child: Node;
  readonly cost: number;
  readonly pre: readonly Check[];
  readonly effects: Readonly<Record<string, Value>>;
}

export type Node = Base & (
  | { readonly type: 'sequence'; readonly children: readonly Node[] }
  | { readonly type: 'selector'; readonly children: readonly Node[]; readonly memory: boolean }
  | { readonly type: 'parallel'; readonly children: readonly Node[]; readonly succeed: 'all' | 'any'; readonly fail: 'all' | 'any' }
  | { readonly type: 'random'; readonly children: readonly Node[]; readonly weights: readonly number[] }
  | { readonly type: 'invert' | 'succeed' | 'fail'; readonly child: Node }
  | { readonly type: 'repeat'; readonly child: Node; readonly times: number | null; readonly until: 'success' | 'failure' | null }
  | { readonly type: 'retry'; readonly child: Node; readonly times: number }
  | { readonly type: 'cooldown' | 'timeout'; readonly child: Node; readonly seconds: number }
  | { readonly type: 'guard'; readonly test: Check; readonly child: Node }
  | ({ readonly type: 'check' } & Check)
  | { readonly type: 'wait'; readonly seconds: number | readonly [number, number] }
  | { readonly type: 'set'; readonly key: string; readonly value: Value; readonly ttl: number | null }
  | { readonly type: 'add'; readonly key: string; readonly value: number }
  | { readonly type: 'clear'; readonly key: string }
  | { readonly type: 'do'; readonly task: string; readonly args: Readonly<Record<string, Value>> }
  | { readonly type: 'move_to'; readonly key: string; readonly stoppingDistance: number | null; readonly speed: number | null }
  | { readonly type: 'utility'; readonly options: readonly UtilityOption[]; readonly hysteresis: number }
  | { readonly type: 'plan'; readonly goal: readonly Check[]; readonly actions: readonly PlanAction[]; readonly maxDepth: number }
);

export type NodeType = Node['type'];

export interface TreeDef {
  readonly id: string;
  readonly root: Node;
  /** Every node, by index. */
  readonly nodes: readonly Node[];
  readonly blackboard: Readonly<Record<string, Value>>;
  /** Seconds between ticks (0: every fixed step). */
  readonly tick: number;
  /** Task names `do` nodes use. */
  readonly tasks: ReadonlySet<string>;
}

/** Keys each node type takes besides `type` and `name`. */
const KEYS: Readonly<Record<string, readonly string[]>> = {
  sequence: ['children'],
  selector: ['children', 'memory'],
  parallel: ['children', 'succeed', 'fail'],
  random: ['children', 'weights'],
  invert: ['child'],
  succeed: ['child'],
  fail: ['child'],
  repeat: ['child', 'times', 'until'],
  retry: ['child', 'times'],
  cooldown: ['child', 'seconds'],
  timeout: ['child', 'seconds'],
  guard: ['if', 'child'],
  check: ['key', 'op', 'value'],
  wait: ['seconds'],
  set: ['key', 'value', 'ttl'],
  add: ['key', 'value'],
  clear: ['key'],
  do: ['task', 'args'],
  move_to: ['key', 'stopping_distance', 'speed'],
  utility: ['options', 'hysteresis'],
  plan: ['goal', 'actions', 'max_depth'],
  subtree: ['tree'],
};
export const NODE_TYPES: readonly string[] = Object.keys(KEYS);

const ORDERED_OPS: ReadonlySet<Op> = new Set(['<', '<=', '>', '>=']);
const VALUELESS_OPS: ReadonlySet<Op> = new Set(['truthy', 'falsy', 'exists', 'missing']);

export interface ParseScope {
  /** The document's own path, for diagnostics. */
  readonly path?: string;
  /** Another tree's document by id (for `subtree`); undefined when there is none. */
  readonly tree?: (id: string) => unknown;
  /** Tree ids that exist, for suggestions. */
  readonly treeIds?: () => readonly string[];
}

type Raw = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Vec3) && !(value instanceof Vec2);
}

/** Plain data from a JSON document or a Python composite (dicts arrive through their `toJSON`). */
function plain(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Vec3 || value instanceof Vec2 || value instanceof EntityRef) return value;
  if (Object.getPrototypeOf(value) === Object.prototype) return value;
  const json = (value as { toJSON?: () => unknown }).toJSON;
  return typeof json === 'function' ? json.call(value) : value;
}

class Parser {
  readonly out: Diagnostic[] = [];
  readonly nodes: Node[] = [];
  readonly tasks = new Set<string>();
  readonly #scope: ParseScope;
  readonly #stack: string[];
  #muted = 0;
  #failures = 0;

  constructor(scope: ParseScope, stack: string[]) {
    this.#scope = scope;
    this.#stack = stack;
  }

  report(code: DiagnosticCode, message: string, pointer: string, init: Omit<DiagnosticInit, 'path' | 'pointer'> = {}): void {
    if (this.#muted > 0) {
      this.#failures++;
      return;
    }
    this.out.push(diagnostic(code, message, { ...init, ...(this.#scope.path !== undefined && { path: this.#scope.path }), pointer }));
  }

  value(raw: unknown, pointer: string): Value | undefined {
    const v = plain(raw);
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : this.#bad(pointer);
    if (v instanceof Vec3 || v instanceof Vec2) return v;
    if (Array.isArray(v)) {
      const items = v.map((item, i) => this.value(item, `${pointer}/${i}`));
      return items.every((i) => i !== undefined) ? items as Value[] : undefined;
    }
    return this.#bad(pointer);
  }

  #bad(pointer: string): undefined {
    this.report('PP3252', 'a tree value must be None, a bool, a number, a string, a Vec2/Vec3 or a list of them', pointer, {
      fix: 'Write a literal; values the game computes belong in the blackboard at runtime.',
    });
    return undefined;
  }

  number(raw: unknown, pointer: string, what: string, min: number, integer = false): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= min && (!integer || Number.isInteger(raw))) return raw;
    this.report('PP3252', `${what} must be ${integer ? 'a whole number' : 'a number'} of at least ${min}, got ${JSON.stringify(raw) ?? String(raw)}`, pointer);
    return undefined;
  }

  key(raw: unknown, pointer: string): string | undefined {
    if (typeof raw === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(raw)) return raw;
    this.report('PP3252', `"key" must name a blackboard key like "target", got ${JSON.stringify(raw) ?? String(raw)}`, pointer);
    return undefined;
  }

  check(raw: Raw, pointer: string): Check | undefined {
    const key = this.key(raw['key'], `${pointer}/key`);
    const op = raw['op'] === undefined ? 'truthy' : raw['op'];
    if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) {
      const guess = typeof op === 'string' ? closestMatch(op, OPS) : undefined;
      this.report('PP3252', `unknown check op ${JSON.stringify(op)}`, `${pointer}/op`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : `Ops: ${OPS.join(', ')}.`,
      });
      return undefined;
    }
    const valueless = VALUELESS_OPS.has(op as Op);
    if (valueless && raw['value'] !== undefined) {
      this.report('PP3252', `op "${op}" takes no "value"`, `${pointer}/value`, { fix: 'Remove "value", or use "==" to compare.' });
      return undefined;
    }
    if (!valueless && raw['value'] === undefined) {
      this.report('PP3252', `op "${op}" needs a "value"`, pointer);
      return undefined;
    }
    const value = valueless ? null : this.value(raw['value'], `${pointer}/value`);
    if (value === undefined || key === undefined) return undefined;
    if (ORDERED_OPS.has(op as Op) && typeof value !== 'number') {
      this.report('PP3252', `op "${op}" compares numbers; "value" is ${JSON.stringify(value)}`, `${pointer}/value`);
      return undefined;
    }
    return { key, op: op as Op, value };
  }

  /** `{"key": value}` or `{"key": {"op": ">", "value": 0}}` — plan goals and preconditions. */
  facts(raw: unknown, pointer: string): Check[] | undefined {
    const v = plain(raw);
    if (v === undefined) return [];
    if (!isObject(v)) {
      this.report('PP3252', 'facts must be an object of blackboard keys', pointer, { fix: 'Write e.g. {"has_ammo": true, "distance": {"op": "<", "value": 5}}.' });
      return undefined;
    }
    const out: Check[] = [];
    let ok = true;
    for (const [key, spec] of Object.entries(v)) {
      const at = `${pointer}/${key}`;
      const s = plain(spec);
      const check = isObject(s) ? this.check({ ...s, key }, at) : (() => {
        const value = this.value(s, at);
        const k = this.key(key, at);
        return value === undefined || k === undefined ? undefined : { key: k, op: '==' as Op, value };
      })();
      if (check === undefined) ok = false;
      else out.push(check);
    }
    return ok ? out : undefined;
  }

  children(raw: unknown, pointer: string, min = 1): Node[] | undefined {
    const v = plain(raw);
    if (!Array.isArray(v) || v.length < min) {
      this.report('PP3252', `"children" must be a list of at least ${min} node${min === 1 ? '' : 's'}`, pointer);
      return undefined;
    }
    const nodes = v.map((c, i) => this.node(c, `${pointer}/${i}`));
    return nodes.every((n) => n !== undefined) ? nodes as Node[] : undefined;
  }

  node(raw: unknown, pointer: string): Node | undefined {
    const v = plain(raw);
    if (!isObject(v)) {
      this.report('PP3252', 'a tree node must be an object with a "type"', pointer, { fix: 'Write e.g. {"type": "sequence", "children": [...]}.' });
      return undefined;
    }
    const type = v['type'];
    if (typeof type !== 'string' || !(type in KEYS)) {
      const guess = typeof type === 'string' ? closestMatch(type, NODE_TYPES) : undefined;
      this.report('PP3252', `unknown node type ${JSON.stringify(type) ?? 'None'}`, `${pointer}/type`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : `Types: ${NODE_TYPES.join(', ')}.`,
      });
      return undefined;
    }
    const allowed = KEYS[type]!;
    let ok = true;
    for (const key of Object.keys(v)) {
      if (key === 'type' || key === 'name' || allowed.includes(key)) continue;
      const guess = closestMatch(key, allowed);
      this.report('PP3252', `a "${type}" node has no "${key}"`, `${pointer}/${key}`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : `Its keys: ${allowed.join(', ') || '(none)'}.`,
      });
      ok = false;
    }
    if (v['name'] !== undefined && (typeof v['name'] !== 'string' || v['name'] === '')) {
      this.report('PP3252', '"name" must be a non-empty string', `${pointer}/name`);
      ok = false;
    }
    if (type === 'subtree') return ok ? this.#subtree(v, pointer) : undefined;
    const index = this.nodes.length;
    // Reserve the index (pre-order), then fill it in once the children are parsed.
    this.nodes.push(undefined as unknown as Node);
    const label = typeof v['name'] === 'string' && v['name'] !== '' ? v['name'] : type === 'do' && typeof v['task'] === 'string' ? v['task'] : type;
    const body = this.#body(type as NodeType, v, pointer);
    if (!body || !ok) return undefined;
    const node = { index, label, type, ...body } as Node;
    this.nodes[index] = node;
    return node;
  }

  #child(v: Raw, pointer: string): Node | undefined {
    if (v['child'] === undefined) {
      this.report('PP3252', 'this node needs a "child"', pointer);
      return undefined;
    }
    return this.node(v['child'], `${pointer}/child`);
  }

  /** The node's own fields, or a falsy value when they don't parse (already reported). */
  #body(type: NodeType, v: Raw, pointer: string): object | undefined | false {
    switch (type) {
      case 'sequence': {
        const children = this.children(v['children'], `${pointer}/children`);
        return children && { children };
      }
      case 'selector': {
        const children = this.children(v['children'], `${pointer}/children`);
        const memory = v['memory'] ?? false;
        if (typeof memory !== 'boolean') {
          this.report('PP3252', '"memory" must be true or false', `${pointer}/memory`);
          return undefined;
        }
        return children && { children, memory };
      }
      case 'parallel': {
        const children = this.children(v['children'], `${pointer}/children`);
        const succeed = v['succeed'] ?? 'all';
        const failOn = v['fail'] ?? 'any';
        for (const [k, p] of [['succeed', succeed], ['fail', failOn]] as const) {
          if (p !== 'all' && p !== 'any') {
            this.report('PP3252', `"${k}" must be "all" or "any", got ${JSON.stringify(p)}`, `${pointer}/${k}`);
            return undefined;
          }
        }
        return children && { children, succeed, fail: failOn };
      }
      case 'random': {
        const children = this.children(v['children'], `${pointer}/children`);
        if (children === undefined) return undefined;
        const weights = plain(v['weights']) ?? children.map(() => 1);
        if (!Array.isArray(weights) || weights.length !== children.length || !weights.every((w) => typeof w === 'number' && w >= 0 && Number.isFinite(w))
          || !weights.some((w) => (w as number) > 0)) {
          this.report('PP3252', `"weights" must be ${children.length} numbers of at least 0 (not all 0), one per child`, `${pointer}/weights`);
          return undefined;
        }
        return { children, weights };
      }
      case 'invert':
      case 'succeed':
      case 'fail': {
        const child = this.#child(v, pointer);
        return child && { child };
      }
      case 'repeat': {
        const child = this.#child(v, pointer);
        const times = v['times'] === undefined || v['times'] === null ? null : this.number(v['times'], `${pointer}/times`, '"times"', 1, true);
        const until = v['until'] ?? null;
        if (until !== null && until !== 'success' && until !== 'failure') {
          this.report('PP3252', '"until" must be "success" or "failure"', `${pointer}/until`);
          return undefined;
        }
        return child && times !== undefined && { child, times, until };
      }
      case 'retry': {
        const child = this.#child(v, pointer);
        const times = this.number(v['times'], `${pointer}/times`, '"times"', 1, true);
        return child && times !== undefined && { child, times };
      }
      case 'cooldown':
      case 'timeout': {
        const child = this.#child(v, pointer);
        const seconds = this.number(v['seconds'], `${pointer}/seconds`, '"seconds"', 0);
        return child && seconds !== undefined && { child, seconds };
      }
      case 'guard': {
        const test = isObject(plain(v['if'])) ? plain(v['if']) as Raw : undefined;
        if (test === undefined || (test['type'] !== undefined && test['type'] !== 'check')) {
          this.report('PP3252', '"if" must be a check: {"key": ..., "op"?: ..., "value"?: ...}', `${pointer}/if`);
          return undefined;
        }
        const { type: _t, ...fields } = test;
        const check = this.check(fields, `${pointer}/if`);
        const child = this.#child(v, pointer);
        return check && child && { test: check, child };
      }
      case 'check':
        return this.check(v, pointer);
      case 'wait': {
        const s = plain(v['seconds']);
        if (Array.isArray(s)) {
          if (s.length === 2 && s.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0) && (s[0] as number) <= (s[1] as number)) {
            return { seconds: [s[0], s[1]] };
          }
          this.report('PP3252', '"seconds" as a range must be [lo, hi] with 0 <= lo <= hi', `${pointer}/seconds`);
          return undefined;
        }
        const seconds = this.number(s, `${pointer}/seconds`, '"seconds"', 0);
        return seconds !== undefined && { seconds };
      }
      case 'set': {
        const key = this.key(v['key'], `${pointer}/key`);
        if (v['value'] === undefined) {
          this.report('PP3252', 'a "set" node needs a "value"', pointer, { fix: 'Use "clear" to remove a key.' });
          return undefined;
        }
        const value = this.value(v['value'], `${pointer}/value`);
        const ttl = v['ttl'] === undefined || v['ttl'] === null ? null : this.number(v['ttl'], `${pointer}/ttl`, '"ttl"', 0);
        return key !== undefined && value !== undefined && ttl !== undefined && { key, value, ttl };
      }
      case 'add': {
        const key = this.key(v['key'], `${pointer}/key`);
        const value = v['value'] ?? 1;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          this.report('PP3252', '"value" of an "add" must be a number', `${pointer}/value`);
          return undefined;
        }
        return key !== undefined && { key, value };
      }
      case 'clear': {
        const key = this.key(v['key'], `${pointer}/key`);
        return key !== undefined && { key };
      }
      case 'do': {
        const task = v['task'];
        if (typeof task !== 'string' || task === '') {
          this.report('PP3252', '"task" must name a task registered with ai(tasks=[...])', `${pointer}/task`);
          return undefined;
        }
        const rawArgs = plain(v['args']) ?? {};
        if (!isObject(rawArgs)) {
          this.report('PP3252', '"args" must be an object', `${pointer}/args`);
          return undefined;
        }
        const args: Record<string, Value> = {};
        for (const [k, a] of Object.entries(rawArgs)) {
          const value = this.value(a, `${pointer}/args/${k}`);
          if (value === undefined) return undefined;
          args[k] = value;
        }
        this.tasks.add(task);
        return { task, args };
      }
      case 'move_to': {
        const key = this.key(v['key'], `${pointer}/key`);
        const stop = v['stopping_distance'] === undefined || v['stopping_distance'] === null ? null : this.number(v['stopping_distance'], `${pointer}/stopping_distance`, '"stopping_distance"', 0);
        const speed = v['speed'] === undefined || v['speed'] === null ? null : this.number(v['speed'], `${pointer}/speed`, '"speed"', 0);
        return key !== undefined && stop !== undefined && speed !== undefined && { key, stoppingDistance: stop, speed };
      }
      case 'utility':
        return this.#utility(v, pointer);
      case 'plan':
        return this.#plan(v, pointer);
    }
  }

  #utility(v: Raw, pointer: string): object | undefined {
    const raw = plain(v['options']);
    if (!Array.isArray(raw) || raw.length === 0) {
      this.report('PP3252', '"options" must be a list of {child, base?, considerations}', `${pointer}/options`);
      return undefined;
    }
    const hysteresis = v['hysteresis'] === undefined ? 0.1 : this.number(v['hysteresis'], `${pointer}/hysteresis`, '"hysteresis"', 0);
    const options: UtilityOption[] = [];
    let ok = hysteresis !== undefined;
    raw.forEach((o, i) => {
      const at = `${pointer}/options/${i}`;
      const opt = plain(o);
      if (!isObject(opt)) {
        this.report('PP3252', 'a utility option must be an object', at);
        ok = false;
        return;
      }
      for (const key of Object.keys(opt)) {
        if (!['child', 'base', 'considerations'].includes(key)) {
          this.report('PP3252', `a utility option has no "${key}"`, `${at}/${key}`, { fix: 'Its keys: child, base, considerations.' });
          ok = false;
        }
      }
      const base = opt['base'] === undefined ? 1 : this.number(opt['base'], `${at}/base`, '"base"', 0);
      const considerations = this.#considerations(opt['considerations'], `${at}/considerations`);
      const child = opt['child'] === undefined ? (this.report('PP3252', 'a utility option needs a "child"', at), undefined) : this.node(opt['child'], `${at}/child`);
      if (base === undefined || considerations === undefined || child === undefined) ok = false;
      else options.push({ child, base, considerations });
    });
    return ok ? { options, hysteresis } : undefined;
  }

  #considerations(raw: unknown, pointer: string): Consideration[] | undefined {
    const v = plain(raw) ?? [];
    if (!Array.isArray(v)) {
      this.report('PP3252', '"considerations" must be a list', pointer);
      return undefined;
    }
    const out: Consideration[] = [];
    for (let i = 0; i < v.length; i++) {
      const at = `${pointer}/${i}`;
      const c = plain(v[i]);
      if (!isObject(c)) {
        this.report('PP3252', 'a consideration must be an object {key, curve?, min?, max?, weight?}', at);
        return undefined;
      }
      for (const key of Object.keys(c)) {
        if (!['key', 'curve', 'min', 'max', 'weight'].includes(key)) {
          const guess = closestMatch(key, ['key', 'curve', 'min', 'max', 'weight']);
          this.report('PP3252', `a consideration has no "${key}"`, `${at}/${key}`, { fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Its keys: key, curve, min, max, weight.' });
          return undefined;
        }
      }
      const key = this.key(c['key'], `${at}/key`);
      const curve = c['curve'] ?? 'linear';
      if (typeof curve !== 'string' || !(CURVES as readonly string[]).includes(curve)) {
        const guess = typeof curve === 'string' ? closestMatch(curve, CURVES) : undefined;
        this.report('PP3252', `unknown curve ${JSON.stringify(curve)}`, `${at}/curve`, { fix: guess !== undefined ? `Did you mean "${guess}"?` : `Curves: ${CURVES.join(', ')}.` });
        return undefined;
      }
      const min = c['min'] ?? 0;
      const max = c['max'] ?? 1;
      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        this.report('PP3252', '"min" and "max" must be numbers with min < max', at);
        return undefined;
      }
      const weight = c['weight'] === undefined ? 1 : this.number(c['weight'], `${at}/weight`, '"weight"', 0);
      if (key === undefined || weight === undefined) return undefined;
      out.push({ key, curve: curve as Curve, min, max, weight });
    }
    return out;
  }

  #plan(v: Raw, pointer: string): object | undefined {
    const goal = this.facts(v['goal'], `${pointer}/goal`);
    if (goal !== undefined && goal.length === 0) {
      this.report('PP3252', 'a "plan" needs a "goal": the facts it makes true', `${pointer}/goal`);
      return undefined;
    }
    const maxDepth = v['max_depth'] === undefined ? 6 : this.number(v['max_depth'], `${pointer}/max_depth`, '"max_depth"', 1, true);
    const raw = plain(v['actions']);
    if (!Array.isArray(raw) || raw.length === 0) {
      this.report('PP3252', '"actions" must be a list of {name, child, cost?, pre?, effects?}', `${pointer}/actions`);
      return undefined;
    }
    const actions: PlanAction[] = [];
    const names = new Set<string>();
    let ok = goal !== undefined && maxDepth !== undefined;
    raw.forEach((a, i) => {
      const at = `${pointer}/actions/${i}`;
      const act = plain(a);
      if (!isObject(act)) {
        this.report('PP3252', 'a plan action must be an object', at);
        ok = false;
        return;
      }
      for (const key of Object.keys(act)) {
        if (!['name', 'child', 'cost', 'pre', 'effects'].includes(key)) {
          this.report('PP3252', `a plan action has no "${key}"`, `${at}/${key}`, { fix: 'Its keys: name, child, cost, pre, effects.' });
          ok = false;
        }
      }
      const name = act['name'];
      if (typeof name !== 'string' || name === '' || names.has(name)) {
        this.report('PP3252', typeof name === 'string' && names.has(name) ? `two plan actions are named "${name}"` : 'a plan action needs a unique "name"', `${at}/name`);
        ok = false;
        return;
      }
      names.add(name);
      const cost = act['cost'] === undefined ? 1 : this.number(act['cost'], `${at}/cost`, '"cost"', 0);
      const pre = this.facts(act['pre'], `${at}/pre`);
      const effects = this.#effects(act['effects'], `${at}/effects`);
      const child = act['child'] === undefined ? (this.report('PP3252', 'a plan action needs a "child"', at), undefined) : this.node(act['child'], `${at}/child`);
      if (cost === undefined || pre === undefined || effects === undefined || child === undefined) ok = false;
      else actions.push({ name, child, cost, pre, effects });
    });
    return ok ? { goal, actions, maxDepth } : undefined;
  }

  #effects(raw: unknown, pointer: string): Record<string, Value> | undefined {
    const v = plain(raw) ?? {};
    if (!isObject(v)) {
      this.report('PP3252', '"effects" must be an object of blackboard keys and values', pointer);
      return undefined;
    }
    const out: Record<string, Value> = {};
    for (const [key, value] of Object.entries(v)) {
      const k = this.key(key, `${pointer}/${key}`);
      const val = this.value(value, `${pointer}/${key}`);
      if (k === undefined || val === undefined) return undefined;
      out[k] = val;
    }
    return out;
  }

  #subtree(v: Raw, pointer: string): Node | undefined {
    const id = v['tree'];
    if (typeof id !== 'string' || id === '') {
      this.report('PP3252', '"tree" must name another behavior tree', `${pointer}/tree`);
      return undefined;
    }
    if (this.#stack.includes(id)) {
      this.report('PP3252', `subtree "${id}" includes itself (${[...this.#stack, id].join(' → ')})`, `${pointer}/tree`, { fix: 'Break the cycle; a tree can loop with "repeat".' });
      return undefined;
    }
    const doc = this.#scope.tree?.(id);
    if (doc === undefined) {
      const guess = closestMatch(id, this.#scope.treeIds?.() ?? []);
      this.report('PP3252', `no behavior tree "${id}"`, `${pointer}/tree`, { fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Add content/behavior_tree/<id>.json, or register it with ai(trees=[...]).' });
      return undefined;
    }
    const root = isObject(plain(doc)) ? (plain(doc) as Raw)['root'] : undefined;
    // Problems inside the other tree are its own document's (checked on its own): here
    // they are muted and reported once, at this node.
    this.#stack.push(id);
    this.#muted++;
    const failures = this.#failures;
    const node = root === undefined ? undefined : this.node(root, '');
    this.#muted--;
    this.#stack.pop();
    if (node === undefined || this.#failures > failures) {
      this.report('PP3252', `subtree "${id}" does not parse`, `${pointer}/tree`, { fix: `Fix behavior tree "${id}" first.` });
      return undefined;
    }
    return node;
  }
}

/**
 * Parse a tree document. `stack` names the trees being inlined (cycle detection). On any
 * problem `tree` is undefined and `diagnostics` says why, with JSON pointers into the doc.
 */
export function parseTree(id: string, doc: unknown, scope: ParseScope = {}, stack: readonly string[] = []): { tree?: TreeDef; diagnostics: Diagnostic[] } {
  const p = new Parser(scope, [...stack, id]);
  const v = plain(doc);
  if (!isObject(v)) {
    p.report('PP3252', `behavior tree "${id}" must be an object {"root": ..., "blackboard"?: ..., "tick"?: ...}`, '');
    return { diagnostics: p.out };
  }
  for (const key of Object.keys(v)) {
    if (!['root', 'blackboard', 'tick'].includes(key)) {
      const guess = closestMatch(key, ['root', 'blackboard', 'tick']);
      p.report('PP3252', `a behavior tree has no "${key}"`, `/${key}`, { fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Its keys: root, blackboard, tick.' });
    }
  }
  const tick = v['tick'] === undefined ? 0.1 : p.number(v['tick'], '/tick', '"tick"', 0);
  const blackboard: Record<string, Value> = {};
  const bb = plain(v['blackboard']) ?? {};
  if (!isObject(bb)) p.report('PP3252', '"blackboard" must be an object of starting values', '/blackboard');
  else {
    for (const [key, value] of Object.entries(bb)) {
      const k = p.key(key, `/blackboard/${key}`);
      const val = p.value(value, `/blackboard/${key}`);
      if (k !== undefined && val !== undefined) blackboard[k] = val;
    }
  }
  if (v['root'] === undefined) {
    p.report('PP3252', `behavior tree "${id}" has no "root" node`, '');
    return { diagnostics: p.out };
  }
  const root = p.node(v['root'], '/root');
  if (root === undefined || tick === undefined || p.out.length > 0) return { diagnostics: p.out };
  return { tree: { id, root, nodes: p.nodes, blackboard, tick, tasks: p.tasks }, diagnostics: [] };
}

/** Whether a blackboard value (undefined: absent) passes a check. */
export function testCheck(check: Check, value: Value | undefined): boolean {
  switch (check.op) {
    case 'truthy': return truthy(value);
    case 'falsy': return !truthy(value);
    case 'exists': return value !== undefined && value !== null;
    case 'missing': return value === undefined || value === null;
    case '==': return sameValue(value ?? null, check.value);
    case '!=': return !sameValue(value ?? null, check.value);
    default: {
      if (typeof value !== 'number') return false;
      const n = check.value as number;
      return check.op === '<' ? value < n : check.op === '<=' ? value <= n : check.op === '>' ? value > n : value >= n;
    }
  }
}

export function describeCheck(check: Check): string {
  return ['truthy', 'falsy', 'exists', 'missing'].includes(check.op)
    ? `${check.key} ${check.op}` : `${check.key} ${check.op} ${describeValue(check.value)}`;
}
