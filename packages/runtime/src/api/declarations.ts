/**
 * The decorators that declare a game: `@component`, `@resource`, `@config`, `@content`,
 * `@record`, `@event`, `@behavior`, `@system`, `@on`, and `tag()`. A decorator checks
 * its arguments now and records the class; definitions are built when a game starts
 * (`createRuntime`), so annotations may name classes declared later in the module graph.
 *
 * Data classes (components, resources, config, content, records, events) are returned as
 * a subclass whose constructor takes Python arguments: fields in declaration order by
 * position, or by name (`Health(current=3, max=3)` → `new Health(kw({ current: 3, max: 3 }))`).
 */

import { fail } from '../core/index.js';
import type { EventDef, Keep } from '../function/kernel/index.js';
import { bindArgs } from './kwargs.js';
import { COPY } from '../function/kernel/index.js';
import { cloneValue, RECORD, recordEquality, schemaOf, Tag } from './types.js';
import type { AnyClass, SchemaInfo } from './types.js';

// ── The registry of declared classes ───────────────────────────────────────────

export interface Declarations {
  readonly components: AnyClass[];
  readonly resources: AnyClass[];
  readonly configs: AnyClass[];
  readonly contents: AnyClass[];
  readonly events: AnyClass[];
  readonly behaviors: AnyClass[];
}

function empty(): Declarations {
  return { components: [], resources: [], configs: [], contents: [], events: [], behaviors: [] };
}

let declared: Declarations = empty();
/** Declared by the api itself (Settings…): survive `resetDeclarations`. */
let builtIn: Declarations = empty();

/** Everything declared so far: the engine's built-ins, then the game's. */
export function declarations(): Declarations {
  return {
    components: [...builtIn.components, ...declared.components],
    resources: [...builtIn.resources, ...declared.resources],
    configs: [...builtIn.configs, ...declared.configs],
    contents: [...builtIn.contents, ...declared.contents],
    events: [...builtIn.events, ...declared.events],
    behaviors: [...builtIn.behaviors, ...declared.behaviors],
  };
}

/** Forget the game's data and logic declarations (`reset.ts` also forgets action sets and panels). */
export function resetGameDeclarations(): void {
  declared = empty();
}

/** The plugin (by kernel plugin id) whose built-in content kinds these classes are. */
const builtInPlugin = new WeakMap<AnyClass, string>();

/**
 * Run `declare` with its declarations recorded as engine built-ins. With `plugin`, the
 * content kinds it declares belong to that plugin: they exist only in games that list it
 * (so a game without economy() may declare its own "item" kind).
 */
export function declareBuiltIns<T>(declare: () => T, plugin?: string): T {
  const game = declared;
  declared = builtIn;
  const before = builtIn.contents.length;
  try {
    return declare();
  } finally {
    declared = game;
    if (plugin !== undefined) for (const cls of builtIn.contents.slice(before)) builtInPlugin.set(cls, plugin);
  }
}

/** The plugin a built-in content kind belongs to (`declareBuiltIns(..., plugin)`), or undefined. */
export function contentPlugin(cls: AnyClass): string | undefined {
  return builtInPlugin.get(cls);
}

// ── Data classes ───────────────────────────────────────────────────────────────

/** Field names a data-class instance was constructed with (`spawn(components=)` overrides only these). */
export const GIVEN = Symbol('parallax.given');

function checkId(what: string, id: unknown): string {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(id)) {
    fail('PP4111', `${what} id ${JSON.stringify(id)} must be snake_case`, { fix: 'Use lowercase letters, digits and underscores.' });
  }
  return id;
}

function checkClass<T>(what: string, cls: T): T {
  if (typeof cls !== 'function') fail('PP4111', `@${what} must decorate a class`);
  return cls;
}

