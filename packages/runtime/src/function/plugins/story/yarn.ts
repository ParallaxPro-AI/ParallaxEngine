/**
 * The dialogue language: the subset of Yarn Spinner 2 that `.yarn` files in `story/` may use,
 * parsed in-house into a tree the dialogue runner walks. Every problem is a coded diagnostic
 * with the file, line and column.
 *
 *   title: start                     a node: header lines (`title:` is required), `---`,
 *   tags: intro                      the body, `===`. A file holds any number of nodes.
 *   ---
 *   // a comment                     `//` to the end of the line
 *   Elder: Welcome, {$name}. #line:w1   a line: optional `Speaker:`, `{expr}` interpolation,
 *                                    `#line:<id>` (its localization key) and other `#tags`
 *   Elder: Again? <<if $met>>        a line shown only while the condition holds
 *   -> Ask about the mill            options: consecutive `->` lines; each option's body is
 *       Elder: It burned.            the lines indented under it. A trailing `<<if cond>>`
 *   -> Leave <<if not $angry>>       shows the option disabled while the condition is false.
 *   <<if $gold >= 10>> … <<elseif …>> … <<else>> … <<endif>>
 *   <<set $met_queen to true>>       assign a fact (`to` or `=`)
 *   <<jump other_node>>              continue at another node of the same file
 *   <<stop>>                         end the conversation
 *   <<wait 1.5>>                     pause (seconds; the conversation shows nothing meanwhile)
 *   <<open_shop "armour" 2>>         a `@dialogue_command`; arguments are literals, `$facts`
 *                                    or `{expr}`
 *
 * Expressions: number, "string", true/false, `$fact`; `not`/`!`, `and`/`&&`, `or`/`||`,
 * `==`/`is`/`eq`, `!=`/`neq`, `<`/`lt`, `>`/`gt`, `<=`/`lte`, `>=`/`gte`, `+ - * / %`,
 * unary `-`, parentheses. Facts are the only variables; function calls are not supported.
 */

import { diagnostic } from '../../../core/index.js';
import type { Diagnostic, DiagnosticCode } from '../../../core/index.js';

// ── Tree ─────────────────────────────────────────────────────────────────────────

export interface Pos {
  readonly line: number;
  readonly col: number;
}

import type { FactValue } from '../../services/index.js';

export type { FactValue };
export type ValueType = 'bool' | 'number' | 'string';

export type BinaryOp = 'and' | 'or' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '+' | '-' | '*' | '/' | '%';

export type Expr =
  | { readonly kind: 'literal'; readonly value: FactValue; readonly at: Pos }
  | { readonly kind: 'fact'; readonly name: string; readonly at: Pos }
  | { readonly kind: 'not' | 'neg'; readonly arg: Expr; readonly at: Pos }
  | { readonly kind: 'binary'; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr; readonly at: Pos };

/** Literal text, or an interpolated `{expr}`. */
export type Segment = string | Expr;

export interface LineContent {
  readonly speaker: string | null;
  readonly text: readonly Segment[];
  /** `#line:<id>`, or null. */
  readonly lineId: string | null;
  /** Other `#tags`, without the `#`. */
  readonly tags: readonly string[];
  readonly at: Pos;
}

export interface OptionItem {
  readonly content: LineContent;
  /** Disabled (shown, not choosable) while false. */
  readonly condition: Expr | null;
  readonly body: readonly Stmt[];
  readonly at: Pos;
}

export type Stmt =
  | { readonly kind: 'line'; readonly content: LineContent; readonly condition: Expr | null; readonly at: Pos }
  | { readonly kind: 'options'; readonly options: readonly OptionItem[]; readonly at: Pos }
  | { readonly kind: 'if'; readonly clauses: readonly { readonly condition: Expr | null; readonly body: readonly Stmt[] }[]; readonly at: Pos }
  | { readonly kind: 'set'; readonly name: string; readonly value: Expr; readonly at: Pos }
  | { readonly kind: 'jump'; readonly node: string; readonly at: Pos }
  | { readonly kind: 'stop'; readonly at: Pos }
  | { readonly kind: 'wait'; readonly seconds: Expr; readonly at: Pos }
  | { readonly kind: 'command'; readonly name: string; readonly args: readonly Expr[]; readonly at: Pos };

export interface DialogueNode {
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: readonly Stmt[];
  readonly at: Pos;
}

