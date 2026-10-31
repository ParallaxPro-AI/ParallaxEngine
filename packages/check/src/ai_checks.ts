/**
 * AI data that a field schema can't check (the ai plugin, sdk/parallax/ai.pyi):
 *
 *   - every `behavior_tree` content entry parses with the runtime's own parser (unknown
 *     node types, keys and ops, bad values, subtree cycles — PP3252, with JSON pointers),
 *     so a tree that checks is a tree that runs;
 *   - the tasks its `do` nodes run are registered in `ai(tasks=[Task("name", ...)])`
 *     (PP2561) — checked when every entry of `tasks=` is a literal `Task("name", ...)` call;
 *   - a `brain.tree` on a prefab or placement names a tree (PP2560).
 *
 * Trees built in Python (`ai(trees=[Tree("id", ...)])`) count as known by id when written
 * as literal `Tree("id", ...)` calls; when `trees=` holds anything else (a variable), names
 * the check can't resolve are warnings instead of errors.
 */

import { closestMatch, diagnostic } from '@parallax/runtime/core';
import type { Diagnostic } from '@parallax/runtime/core';
import { BEHAVIOR_TREE, parseTree } from '@parallax/runtime/plugins/ai';
import type { Json, JsonObject } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';

/** Names in a plugin option list of `Call("name", ...)`s; `complete` is false when an entry isn't one. */
function callNames(option: Json | undefined, call: string): { names: Set<string>; complete: boolean } {
  const names = new Set<string>();
  if (option === undefined || option === null) return { names, complete: true };
  if (!Array.isArray(option)) return { names, complete: false };
  const pattern = new RegExp(`^${call}\\(\\s*['"]([^'"]+)['"]`);
  let complete = true;
  for (const entry of option) {
    const expr = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as JsonObject)['expr'] : undefined;
    const m = typeof expr === 'string' ? pattern.exec(expr) : null;
    if (m === null) complete = false;
    else names.add(m[1]!);
  }
  return { names, complete };
}

function asWarning(d: Diagnostic): Diagnostic {
  return diagnostic(d.code, d.message, {
    severity: 'warning', ...(d.path !== undefined && { path: d.path }), ...(d.pointer !== undefined && { pointer: d.pointer }),
    ...(d.fix !== undefined && { fix: `${d.fix} (It may be a Tree in ai(trees=...) the check can't read.)` }),
  });
}

export function checkAi(ctx: CheckContext): void {
  if (!ctx.plugins.has('ai')) return;
  const options = (ctx.decl.game?.plugins.find((p) => p.id === 'ai')?.options ?? {}) as JsonObject;
  const tasks = callNames(options['tasks'], 'Task');
  const codeTrees = callNames(options['trees'], 'Tree');
  const entries = ctx.project.content.get(BEHAVIOR_TREE) ?? new Map();
  const known = [...new Set([...entries.keys(), ...codeTrees.names])];
  // A code tree's body isn't readable here: stand in for it so subtrees to it resolve.
  const stand = { root: { type: 'wait', seconds: 0 } };
  const doc = (id: string): unknown => entries.get(id)?.values ?? (codeTrees.names.has(id) ? stand : undefined);

  for (const entry of entries.values()) {
    const { tree, diagnostics } = parseTree(entry.id, entry.values, { path: entry.path, tree: doc, treeIds: () => known });
    for (const d of diagnostics) {
      ctx.out.push(!codeTrees.complete && d.message.startsWith('no behavior tree') ? asWarning(d) : d);
    }
    if (tree === undefined || !tasks.complete) continue;
    for (const task of tree.tasks) {
      if (tasks.names.has(task)) continue;
      const guess = closestMatch(task, [...tasks.names]);
      ctx.report('PP2561', `Behavior tree "${entry.id}" runs task "${task}", which ai(tasks=[...]) doesn't register`, {
        path: entry.path, fix: guess !== undefined ? `Did you mean "${guess}"?` : `Add Task("${task}", <function>) to ai(tasks=[...]).`,
      });
    }
  }

  const brainTree = (components: Readonly<Record<string, JsonObject>>, at: { readonly path: string; readonly pointer: string }): void => {
    const tree = components['brain']?.['tree'];
    if (typeof tree !== 'string' || known.includes(tree)) return;
    const guess = closestMatch(tree, known);
    ctx.report('PP2560', `Brain names behavior tree "${tree}", which doesn't exist`, {
      ...(codeTrees.complete ? {} : { severity: 'warning' as const }),
      path: at.path, pointer: `${at.pointer}/components/brain/tree`,
      fix: guess !== undefined ? `Did you mean "${guess}"?` : `Add content/behavior_tree/${tree}.json, or Tree("${tree}", ...) in ai(trees=[...]).`,
    });
  };
  for (const prefab of ctx.project.prefabs.values()) brainTree(prefab.components, { path: prefab.path, pointer: '' });
  for (const scene of ctx.project.scenes.values()) {
    for (const placement of scene.entities) brainTree(placement.components, placement.origin);
  }
}
