/**
 * `parallax.story` (sdk/parallax/story.pyi): facts (`fact`, `ctx.story.facts`), the built-in
 * `quest` content kind (`QuestDef`, `QuestStep`, `QuestBranch`), `@quest_verb`,
 * `@dialogue_command`, the story events, and `ctx.story`. The behavior lives in the story
 * plugin (function/plugins/story/); this module is its Python-facing names and the host that
 * gives the plugin game-facing values.
 *
 *     MetQueen = fact("met_queen", False)            # $met_queen in .yarn
 *     ctx.story.say(Dialogue.innkeeper, speaker=npc)
 *     ctx.story.start_quest(Content.quest.missing_brother)
 */

import { fail } from '../core/index.js';
import { decode } from '../function/kernel/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import { BUILT_IN_VERBS, checkFactDecl, story as storyPlugin, STORY_EVENTS } from '../function/plugins/story/index.js';
import type {
  FactDecl, FactValue, QuestModel, QuestStepDef, QuestVerbDecl, StoryEngine,
} from '../function/plugins/story/index.js';
import type { ContentEntry } from '../resource/index.js';
import { ContentRef } from './content.js';
import type { Context } from './context.js';
import { content, declareBuiltIns, record } from './declarations.js';
import { eventHandle } from './events.js';
import { bindArgs, kw } from './kwargs.js';
import { coerce, DialogueRef, field, Localized, PrefabRef, resolveType, rt, SoundRef } from './types.js';
import type { ApiType, CoerceEnv } from './types.js';
import { DialoguePanel, registeredPanels } from './ui.js';

export { DialogueRef } from './types.js';
export { DialoguePanel } from './ui.js';
export { DIALOGUE_INPUT_SERVICE } from '../function/services/index.js';
export { dialogueInput } from './input.js';

// ── Facts ──────────────────────────────────────────────────────────────────────

/** A declared story fact: `MetQueen = fact("met_queen", False)`. */
export class Fact {
  readonly key: string;
  readonly default: FactValue;

  constructor(decl: FactDecl) {
    this.key = decl.key;
    this.default = decl.default;
  }

  __eq__(o: unknown): boolean { return o instanceof Fact && o.key === this.key; }
  toString(): string { return `Fact(${this.key})`; }
}

/** Declared facts by key (the last declaration of a key wins: a fresh module realm re-declares). */
let facts = new Map<string, FactDecl>();
let verbs = new Map<string, VerbRegistration>();
let commands = new Map<string, CommandRegistration>();

/** Forget the game's facts, verbs and commands (a fresh module realm; `reset.ts`). */
export function resetStory(): void {
  facts = new Map();
  verbs = new Map();
  commands = new Map();
}

export function fact(...args: unknown[]): Fact {
  const a = bindArgs('fact', args, { positional: ['key', 'default'], required: ['key', 'default'] }).args;
  const decl = checkFactDecl(a['key'], a['default']);
  const existing = facts.get(decl.key);
  if (existing !== undefined && existing.default !== decl.default) {
    fail('PP4181', `Fact "${decl.key}" is declared twice, with defaults ${JSON.stringify(existing.default)} and ${JSON.stringify(decl.default)}`, {
      fix: 'Declare each fact once (one module of facts) and import the handle where it is used.',
    });
  }
  facts.set(decl.key, decl);
  return new Fact(decl);
}

function factKey(f: unknown, where: string): string {
  if (!(f instanceof Fact)) fail('PP3992', `${where} takes a fact handle (from fact("key", default)), got ${String(f)}`);
  return f.key;
}

/** `ctx.story.facts`. */
export class Facts {
  readonly #engine: StoryEngine;

  constructor(engine: StoryEngine) {
    this.#engine = engine;
  }

  get(f: unknown): FactValue {
    return this.#engine.fact(factKey(f, 'facts.get()'));
  }

  set(f: unknown, value: unknown): void {
    this.#engine.setFact(factKey(f, 'facts.set()'), value);
  }

  add(...args: unknown[]): number {
    const a = bindArgs('facts.add', args, { positional: ['f', 'amount'], required: ['f'] }).args;
    return this.#engine.addFact(factKey(a['f'], 'facts.add()'), a['amount'] ?? 1);
  }
}

// ── Quests ─────────────────────────────────────────────────────────────────────

