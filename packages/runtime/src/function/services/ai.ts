/**
 * The `ai` service, provided by the ai plugin: brains, squads and the combat director as
 * tools and other plugins see them (an editor's AI inspector, a debug overlay, a HUD's
 * director bar). Read-only views; behavior changes go through the game's own API.
 */

import type { EntityId } from '../../core/index.js';
import type { Json } from '../../resource/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export interface BrainView {
  readonly tree: string | null;
  readonly status: 'idle' | 'success' | 'failure' | 'running';
  /** Paths of the running leaves ("root/combat/shoot"). */
  readonly running: readonly string[];
  /** Blackboard keys and values (Vec3 as {vec3: [...]}, entities as {entity: id}). */
  readonly blackboard: Readonly<Record<string, Json>>;
  /** The last tick's walk, one node per line. */
  readonly trace: string;
}

export interface SquadView {
  readonly name: string;
  readonly members: readonly EntityId[];
  readonly leader: EntityId | null;
  readonly formation: string;
}

export interface DirectorView {
  readonly phase: 'build' | 'peak' | 'relax';
  readonly intensity: number;
  readonly budget: number;
  readonly alive: number;
}

export interface AiService {
  /** Undefined for an entity without a Brain. */
  brain(entity: EntityId): BrainView | undefined;
  squads(): readonly SquadView[];
  /** Undefined when the game configured no director. */
  director(): DirectorView | undefined;
}

export const AI_SERVICE: ServiceKey<AiService> = serviceKey<AiService>(
  'ai', 'Add ai() to Game(plugins=[...]).',
);
