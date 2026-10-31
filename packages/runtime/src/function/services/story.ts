/**
 * Story services, provided by the story plugin folder (function/plugins/story/):
 *
 *   `story`           facts, quest status and objective markers, for plugins that follow the
 *                     story: world layers' `active_when` (streaming), marker renderers. Slot
 *                     saves get facts and quests through the save service's sections ("facts",
 *                     "quests"). Provided by `story()`.
 *   `dialogue_input`  whether the player pressed something that advances a conversation this
 *                     frame. The story plugin can't read input itself (plugins don't import each
 *                     other); the runtime, which owns the input engine, provides it.
 */

import type { EntityId } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

/** A fact's value: what `.yarn` and `fact(key, default)` hold. */
export type FactValue = boolean | number | string;

export type QuestStatus = 'inactive' | 'active' | 'completed' | 'failed';

export interface QuestMarker {
  readonly quest: string;
  readonly step: string;
  /** The placed id the step's `marker` names. */
  readonly placed: string;
}

export interface StoryService {
  /** A declared fact's value (PP3980 for an unknown key). */
  fact(key: string): FactValue;
  /** A quest's status (PP2191 for an unknown quest id). */
  questStatus(id: string): QuestStatus;
  /** Markers of every active step that names one, in quest then step order. */
  markers(): readonly QuestMarker[];
  /** The entities that count as the player for `reach` steps. */
  players(): readonly EntityId[];
}

export const STORY_SERVICE: ServiceKey<StoryService> = serviceKey<StoryService>(
  'story', 'Add story() to Game(plugins=[...]) (from parallax import plugins).',
);

export interface DialogueInput {
  /** True on the frame the player pressed any button (read through a modal's mute). */
  confirmPressed(): boolean;
}

export const DIALOGUE_INPUT_SERVICE: ServiceKey<DialogueInput> = serviceKey<DialogueInput>(
  'dialogue_input',
  'The runtime provides it from the input engine (api/runtime.ts: kernel.provide(DIALOGUE_INPUT_SERVICE, dialogueInput(inputEngine))).',
);