class QuestBranchFields {
  static readonly __annotations__ = {
    fact: () => rt.optional(rt.str),
    outcome: () => rt.optional(rt.str),
    equals: () => rt.union(rt.bool, rt.int, rt.str),
    goto: () => rt.list(rt.str),
  };
  static readonly fact = field(null);
  static readonly outcome = field(null);
  static readonly equals = field(true);
  static readonly goto = field([]);
}

/** Take `goto` instead of `next` when the condition holds. */
export const QuestBranch = record(QuestBranchFields);

class QuestStepFields {
  static readonly __annotations__ = {
    text: () => Localized,
    verb: () => rt.str,
    target: () => rt.str,
    count: () => rt.int,
    args: () => rt.dict(rt.str, rt.any),
    next: () => rt.list(rt.str),
    next_if: () => rt.list(QuestBranch),
    sets: () => rt.list(rt.str),
    marker: () => rt.optional(rt.str),
  };
  static readonly target = field('');
  static readonly count = field(1);
  static readonly args = field({});
  static readonly next = field([]);
  static readonly next_if = field([]);
  static readonly sets = field([]);
  static readonly marker = field(null);

  /** The target as the verb's declared type (an EntityRef, PrefabRef, ContentRef…). */
  resolve(ctx: unknown): unknown {
    const { verb, target } = this as unknown as { verb: string; target: string };
    if (target === '') return null;
    const builtIn = BUILT_IN_TARGETS[verb];
    if (builtIn !== undefined) return builtIn(target);
    const custom = verbs.get(verb);
    if (custom === undefined) fail('PP2191', `"${verb}" is not a quest verb`);
    if (custom.target === null) return target;
    return coerce(custom.target, target, envOf(ctx as Context), `step.resolve() ${verb}`);
  }
}

/** Built-in verbs' targets as game values (`step.resolve(ctx)`). */
const BUILT_IN_TARGETS: Readonly<Record<string, (target: string) => unknown>> = {
  defeat: (t) => new PrefabRef(t),
  reach: (t) => t,
  talk: (t) => t,
  obtain: (t) => t,
  use: (t) => t,
  wait: (t) => t,
  fact: (t) => t,
};

export const QuestStep = record(QuestStepFields);

class QuestDefFields {
  static readonly __annotations__ = {
    title: () => Localized,
    summary: () => Localized,
    start: () => rt.str,
    steps: () => rt.dict(rt.str, QuestStep),
  };
}

/** Built-in content kind: games add entries in content/quest/*.json, or extend it. */
export const QuestDef = declareBuiltIns(() => content('quest')(QuestDefFields), 'story');

/** `ctx.story.quest(q)`. */
export class QuestState {
  readonly status: string;
  readonly active_steps: string[];
  readonly completed_steps: string[];
  readonly #progress: (step: string) => readonly [number, number];

  constructor(status: string, active: string[], completed: string[], progress: (step: string) => readonly [number, number]) {
    this.status = status;
    this.active_steps = active;
    this.completed_steps = completed;
    this.#progress = progress;
  }