export interface DialogueDoc {
  /** The file name without `.yarn`: `DialogueRef.id`. */
  readonly id: string;
  readonly path: string;
  readonly nodes: ReadonlyMap<string, DialogueNode>;
}

export interface ParseResult {
  /** Undefined when the file has errors. */
  readonly doc: DialogueDoc | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

/** What a file may name: declared facts (with their types) and `@dialogue_command`s. */
export interface DialogueScope {
  readonly facts: ReadonlyMap<string, ValueType>;
  readonly commands: ReadonlySet<string>;
}

const BUILT_IN_COMMANDS = new Set(['if', 'elseif', 'else', 'endif', 'set', 'jump', 'stop', 'wait', 'declare']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function valueType(value: FactValue): ValueType {
  return typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'number' : 'string';
}

// ── Diagnostics ──────────────────────────────────────────────────────────────────

class ParseError extends Error {
  readonly code: DiagnosticCode;
  readonly at: Pos;
  readonly fix: string | undefined;

  constructor(code: DiagnosticCode, message: string, at: Pos, fix?: string) {
    super(message);
    this.code = code;
    this.at = at;
    this.fix = fix;
  }
}

function where(at: Pos): string {
  return `line ${at.line}, column ${at.col}`;
}

// ── Expressions ──────────────────────────────────────────────────────────────────

type Token =
  | { readonly t: 'num'; readonly v: number; readonly at: Pos }
  | { readonly t: 'str'; readonly v: string; readonly at: Pos }
  | { readonly t: 'fact'; readonly v: string; readonly at: Pos }
  | { readonly t: 'word'; readonly v: string; readonly at: Pos }
  | { readonly t: 'op'; readonly v: string; readonly at: Pos };

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '(', ')', '!', '='];

function tokenize(src: string, base: Pos): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const pos = (k: number): Pos => ({ line: base.line, col: base.col + k });
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t') { i++; continue; }
    const at = pos(i);
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      tokens.push({ t: 'num', v: Number(m[0]), at });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue; }
        v += src[j];
        j++;
      }
      if (j >= src.length) throw new ParseError('PP2183', 'Unterminated string', at, 'Close it with ".');
      tokens.push({ t: 'str', v, at });
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_.]*)/.exec(src.slice(i));
      if (m === null) throw new ParseError('PP2183', 'A $ must start a fact name', at, 'Write $fact_name.');
      tokens.push({ t: 'fact', v: m[1]!, at });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!;
      tokens.push({ t: 'word', v: m[0], at });
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op === undefined) throw new ParseError('PP2183', `Unexpected "${c}" in an expression`, at);
    tokens.push({ t: 'op', v: op, at });
    i += op.length;
  }
  return tokens;
}

const WORD_OPS: Readonly<Record<string, string>> = {
  and: '&&', or: '||', not: '!', is: '==', eq: '==', neq: '!=', lt: '<', gt: '>', lte: '<=', gte: '>=',
};

class ExprParser {
  #i = 0;

  readonly tokens: readonly Token[];
  readonly end: Pos;

  constructor(tokens: readonly Token[], end: Pos) {
    this.tokens = tokens;
    this.end = end;
  }

  #peek(): Token | undefined { return this.tokens[this.#i]; }

