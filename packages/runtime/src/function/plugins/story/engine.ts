/**
 * The story engine behind `ctx.story`: facts, quests and the running conversation, for one
 * kernel. The api layer supplies what only it knows (the game's facts, commands and verbs,
 * game-facing refs, localized text, the DialoguePanel) through `StoryHost`.
 *
 * Frame order:
 *   update (a plugin system, before the game's)   active steps with custom verbs, `fact`,
 *                                                 `wait` and region `reach` are evaluated
 *   handlers (died, trigger_entered)              `defeat` and trigger `reach` progress
 *   ui hook (after the panels)                    the conversation advances on a press
 *
 * A conversation runs in the built-in DialoguePanel; the line shown, its speaker and the
 * options are `view()`. It advances when the player presses any button (not on the frame it
 * started), or through the panel's `next` / `choose` actions.
 */

import { closestMatch, fail } from '../../../core/index.js';
import type { Diagnostic, EntityId, Vec3 } from '../../../core/index.js';
import type { ContentEntry, Json, JsonObject } from '../../../resource/index.js';
import type { EventDef, Kernel } from '../../kernel/index.js';
import { PLAYERS_SERVICE, SAVE_SERVICE } from '../../services/index.js';
import { DialogueRunner } from './dialogue.js';
import type { Pending, RunnerState, ShownLine } from './dialogue.js';
import { FactStore } from './facts.js';
import type { FactDecl } from './facts.js';
import {
  BUILT_IN_VERBS, isBuiltInVerb, newRecord, QUEST_KIND, questModel, recordFrom, recordJson, REPORTABLE_VERBS,
} from './quests.js';
import type { QuestModel, QuestRecord, QuestStatus, QuestStepDef } from './quests.js';
import { DIALOGUE_INPUT_SERVICE } from './service.js';
import type { QuestMarker, StoryService } from './service.js';
import { checkDialogue, parseDialogue } from './yarn.js';
import type { DialogueDoc, FactValue } from './yarn.js';

export const STORY_EVENTS = {
  dialogueStarted: { id: 'dialogue_started' },
  dialogueEnded: { id: 'dialogue_ended' },
  questStarted: { id: 'quest_started' },
  questStepCompleted: { id: 'quest_step_completed' },
  questCompleted: { id: 'quest_completed' },
  factChanged: { id: 'fact_changed' },
} as const satisfies Record<string, EventDef>;

/** A `.yarn` file as the resource layer hands it over: `story/<id>.yarn` (optionally under `features/<f>/`). */
export interface DialogueSource {
  readonly id: string;
  readonly path: string;
  readonly text: string;
}

/** A custom verb (`@quest_verb`). */
export interface QuestVerbDecl {
  /** Check a step that uses the verb (its target and args against the declared types); throws a coded error. */
  check(quest: QuestModel, step: QuestStepDef, entry: ContentEntry): void;
  /** False: not yet; true: complete; a string: complete with that outcome. */
  evaluate(quest: string, step: string, dt: number): unknown;
}

export interface StoryHost {
  /** The game's `fact(...)` declarations. */
  facts(): readonly FactDecl[];
  /** `@dialogue_command` names. */
  commands(): ReadonlySet<string>;
  runCommand(name: string, args: readonly FactValue[], where: string): void;
  /** `@quest_verb`s by id. */
  verbs(): ReadonlyMap<string, QuestVerbDecl>;
  /** Game-facing values for event payloads. */
  dialogueRef(id: string): unknown;
  questRef(id: string): unknown;
  /** A line's text in the player's language (`key` is its localization key). */
  localize(key: string, text: string): string;
  openPanel(): void;
  closePanel(): void;
  /** Play a voiced line's sound (a `#voice:<sound>` tag), ducking the music under it. */
  voice(sound: string): void;
}

export interface QuestStateView {
  readonly status: QuestStatus;
  readonly active: readonly string[];
  readonly completed: readonly string[];
  progress(step: string): readonly [number, number];
}

export interface DialogueView {
  readonly dialogue: string;
  readonly node: string;
  /** Null while waiting (<<wait>>) or choosing. */
  readonly speaker: string | null;
  readonly text: string;
  readonly tags: readonly string[];
  readonly options: readonly { readonly index: number; readonly speaker: string | null; readonly text: string; readonly enabled: boolean }[];
}

