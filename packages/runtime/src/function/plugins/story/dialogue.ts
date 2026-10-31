/**
 * Running a conversation: walks a parsed `.yarn` node, evaluating conditions against the
 * facts, running `<<set>>` and commands as it reaches them, and stopping at each line (until
 * the player advances), at each option group (until one is chosen) and at `<<wait>>`.
 *
 * Its position is plain data — a stack of (block path, index) frames — so a snapshot holds a
 * conversation mid-way and puts it back exactly.
 */

import { fail } from '../../../core/index.js';
import type { DialogueDoc, DialogueNode, Expr, FactValue, LineContent, Segment, Stmt } from './yarn.js';
import { lineKeys } from './yarn.js';

/** Where in a node a frame runs: [] is the node body; each pair is (statement, clause or option). */
type Path = readonly number[];

export interface Frame {
  readonly path: Path;
  index: number;
}

export interface ShownLine {
  /** `story.<dialogue>.<line id>` with `#line:`, else `story.<dialogue>.<node>.<n>` (n-th line of the node, from 1). */
  readonly key: string;
  readonly speaker: string | null;
  readonly text: string;
  readonly tags: readonly string[];
}

export interface ShownOption extends ShownLine {
  readonly enabled: boolean;
}

/** What the conversation is waiting on. */
export type Pending =
  | { readonly kind: 'line'; readonly line: ShownLine }
  | { readonly kind: 'options'; readonly options: readonly ShownOption[]; readonly path: Path; readonly at: number }
  | { readonly kind: 'wait'; remaining: number }
  | { readonly kind: 'end' };

/** What the runner needs from the story: facts, commands and line text. */
export interface DialogueHooks {
  fact(name: string, where: string): FactValue;
  setFact(name: string, value: FactValue, where: string): void;
  command(name: string, args: readonly FactValue[], where: string): void;
}

export interface RunnerState {
  readonly dialogue: string;
  readonly node: string;
  readonly frames: readonly { readonly path: readonly number[]; readonly index: number }[];
  readonly pending: Pending;
}

function display(value: FactValue): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

export function evaluate(e: Expr, hooks: DialogueHooks, where: string): FactValue {
  const at = `${where} line ${e.at.line}`;
  switch (e.kind) {
    case 'literal': return e.value;
    case 'fact': return hooks.fact(e.name, at);
    case 'not': return !expect(evaluate(e.arg, hooks, where), 'boolean', 'not', at);
    case 'neg': return -expect(evaluate(e.arg, hooks, where), 'number', '-', at);
    case 'binary': {
      if (e.op === 'and') return expect(evaluate(e.left, hooks, where), 'boolean', 'and', at) && expect(evaluate(e.right, hooks, where), 'boolean', 'and', at);
      if (e.op === 'or') return expect(evaluate(e.left, hooks, where), 'boolean', 'or', at) || expect(evaluate(e.right, hooks, where), 'boolean', 'or', at);
      const l = evaluate(e.left, hooks, where);
      const r = evaluate(e.right, hooks, where);
      switch (e.op) {
        case '==': return l === r;
        case '!=': return l !== r;
        case '+':
          if (typeof l === 'string' && typeof r === 'string') return l + r;
          return expect(l, 'number', '+', at) + expect(r, 'number', '+', at);
        case '<': return expect(l, 'number', '<', at) < expect(r, 'number', '<', at);
        case '>': return expect(l, 'number', '>', at) > expect(r, 'number', '>', at);
        case '<=': return expect(l, 'number', '<=', at) <= expect(r, 'number', '<=', at);
        case '>=': return expect(l, 'number', '>=', at) >= expect(r, 'number', '>=', at);
        case '-': return expect(l, 'number', '-', at) - expect(r, 'number', '-', at);
        case '*': return expect(l, 'number', '*', at) * expect(r, 'number', '*', at);
        case '/': {
          const d = expect(r, 'number', '/', at);
          if (d === 0) fail('PP3983', `${at}: division by zero`);
          return expect(l, 'number', '/', at) / d;
        }
        case '%': {
          const d = expect(r, 'number', '%', at);
          if (d === 0) fail('PP3983', `${at}: modulo by zero`);
          const n = expect(l, 'number', '%', at);
          return ((n % d) + d) % d;
        }
      }
    }
  }
}

function expect<T extends 'boolean' | 'number'>(value: FactValue, type: T, op: string, at: string): T extends 'boolean' ? boolean : number {
  if (typeof value !== type) fail('PP3983', `${at}: "${op}" needs a ${type === 'boolean' ? 'bool' : 'number'}, got ${JSON.stringify(value)}`);
  return value as never;
}

function condition(e: Expr | null, hooks: DialogueHooks, where: string): boolean {
  if (e === null) return true;
  const value = evaluate(e, hooks, where);
  if (typeof value !== 'boolean') fail('PP3983', `${where} line ${e.at.line}: a condition must be a bool, got ${JSON.stringify(value)}`);
  return value;
}

export class DialogueRunner {
  readonly doc: DialogueDoc;
  #node: DialogueNode;
  #frames: Frame[];
  #pending: Pending = { kind: 'end' };
  readonly #hooks: DialogueHooks;
  /** Localization keys by line, built on first use. */
  #keys: ReadonlyMap<LineContent, string> | undefined;

  constructor(doc: DialogueDoc, node: string, hooks: DialogueHooks) {
    this.doc = doc;
    this.#hooks = hooks;
    this.#node = this.#nodeNamed(node);
    this.#frames = [{ path: [], index: 0 }];
  }

