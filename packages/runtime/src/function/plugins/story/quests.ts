/**
 * Quests: entries of the built-in `quest` content kind (content/quest/<id>.json), each a
 * graph of steps. A step has a verb and a target; when its progress reaches `count` it
 * completes — its `sets` facts become true, QuestStepCompleted is emitted, and the first
 * `next_if` branch whose condition holds (else `next`) opens the following steps. A quest
 * whose last active step completes without opening another is completed.
 *
 * Built-in verbs (progress observed by the plugin or reported by the game):
 *
 *   reach    the player enters the region (`regions/<target>/`) or the trigger placed as
 *            `target`
 *   talk     a conversation ends whose speaker was placed as `target`, or whose dialogue
 *            file is `target`
 *   defeat   an entity of prefab `target` dies (combat's Died)            — counts
 *   obtain   reported by the game: ctx.story.report("obtain", target, n)  — counts
 *   use      reported by the game: ctx.story.report("use", target, n)     — counts
 *   wait     `count` seconds of game time pass while the step is active
 *   fact     the fact `target` holds: true (bool), non-empty (str), or >= `count` (number)
 *
 * Any other verb is a custom one (`@quest_verb`), asked every frame while its step is active.
 */

import { fail } from '../../../core/index.js';
import type { Json, JsonObject, ContentEntry } from '../../../resource/index.js';

export const QUEST_KIND = 'quest';

export const BUILT_IN_VERBS = ['reach', 'talk', 'obtain', 'defeat', 'use', 'wait', 'fact'] as const;
export type BuiltInVerb = typeof BUILT_IN_VERBS[number];

/** Verbs whose progress the game may report itself. */
export const REPORTABLE_VERBS: readonly string[] = ['reach', 'talk', 'obtain', 'defeat', 'use'];

export function isBuiltInVerb(verb: string): verb is BuiltInVerb {
  return (BUILT_IN_VERBS as readonly string[]).includes(verb);
}

export interface QuestBranchDef {
  readonly fact: string | null;
  readonly outcome: string | null;
  readonly equals: boolean | number | string;
  readonly goto: readonly string[];
}

export interface QuestStepDef {
  readonly id: string;
  readonly verb: string;
  readonly target: string;
  readonly count: number;
  readonly next: readonly string[];
  readonly nextIf: readonly QuestBranchDef[];
  readonly sets: readonly string[];
  readonly marker: string | null;
  /** JSON pointer of the step in its file, for diagnostics. */
  readonly pointer: string;
}

export interface QuestModel {
  readonly id: string;
  readonly path: string;
  readonly start: string;
  readonly steps: ReadonlyMap<string, QuestStepDef>;
}

import type { QuestStatus } from '../../services/index.js';

export type { QuestStatus };

export interface QuestRecord {
  status: QuestStatus;
  active: string[];
  completed: string[];
  /** Step → progress (a count; seconds for `wait`). */
  progress: Map<string, number>;
}

function bad(entry: ContentEntry, pointer: string, message: string, fix?: string): never {
  return fail('PP2190', `${entry.path} ${pointer}: ${message}`, { path: entry.path, pointer, ...(fix !== undefined && { fix }) });
}

function stringList(entry: ContentEntry, value: Json | undefined, pointer: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) bad(entry, pointer, 'must be a list of strings');
  return value as string[];
}

function objectAt(entry: ContentEntry, value: Json | undefined, pointer: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(entry, pointer, 'must be an object');
  return value as JsonObject;
}

