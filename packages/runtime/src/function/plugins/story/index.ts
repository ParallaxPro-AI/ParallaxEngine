/**
 * plugins/story — the story plugin (sdk/parallax/story.pyi): typed story
 * facts, `.yarn` dialogue run in the built-in DialoguePanel, and quests as step graphs of the
 * built-in `quest` content kind, with their events, snapshot/restore and slot-save sections.
 *
 * One `story(...)` value serves one kernel. The api layer (`api/story.ts`) builds it with a
 * `StoryHost` and mounts `ctx.story` over the engine.
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import { KERNEL_EVENTS } from '../../kernel/index.js';
import type { Fields, Handler, Kernel, KernelPlugin, SystemDef } from '../../kernel/index.js';
import { StoryEngine, STORY_EVENTS } from './engine.js';
import type { StoryHost } from './engine.js';
import { STORY_SERVICE } from './service.js';

export { StoryEngine, STORY_EVENTS } from './engine.js';
export type { DialogueSource, DialogueView, QuestStateView, QuestVerbDecl, StoryHost } from './engine.js';
export { checkFactDecl } from './facts.js';
export type { FactDecl } from './facts.js';
export { BUILT_IN_VERBS, QUEST_KIND } from './quests.js';
export type { QuestModel, QuestStatus, QuestStepDef } from './quests.js';
export { DIALOGUE_INPUT_SERVICE, STORY_SERVICE } from './service.js';
export type { DialogueInput, QuestMarker, StoryService } from './service.js';
export { checkDialogue, lineKeys, parseDialogue } from './yarn.js';
export type { DialogueDoc, DialogueScope, FactValue, LineContent, ParseResult, ValueType } from './yarn.js';

export interface StoryOptions {
  readonly host: StoryHost;
  /** Builds `ctx.story` (the api layer's Python-facing facade over the engine). */
  readonly namespace?: (engine: StoryEngine) => object;
}

export interface StoryPlugin extends KernelPlugin {
  /** The engine behind `ctx.story`, once installed. */
  readonly engine: () => StoryEngine;
}

/** The combat plugin's death event, by id (plugins don't import each other). */
const DIED = 'died';

export function story(options: StoryOptions): StoryPlugin {
  let engine: StoryEngine | undefined;
  let installedOn: Kernel | undefined;
  const current = (): StoryEngine => {
    if (engine === undefined) fail('PP9981', 'The story plugin is used before its kernel was built');
    return engine;
  };
  let handlers: Handler[] | undefined;
  const system: SystemDef = {
    id: 'story.quests',
    scenes: [],
    // Resolved on first delivery: `died` exists only when combat is in the game.
    get handlers(): readonly Handler[] {
      if (handlers === undefined) {
        const died = installedOn?.registry.events.get(DIED);
        handlers = [
          { event: KERNEL_EVENTS.triggerEntered, method: 'trigger_entered' },
          ...(died === undefined ? [] : [{ event: died, method: 'died' }]),
        ];
      }
      return handlers;
    },
    create: () => ({
      update: (_ctx: unknown, dt: number) => current().update(dt),
      trigger_entered: (_ctx: unknown, payload: Fields) => current().triggerEntered(payload['entity'], payload['target']),
      died: (_ctx: unknown, payload: Fields) => current().died(payload['entity']),
    }),
  };

  return {
    id: 'story',
    events: Object.values(STORY_EVENTS),
    systems: [system],
    engine: current,
    install(kernel) {
      if (installedOn !== undefined) {
        fail('PP9983', 'This story plugin is already installed in another kernel', { fix: 'Call story() once per game.' });
      }
      installedOn = kernel;
      const created = new StoryEngine(kernel, options.host);
      engine = created;
      kernel.provide(STORY_SERVICE, created);
      kernel.observeScenes({ loading: (_scene, request) => created.sceneLoading(request.newRun === true) });
      kernel.addHook('ui', (realDt) => created.uiFrame(realDt));
    },
    snapshot: () => current().snapshot() as unknown as Json,
    restore: (_kernel, saved) => current().restore(saved as never),
    ...(options.namespace !== undefined && { namespace: { name: 'story', create: () => options.namespace!(current()) } }),
  };
}