interface Conversation {
  readonly runner: DialogueRunner;
  readonly speaker: EntityId | null;
  /** The kernel frame it started on: that frame's press started it, so it doesn't advance it. */
  readonly startFrame: number;
}

interface StorySnapshot {
  readonly facts: JsonObject;
  readonly quests: JsonObject;
  readonly conversation: { readonly state: RunnerState; readonly speaker: number | null; readonly startFrame: number } | null;
}

const CAMERA = 'camera';

export class StoryEngine implements StoryService {
  readonly #kernel: Kernel;
  readonly #host: StoryHost;
  #ready = false;
  #facts: FactStore | undefined;
  readonly #quests = new Map<string, QuestModel>();
  readonly #records = new Map<string, QuestRecord>();
  readonly #dialogues = new Map<string, DialogueDoc>();
  #dialoguesLoaded = false;
  #conversation: Conversation | undefined;
  #saveRegistered = false;

  constructor(kernel: Kernel, host: StoryHost) {
    this.#kernel = kernel;
    this.#host = host;
  }

  // ── Setup ────────────────────────────────────────────────────────────────────

  /** Build the stores and check the quests (and dialogue, when the project carries it) against the game. */
  prepare(): void {
    if (this.#ready) return;
    this.#ready = true;
    const facts = new FactStore(this.#host.facts());
    this.#facts = facts;
    const verbs = this.#host.verbs();
    const entries = [...(this.#kernel.project.content.get(QUEST_KIND)?.values() ?? [])];
    for (const entry of entries) {
      const model = questModel(entry);
      this.#checkQuest(model, entry, verbs);
      this.#quests.set(model.id, model);
      this.#records.set(model.id, newRecord());
    }
    this.#loadDialogues(this.#sources());
  }

  #sources(): ReadonlyMap<string, DialogueSource> {
    return this.#kernel.project.dialogues;
  }

  #loadDialogues(sources: ReadonlyMap<string, DialogueSource>): void {
    const scope = { facts: this.#factStore().types(), commands: this.#host.commands() };
    const problems: Diagnostic[] = [];
    for (const source of sources.values()) {
      const parsed = parseDialogue(source.id, source.path, source.text);
      problems.push(...parsed.diagnostics);
      if (parsed.doc === undefined) continue;
      problems.push(...checkDialogue(parsed.doc, scope));
      this.#dialogues.set(source.id, parsed.doc);
    }
    this.#dialoguesLoaded = true;
    const first = problems[0];
    if (first !== undefined) {
      const more = problems.length > 1 ? `\n(and ${problems.length - 1} more:\n${problems.slice(1).map((d) => `  ${d.code} ${d.message}`).join('\n')})` : '';
      fail(first.code, `${first.message}${more}`, {
        ...(first.path !== undefined && { path: first.path }), ...(first.line !== undefined && { line: first.line }),
        ...(first.fix !== undefined && { fix: first.fix }),
      });
    }
  }

  #checkQuest(model: QuestModel, entry: ContentEntry, verbs: ReadonlyMap<string, QuestVerbDecl>): void {
    const facts = this.#factStore();
    const types = facts.types();
    const bad = (step: QuestStepDef, field: string, message: string, fix?: string): never =>
      fail('PP2191', `${entry.path} ${step.pointer}/${field}: ${message}`, { path: entry.path, pointer: `${step.pointer}/${field}`, ...(fix !== undefined && { fix }) });
    const project = this.#kernel.project;
    for (const step of model.steps.values()) {
      step.sets.forEach((key, i) => {
        if (types.get(key) !== 'bool') {
          bad(step, `sets/${i}`, types.has(key) ? `"${key}" is not a bool fact; sets= makes facts true` : `"${key}" is not a declared fact`,
            types.has(key) ? 'Set other facts from a QuestStepCompleted handler.' : `Declare it: ${pascal(key)} = fact("${key}", False).`);
        }
      });
      step.nextIf.forEach((b, i) => {
        if (b.fact === null) return;
        const t = types.get(b.fact);
        if (t === undefined) bad(step, `next_if/${i}/fact`, `"${b.fact}" is not a declared fact`, suggestion(b.fact, types.keys()));
        if ((t === 'bool' && typeof b.equals !== 'boolean') || (t === 'number' && typeof b.equals !== 'number') || (t === 'string' && typeof b.equals !== 'string')) {
          bad(step, `next_if/${i}/equals`, `fact "${b.fact}" is a ${t === 'string' ? 'str' : t}; equals is ${JSON.stringify(b.equals)}`);
        }
      });
      if (!isBuiltInVerb(step.verb)) {
        const verb = verbs.get(step.verb);
        if (verb === undefined) {
          return bad(step, 'verb', `"${step.verb}" is not a verb`, `Use one of ${BUILT_IN_VERBS.join(', ')}, or declare @quest_verb("${step.verb}").${hint(step.verb, verbs.keys())}`);
        }
        verb.check(model, step, entry);
        continue;
      }
      switch (step.verb) {
        case 'fact':
          if (!types.has(step.target)) bad(step, 'target', `"${step.target}" is not a declared fact`, suggestion(step.target, types.keys()));
          break;
        case 'defeat':
          if (!project.prefabs.has(step.target)) {
            bad(step, 'target', `"${step.target}" is not a prefab`, `defeat counts deaths by prefab id.${hint(step.target, project.prefabs.keys())}`);
          }
          break;
        case 'reach': {
          const places = new Set<string>();
          for (const scene of project.scenes.values()) {
            for (const id of scene.regions.keys()) places.add(id);
            for (const p of scene.entities) if (p.id !== undefined) places.add(p.id);
          }
          if (!places.has(step.target)) bad(step, 'target', `"${step.target}" is neither a region nor a placed id`, `reach needs a region id or a placed trigger's id.${hint(step.target, places)}`);
          break;
        }
        case 'talk':
        case 'obtain':
        case 'use':
          if (step.target === '') bad(step, 'target', `a ${step.verb} step needs a target`);
          break;
        case 'wait':
          break;
      }
      if (step.marker !== null) {
        const placed = [...project.scenes.values()].some((s) => s.entities.some((p) => p.id === step.marker));
        if (!placed) bad(step, 'marker', `no scene places an entity with id "${step.marker}"`);
      }
    }
  }

  #factStore(): FactStore {
    if (this.#facts === undefined) fail('PP9981', 'The story is used before its first scene loaded');
    return this.#facts;
  }

  /** Scene loading: New Game resets facts and quests; any conversation ends; slot saves learn our sections. */
  sceneLoading(reset: boolean): void {
    this.prepare();
    if (this.#conversation !== undefined) this.#end(false);
    if (reset) {
      for (const key of this.#factStore().reset()) this.#kernel.emit(STORY_EVENTS.factChanged, { key });
      for (const id of this.#records.keys()) this.#records.set(id, newRecord());
    }
    if (!this.#saveRegistered) {
      const save = this.#kernel.tryService(SAVE_SERVICE);
      if (save !== undefined) {
        this.#saveRegistered = true;
        save.register({ key: 'facts', save: () => this.#factStore().toJSON(), load: (data) => this.#factStore().load(data, 'save "facts"') });
        save.register({ key: 'quests', save: () => this.#questsJson(), load: (data) => this.#loadQuests(data, 'save "quests"') });
      }
    }
  }

  // ── Facts ────────────────────────────────────────────────────────────────────

  fact(key: string, where = 'facts.get()'): FactValue {
    return this.#factStore().get(key, where);
  }

  setFact(key: string, value: unknown, where = 'facts.set()'): void {
    if (this.#factStore().set(key, value, where)) this.#kernel.emit(STORY_EVENTS.factChanged, { key });
  }

  addFact(key: string, amount: unknown, where = 'facts.add()'): number {
    const before = this.#factStore().get(key, where);
    const after = this.#factStore().add(key, amount, where);
    if (after !== before) this.#kernel.emit(STORY_EVENTS.factChanged, { key });
    return after;
  }

  // ── Quests ───────────────────────────────────────────────────────────────────

  #model(id: string, where: string): QuestModel {
    this.prepare();
    const model = this.#quests.get(id);
    if (model === undefined) {
      fail('PP2191', `${where}: there is no quest "${id}"`, { fix: `Add content/quest/${id}.json.${hint(id, this.#quests.keys())}` });
    }
    return model;
  }

  questStatus(id: string): QuestStatus {
    this.#model(id, 'quest status');
    return this.#records.get(id)!.status;
  }

  /** Quest ids in registry order: "active", "completed" or "all". */
  quests(status: string): string[] {
    this.prepare();
    if (status !== 'active' && status !== 'completed' && status !== 'all') {
      fail('PP3987', `quests() takes "active", "completed" or "all", got ${JSON.stringify(status)}`);
    }
    return [...this.#records].filter(([, r]) => status === 'all' || r.status === status).map(([id]) => id);
  }

  questState(id: string): QuestStateView {
    const model = this.#model(id, 'quest()');
    const record = this.#records.get(id)!;
    return {
      status: record.status,
      active: [...record.active],
      completed: [...record.completed],
      progress: (step: string) => {
        const def = model.steps.get(step);
        if (def === undefined) fail('PP2191', `quest "${id}" has no step "${step}"`, { fix: `Steps: ${[...model.steps.keys()].join(', ')}.` });
        return [Math.floor(record.progress.get(step) ?? 0), def.count] as const;
      },
    };
  }

  startQuest(id: string): void {
    const model = this.#model(id, 'start_quest()');
    const record = this.#records.get(id)!;
    if (record.status === 'active') fail('PP3988', `Quest "${id}" is already active`, { fix: 'Check ctx.story.quest(q).status before starting it.' });
    if (record.status === 'completed') {
      fail('PP3988', `Quest "${id}" is already completed`, { fix: 'Check ctx.story.quest(q).status before starting it; a completed quest stays completed.' });
    }
    this.#records.set(id, { status: 'active', active: [model.start], completed: [], progress: new Map() });
    this.#kernel.emit(STORY_EVENTS.questStarted, { quest: this.#host.questRef(id) });
  }

  failQuest(id: string): void {
    this.#model(id, 'fail_quest()');
    const record = this.#records.get(id)!;
    if (record.status !== 'active') {
      fail('PP3988', `Quest "${id}" is ${record.status}; only an active quest can fail`, { fix: 'Check ctx.story.quest(q).status first.' });
    }
    record.status = 'failed';
    record.active = [];
  }

  /** Progress the plugin can't observe: `ctx.story.report(verb, target, count)`. */
  report(verb: string, target: string, count: number): void {
    this.prepare();
    if (!REPORTABLE_VERBS.includes(verb)) {
      fail('PP3989', `report("${verb}", ...): ${isBuiltInVerb(verb) ? `"${verb}" steps progress by themselves` : `"${verb}" is a custom verb, asked every frame`}`, {
        fix: `report() takes ${REPORTABLE_VERBS.join(', ')}.`,
      });
    }
    if (!Number.isInteger(count) || count < 1) fail('PP3989', `report() count must be a whole number of 1 or more, got ${String(count)}`);
    this.#observe(verb, (t) => t === target, count);
  }

  /** Add progress to every active step with this verb whose target matches. */
  #observe(verb: string, matches: (target: string) => boolean, amount: number): void {
    for (const [id, record] of this.#records) {
      if (record.status !== 'active') continue;
      const model = this.#quests.get(id)!;
      for (const stepId of [...record.active]) {
        const step = model.steps.get(stepId)!;
        if (step.verb !== verb || !matches(step.target) || !record.active.includes(stepId)) continue;
        const progress = (record.progress.get(stepId) ?? 0) + amount;
        record.progress.set(stepId, progress);
        if (progress >= step.count) this.#complete(model, record, step, null);
      }
    }
  }

  #complete(model: QuestModel, record: QuestRecord, step: QuestStepDef, outcome: string | null): void {
    record.active = record.active.filter((s) => s !== step.id);
    if (!record.completed.includes(step.id)) record.completed.push(step.id);
    record.progress.set(step.id, Math.max(record.progress.get(step.id) ?? 0, step.count));
    for (const key of step.sets) this.setFact(key, true, `${model.path} ${step.pointer}/sets`);
    const quest = this.#host.questRef(model.id);
    this.#kernel.emit(STORY_EVENTS.questStepCompleted, { quest, step: step.id, verb: step.verb, outcome });
    const branch = step.nextIf.find((b) =>
      (b.fact === null || this.#factStore().get(b.fact) === b.equals) && (b.outcome === null || b.outcome === outcome));
    for (const next of branch?.goto ?? step.next) {
      if (record.active.includes(next)) continue;
      record.active.push(next);
      record.progress.delete(next);
    }
    if (record.active.length === 0) {
      record.status = 'completed';
      this.#kernel.emit(STORY_EVENTS.questCompleted, { quest });
    }
  }

  /** The per-frame evaluation (story system `update`). */
  update(dt: number): void {
    this.prepare();
    const verbs = this.#host.verbs();
    for (const [id, record] of this.#records) {
      if (record.status !== 'active') continue;
      const model = this.#quests.get(id)!;
      for (const stepId of [...record.active]) {
        if (record.status !== 'active' || !record.active.includes(stepId)) continue;
        const step = model.steps.get(stepId)!;
        const result = this.#evaluate(model, record, step, dt, verbs);
        if (result === false) continue;
        this.#complete(model, record, step, typeof result === 'string' ? result : null);
      }
    }
  }

  #evaluate(model: QuestModel, record: QuestRecord, step: QuestStepDef, dt: number, verbs: ReadonlyMap<string, QuestVerbDecl>): boolean | string {
    switch (step.verb) {
      case 'wait': {
        const waited = (record.progress.get(step.id) ?? 0) + dt;
        record.progress.set(step.id, waited);
        return waited + 1e-9 >= step.count;
      }
      case 'fact': {
        const value = this.#factStore().get(step.target);
        if (typeof value === 'number') record.progress.set(step.id, Math.min(value, step.count));
        return typeof value === 'number' ? value >= step.count : value === true || (typeof value === 'string' && value !== '');
      }
      case 'reach': {
        const region = this.#kernel.scene?.regions.get(step.target)?.bounds;
        if (region === undefined) return false;
        return this.players().some((id) => inside(this.#kernel.world.get(id)?.transform.worldPosition(), region));
      }
      case 'talk': case 'defeat': case 'obtain': case 'use':
        return false;
      default: {
        const verb = verbs.get(step.verb)!;
        const result = verb.evaluate(model.id, step.id, dt);
        if (typeof result === 'boolean' || (typeof result === 'string' && result !== '')) return result;
        return fail('PP3990', `@quest_verb("${step.verb}") returned ${String(result)} for ${model.id}.${step.id}`, {
          fix: 'Return False (not yet), True (done) or a non-empty outcome string.',
        });
      }
    }
  }

  /** combat's `died`: a `defeat` step counts its prefab. */
  died(entity: unknown): void {
    const id = this.#kernel.handles.unwrap(entity);
    const prefab = id === undefined ? undefined : this.#kernel.world.peek(id)?.prefab;
    if (prefab !== undefined) this.#observe('defeat', (t) => t === prefab, 1);
  }

  /** `trigger_entered`: a player entering the trigger placed as a `reach` target. */
  triggerEntered(trigger: unknown, other: unknown): void {
    const triggerId = this.#kernel.handles.unwrap(trigger);
    const otherId = this.#kernel.handles.unwrap(other);
    const placed = triggerId === undefined ? undefined : this.#kernel.world.peek(triggerId)?.placedId;
    if (placed === undefined || otherId === undefined || !this.players().includes(otherId)) return;
    this.#observe('reach', (t) => t === placed, 1);
  }

  /**
   * The player's entities: each seat's (with local_players or net), else whatever the
   * scene's cameras follow (a single-player game's camera follows its player).
   */
  players(): EntityId[] {
    const seats = this.#kernel.tryService(PLAYERS_SERVICE);
    if (seats !== undefined) return seats.seats().map((s) => seats.entity(s.index)).filter((e): e is EntityId => e !== null);
    const out: EntityId[] = [];
    for (const record of this.#kernel.world.live()) {
      const camera = record.components.get(CAMERA);
      if (camera === undefined) continue;
      const follow = camera['follow'];
      for (const target of Array.isArray(follow) ? follow : [follow]) {
        if (target === null || target === undefined || typeof target === 'string') continue;
        const id = this.#kernel.handles.unwrap(target);
        if (id !== undefined && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  markers(): QuestMarker[] {
    const out: QuestMarker[] = [];
    for (const [id, record] of this.#records) {
      if (record.status !== 'active') continue;
      const model = this.#quests.get(id)!;
      for (const step of record.active) {
        const marker = model.steps.get(step)!.marker;
        if (marker !== null) out.push({ quest: id, step, placed: marker });
      }
    }
    return out;
  }

  #questsJson(): JsonObject {
    return Object.fromEntries([...this.#records].map(([id, r]) => [id, recordJson(r)]));
  }

  #loadQuests(data: Json | undefined, where: string): void {
    if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) fail('PP3982', `${where} must be an object of quest id → state`);
    const saved = (data ?? {}) as JsonObject;
    for (const id of Object.keys(saved)) {
      if (!this.#quests.has(id)) {
        fail('PP3982', `${where}: the saved quest "${id}" has no content/quest/${id}.json`, {
          fix: `Restore the quest, or add a save migration that removes it: save.quests.pop("${id}", None).`,
        });
      }
    }
    for (const [id, model] of this.#quests) {
      const entry = saved[id];
      this.#records.set(id, entry === undefined ? newRecord() : recordFrom(model, entry, `${where}["${id}"]`));
    }
  }

  // ── Dialogue ─────────────────────────────────────────────────────────────────

  get inDialogue(): boolean {
    return this.#conversation !== undefined;
  }

  #doc(id: string): DialogueDoc {
    this.prepare();
    if (!this.#dialoguesLoaded) this.#loadDialogues(this.#sources());
    const doc = this.#dialogues.get(id);
    if (doc === undefined) fail('PP2180', `There is no story/${id}.yarn`, { fix: `Create it.${hint(id, this.#dialogues.keys())}` });
    return doc;
  }

  #hooks(): ConstructorParameters<typeof DialogueRunner>[2] {
    return {
      fact: (name, where) => this.fact(name, where),
      setFact: (name, value, where) => this.setFact(name, value, where),
      command: (name, args, where) => this.#host.runCommand(name, args, where),
    };
  }

  /** `ctx.story.say(...)`: start a conversation in the DialoguePanel. */
  say(dialogue: string, node: string, speaker: EntityId | null): void {
    if (this.#conversation !== undefined) {
      fail('PP3991', `say(${dialogue}): a conversation (${this.#conversation.runner.doc.id}) is already running`, {
        fix: 'Check ctx.story.in_dialogue first, or start the next one from a DialogueEnded handler.',
      });
    }
    const runner = new DialogueRunner(this.#doc(dialogue), node, this.#hooks());
    this.#conversation = { runner, speaker, startFrame: this.#kernel.time.frame };
    this.#host.openPanel();
    this.#kernel.emit(STORY_EVENTS.dialogueStarted, {
      dialogue: this.#host.dialogueRef(dialogue), speaker: speaker === null ? null : this.#kernel.handles.wrap(speaker),
    });
    this.#after(runner.run());
  }

  #after(pending: Pending): void {
    if (pending.kind === 'end') this.#end(true);
    else if (pending.kind === 'line') this.#voice(pending.line);
  }

  /** A line tagged `#voice:<sound>` plays that sound as it is shown (once; restores don't replay it). */
  #voice(line: ShownLine): void {
    for (const tag of line.tags) if (tag.startsWith(VOICE_TAG) && tag.length > VOICE_TAG.length) this.#host.voice(tag.slice(VOICE_TAG.length));
  }

  /** End the conversation; `finished`: it ran to its end (a scene change cuts it short, and that isn't talking). */
  #end(finished: boolean): void {
    const conversation = this.#conversation!;
    this.#conversation = undefined;
    this.#host.closePanel();
    const id = conversation.runner.doc.id;
    this.#kernel.emit(STORY_EVENTS.dialogueEnded, { dialogue: this.#host.dialogueRef(id) });
    if (!finished) return;
    const placed = conversation.speaker === null ? undefined : this.#kernel.world.peek(conversation.speaker)?.placedId;
    this.#observe('talk', (t) => t === id || t === placed, 1);
  }

  /** Past the current line (the panel's `next`, or a press). */
  next(): void {
    const conversation = this.#current('next');
    if (conversation.runner.pending.kind === 'wait') return;
    this.#after(conversation.runner.advance());
  }

  choose(index: number): void {
    this.#after(this.#current('choose').runner.choose(index));
  }

  #current(what: string): Conversation {
    if (this.#conversation === undefined) fail('PP3986', `${what}: no conversation is running`, { fix: 'Start one with ctx.story.say(...).' });
    return this.#conversation;
  }

  /** Kernel `ui` hook: a press advances the line; a <<wait>> runs out. */
  uiFrame(realDt: number): void {
    const conversation = this.#conversation;
    if (conversation === undefined) return;
    const pending = conversation.runner.pending;
    if (pending.kind === 'wait') {
      pending.remaining -= realDt;
      if (pending.remaining <= 1e-9) this.#after(conversation.runner.advance());
      return;
    }
    if (pending.kind !== 'line' || this.#kernel.time.frame === conversation.startFrame) return;
    if (this.#kernel.service(DIALOGUE_INPUT_SERVICE).confirmPressed()) this.#after(conversation.runner.advance());
  }

  /** What the DialoguePanel shows; null when no conversation runs. */
  view(): DialogueView | null {
    const conversation = this.#conversation;
    if (conversation === undefined) return null;
    const runner = conversation.runner;
    const pending = runner.pending;
    const shown = (line: ShownLine): { speaker: string | null; text: string } => this.#localized(line);
    const base = { dialogue: runner.doc.id, node: runner.node };
    if (pending.kind === 'line') return { ...base, ...shown(pending.line), tags: pending.line.tags, options: [] };
    if (pending.kind === 'options') {
      return {
        ...base, speaker: null, text: '', tags: [],
        options: pending.options.map((o, index) => ({ index, ...shown(o), enabled: o.enabled })),
      };
    }
    return { ...base, speaker: null, text: '', tags: [], options: [] };
  }

  /** Localize the whole line ("Speaker: text", as translators see it), then split the speaker back off. */
  #localized(line: ShownLine): { speaker: string | null; text: string } {
    const source = line.speaker === null ? line.text : `${line.speaker}: ${line.text}`;
    const text = this.#host.localize(line.key, source);
    if (line.speaker === null) return { speaker: null, text };
    const colon = text.indexOf(': ');
    return colon < 0 ? { speaker: null, text } : { speaker: text.slice(0, colon), text: text.slice(colon + 2) };
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  snapshot(): StorySnapshot {
    this.prepare();
    const c = this.#conversation;
    return {
      facts: this.#factStore().toJSON(),
      quests: this.#questsJson(),
      conversation: c === undefined ? null : { state: c.runner.state(), speaker: c.speaker, startFrame: c.startFrame },
    };
  }

  restore(saved: StorySnapshot): void {
    this.prepare();
    this.#factStore().load(saved.facts, 'snapshot facts');
    this.#loadQuests(saved.quests, 'snapshot quests');
    const c = saved.conversation;
    if (c === null) {
      this.#conversation = undefined;
      return;
    }
    const speaker = c.speaker === null ? null : c.speaker as EntityId;
    if (speaker !== null && this.#kernel.world.get(speaker) === undefined) {
      fail('PP9002', `The snapshot's conversation is with entity ${speaker}, which the restored world doesn't have`);
    }
    this.#conversation = {
      runner: DialogueRunner.restore(this.#doc(c.state.dialogue), c.state, this.#hooks()),
      speaker, startFrame: c.startFrame,
    };
  }
}

/** The line tag naming a voiced line's sound: `Elder: Welcome. #voice:elder_welcome` (a sound in assets/sfx/). */
export const VOICE_TAG = 'voice:';

function inside(at: Vec3 | undefined, bounds: { readonly min: readonly number[]; readonly max: readonly number[] }): boolean {
  if (at === undefined) return false;
  return at.x >= bounds.min[0]! && at.x <= bounds.max[0]! && at.z >= bounds.min[1]! && at.z <= bounds.max[1]!;
}

function hint(id: string, known: Iterable<string>): string {
  const guess = closestMatch(id, known);
  return guess === undefined ? '' : ` Did you mean "${guess}"?`;
}

function suggestion(id: string, known: Iterable<string>): string {
  const guess = closestMatch(id, known);
  return guess === undefined ? `Declare it: fact("${id}", ...).` : `Did you mean "${guess}"?`;
}

function pascal(key: string): string {
  return key.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}