/** Fill `target` from Python constructor arguments against `info`. */
export function initFields(target: Record<string, unknown>, info: SchemaInfo, args: readonly unknown[], name: string): void {
  const names = info.fields.map((f) => f.name);
  const { args: bound } = bindArgs(name, args, { positional: names });
  for (const f of info.fields) {
    if (f.name in bound) target[f.name] = bound[f.name];
    else if (f.apiDefault !== undefined) target[f.name] = cloneValue(f.apiDefault.value);
    else fail('PP3030', `${name}() is missing the required field "${f.name}"`);
  }
  Object.defineProperty(target, GIVEN, { value: new Set(Object.keys(bound)), enumerable: false });
}

/** A subclass of `cls` constructed from Python arguments. */
function dataClass<T extends AnyClass>(cls: T, label: string): T {
  const Base = cls as unknown as new () => object;
  const data = class extends Base {
    constructor(...args: unknown[]) {
      super();
      initFields(this as Record<string, unknown>, schemaOf(data, `${label} ${cls.name}`), args, cls.name);
    }
  };
  Object.defineProperty(data, 'name', { value: cls.name });
  return data as unknown as T;
}

function setStatic(cls: object, name: string, value: unknown): void {
  Object.defineProperty(cls, name, { value, enumerable: false, writable: false, configurable: true });
}

// ── Data decorators ────────────────────────────────────────────────────────────

/** `@component("lane")`: per-entity data. */
export function component(...args: unknown[]): <T extends AnyClass>(cls: T) => T {
  const { id } = bindArgs('component', args, { positional: ['id'], required: ['id'] }).args;
  const componentId = checkId('component', id);
  return (cls) => {
    const data = dataClass(checkClass('component', cls), 'component');
    setStatic(data, '__component_id__', componentId);
    declared.components.push(data);
    return data;
  };
}

/** `@resource("run", keep="run")`: a game-wide singleton. */
export function resource(...args: unknown[]): <T extends AnyClass>(cls: T) => T {
  const bound = bindArgs('resource', args, { positional: ['id'], keyword: ['keep'], required: ['id'] }).args;
  const resourceId = checkId('resource', bound['id']);
  const keep = (bound['keep'] ?? 'run') as Keep;
  if (!['scene', 'run', 'session', 'profile'].includes(keep)) {
    fail('PP4110', `keep=${JSON.stringify(keep)} is not a lifetime`, { fix: 'Use "scene", "run", "session" or "profile".' });
  }
  return (cls) => {
    const data = dataClass(checkClass('resource', cls), 'resource');
    setStatic(data, '__resource_id__', resourceId);
    setStatic(data, '__resource_keep__', keep);
    declared.resources.push(data);
    return data;
  };
}

/** `@config("rules")`: one read-only document, config/<id>.json. */
export function config(...args: unknown[]): <T extends AnyClass>(cls: T) => T {
  const { id } = bindArgs('config', args, { positional: ['id'], required: ['id'] }).args;
  const configId = checkId('config', id);
  return (cls) => {
    const data = dataClass(checkClass('config', cls), 'config');
    setStatic(data, '__config_id__', configId);
    declared.configs.push(data);
    return data;
  };
}

/** `@content("stage", order="number")`: a registry, content/<kind>/<id>.json. */
export function content(...args: unknown[]): <T extends AnyClass>(cls: T) => T {
  const bound = bindArgs('content', args, { positional: ['kind'], keyword: ['order'], required: ['kind'] }).args;
  const kind = checkId('content', bound['kind']);
  const order = bound['order'] ?? null;
  if (order !== null && typeof order !== 'string') fail('PP4110', 'content order= must name a field');
  return (cls) => {
    const data = dataClass(checkClass('content', cls), 'content');
    setStatic(data, '__content_kind__', kind);
    setStatic(data, '__content_order__', order);
    declared.contents.push(data);
    return data;
  };
}

/** `@record`: a nested value type for fields. */
export function record<T extends AnyClass>(cls: T): T {
  const data = dataClass(checkClass('record', cls), 'record');
  setStatic(data, RECORD as unknown as string, true);
  recordEquality(data, cls.prototype as object);
  // The kernel copies field values (defaults, spawns) through this, so no two entities share one.
  Object.defineProperty(data.prototype, COPY, { value(this: object) { return cloneValue(this); } });
  return data;
}

