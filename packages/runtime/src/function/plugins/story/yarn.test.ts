import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDialogue, parseDialogue } from './yarn.js';
import type { DialogueDoc, DialogueScope, Stmt } from './yarn.js';

const EXAMPLES = fileURLToPath(new URL('../../../../../../examples/', import.meta.url));

function parse(text: string): DialogueDoc {
  const result = parseDialogue('test', 'story/test.yarn', text);
  expect(result.diagnostics.map((d) => d.message)).toEqual([]);
  return result.doc!;
}

function errors(text: string, scope?: DialogueScope): string[] {
  const result = parseDialogue('test', 'story/test.yarn', text);
  const out = result.diagnostics.map((d) => `${d.code} ${d.message}`);
  if (result.doc !== undefined && scope !== undefined) out.push(...checkDialogue(result.doc, scope).map((d) => `${d.code} ${d.message}`));
  return out;
}

const SCOPE: DialogueScope = {
  facts: new Map([['met', 'bool'], ['gold', 'number'], ['name', 'string']]),
  commands: new Set(['open_shop', 'give']),
};

describe('parsing', () => {
  it('reads lines, speakers, interpolation, tags and comments', () => {
    const doc = parse([
      'title: start',
      'tags: intro',
      '---',
      '// a comment',
      'Elder: Welcome, {$name}! #line:greet #mood_happy',
      'Just text \\{braces\\} and https://example.com',
      '===',
    ].join('\n'));
    const node = doc.nodes.get('start')!;
    expect(node.tags).toEqual(['intro']);
    const [first, second] = node.body as Extract<Stmt, { kind: 'line' }>[];
    expect(first!.content.speaker).toBe('Elder');
    expect(first!.content.lineId).toBe('greet');
    expect(first!.content.tags).toEqual(['mood_happy']);
    expect(first!.content.text[0]).toBe('Welcome, ');
    expect(first!.content.text[1]).toMatchObject({ kind: 'fact', name: 'name' });
    expect(second!.content.speaker).toBeNull();
    expect(second!.content.text).toEqual(['Just text {braces} and https://example.com']);
  });

  it('reads if/elseif/else, options with indented bodies, set, jump, stop, wait and commands', () => {
    const doc = parse([
      'title: start',
      '---',
      '<<if not $met and $gold >= 10>>',
      '  A: one',
      '<<elseif $name == "Ana" or ($gold + 1) * 2 > 3>>',
      '  A: two',
      '<<else>>',
      '  A: three',
      '<<endif>>',
      '-> Buy <<if $gold >= 5>>',
      '    <<give "sword" 2 true>>',
      '    <<set $gold to $gold - 5>>',
      '-> Leave',
      '    <<jump other>>',
      '<<wait 0.5>>',
      '<<stop>>',
      '===',
      'title: other',
      '---',
      'B: bye <<if $met>>',
      '===',
    ].join('\n'));
    const body = doc.nodes.get('start')!.body;
    expect(body.map((s) => s.kind)).toEqual(['if', 'options', 'wait', 'stop']);
    const branch = body[0] as Extract<Stmt, { kind: 'if' }>;
    expect(branch.clauses.map((c) => c.condition === null)).toEqual([false, false, true]);
    const options = body[1] as Extract<Stmt, { kind: 'options' }>;
    expect(options.options.map((o) => o.body.map((s) => s.kind))).toEqual([['command', 'set'], ['jump']]);
    expect(options.options[0]!.condition).not.toBeNull();
    const give = options.options[0]!.body[0] as Extract<Stmt, { kind: 'command' }>;
    expect(give.args.map((a) => (a.kind === 'literal' ? a.value : a.kind))).toEqual(['sword', 2, true]);
    expect(checkDialogue(doc, SCOPE)).toEqual([]);
  });

  it('parses every example .yarn file without a diagnostic', () => {
    let count = 0;
    for (const example of readdirSync(EXAMPLES)) {
      let files: string[];
      try { files = readdirSync(`${EXAMPLES}${example}/story`); } catch { continue; }
      for (const file of files.filter((f) => f.endsWith('.yarn'))) {
        const result = parseDialogue(file.slice(0, -5), `story/${file}`, readFileSync(`${EXAMPLES}${example}/story/${file}`, 'utf8'));
        expect(result.diagnostics, `${example}/${file}`).toEqual([]);
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(6);
  });
});

describe('diagnostics', () => {
  it('reports structure errors with line and column', () => {
    expect(errors('title: start\nElder Mirelle: hi\n===')).toEqual([
      'PP2181 story/test.yarn line 2, column 1: Expected a header line ("title: name") or "---", got "Elder Mirelle: hi"',
    ]);
    expect(errors('title: start\nA: hi\n===\ntitle: b\n---\nB: ok\n===')).toEqual(['PP2181 story/test.yarn line 1, column 1: The node has no "---" line']);
    expect(errors('title: start\n---\nA: hi\n')).toEqual(['PP2181 story/test.yarn line 1, column 1: Node "start" is not closed']);
    expect(errors('---\nA: hi\n===')).toEqual(['PP2181 story/test.yarn line 1, column 1: The node has no title']);
    expect(errors('title: a\n---\nx\n===\ntitle: a\n---\ny\n===')).toEqual(['PP2181 story/test.yarn line 5, column 1: Two nodes are titled "a"']);
  });

  it('reports block and expression errors with line and column, and keeps going across nodes', () => {
    expect(errors('title: a\n---\n<<if $met>>\nA: x\n===')).toEqual(['PP2182 story/test.yarn line 3, column 1: <<if>> is never closed']);
    expect(errors('title: a\n---\n<<endif>>\n===')).toEqual(['PP2182 story/test.yarn line 3, column 1: <<endif>> without an <<if>>']);
    expect(errors('title: a\n---\n<<if $gold = 3>>\nx\n<<endif>>\n===')).toEqual([
      'PP2183 story/test.yarn line 3, column 12: "=" assigns; compare with "=="',
    ]);
    expect(errors('title: a\n---\nA: {visited("x")}\n===\ntitle: b\n---\n  <<set gold to 1>>\n===')).toEqual([
      'PP2183 story/test.yarn line 3, column 5: Function calls are not supported ("visited(...)")',
      'PP2182 story/test.yarn line 7, column 9: <<set>> is written <<set $fact to value>>',
    ]);
    expect(errors('title: a\n---\nA: hi <<open_shop>> there\n===')[0]).toContain('line 3, column 7: A command must be on a line of its own');
    expect(errors('title: a\n---\n<<declare $x = 1>>\n===')[0]).toContain('PP2182');
  });

  it('checks facts, types, jumps and commands against the game', () => {
    const text = [
      'title: start',
      '---',
      'A: {$nope}',
      '<<if $gold>>',
      '<<endif>>',
      '<<set $met to 3>>',
      '<<if $name == 1>>',
      '<<endif>>',
      '<<jump nowhere>>',
      '<<teleport home>>',
      '===',
    ].join('\n');
    expect(errors(text, SCOPE)).toEqual([
      'PP2184 story/test.yarn line 3, column 5: $nope is not a declared fact',
      'PP2185 story/test.yarn line 4, column 6: A condition must be a bool, got a number',
      'PP2185 story/test.yarn line 6, column 15: $met is a bool fact; this sets a number',
      'PP2185 story/test.yarn line 7, column 12: "==" compares a string with a number',
      'PP2186 story/test.yarn line 9, column 1: <<jump nowhere>>: this file has no node "nowhere"',
      'PP2187 story/test.yarn line 10, column 1: <<teleport>> is not a dialogue command',
    ]);
  });
});