/** The plugin's reading of a quest entry (field types are also checked by the content decoder). */
export function questModel(entry: ContentEntry): QuestModel {
  const start = entry.values['start'];
  if (typeof start !== 'string') bad(entry, '/start', 'a quest needs "start": the id of its first step');
  const stepsJson = objectAt(entry, entry.values['steps'], '/steps');
  const steps = new Map<string, QuestStepDef>();
  for (const [id, raw] of Object.entries(stepsJson)) {
    const pointer = `/steps/${id}`;
    const s = objectAt(entry, raw, pointer);
    const verb = s['verb'];
    if (typeof verb !== 'string' || verb === '') bad(entry, `${pointer}/verb`, 'a step needs a verb', `Use one of ${BUILT_IN_VERBS.join(', ')}, or a @quest_verb id.`);
    const target = s['target'] ?? '';
    if (typeof target !== 'string') bad(entry, `${pointer}/target`, 'must be a string');
    const count = s['count'] ?? 1;
    if (typeof count !== 'number' || !(count > 0) || (verb !== 'wait' && !Number.isInteger(count))) {
      bad(entry, `${pointer}/count`, verb === 'wait' ? 'must be seconds above 0' : 'must be a whole number above 0');
    }
    const marker = s['marker'] ?? null;
    if (marker !== null && typeof marker !== 'string') bad(entry, `${pointer}/marker`, 'must be a placed id or null');
    const branches = s['next_if'] ?? [];
    if (!Array.isArray(branches)) bad(entry, `${pointer}/next_if`, 'must be a list of branches');
    const nextIf = (branches as Json[]).map((b, i): QuestBranchDef => {
      const at = `${pointer}/next_if/${i}`;
      const o = objectAt(entry, b, at);
      const fact = o['fact'] ?? null;
      const outcome = o['outcome'] ?? null;
      if (fact !== null && typeof fact !== 'string') bad(entry, `${at}/fact`, 'must be a fact key');
      if (outcome !== null && typeof outcome !== 'string') bad(entry, `${at}/outcome`, 'must be a string');
      if (fact === null && outcome === null) {
        bad(entry, at, 'a branch needs "fact" or "outcome"', 'Add "fact": "<key>" (with "equals"), or "outcome": "<what the verb returned>".');
      }
      const equals = o['equals'] ?? true;
      if (typeof equals !== 'boolean' && typeof equals !== 'number' && typeof equals !== 'string') bad(entry, `${at}/equals`, 'must be a bool, number or string');
      return { fact: fact as string | null, outcome: outcome as string | null, equals, goto: stringList(entry, o['goto'], `${at}/goto`) };
    });
    steps.set(id, {
      id, verb, target: target as string, count: count as number,
      next: stringList(entry, s['next'], `${pointer}/next`), nextIf,
      sets: stringList(entry, s['sets'], `${pointer}/sets`), marker: marker as string | null, pointer,
    });
  }
  const model: QuestModel = { id: entry.id, path: entry.path, start, steps };
  const exists = (step: string, pointer: string): void => {
    if (!steps.has(step)) bad(entry, pointer, `there is no step "${step}"`, `Steps: ${[...steps.keys()].join(', ') || '(none)'}.`);
  };
  exists(start, '/start');
  for (const step of steps.values()) {
    step.next.forEach((n, i) => exists(n, `${step.pointer}/next/${i}`));
    step.nextIf.forEach((b, i) => b.goto.forEach((n, k) => exists(n, `${step.pointer}/next_if/${i}/goto/${k}`)));
  }
  return model;
}

export function newRecord(): QuestRecord {
  return { status: 'inactive', active: [], completed: [], progress: new Map() };
}

/** `SaveData.quests[id]`: {"status", "active_steps", "completed_steps", "progress"}. */
export function recordJson(record: QuestRecord): JsonObject {
  return {
    status: record.status,
    active_steps: [...record.active],
    completed_steps: [...record.completed],
    progress: Object.fromEntries(record.progress),
  };
}

const STATUSES: readonly QuestStatus[] = ['inactive', 'active', 'completed', 'failed'];

export function recordFrom(model: QuestModel, data: Json, where: string): QuestRecord {
  const o = typeof data === 'object' && data !== null && !Array.isArray(data) ? data as JsonObject : undefined;
  const status = o?.['status'];
  if (o === undefined || typeof status !== 'string' || !STATUSES.includes(status as QuestStatus)) {
    fail('PP3982', `${where}: a saved quest is {"status", "active_steps", "completed_steps", "progress"} with a status of ${STATUSES.join('/')}`);
  }
  const steps = (key: string): string[] => {
    const v = o[key] ?? [];
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !model.steps.has(s))) {
      fail('PP3982', `${where}.${key} must list steps of quest "${model.id}"`, {
        fix: `Steps: ${[...model.steps.keys()].join(', ')}. A save migration can rename removed steps.`,
      });
    }
    return [...v as string[]];
  };
  const progress = new Map<string, number>();
  const p = o['progress'] ?? {};
  if (typeof p !== 'object' || p === null || Array.isArray(p)) fail('PP3982', `${where}.progress must be an object of step → number`);
  for (const [step, n] of Object.entries(p)) {
    if (!model.steps.has(step) || typeof n !== 'number') fail('PP3982', `${where}.progress["${step}"] must be a number for a step of quest "${model.id}"`);
    progress.set(step, n);
  }
  return { status: status as QuestStatus, active: steps('active_steps'), completed: steps('completed_steps'), progress };
}
