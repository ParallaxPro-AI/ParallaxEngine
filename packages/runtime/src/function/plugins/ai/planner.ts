/**
 * The goal planner behind `plan` nodes: a cheapest-first search over blackboard facts.
 * A state is the values of the keys the goal and the actions mention; an action applies
 * when its `pre` checks pass and sets its `effects`. The first state popped that meets the
 * goal is the cheapest plan (uniform-cost search; ties go to the plan found first, so
 * equal-cost plans come out in action order). Bounded by `maxDepth` steps and
 * MAX_PLAN_STATES visited states. Pure: it reads facts through `read` and returns action
 * indices.
 */

import { encodeValue, sameValue } from './blackboard.js';
import type { Value } from './blackboard.js';
import { testCheck } from './tree.js';
import type { Check, PlanAction } from './tree.js';

export const MAX_PLAN_STATES = 4096;

interface Entry {
  readonly facts: ReadonlyMap<string, Value | undefined>;
  readonly steps: readonly number[];
  readonly cost: number;
  readonly seq: number;
}

function meets(checks: readonly Check[], facts: ReadonlyMap<string, Value | undefined>): boolean {
  return checks.every((c) => testCheck(c, facts.get(c.key)));
}

function stateKey(facts: ReadonlyMap<string, Value | undefined>): string {
  return JSON.stringify([...facts].map(([k, v]) => [k, v === undefined ? '~' : encodeValue(v)]));
}

/** Action indices from the current facts to the goal ([] when it already holds), or null. */
export function plan(goal: readonly Check[], actions: readonly PlanAction[], read: (key: string) => Value | undefined, maxDepth: number): number[] | null {
  const keys = new Set<string>();
  for (const c of goal) keys.add(c.key);
  for (const a of actions) {
    for (const c of a.pre) keys.add(c.key);
    for (const k of Object.keys(a.effects)) keys.add(k);
  }
  const start = new Map([...keys].sort().map((k) => [k, read(k)] as const));
  if (meets(goal, start)) return [];
  let seq = 0;
  const open: Entry[] = [{ facts: start, steps: [], cost: 0, seq: seq++ }];
  const best = new Map<string, number>([[stateKey(start), 0]]);
  let visited = 0;
  while (open.length > 0) {
    // Cheapest first, then oldest (stable ties).
    let at = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i]!;
      const b = open[at]!;
      if (a.cost < b.cost || (a.cost === b.cost && a.seq < b.seq)) at = i;
    }
    const entry = open.splice(at, 1)[0]!;
    if (entry.steps.length > 0 && meets(goal, entry.facts)) return [...entry.steps];
    if (++visited > MAX_PLAN_STATES) return null;
    if (entry.steps.length >= maxDepth) continue;
    actions.forEach((action, i) => {
      if (!meets(action.pre, entry.facts)) return;
      const facts = new Map(entry.facts);
      let changed = false;
      for (const [k, v] of Object.entries(action.effects)) {
        if (!sameValue(facts.get(k), v)) changed = true;
        facts.set(k, v);
      }
      if (!changed) return;
      const cost = entry.cost + action.cost;
      const key = stateKey(facts);
      if ((best.get(key) ?? Infinity) <= cost) return;
      best.set(key, cost);
      open.push({ facts, steps: [...entry.steps, i], cost, seq: seq++ });
    });
  }
  return null;
}