  /** The operator spelled by the next token (`and` is `&&`), or undefined. */
  #op(): string | undefined {
    const t = this.#peek();
    if (t === undefined) return undefined;
    if (t.t === 'op') return t.v;
    if (t.t === 'word') return WORD_OPS[t.v];
    return undefined;
  }

  get done(): boolean { return this.#i >= this.tokens.length; }

  get position(): Pos { return this.#peek()?.at ?? this.end; }

  parse(): Expr { return this.#or(); }

  #or(): Expr {
    let left = this.#and();
    while (this.#op() === '||') {
      const at = this.#peek()!.at;
      this.#i++;
      left = { kind: 'binary', op: 'or', left, right: this.#and(), at };
    }
    return left;
  }

  #and(): Expr {
    let left = this.#not();
    while (this.#op() === '&&') {
      const at = this.#peek()!.at;
      this.#i++;
      left = { kind: 'binary', op: 'and', left, right: this.#not(), at };
    }
    return left;
  }

  #not(): Expr {
    if (this.#op() === '!') {
      const at = this.#peek()!.at;
      this.#i++;
      return { kind: 'not', arg: this.#not(), at };
    }
    return this.#comparison();
  }

  #comparison(): Expr {
    let left = this.#additive();
    for (;;) {
      const op = this.#op();
      if (op === '=') {
        throw new ParseError('PP2183', '"=" assigns; compare with "=="', this.#peek()!.at, 'Write == (or `is`).');
      }
      if (op !== '==' && op !== '!=' && op !== '<' && op !== '>' && op !== '<=' && op !== '>=') return left;
      const at = this.#peek()!.at;
      this.#i++;
      left = { kind: 'binary', op, left, right: this.#additive(), at };
    }
  }

  #additive(): Expr {
    let left = this.#multiplicative();
    for (let op = this.#op(); op === '+' || op === '-'; op = this.#op()) {
      const at = this.#peek()!.at;
      this.#i++;
      left = { kind: 'binary', op, left, right: this.#multiplicative(), at };
    }
    return left;
  }

  #multiplicative(): Expr {
    let left = this.#unary();
    for (let op = this.#op(); op === '*' || op === '/' || op === '%'; op = this.#op()) {
      const at = this.#peek()!.at;
      this.#i++;
      left = { kind: 'binary', op, left, right: this.#unary(), at };
    }
    return left;
  }

  #unary(): Expr {
    if (this.#op() === '-') {
      const at = this.#peek()!.at;
      this.#i++;
      return { kind: 'neg', arg: this.#unary(), at };
    }
    return this.#primary();
  }

  #primary(): Expr {
    const t = this.#peek();
    if (t === undefined) throw new ParseError('PP2183', 'The expression ends too early', this.end, 'Complete the expression.');
    this.#i++;
    switch (t.t) {
      case 'num': return { kind: 'literal', value: t.v, at: t.at };
      case 'str': return { kind: 'literal', value: t.v, at: t.at };
      case 'fact': return { kind: 'fact', name: t.v, at: t.at };
      case 'word':
        if (t.v === 'true' || t.v === 'false') return { kind: 'literal', value: t.v === 'true', at: t.at };
        if (this.#peek()?.t === 'op' && this.#peek()!.v === '(') {
          throw new ParseError('PP2183', `Function calls are not supported ("${t.v}(...)")`, t.at,
            'Compute the value in game code and keep it in a fact.');
        }
        throw new ParseError('PP2183', `"${t.v}" is not a value`, t.at, `Facts are written with a $: $${t.v}; text goes in quotes: "${t.v}".`);
      case 'op':
        if (t.v === '(') {
          const inner = this.#or();
          const close = this.#peek();
          if (close?.t !== 'op' || close.v !== ')') throw new ParseError('PP2183', 'Missing ")"', close?.at ?? this.end, 'Close the parenthesis.');
          this.#i++;
          return inner;
        }
        throw new ParseError('PP2183', `Unexpected "${t.v}"`, t.at);
    }
  }
}

function parseExpression(src: string, base: Pos): Expr {
  const end: Pos = { line: base.line, col: base.col + src.length };
  const tokens = tokenize(src, base);
  if (tokens.length === 0) throw new ParseError('PP2183', 'An expression is missing', base, 'Write a condition or value here.');
  const parser = new ExprParser(tokens, end);
  const expr = parser.parse();
  if (!parser.done) throw new ParseError('PP2183', 'Unexpected text after the expression', parser.position, 'Remove it, or join it with and/or.');
  return expr;
}

/** A command argument: a literal, a `$fact`, `{expr}`, or a bare word (a string). */
function parseArgument(src: string, at: Pos): Expr {
  if (src.startsWith('{') && src.endsWith('}')) return parseExpression(src.slice(1, -1), { line: at.line, col: at.col + 1 });
  if (src.startsWith('"') || src.startsWith('$') || /^-?[0-9.]/.test(src) || src === 'true' || src === 'false') {
    return parseExpression(src, at);
  }
  return { kind: 'literal', value: src, at };
}

/** Split a command's argument text on whitespace, keeping "quoted strings" and {expressions} whole. */
function splitArguments(src: string, base: Pos): { text: string; at: Pos }[] {
  const out: { text: string; at: Pos }[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === ' ' || src[i] === '\t') { i++; continue; }
    const start = i;
    if (src[i] === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      i++;
    } else if (src[i] === '{') {
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}' && --depth === 0) { i++; break; }
      }
    } else {
      while (i < src.length && src[i] !== ' ' && src[i] !== '\t') i++;
    }
    out.push({ text: src.slice(start, i), at: { line: base.line, col: base.col + start } });
  }
  return out;
}