  #nodeNamed(title: string): DialogueNode {
    const node = this.doc.nodes.get(title);
    if (node === undefined) {
      fail('PP3984', `story/${this.doc.id}.yarn has no node "${title}"`, {
        fix: `Nodes: ${[...this.doc.nodes.keys()].join(', ')}.`,
      });
    }
    return node;
  }

  get node(): string { return this.#node.title; }
  get pending(): Pending { return this.#pending; }
  get where(): string { return `story/${this.doc.id}.yarn node "${this.#node.title}"`; }

  #block(path: Path): readonly Stmt[] {
    let block = this.#node.body;
    for (let i = 0; i < path.length; i += 2) {
      const stmt = block[path[i]!]!;
      if (stmt.kind === 'if') block = stmt.clauses[path[i + 1]!]!.body;
      else if (stmt.kind === 'options') block = stmt.options[path[i + 1]!]!.body;
      else fail('PP9980', `${this.where}: a saved dialogue position no longer matches the file`);
    }
    return block;
  }

  #show(content: LineContent): ShownLine {
    const text = content.text.map((s: Segment) => (typeof s === 'string' ? s : display(evaluate(s, this.#hooks, this.where)))).join('');
    this.#keys ??= lineKeys(this.doc);
    const key = this.#keys.get(content)!;
    return { key, speaker: content.speaker, text, tags: content.tags };
  }

  /** Run until a line, options, a wait or the end; returns what it stopped at. */
  run(): Pending {
    for (;;) {
      const top = this.#frames[this.#frames.length - 1];
      if (top === undefined) return (this.#pending = { kind: 'end' });
      const block = this.#block(top.path);
      if (top.index >= block.length) { this.#frames.pop(); continue; }
      const at = top.index;
      const stmt = block[at]!;
      top.index++;
      const where = `${this.where} line ${stmt.at.line}`;
      switch (stmt.kind) {
        case 'line':
          if (!condition(stmt.condition, this.#hooks, this.where)) continue;
          return (this.#pending = { kind: 'line', line: this.#show(stmt.content) });
        case 'options': {
          const options = stmt.options.map((o) => ({ ...this.#show(o.content), enabled: condition(o.condition, this.#hooks, this.where) }));
          if (!options.some((o) => o.enabled)) {
            fail('PP3985', `${where}: every option is disabled, so the conversation can't go on`, {
              fix: 'Leave at least one option without a condition (a way out).',
            });
          }
          return (this.#pending = { kind: 'options', options, path: top.path, at });
        }
        case 'if': {
          const clause = stmt.clauses.findIndex((c) => condition(c.condition, this.#hooks, this.where));
          if (clause >= 0) this.#frames.push({ path: [...top.path, at, clause], index: 0 });
          continue;
        }
        case 'set':
          this.#hooks.setFact(stmt.name, evaluate(stmt.value, this.#hooks, this.where), `${where} <<set>>`);
          continue;
        case 'jump':
          this.#node = this.#nodeNamed(stmt.node);
          this.#frames = [{ path: [], index: 0 }];
          continue;
        case 'stop':
          this.#frames = [];
          continue;
        case 'wait': {
          const seconds = evaluate(stmt.seconds, this.#hooks, this.where);
          if (typeof seconds !== 'number' || !(seconds >= 0)) fail('PP3983', `${where}: <<wait>> needs 0 or more seconds, got ${JSON.stringify(seconds)}`);
          return (this.#pending = { kind: 'wait', remaining: seconds });
        }
        case 'command':
          this.#hooks.command(stmt.name, stmt.args.map((a) => evaluate(a, this.#hooks, this.where)), where);
          continue;
      }
    }
  }

  /** Past the current line (or a finished wait). */
  advance(): Pending {
    if (this.#pending.kind === 'options') {
      fail('PP3986', `${this.where}: the conversation is waiting for a choice`, { fix: 'Choose an option (the panel\'s "choose" action with option=<index>).' });
    }
    return this.run();
  }

  choose(index: number): Pending {
    const pending = this.#pending;
    if (pending.kind !== 'options') fail('PP3986', `${this.where}: there is no choice to make now`);
    const option = pending.options[index];
    if (!Number.isInteger(index) || option === undefined) {
      fail('PP3986', `${this.where}: option ${index} doesn't exist`, { fix: `Choose 0 to ${pending.options.length - 1}.` });
    }
    if (!option.enabled) fail('PP3986', `${this.where}: option ${index} ("${option.text}") is disabled`, { fix: 'Choose an enabled option.' });
    this.#frames.push({ path: [...pending.path, pending.at, index], index: 0 });
    return this.run();
  }

  state(): RunnerState {
    return {
      dialogue: this.doc.id,
      node: this.#node.title,
      frames: this.#frames.map((f) => ({ path: [...f.path], index: f.index })),
      pending: this.#pending,
    };
  }

  static restore(doc: DialogueDoc, state: RunnerState, hooks: DialogueHooks): DialogueRunner {
    const runner = new DialogueRunner(doc, state.node, hooks);
    runner.#frames = state.frames.map((f) => ({ path: [...f.path], index: f.index }));
    for (const f of runner.#frames) runner.#block(f.path);
    runner.#pending = state.pending.kind === 'wait' ? { kind: 'wait', remaining: state.pending.remaining } : state.pending;
    return runner;
  }
}
