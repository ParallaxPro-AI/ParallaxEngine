/**
 * `parallax.ai` (sdk/parallax/ai.pyi): the AI components' handles, the AI events, the
 * built-in `behavior_tree` content kind, the behavior-tree node constructors (they build
 * the same documents as content/behavior_tree/*.json, so one parser checks both), `Task`,
 * `Tree`, `Director`, the status constants, `AiApi` (the type of `ctx.ai`), and the `ai()`
 * plugin factory (`parallax.plugins.ai`). The behavior lives in the ai plugin.
 */

import { fail } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import {
  AI_EVENTS, ai as aiPlugin, BEHAVIOR_TREE, BRAIN, COVER_POINT, DETECTABLE, directorSettings, FLOCK, ORDERS, PERCEPTION, SCHEMAS,
  SQUAD_MEMBER, VISION,
} from '../function/plugins/ai/index.js';
import type { TaskDef, TreeSource } from '../function/plugins/ai/index.js';
import { content, declareBuiltIns } from './declarations.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs, kw } from './kwargs.js';
import { field, rt } from './types.js';

export { AiApi, BlackboardView, DirectorHandle, FogHandle, SquadHandle, TaskAgent } from '../function/plugins/ai/index.js';

const handle = (id: string, name: string): ReturnType<typeof componentHandle> => componentHandle({ id, schema: SCHEMAS[id]! }, name);

/** `entity.get(Brain)`: tree, tick, enabled — and blackboard / status / running / describe / restart. */
export const Brain = handle(BRAIN, 'Brain');
export const Perception = handle(PERCEPTION, 'Perception');
export const Detectable = handle(DETECTABLE, 'Detectable');
export const SquadMember = handle(SQUAD_MEMBER, 'SquadMember');
export const CoverPoint = handle(COVER_POINT, 'CoverPoint');
export const Orders = handle(ORDERS, 'Orders');
export const Flock = handle(FLOCK, 'Flock');
export const Vision = handle(VISION, 'Vision');

export const Spotted = eventHandle(AI_EVENTS.spotted, 'Spotted');
export const Suspicious = eventHandle(AI_EVENTS.suspicious, 'Suspicious');
export const LostTarget = eventHandle(AI_EVENTS.lostTarget, 'LostTarget');
export const HeardNoise = eventHandle(AI_EVENTS.heardNoise, 'HeardNoise');
export const OrderDone = eventHandle(AI_EVENTS.orderDone, 'OrderDone');
export const DirectorPhase = eventHandle(AI_EVENTS.directorPhase, 'DirectorPhase');

export const SUCCESS = 'success';
export const FAILURE = 'failure';
export const RUNNING = 'running';

class BehaviorTreeFields {
  static readonly __annotations__ = { root: () => rt.any, blackboard: () => rt.dict(rt.str, rt.any), tick: () => rt.float };
  static readonly blackboard = field({});
  static readonly tick = field(0.1, kw({ min: 0, unit: 's' }));
}

/** Built-in content kind: content/behavior_tree/<id>.json — {"root": node, "blackboard"?: {...}, "tick"?: 0.1}. */
export const BehaviorTreeDef = declareBuiltIns(() => content(BEHAVIOR_TREE)(BehaviorTreeFields), 'ai');

// ── Node constructors: each returns the node document ──────────────────────────

type NodeDoc = Record<string, unknown>;

function named(doc: NodeDoc, name: unknown): NodeDoc {
  if (name === undefined || name === null) return doc;
  if (typeof name !== 'string' || name === '') fail('PP3252', 'a node name must be a non-empty str');
  return { ...doc, name };
}

function composite(type: string, label: string, keywords: readonly string[] = []) {
  return (...args: unknown[]): NodeDoc => {
    const b = bindArgs(label, args, { keyword: ['name', ...keywords], rest: true });
    const extra: NodeDoc = {};
    for (const k of keywords) if (b.args[k] !== undefined && b.args[k] !== null) extra[k] = b.args[k];
    return named({ type, children: b.rest, ...extra }, b.args['name']);
  };
}

function node(type: string, label: string, positional: readonly string[], required: readonly string[], keywords: readonly string[] = []) {
  return (...args: unknown[]): NodeDoc => {
    const a = bindArgs(label, args, { positional, keyword: ['name', ...keywords], required }).args;
    const doc: NodeDoc = { type };
    for (const k of [...positional, ...keywords]) if (a[k] !== undefined && !(a[k] === null && !required.includes(k))) doc[k] = a[k];
    return named(doc, a['name']);
  };
}