/** `@event("stage_started", target=None)`: a typed message, emitted as an instance. */
export function event(...args: unknown[]): <T extends AnyClass>(cls: T) => T {
  const bound = bindArgs('event', args, { positional: ['id'], keyword: ['target'], required: ['id'] }).args;
  const eventId = checkId('event', bound['id']);
  const target = bound['target'] ?? undefined;
  if (target !== undefined && typeof target !== 'string') fail('PP4110', 'event target= must name an Entity field');
  return (cls) => {
    const data = dataClass(checkClass('event', cls), 'event');
    const def: EventDef = target === undefined ? { id: eventId } : { id: eventId, target: target as string };
    setStatic(data, '__event_id__', eventId);
    setStatic(data, '__event_def__', def);
    declared.events.push(data);
    return data;
  };
}

/** A data-less marker: `Paddle = tag("paddle")`. */
export function tag(...args: unknown[]): Tag {
  const { id } = bindArgs('tag', args, { positional: ['id'], required: ['id'] }).args;
  return Tag.of(checkId('tag', id));
}

// ── Logic ──────────────────────────────────────────────────────────────────────

/** Base of game behaviors. `entity` is set by the engine before `start`. */
export class Behavior {
  declare entity: unknown;
}

/** Base of game systems. Systems have no fields. */
export class System {}

export interface BehaviorOptions {
  readonly id: string;
  readonly requires: readonly unknown[];
  readonly tick: BehaviorTick;
  readonly when: ((ctx: unknown) => unknown) | undefined;
}

export interface SystemOptions {
  readonly id: string;
  readonly scenes: readonly unknown[];
  readonly when: ((ctx: unknown) => unknown) | undefined;
  readonly after: readonly unknown[];
  readonly runsWhileFrozen: boolean;
  /** Where it runs in a networked game (`runs_on=`). */
  readonly runsOn: 'server' | 'client' | 'everywhere';
}

export const BEHAVIOR = Symbol('parallax.behavior');
export const SYSTEM = Symbol('parallax.system');

function optionalFn(what: string, value: unknown): ((ctx: unknown) => unknown) | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'function') fail('PP4110', `${what}= must be a function (a lambda)`);
  return value as (ctx: unknown) => unknown;
}

function sequence(what: string, value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object' || !(Symbol.iterator in value)) fail('PP4110', `${what}= must be a list`);
  return [...(value as Iterable<unknown>)];
}

/**
 * How often a behavior's `update` runs: every frame, a rate in Hz, or by significance —
 * every frame while its entity is on screen, less often off screen and far from the
 * camera (`SIGNIFICANCE_RATES`).
 */
export type BehaviorTick = 'frame' | 'significance' | number;

/**
 * `tick="significance"`: Hz for an entity off screen within `near` meters of the active
 * camera, and beyond it. On screen (or with no camera) it runs every frame. The skipped
 * time is passed on: `update` gets the seconds since it last ran.
 */
export const SIGNIFICANCE_RATES = { near: 40, offScreenNear: 10, offScreenFar: 2 } as const;

/** `@behavior("orb", requires=[Rigidbody], tick="frame", when=None)`. */
export function behavior(...args: unknown[]): <T extends AnyClass>(cls: T) => T {
  const bound = bindArgs('behavior', args, { positional: ['id'], keyword: ['requires', 'tick', 'when'], required: ['id'] }).args;
  const tick = bound['tick'] ?? 'frame';
  if (tick !== 'frame' && tick !== 'significance' && !(typeof tick === 'number' && tick > 0)) {
    fail('PP4110', `tick=${JSON.stringify(tick)} must be "frame", "significance" or a positive rate in Hz`);
  }
  const options: BehaviorOptions = {
    id: checkId('behavior', bound['id']),
    requires: sequence('requires', bound['requires']),
    tick: tick as BehaviorTick,
    when: optionalFn('when', bound['when']),
  };
  return (cls) => {
    if (!(checkClass('behavior', cls).prototype instanceof Behavior)) {
      fail('PP4111', `@behavior class ${cls.name} must subclass Behavior`);
    }
    setStatic(cls, '__behavior_id__', options.id);
    setStatic(cls, BEHAVIOR as unknown as string, options);
    declared.behaviors.push(cls);
    return cls;
  };
}

