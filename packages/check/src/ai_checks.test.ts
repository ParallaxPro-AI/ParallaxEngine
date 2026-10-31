/**
 * AI data checks over a real example (read-only): the FPS example with the ai plugin added
 * in memory — its engine declarations as the extract pass gives them for parallax.ai — then
 * behavior trees, task names and Brain refs broken one at a time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '@parallax/runtime/core';
import { checkFiles } from './check.js';
import type { Declarations } from './declarations.js';
import { runExtract } from './extract.js';
import { directoryFiles, memoryFiles } from './files.js';

const DIR = fileURLToPath(new URL('../../../examples/fps_shooter', import.meta.url));
const BOT = 'prefabs/bot.prefab.json';

let files: Record<string, string>;
let declarations: Declarations;

beforeAll(() => {
  const tree = directoryFiles(DIR);
  files = {};
  for (const path of tree.all()) if (!/\.(png|glb|ogg|mp3|wav)$/.test(path)) files[path] = tree.read(path);
  const extracted = runExtract(DIR);
  if (!extracted.ok) throw new Error(extracted.diagnostic.message);
  declarations = extracted.declarations;
});

const GUARD = {
  tick: 0.2,
  root: {
    type: 'selector', children: [
      { type: 'sequence', name: 'combat', children: [{ type: 'check', key: 'target_visible' }, { type: 'do', task: 'shoot' }] },
      { type: 'subtree', tree: 'patrol' },
    ],
  },
};
const PATROL = { root: { type: 'sequence', children: [{ type: 'do', task: 'walk' }, { type: 'wait', seconds: [1, 2] }] } };

function check(trees: Record<string, unknown>, options: Record<string, unknown>, brain: unknown = 'guard'): readonly Diagnostic[] {
  const bot = JSON.parse(files[BOT]!) as { components: Record<string, unknown> };
  bot.components['brain'] = { tree: brain };
  const decl = structuredClone(declarations) as unknown as {
    game: { plugins: { id: string; options: unknown; line: number }[] };
    engine: { components: Record<string, unknown>; content: Record<string, unknown> };
  };
  decl.game.plugins.push({ id: 'ai', options, line: 1 });
  decl.engine.components['brain'] = {
    name: 'Brain', module: 'parallax.ai', plugins: ['ai'], fields: {
      tree: { type: { kind: 'optional', of: { kind: 'string' } }, default: null },
      tick: { type: { kind: 'optional', of: { kind: 'number' } }, default: null, min: 0 },
      enabled: { type: { kind: 'bool' }, default: true },
    },
  };
  decl.engine.content['behavior_tree'] = {
    name: 'BehaviorTreeDef', module: 'parallax.ai', plugins: ['ai'], localized: [], fields: {
      root: { type: { kind: 'json' } }, blackboard: { type: { kind: 'dict', of: { kind: 'json' } }, default: {} }, tick: { type: { kind: 'number' }, default: 0.1, min: 0 },
    },
  };
  const extra: Record<string, string> = { [BOT]: JSON.stringify(bot) };
  for (const [id, doc] of Object.entries(trees)) extra[`content/behavior_tree/${id}.json`] = JSON.stringify(doc);
  return checkFiles(memoryFiles({ ...files, ...extra }), decl as unknown as Declarations, { assetFiles: false }).diagnostics;
}

const TASKS = { tasks: [{ expr: "Task('shoot', shoot)" }, { expr: "Task('walk', walk, stop=halt)" }] };
const brief = (found: readonly Diagnostic[]): string[] =>
  found.filter((d) => d.code === 'PP3252' || d.code.startsWith('PP256')).map((d) => `${d.code} ${d.severity} ${d.path ?? ''}${d.pointer ?? ''}`);

describe('ai checks', () => {
  it('accepts good trees, registered tasks and Brain refs', () => {
    const found = check({ guard: GUARD, patrol: PATROL }, TASKS);
    expect(brief(found)).toEqual([]);
    expect(found.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('reports tree problems with the runtime parser\'s pointers', () => {
    const broken = { root: { type: 'selector', children: [{ type: 'check', key: 'hp', op: '=<', value: 3 }, { type: 'wiat', seconds: 1 }] } };
    const found = check({ guard: broken, patrol: PATROL }, TASKS);
    expect(brief(found)).toEqual([
      'PP3252 error content/behavior_tree/guard.json/root/children/0/op',
      'PP3252 error content/behavior_tree/guard.json/root/children/1/type',
    ]);
    expect(found.find((d) => d.pointer === '/root/children/1/type')!.fix).toBe('Did you mean "wait"?');
  });

  it('unregistered tasks and unknown Brain trees are errors; unknown code trees make them warnings', () => {
    expect(brief(check({ guard: GUARD, patrol: PATROL }, { tasks: [{ expr: "Task('shot', shoot)" }, { expr: "Task('walk', walk)" }] })))
      .toEqual(['PP2561 error content/behavior_tree/guard.json']);
    expect(brief(check({ guard: GUARD, patrol: PATROL }, TASKS, 'gaurd'))).toEqual(['PP2560 error prefabs/bot.prefab.json/components/brain/tree']);
    // A task list the check can't read: task names aren't checked.
    expect(brief(check({ guard: GUARD, patrol: PATROL }, { tasks: { expr: 'TASKS' } }))).toEqual([]);
    // A code tree named literally resolves; one behind a variable makes misses warnings.
    expect(brief(check({ guard: GUARD }, { ...TASKS, trees: [{ expr: "Tree('patrol', Do('walk'))" }] }))).toEqual([]);
    expect(brief(check({ guard: GUARD }, { ...TASKS, trees: [{ expr: 'PATROL' }] }, 'patrol'))).toEqual([
      'PP3252 warning content/behavior_tree/guard.json/root/children/1/tree',
      'PP2560 warning prefabs/bot.prefab.json/components/brain/tree',
    ]);
  });
});