  /** (done, needed) for a step. */
  progress(step: unknown): readonly [number, number] {
    if (typeof step !== 'string') fail('PP3992', `progress() takes a step id, got ${String(step)}`);
    return Object.freeze([...this.#progress(step)]) as unknown as readonly [number, number];
  }
}

function questId(value: unknown, where: string): string {
  if (!(value instanceof ContentRef) || value.kind !== 'quest') {
    fail('PP3992', `${where} takes a quest (Content.quest.<id>, or a ContentRef of a QuestDef subclass), got ${String(value)}`);
  }
  return value.id;
}

// ── Events ─────────────────────────────────────────────────────────────────────

export const DialogueStarted = eventHandle(STORY_EVENTS.dialogueStarted, 'DialogueStarted');
export const DialogueEnded = eventHandle(STORY_EVENTS.dialogueEnded, 'DialogueEnded');
export const QuestStarted = eventHandle(STORY_EVENTS.questStarted, 'QuestStarted');
export const QuestStepCompleted = eventHandle(STORY_EVENTS.questStepCompleted, 'QuestStepCompleted');
export const QuestCompleted = eventHandle(STORY_EVENTS.questCompleted, 'QuestCompleted');
export const FactChanged = eventHandle(STORY_EVENTS.factChanged, 'FactChanged');

// ── Verbs and commands ─────────────────────────────────────────────────────────

interface VerbRegistration {
  readonly id: string;
  readonly fn: (...a: unknown[]) => unknown;
  /** Declared target type; null: the verb takes no target. */
  readonly target: ApiType | null;
  readonly args: ReadonlyMap<string, ApiType>;
}

interface CommandRegistration {
  readonly name: string;
  readonly fn: (...a: unknown[]) => unknown;
  /** Parameters after ctx: name and scalar kind. */
  readonly params: readonly { readonly name: string; readonly kind: 'bool' | 'int' | 'number' | 'string' }[];
}

const ID = /^[a-z][a-z0-9_]*$/;

function entries(value: unknown, where: string): [string, unknown][] {
  if (value === null || value === undefined) return [];
  if (value instanceof Map) return [...value].map(([k, v]) => [String(k), v]);
  const items = (value as { items?: () => Iterable<[unknown, unknown]> }).items;
  if (typeof items === 'function') return [...items.call(value)].map(([k, v]) => [String(k), v]);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.entries(value);
  return fail('PP4182', `${where} must be a dict of name → type`);
}

/** `@quest_verb("deliver", target=EntityRef, args={"car": PrefabRef})`. */
export function quest_verb(...args: unknown[]): <F>(fn: F) => F {
  const a = bindArgs('quest_verb', args, { positional: ['id'], keyword: ['target', 'args'], required: ['id'] }).args;
  const id = a['id'];
  if (typeof id !== 'string' || !ID.test(id)) fail('PP4182', `@quest_verb id ${JSON.stringify(id)} must be snake_case`);
  if ((BUILT_IN_VERBS as readonly string[]).includes(id)) {
    fail('PP4182', `@quest_verb("${id}") would replace the built-in verb "${id}"`, { fix: 'Name your verb differently.' });
  }
  const where = `@quest_verb("${id}")`;
  const target = a['target'] === undefined || a['target'] === null ? null : resolveType(a['target'], `${where} target`);
  const declaredArgs = new Map(entries(a['args'], `${where} args`).map(([name, type]) => [name, resolveType(type, `${where} args["${name}"]`)]));
  return (fn) => {
    if (typeof fn !== 'function') fail('PP4182', `${where} must decorate a function (ctx, quest, step, dt)`);
    verbs.set(id, { id, fn: fn as (...a: unknown[]) => unknown, target, args: declaredArgs });
    return fn;
  };
}

type Annotated = { __annotations__?: Record<string, () => unknown> };

/** `@dialogue_command("open_shop")`: `<<open_shop>>` in .yarn calls it with (ctx, *args). */
export function dialogue_command(...args: unknown[]): <F>(fn: F) => F {
  const a = bindArgs('dialogue_command', args, { positional: ['name'], required: ['name'] }).args;
  const name = a['name'];
  if (typeof name !== 'string' || !ID.test(name)) fail('PP4183', `@dialogue_command name ${JSON.stringify(name)} must be snake_case`);
  const where = `@dialogue_command("${name}")`;
  if (['if', 'elseif', 'else', 'endif', 'set', 'jump', 'stop', 'wait', 'declare'].includes(name)) {
    fail('PP4183', `${where} is a built-in .yarn command`, { fix: 'Name your command differently.' });
  }
  return (fn) => {
    if (typeof fn !== 'function') fail('PP4183', `${where} must decorate a function (ctx, *args)`);
    const annotations = (fn as Annotated).__annotations__ ?? {};
    const params = Object.entries(annotations)
      .filter(([p]) => p !== 'ctx' && p !== 'return')
      .map(([p, thunk]) => {
        const type = resolveType(thunk(), `${where} parameter "${p}"`);
        const kind = type.kind === 'value' ? type.field.kind : undefined;
        if (kind !== 'bool' && kind !== 'int' && kind !== 'number' && kind !== 'string') {
          fail('PP4183', `${where} parameter "${p}" must be a bool, int, float or str (what .yarn can pass)`);
        }
        return { name: p, kind };
      });
    const declared = (fn as unknown as { length: number }).length;
    if (Object.keys(annotations).filter((p) => p !== 'return').length === 0 && declared > 1) {
      fail('PP4183', `${where}: annotate the parameters after ctx (int, float, str or bool)`);
    }
    commands.set(name, { name, fn: fn as (...a: unknown[]) => unknown, params });
    return fn;
  };
}

function envOf(ctx: Context): CoerceEnv {
  return { content: (target, id) => ctx.content(target).get(id) };
}

function runCommand(ctx: Context, name: string, args: readonly FactValue[], where: string): void {
  const command = commands.get(name);
  if (command === undefined) fail('PP2187', `${where}: <<${name}>> is not a dialogue command`, { fix: `Declare it: @dialogue_command("${name}").` });
  if (args.length !== command.params.length) {
    fail('PP3993', `${where}: <<${name}>> takes ${command.params.length} argument(s) (${command.params.map((p) => p.name).join(', ') || 'none'}), got ${args.length}`);
  }
  command.params.forEach((p, i) => {
    const v = args[i];
    const ok = p.kind === 'bool' ? typeof v === 'boolean'
      : p.kind === 'string' ? typeof v === 'string'
        : typeof v === 'number' && (p.kind === 'number' || Number.isInteger(v));
    if (!ok) {
      const want = { bool: 'bool', int: 'int', number: 'float', string: 'str' }[p.kind];
      fail('PP3993', `${where}: <<${name}>> argument "${p.name}" must be a ${want}, got ${JSON.stringify(v)}`, {
        fix: p.kind === 'string' ? 'Quote text: "like this".' : undefined,
      });
    }
  });
  command.fn(ctx, ...args);
}

/** A custom verb as the plugin sees it. */
function verbDecl(registration: VerbRegistration, ctx: () => Context): QuestVerbDecl {
  return {
    check(_quest: QuestModel, step: QuestStepDef, entry: ContentEntry) {
      const at = (f: string): string => `${entry.path} ${step.pointer}/${f}`;
      const bad = (f: string, message: string, fix?: string): never =>
        fail('PP2192', `${at(f)}: ${message}`, { path: entry.path, pointer: `${step.pointer}/${f}`, ...(fix !== undefined && { fix }) });
      if (registration.target === null) {
        if (step.target !== '') bad('target', `@quest_verb("${registration.id}") takes no target`, 'Remove "target", or declare target= on the verb.');
      } else if (step.target !== '') {
        const decoded = decode(registration.target.field, step.target, at('target'));
        coerce(registration.target, decoded, envOf(ctx()), at('target'));
      }
      const stepJson = (entry.values['steps'] as Record<string, Record<string, unknown>>)[step.id]!;
      const given = (stepJson['args'] ?? {}) as Record<string, unknown>;
      for (const name of Object.keys(given)) {
        if (!registration.args.has(name)) {
          bad(`args/${name}`, `@quest_verb("${registration.id}") has no argument "${name}"`,
            `Arguments: ${[...registration.args.keys()].join(', ') || '(none)'}.`);
        }
      }
      for (const [name, value] of Object.entries(given)) {
        const type = registration.args.get(name)!;
        coerce(type, decode(type.field, value as never, at(`args/${name}`)), envOf(ctx()), at(`args/${name}`));
      }
    },
    evaluate(quest: string, step: string, dt: number) {
      const c = ctx();
      const ref = c.content(QuestDef).get(quest) as ContentRef<{ steps: { __getitem__(k: string): unknown } }>;
      const result = registration.fn(c, ref, ref.data.steps.__getitem__(step), dt);
      return result;
    },
  };
}

// ── ctx.story ──────────────────────────────────────────────────────────────────

export class StoryApi {
  readonly facts: Facts;
  readonly #engine: StoryEngine;
  readonly #kernel: Kernel;

  constructor(engine: StoryEngine, kernel: Kernel) {
    this.#engine = engine;
    this.#kernel = kernel;
    this.facts = new Facts(engine);
  }

  /** Start a conversation in the built-in DialoguePanel (modal) until it ends. */
  say(...args: unknown[]): void {
    const a = bindArgs('story.say', args, { positional: ['dialogue'], keyword: ['node', 'speaker'], required: ['dialogue'] }).args;
    const dialogue = a['dialogue'];
    if (!(dialogue instanceof DialogueRef)) fail('PP3992', `say() takes a dialogue (Dialogue.<file>, or a DialogueRef field), got ${String(dialogue)}`);
    const node = a['node'] ?? 'start';
    if (typeof node !== 'string') fail('PP3992', `say() node= must be a node title, got ${String(node)}`);
    const speakerHandle = a['speaker'] ?? null;
    let speaker = null;
    if (speakerHandle !== null) {
      speaker = this.#kernel.handles.unwrap(speakerHandle) ?? null;
      if (speaker === null || !this.#kernel.world.isAlive(speaker)) fail('PP3992', `say() speaker= takes a live entity, got ${String(speakerHandle)}`);
    }
    this.#engine.say(dialogue.id, node, speaker);
  }

  quests(...args: unknown[]): unknown[] {
    const a = bindArgs('story.quests', args, { positional: ['status'] }).args;
    const ctx = this.#kernel.context as Context;
    const list = ctx.content(QuestDef);
    return this.#engine.quests((a['status'] ?? 'active') as string).map((id) => list.get(id));
  }

  start_quest(quest: unknown): void {
    this.#engine.startQuest(questId(quest, 'start_quest()'));
  }

  fail_quest(quest: unknown): void {
    this.#engine.failQuest(questId(quest, 'fail_quest()'));
  }

  quest(quest: unknown): QuestState {
    const state = this.#engine.questState(questId(quest, 'quest()'));
    return new QuestState(state.status, [...state.active], [...state.completed], state.progress);
  }

  /** Report progress the plugin can't observe itself (obtain, use, …). */
  report(...args: unknown[]): void {
    const a = bindArgs('story.report', args, { positional: ['verb', 'target', 'count'], required: ['verb', 'target'] }).args;
    if (typeof a['verb'] !== 'string' || typeof a['target'] !== 'string') fail('PP3989', 'report() takes (verb: str, target: str, count: int = 1)');
    this.#engine.report(a['verb'], a['target'], (a['count'] ?? 1) as number);
  }

  get in_dialogue(): boolean {
    return this.#engine.inDialogue;
  }

  // Engine-facing: the built-in DialoguePanel reads and drives the conversation through these.

  /** The DialoguePanel's state: {dialogue, node, speaker, text, tags, options: [{index, speaker, text, enabled}]}. */
  __dialogue_view__(): Record<string, unknown> {
    const view = this.#engine.view();
    if (view === null) return { dialogue: '', node: '', speaker: null, text: '', tags: [], options: [] };
    return { ...view, tags: [...view.tags], options: view.options.map((o) => ({ ...o })) };
  }

  /** The DialoguePanel's `next` action. */
  __next__(): void {
    this.#engine.next();
  }

  /** The DialoguePanel's `choose` action (option index). */
  __choose__(option: unknown): void {
    if (typeof option !== 'number') fail('PP3986', `choose takes an option index, got ${String(option)}`);
    this.#engine.choose(option);
  }
}

// ── The plugin ─────────────────────────────────────────────────────────────────

/** `parallax.plugins.story()`: facts, quests and dialogue. */
export function story(...args: unknown[]): KernelPlugin {
  bindArgs('story', args, {});
  let kernel: Kernel | undefined;
  const ctx = (): Context => kernel!.context as Context;
  const plugin = storyPlugin({
    host: {
      facts: () => [...facts.values()],
      commands: () => new Set(commands.keys()),
      runCommand: (name, commandArgs, where) => runCommand(ctx(), name, commandArgs, where),
      verbs: () => new Map([...verbs].map(([id, r]) => [id, verbDecl(r, ctx)])),
      dialogueRef: (id) => new DialogueRef(id),
      questRef: (id) => ctx().content(QuestDef).get(id),
      localize: (key, text) => ctx().text(new Localized(key, text)),
      openPanel: () => (ctx() as unknown as { ui: { open(p: unknown): void } }).ui.open(dialoguePanel()),
      closePanel: () => (ctx() as unknown as { ui: { close(p: unknown): void } }).ui.close(dialoguePanel()),
      // Voiced lines always duck the music (DESIGN: dialogue sits over the score). A
      // `#voice:<name>` tag names a sound in assets/sfx/; a full "folder/name" handle also works.
      voice: (sound) => (ctx() as unknown as { audio: { play(...a: unknown[]): void } }).audio.play(new SoundRef(sound.includes('/') ? sound : `sfx/${sound}`), kw({ duck: true })),
    },
    namespace: (engine) => new StoryApi(engine, kernel!),
  });
  return {
    ...plugin,
    install(k) {
      kernel = k;
      plugin.install!(k);
    },
  };
}

/** The panel conversations show in: the game's restyled DialoguePanel subclass when it declares one (the last declared), else the built-in. */
function dialoguePanel(): Function {
  const mine = registeredPanels().filter((c) => c !== DialoguePanel && c.prototype instanceof DialoguePanel);
  return mine.at(-1) ?? DialoguePanel;
}