// ── Lines ────────────────────────────────────────────────────────────────────────

interface SourceLine {
  readonly n: number;
  /** Columns of leading whitespace (a tab counts 4). */
  readonly indent: number;
  /** Text without the indentation and the trailing comment. */
  readonly text: string;
  /** 1-based column where `text` starts. */
  readonly col: number;
}

/** Strip a `//` comment that is outside "strings" and not escaped. */
function stripComment(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '"') quoted = !quoted;
    if (!quoted && c === '/' && text[i + 1] === '/') {
      // `https://` inside a line is text, not a comment.
      if (i > 0 && text[i - 1] === ':') continue;
      return text.slice(0, i);
    }
  }
  return text;
}

function sourceLine(raw: string, n: number): SourceLine {
  let indent = 0;
  let k = 0;
  while (k < raw.length && (raw[k] === ' ' || raw[k] === '\t')) {
    indent += raw[k] === '\t' ? 4 : 1;
    k++;
  }
  return { n, indent, text: stripComment(raw.slice(k)).trimEnd(), col: k + 1 };
}

/** `<<name rest>>` filling the whole text, or undefined. */
function wholeCommand(text: string): { name: string; rest: string; restCol: number } | undefined {
  if (!text.startsWith('<<') || !text.endsWith('>>') || text.indexOf('>>') !== text.length - 2) return undefined;
  const inner = text.slice(2, -2);
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*/.exec(inner);
  if (m === null) return { name: '', rest: inner, restCol: 2 };
  return { name: m[1]!, rest: inner.slice(m[0].length).trimEnd(), restCol: 2 + m[0].length };
}