export const Sequence = composite('sequence', 'Sequence');
export const Selector = composite('selector', 'Selector', ['memory']);
export const Parallel = composite('parallel', 'Parallel', ['succeed', 'fail']);
export const Random = composite('random', 'Random', ['weights']);
export const Invert = node('invert', 'Invert', ['child'], ['child']);
export const Succeed = node('succeed', 'Succeed', ['child'], ['child']);
export const Fail = node('fail', 'Fail', ['child'], ['child']);
export const Repeat = node('repeat', 'Repeat', ['child'], ['child'], ['times', 'until']);
export const Retry = node('retry', 'Retry', ['child', 'times'], ['child', 'times']);
export const Cooldown = node('cooldown', 'Cooldown', ['child', 'seconds'], ['child', 'seconds']);
export const Timeout = node('timeout', 'Timeout', ['child', 'seconds'], ['child', 'seconds']);
export const Wait = node('wait', 'Wait', ['seconds'], ['seconds']);
export const SetValue = node('set', 'SetValue', ['key', 'value'], ['key', 'value'], ['ttl']);
export const Add = node('add', 'Add', ['key', 'value'], ['key']);
export const Clear = node('clear', 'Clear', ['key'], ['key']);
export const MoveTo = node('move_to', 'MoveTo', ['key'], ['key'], ['stopping_distance', 'speed']);
export const Subtree = node('subtree', 'Subtree', ['tree'], ['tree']);

/** `Check(key, op="truthy", value=...)`: a blackboard test. `value` is given only for comparing ops. */
export function Check(...args: unknown[]): NodeDoc {
  const a = bindArgs('Check', args, { positional: ['key', 'op', 'value'], keyword: ['name'], required: ['key'] }).args;
  return named({ type: 'check', key: a['key'], ...(a['op'] !== undefined && { op: a['op'] }), ...('value' in a && { value: a['value'] }) }, a['name']);
}

/** `Guard(check, child)`: `check` (a Check) is re-tested every tick. */
export function Guard(...args: unknown[]): NodeDoc {
  const a = bindArgs('Guard', args, { positional: ['check', 'child'], keyword: ['name'], required: ['check', 'child'] }).args;
  const check = a['check'];
  if (typeof check !== 'object' || check === null || (check as NodeDoc)['type'] !== 'check') {
    fail('PP3252', 'Guard(check, child) takes a Check(...) first', { fix: 'Write Guard(Check("target_visible"), child).' });
  }
  const { type: _t, name: _n, ...test } = check as NodeDoc;
  return named({ type: 'guard', if: test, child: a['child'] }, a['name']);
}

/** `Do("shoot", spread=2)`: run a registered task; extra keywords are its args (`agent.arg("spread")`). */
export function Do(...args: unknown[]): NodeDoc {
  const b = bindArgs('Do', args, { positional: ['task'], keyword: ['name'], required: ['task'], restKeywords: true });
  return named({ type: 'do', task: b.args['task'], ...(Object.keys(b.restKeywords).length > 0 && { args: b.restKeywords }) }, b.args['name']);
}

/** `Consider(key, curve="linear", min=0, max=1, weight=1)`: one utility consideration. */
export function Consider(...args: unknown[]): NodeDoc {
  const a = bindArgs('Consider', args, { positional: ['key', 'curve', 'min', 'max', 'weight'], required: ['key'] }).args;
  const doc: NodeDoc = { key: a['key'] };
  for (const k of ['curve', 'min', 'max', 'weight']) if (a[k] !== undefined) doc[k] = a[k];
  return doc;
}

/** `Option(child, *considerations, base=1)`: one choice of a Utility node. */
export function Option(...args: unknown[]): NodeDoc {
  const b = bindArgs('Option', args, { positional: ['child'], keyword: ['base'], required: ['child'], rest: true });
  return { child: b.args['child'], considerations: b.rest, ...(b.args['base'] !== undefined && { base: b.args['base'] }) };
}

/** `Utility(*options, hysteresis=0.1)`: run the best-scoring option. */
export function Utility(...args: unknown[]): NodeDoc {
  const b = bindArgs('Utility', args, { keyword: ['name', 'hysteresis'], rest: true });
  return named({ type: 'utility', options: b.rest, ...(b.args['hysteresis'] !== undefined && { hysteresis: b.args['hysteresis'] }) }, b.args['name']);
}

/** `Step(name, child, cost=1, pre={}, effects={})`: one action a Plan can use. */
export function Step(...args: unknown[]): NodeDoc {
  const a = bindArgs('Step', args, { positional: ['name', 'child'], keyword: ['cost', 'pre', 'effects'], required: ['name', 'child'] }).args;
  const doc: NodeDoc = { name: a['name'], child: a['child'] };
  for (const k of ['cost', 'pre', 'effects']) if (a[k] !== undefined && a[k] !== null) doc[k] = a[k];
  return doc;
}