/** `@system("stages", scenes=[...], when=None, after=[...], runs_while_frozen=False, runs_on="server")`. */
export function system(...args: unknown[]): <T extends AnyClass>(cls: T) => T {
  const bound = bindArgs('system', args, {
    positional: ['id'], keyword: ['scenes', 'when', 'after', 'runs_while_frozen', 'runs_on'], required: ['id'],
  }).args;
  const runsOn = bound['runs_on'] ?? 'server';
  if (!['server', 'client', 'everywhere'].includes(runsOn as string)) {
    fail('PP4110', `runs_on=${JSON.stringify(runsOn)} must be "server", "client" or "everywhere"`);
  }
  const options: SystemOptions = {
    id: checkId('system', bound['id']),
    scenes: sequence('scenes', bound['scenes']),
    when: optionalFn('when', bound['when']),
    after: sequence('after', bound['after']),
    runsWhileFrozen: bound['runs_while_frozen'] === true,
    runsOn: runsOn as SystemOptions['runsOn'],
  };
  return (cls) => {
    if (!(checkClass('system', cls).prototype instanceof System)) {
      fail('PP4111', `@system class ${cls.name} must subclass System`);
    }
    setStatic(cls, '__system_id__', options.id);
    setStatic(cls, SYSTEM as unknown as string, options);
    return cls;
  };
}

export function behaviorOptions(cls: AnyClass): BehaviorOptions {
  return (cls as unknown as Record<symbol, BehaviorOptions>)[BEHAVIOR]!;
}

export function systemOptions(cls: unknown): SystemOptions {
  const options = typeof cls === 'function' ? (cls as unknown as Record<symbol, SystemOptions | undefined>)[SYSTEM] : undefined;
  if (options === undefined) {
    fail('PP4111', `${typeof cls === 'function' ? cls.name : String(cls)} is not a @system class`);
  }
  return options;
}

// ── Event handlers ─────────────────────────────────────────────────────────────

export interface HandlerMark {
  readonly event: unknown;
  readonly when: ((ctx: unknown) => unknown) | undefined;
  readonly where: ((...args: unknown[]) => unknown) | undefined;
  readonly always: boolean;
}

export const HANDLERS = Symbol('parallax.handlers');

/** `@on(Event, when=None, where=None, always=False)` on a behavior or system method. */
export function on(...args: unknown[]): <F>(fn: F) => F {
  const bound = bindArgs('on', args, { positional: ['event_type'], keyword: ['when', 'where', 'always'], required: ['event_type'] }).args;
  const eventType = bound['event_type'];
  eventDefOf(eventType, '@on');
  const mark: HandlerMark = {
    event: eventType,
    when: optionalFn('when', bound['when']),
    where: optionalFn('where', bound['where']) as HandlerMark['where'],
    always: bound['always'] === true,
  };
  return (fn) => {
    if (typeof fn !== 'function') fail('PP4111', '@on must decorate a method');
    const marked = fn as unknown as Record<symbol, HandlerMark[] | undefined>;
    if (marked[HANDLERS] === undefined) Object.defineProperty(fn, HANDLERS, { value: [] });
    marked[HANDLERS]!.push(mark);
    return fn;
  };
}

/** The kernel EventDef behind an event class or engine event handle. */
export function eventDefOf(eventType: unknown, where: string): EventDef {
  const def = typeof eventType === 'function' || typeof eventType === 'object'
    ? (eventType as { __event_def__?: EventDef } | null)?.__event_def__
    : undefined;
  if (def === undefined) {
    fail('PP4111', `${where} needs an event class, got ${typeof eventType === 'function' ? eventType.name : String(eventType)}`, {
      fix: 'Declare it with @event("id"), or use an engine event such as Spawned.',
    });
  }
  return def;
}