/** Line text → speaker, segments and tags (and a trailing `<<if cond>>`). */
function parseContent(text: string, at: Pos): { content: LineContent; condition: Expr | null } {
  let body = text;
  // Trailing #tags.
  const tags: string[] = [];
  let lineId: string | null = null;
  for (;;) {
    const m = /(?:^|\s)#([^\s#]+)\s*$/.exec(body);
    if (m === null || isEscaped(body, body.length - m[0].trimStart().length)) break;
    const tag = m[1]!;
    if (tag.startsWith('line:')) {
      if (lineId !== null) throw new ParseError('PP2182', 'A line has two #line: tags', { line: at.line, col: at.col + m.index }, 'Keep one.');
      lineId = tag.slice(5);
      if (!/^[A-Za-z0-9_]+$/.test(lineId)) {
        throw new ParseError('PP2182', `#line:${lineId} must be letters, digits and underscores`, { line: at.line, col: at.col + m.index });
      }
    } else {
      tags.unshift(tag);
    }
    body = body.slice(0, m.index).trimEnd();
  }
  // Trailing <<if cond>>.
  let condition: Expr | null = null;
  const cond = /<<\s*if\s+(.*)>>\s*$/.exec(body);
  if (cond !== null) {
    const exprCol = at.col + cond.index + cond[0].indexOf(cond[1]!);
    condition = parseExpression(cond[1]!.trimEnd(), { line: at.line, col: exprCol });
    body = body.slice(0, cond.index).trimEnd();
  }
  if (/<<|>>/.test(body.replace(/\\[<>]/g, ''))) {
    const col = at.col + body.search(/<<|>>/);
    throw new ParseError('PP2182', 'A command must be on a line of its own', { line: at.line, col },
      'Move <<...>> to its own line (only a trailing <<if ...>> may follow text).');
  }
  // Speaker: everything before the first unescaped ':' when it is a plain name.
  let speaker: string | null = null;
  let textStart = 0;
  const colon = /^([^:{}#<>\\]+?):\s?/.exec(body);
  if (colon !== null) {
    speaker = colon[1]!.trim();
    textStart = colon[0].length;
  }
  const segments = parseSegments(body.slice(textStart), { line: at.line, col: at.col + textStart });
  if (segments.length === 0) throw new ParseError('PP2182', 'This line has no text', at, 'Write what is said, or remove the line.');
  return { content: { speaker, text: segments, lineId, tags, at }, condition };
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function parseSegments(text: string, at: Pos): Segment[] {
  const out: Segment[] = [];
  let literal = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < text.length) { literal += text[i + 1]; i += 2; continue; }
    if (c === '}') throw new ParseError('PP2182', 'Unmatched "}"', { line: at.line, col: at.col + i }, 'Write \\} for a literal brace.');
    if (c === '{') {
      const close = text.indexOf('}', i);
      if (close < 0) throw new ParseError('PP2182', 'Unclosed "{"', { line: at.line, col: at.col + i }, 'Close it with }, or write \\{ for a literal brace.');
      if (literal !== '') out.push(literal);
      literal = '';
      out.push(parseExpression(text.slice(i + 1, close), { line: at.line, col: at.col + i + 1 }));
      i = close + 1;
      continue;
    }
    literal += c;
    i++;
  }
  if (literal.trim() !== '' || (literal !== '' && out.length > 0)) out.push(literal);
  return out;
}

// ── Bodies ───────────────────────────────────────────────────────────────────────

class BodyParser {
  #i = 0;

  readonly lines: readonly SourceLine[];

  constructor(lines: readonly SourceLine[]) {
    this.lines = lines;
  }

  /** Statements until a line indented less than `minIndent`, or (inside an if) its next clause. */
  block(minIndent: number, inIf: boolean): Stmt[] {
    const out: Stmt[] = [];
    while (this.#i < this.lines.length) {
      const ln = this.lines[this.#i]!;
      if (ln.indent < minIndent) break;
      const at = { line: ln.n, col: ln.col };
      const command = wholeCommand(ln.text);
      if (command !== undefined && (command.name === 'elseif' || command.name === 'else' || command.name === 'endif')) {
        if (inIf) break;
        throw new ParseError('PP2182', `<<${command.name}>> without an <<if>>`, at, 'Open the block with <<if condition>>, or remove this line.');
      }
      if (ln.text.startsWith('->')) {
        out.push(this.#options(ln.indent));
        continue;
      }
      this.#i++;
      if (command !== undefined) {
        out.push(this.#command(command, ln, at, minIndent));
        continue;
      }
      const { content, condition } = parseContent(ln.text, at);
      out.push({ kind: 'line', content, condition, at });
    }
    return out;
  }

  #options(indent: number): Stmt {
    const first = this.lines[this.#i]!;
    const options: OptionItem[] = [];
    while (this.#i < this.lines.length) {
      const ln = this.lines[this.#i]!;
      if (ln.indent !== indent || !ln.text.startsWith('->')) break;
      const at = { line: ln.n, col: ln.col };
      const rest = ln.text.slice(2);
      const lead = rest.length - rest.trimStart().length;
      if (rest.trim() === '') throw new ParseError('PP2182', 'An option needs text', at, 'Write the choice after ->.');
      const { content, condition } = parseContent(rest.trim(), { line: ln.n, col: ln.col + 2 + lead });
      this.#i++;
      const body = this.block(indent + 1, false);
      options.push({ content, condition, body, at });
    }
    return { kind: 'options', options, at: { line: first.n, col: first.col } };
  }

  #command(command: { name: string; rest: string; restCol: number }, ln: SourceLine, at: Pos, minIndent: number): Stmt {
    const restAt = { line: ln.n, col: ln.col + command.restCol };
    switch (command.name) {
      case '':
        throw new ParseError('PP2182', 'A command needs a name', at, 'Write <<name arguments>>.');
      case 'if': {
        const clauses: { condition: Expr | null; body: Stmt[] }[] = [];
        let condition: Expr | null = parseExpression(command.rest, restAt);
        let sawElse = false;
        for (;;) {
          const body = this.block(minIndent, true);
          clauses.push({ condition, body });
          const next = this.lines[this.#i];
          const nextCommand = next === undefined ? undefined : wholeCommand(next.text);
          if (next === undefined || nextCommand === undefined || next.indent < minIndent) {
            throw new ParseError('PP2182', '<<if>> is never closed', at, 'Add <<endif>> after its last line.');
          }
          this.#i++;
          const nextAt = { line: next.n, col: next.col };
          if (nextCommand.name === 'endif') break;
          if (sawElse) throw new ParseError('PP2182', `<<${nextCommand.name}>> after <<else>>`, nextAt, 'Move <<else>> to the end, before <<endif>>.');
          if (nextCommand.name === 'else') {
            if (nextCommand.rest !== '') throw new ParseError('PP2182', '<<else>> takes no condition', nextAt, 'Use <<elseif condition>>.');
            sawElse = true;
            condition = null;
          } else {
            condition = parseExpression(nextCommand.rest, { line: next.n, col: next.col + nextCommand.restCol });
          }
        }
        return { kind: 'if', clauses, at };
      }
      case 'set': {
        const m = /^\$([A-Za-z_][A-Za-z0-9_.]*)\s*(?:to\b|=(?!=))\s*/.exec(command.rest);
        if (m === null) throw new ParseError('PP2182', '<<set>> is written <<set $fact to value>>', restAt);
        return { kind: 'set', name: m[1]!, value: parseExpression(command.rest.slice(m[0].length), { line: restAt.line, col: restAt.col + m[0].length }), at };
      }
      case 'jump':
        if (!IDENT.test(command.rest)) throw new ParseError('PP2182', '<<jump>> needs a node title', restAt, 'Write <<jump node_title>>.');
        return { kind: 'jump', node: command.rest, at };
      case 'stop':
        if (command.rest !== '') throw new ParseError('PP2182', '<<stop>> takes no arguments', restAt);
        return { kind: 'stop', at };
      case 'wait':
        return { kind: 'wait', seconds: parseExpression(command.rest, restAt), at };
      case 'declare':
        throw new ParseError('PP2182', '<<declare>> is not used: facts are declared in game code', at,
          'Declare it in Python: `MetQueen = fact("met_queen", False)`, then use $met_queen here.');
      default:
        return {
          kind: 'command', name: command.name,
          args: splitArguments(command.rest, restAt).map((a) => parseArgument(a.text, a.at)), at,
        };
    }
  }

  get rest(): SourceLine | undefined { return this.lines[this.#i]; }
}

// ── Files ────────────────────────────────────────────────────────────────────────

/** Parse one `.yarn` file. `id` is its name (`story/<id>.yarn`). */
export function parseDialogue(id: string, path: string, source: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const report = (e: ParseError): void => {
    diagnostics.push(diagnostic(e.code, `${path} ${where(e.at)}: ${e.message}`, {
      path, line: e.at.line, ...(e.fix !== undefined && { fix: e.fix }),
    }));
  };
  const raw = source.replace(/\r\n?/g, '\n').split('\n');
  const nodes = new Map<string, DialogueNode>();
  let i = 0;
  const blank = (k: number): boolean => sourceLine(raw[k]!, k + 1).text.trim() === '';
  while (i < raw.length) {
    if (blank(i)) { i++; continue; }
    const start = i;
    /** The line after this node's `===`, once found. */
    let after: number | undefined;
    try {
      // Headers.
      const headers = new Map<string, string>();
      let headerAt: Pos = { line: i + 1, col: 1 };
      for (; i < raw.length; i++) {
        const ln = sourceLine(raw[i]!, i + 1);
        if (ln.text.trim() === '---') break;
        if (ln.text.trim() === '') continue;
        if (ln.text.trim() === '===') {
          after = i + 1;
          throw new ParseError('PP2181', 'The node has no "---" line', { line: start + 1, col: 1 }, 'Put --- between the headers and the body.');
        }
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(ln.text);
        if (m === null) {
          throw new ParseError('PP2181', `Expected a header line ("title: name") or "---", got "${ln.text}"`, { line: ln.n, col: ln.col },
            'Start each node with `title: <name>` and `---`, and end it with `===`.');
        }
        if (headers.has(m[1]!)) throw new ParseError('PP2181', `Header "${m[1]}" appears twice`, { line: ln.n, col: ln.col });
        headers.set(m[1]!, m[2]!.trim());
        if (m[1] === 'title') headerAt = { line: ln.n, col: ln.col };
      }
      if (i >= raw.length) throw new ParseError('PP2181', 'The node has no "---" line', { line: start + 1, col: 1 }, 'Put --- between the headers and the body.');
      const title = headers.get('title');
      if (title === undefined) throw new ParseError('PP2181', 'The node has no title', { line: start + 1, col: 1 }, 'Add `title: <name>` above ---.');
      if (!IDENT.test(title)) throw new ParseError('PP2181', `Node title "${title}" must be a name (letters, digits, underscores)`, headerAt);
      if (nodes.has(title)) throw new ParseError('PP2181', `Two nodes are titled "${title}"`, headerAt, 'Rename one of them.');
      // Body.
      i++;
      const bodyLines: SourceLine[] = [];
      let closed = false;
      for (; i < raw.length; i++) {
        const ln = sourceLine(raw[i]!, i + 1);
        if (ln.text.trim() === '===') { closed = true; i++; after = i; break; }
        if (ln.text.trim() === '---') throw new ParseError('PP2181', `"---" inside node "${title}"`, { line: ln.n, col: ln.col }, 'End the node with === first.');
        if (ln.text !== '') bodyLines.push(ln);
      }
      if (!closed) throw new ParseError('PP2181', `Node "${title}" is not closed`, headerAt, 'End it with a line holding ===.');
      const minIndent = bodyLines.length === 0 ? 0 : Math.min(...bodyLines.map((l) => l.indent));
      const parser = new BodyParser(bodyLines);
      const body = parser.block(minIndent, false);
      const leftover = parser.rest;
      if (leftover !== undefined) {
        throw new ParseError('PP2182', 'This line is indented less than the node body', { line: leftover.n, col: leftover.col }, 'Align it with the lines above.');
      }
      const tags = (headers.get('tags') ?? '').split(/\s+/).filter((t) => t !== '');
      nodes.set(title, { title, tags, body, at: headerAt });
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      report(e);
      // Skip to the end of this node and carry on, so one file reports every broken node.
      if (after !== undefined) {
        i = after;
      } else {
        while (i < raw.length && sourceLine(raw[i]!, i + 1).text.trim() !== '===') i++;
        i++;
      }
    }
  }
  if (diagnostics.length === 0 && nodes.size === 0) {
    diagnostics.push(diagnostic('PP2181', `${path} has no nodes`, { path, fix: 'Add a node: `title: start`, `---`, its lines, `===`.' }));
  }
  return { doc: diagnostics.length === 0 ? { id, path, nodes } : undefined, diagnostics };
}

// ── Localization keys ────────────────────────────────────────────────────────────

/**
 * Every line's and option's localization key, by line: `story.<file>.<id>` for a line with
 * `#line:<id>`, else `story.<file>.<node>.<n>`, n counting the node's lines and options from
 * 1 in file order. Translators key `locale/<lang>.json` by these; the text they translate is
 * the whole line, "Speaker: text".
 */
export function lineKeys(doc: DialogueDoc): Map<LineContent, string> {
  const keys = new Map<LineContent, string>();
  for (const node of doc.nodes.values()) {
    let n = 0;
    const add = (content: LineContent): void => {
      n++;
      keys.set(content, `story.${doc.id}.${content.lineId ?? `${node.title}.${n}`}`);
    };
    const walk = (stmts: readonly Stmt[]): void => {
      for (const s of stmts) {
        if (s.kind === 'line') add(s.content);
        else if (s.kind === 'options') for (const o of s.options) { add(o.content); walk(o.body); }
        else if (s.kind === 'if') for (const c of s.clauses) walk(c.body);
      }
    };
    walk(node.body);
  }
  return keys;
}

// ── Checking against the game ────────────────────────────────────────────────────

/**
 * Check a parsed file against what the game declares: every `$fact` exists, expressions
 * are well typed, `<<set>>` matches the fact's type, `<<jump>>` targets a node of this
 * file, and every command is a `@dialogue_command`.
 */
export function checkDialogue(doc: DialogueDoc, scope: DialogueScope): Diagnostic[] {
  const out: Diagnostic[] = [];
  const report = (code: DiagnosticCode, message: string, at: Pos, fix?: string): void => {
    out.push(diagnostic(code, `${doc.path} ${where(at)}: ${message}`, { path: doc.path, line: at.line, ...(fix !== undefined && { fix }) }));
  };
  const typeOf = (e: Expr): ValueType | undefined => {
    switch (e.kind) {
      case 'literal': return valueType(e.value);
      case 'fact': {
        const t = scope.facts.get(e.name);
        if (t === undefined) {
          const known = [...scope.facts.keys()];
          report('PP2184', `$${e.name} is not a declared fact`, e.at, known.length === 0
            ? `Declare it in Python: \`${pascal(e.name)} = fact("${e.name}", False)\` (from parallax.story import fact).`
            : `Declare it with fact("${e.name}", ...), or use one of: ${known.map((k) => `$${k}`).join(', ')}.`);
        }
        return t;
      }
      case 'not': {
        const t = typeOf(e.arg);
        if (t !== undefined && t !== 'bool') report('PP2185', `"not" needs a bool, got a ${t}`, e.at);
        return 'bool';
      }
      case 'neg': {
        const t = typeOf(e.arg);
        if (t !== undefined && t !== 'number') report('PP2185', `"-" needs a number, got a ${t}`, e.at);
        return 'number';
      }
      case 'binary': {
        const l = typeOf(e.left);
        const r = typeOf(e.right);
        if (l === undefined || r === undefined) return binaryResult(e.op, l ?? r);
        switch (e.op) {
          case 'and': case 'or':
            if (l !== 'bool' || r !== 'bool') report('PP2185', `"${e.op}" needs two bools, got ${l} and ${r}`, e.at);
            return 'bool';
          case '==': case '!=':
            if (l !== r) report('PP2185', `"${e.op}" compares a ${l} with a ${r}`, e.at, 'Compare values of the same type.');
            return 'bool';
          case '<': case '>': case '<=': case '>=':
            if (l !== 'number' || r !== 'number') report('PP2185', `"${e.op}" needs two numbers, got ${l} and ${r}`, e.at);
            return 'bool';
          case '+':
            if (l !== r || l === 'bool') report('PP2185', `"+" needs two numbers or two strings, got ${l} and ${r}`, e.at);
            return l;
          default:
            if (l !== 'number' || r !== 'number') report('PP2185', `"${e.op}" needs two numbers, got ${l} and ${r}`, e.at);
            return 'number';
        }
      }
    }
  };
  const condition = (e: Expr | null): void => {
    if (e === null) return;
    const t = typeOf(e);
    if (t !== undefined && t !== 'bool') report('PP2185', `A condition must be a bool, got a ${t}`, e.at, 'Compare it: `$count > 0`, `$name == "Ana"`.');
  };
  const content = (c: LineContent): void => {
    for (const s of c.text) if (typeof s !== 'string') typeOf(s);
  };
  const block = (stmts: readonly Stmt[]): void => {
    for (const s of stmts) {
      switch (s.kind) {
        case 'line': content(s.content); condition(s.condition); break;
        case 'options':
          for (const o of s.options) { content(o.content); condition(o.condition); block(o.body); }
          break;
        case 'if':
          for (const c of s.clauses) { condition(c.condition); block(c.body); }
          break;
        case 'set': {
          const want = scope.facts.get(s.name);
          const got = typeOf(s.value);
          if (want === undefined) {
            report('PP2184', `<<set>> names $${s.name}, which is not a declared fact`, s.at, `Declare it in Python: \`fact("${s.name}", ...)\`.`);
          } else if (got !== undefined && got !== want) {
            report('PP2185', `$${s.name} is a ${want} fact; this sets a ${got}`, s.value.at);
          }
          break;
        }
        case 'jump':
          if (!doc.nodes.has(s.node)) {
            report('PP2186', `<<jump ${s.node}>>: this file has no node "${s.node}"`, s.at, `Nodes: ${[...doc.nodes.keys()].join(', ')}.`);
          }
          break;
        case 'wait': {
          const t = typeOf(s.seconds);
          if (t !== undefined && t !== 'number') report('PP2185', `<<wait>> takes seconds, got a ${t}`, s.seconds.at);
          break;
        }
        case 'command':
          if (BUILT_IN_COMMANDS.has(s.name)) break;
          if (!scope.commands.has(s.name)) {
            const known = [...scope.commands];
            report('PP2187', `<<${s.name}>> is not a dialogue command`, s.at, known.length === 0
              ? `Declare it in Python: \`@dialogue_command("${s.name}")\` on a function (ctx, ...).`
              : `Declare it with @dialogue_command("${s.name}"), or use one of: ${known.join(', ')}.`);
          }
          for (const a of s.args) typeOf(a);
          break;
        case 'stop':
          break;
      }
    }
  };
  for (const node of doc.nodes.values()) block(node.body);
  return out;
}

function binaryResult(op: BinaryOp, known: ValueType | undefined): ValueType | undefined {
  if (op === 'and' || op === 'or' || op === '==' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=') return 'bool';
  if (op === '+') return known;
  return 'number';
}

function pascal(key: string): string {
  return key.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}