/** `Plan(goal, *steps, max_depth=6)`: reach `goal` (blackboard facts) with the cheapest chain of steps. */
export function Plan(...args: unknown[]): NodeDoc {
  const b = bindArgs('Plan', args, { positional: ['goal'], keyword: ['name', 'max_depth'], required: ['goal'], rest: true });
  return named({ type: 'plan', goal: b.args['goal'], actions: b.rest, ...(b.args['max_depth'] !== undefined && { max_depth: b.args['max_depth'] }) }, b.args['name']);
}

/** `Tree(id, root, blackboard={}, tick=0.1)`: a tree built in code, registered with ai(trees=[...]). */
export class Tree implements TreeSource {
  readonly id: string;
  readonly doc: unknown;

  constructor(...args: unknown[]) {
    const a = bindArgs('Tree', args, { positional: ['id', 'root'], keyword: ['blackboard', 'tick'], required: ['id', 'root'] }).args;
    if (typeof a['id'] !== 'string' || a['id'] === '') fail('PP3255', 'Tree(id, root): id must be a non-empty str');
    this.id = a['id'];
    this.doc = { root: a['root'], ...(a['blackboard'] !== undefined && { blackboard: a['blackboard'] }), ...(a['tick'] !== undefined && { tick: a['tick'] }) };
  }
}

/** `Task(name, tick, *, start=None, stop=None)`: a leaf the trees run with Do(name). */
export class Task implements TaskDef {
  readonly name: string;
  readonly tick: (ctx: unknown, agent: unknown) => unknown;
  readonly start: ((ctx: unknown, agent: unknown) => unknown) | null;
  readonly stop: ((ctx: unknown, agent: unknown) => unknown) | null;

  constructor(...args: unknown[]) {
    const a = bindArgs('Task', args, { positional: ['name', 'tick'], keyword: ['start', 'stop'], required: ['name', 'tick'] }).args;
    if (typeof a['name'] !== 'string' || a['name'] === '') fail('PP3253', 'Task(name, tick): name must be a non-empty str');
    const fn = (v: unknown, what: string): ((ctx: unknown, agent: unknown) => unknown) | null => {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'function') fail('PP3253', `Task("${a['name'] as string}") ${what} must be a function (ctx, agent)`);
      return v as (ctx: unknown, agent: unknown) => unknown;
    };
    this.name = a['name'];
    this.tick = fn(a['tick'], 'tick') ?? fail('PP3253', `Task("${this.name}") needs a tick function`);
    this.start = fn(a['start'], 'start');
    this.stop = fn(a['stop'], 'stop');
  }
}

/** `Director(budget_per_minute=20, ...)`: combat director settings for ai(director=...). */
export class Director {
  readonly settings: Readonly<Record<string, unknown>>;

  constructor(...args: unknown[]) {
    const { restKeywords } = bindArgs('Director', args, { restKeywords: true });
    directorSettings(restKeywords);
    this.settings = restKeywords;
  }
}

function sequenceOf<T>(value: unknown, what: string, is: (v: unknown) => v is T): T[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object' || !(Symbol.iterator in value)) fail('PP3253', `ai(${what}=...) must be a list`);
  const items = [...(value as Iterable<unknown>)];
  items.forEach((v, i) => { if (!is(v)) fail('PP3253', `ai(${what}=...)[${i}] is not a ${what === 'tasks' ? 'Task' : 'Tree'}`); });
  return items as T[];
}

/** `parallax.plugins.ai(*, tasks=(), trees=(), director=None, fog_cell=2)`. */
export function ai(...args: unknown[]): KernelPlugin {
  const a = bindArgs('ai', args, { keyword: ['tasks', 'trees', 'director', 'fog_cell'] }).args;
  const director = a['director'];
  if (director !== undefined && director !== null && !(director instanceof Director)) fail('PP3280', 'ai(director=...) takes a Director(...)');
  const fogCell = a['fog_cell'];
  if (fogCell !== undefined && typeof fogCell !== 'number') fail('PP3285', 'ai(fog_cell=...) must be a number of meters');
  const plugin = aiPlugin({
    tasks: sequenceOf(a['tasks'], 'tasks', (v): v is Task => v instanceof Task),
    trees: sequenceOf(a['trees'], 'trees', (v): v is Tree => v instanceof Tree),
    director: director instanceof Director ? director.settings : null,
    ...(typeof fogCell === 'number' && { fogCell }),
  });
  return { ...plugin, namespace: { name: 'ai', create: () => plugin.api() } };
}
