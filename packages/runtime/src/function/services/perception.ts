/**
 * The `perception` service, provided by the ai plugin: what NPCs perceive, for the HUD
 * (awareness meters, sound-direction cues), other plugins that make noise (weapons,
 * footsteps, explosions), and tools. Positions are world-space `Vec3` meters; time is the
 * AI clock (seconds of fixed steps since the scene loaded).
 */

import type { EntityId, Vec3 } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export type AlertLevel = 'unaware' | 'suspicious' | 'alert';

export interface NoiseEvent {
  readonly at: Vec3;
  /** Meters it carries to a perceiver with `hearing` 1 (half through walls). */
  readonly loudness: number;
  /** AI clock when it was made. */
  readonly time: number;
  readonly source?: EntityId;
  /** A tag id (gunshot, footstep…) the game chose, for HUD styling. */
  readonly kind?: string;
}

export interface KnownTarget {
  readonly target: EntityId;
  /** 0..1. */
  readonly awareness: number;
  /** Reached 1 and not yet lost. */
  readonly alerted: boolean;
  /** Seen at the perceiver's last update. */
  readonly visible: boolean;
  readonly lastPosition: Vec3;
}

export interface PerceptionService {
  /** Make a noise (as `ctx.ai.noise`). */
  noise(at: Vec3, loudness: number, source?: EntityId, kind?: string): void;
  /** Noises of the last two seconds, oldest first. */
  recentNoises(): readonly NoiseEvent[];
  /** A perceiver's highest awareness (0..1); 0 for an entity without Perception. */
  awareness(perceiver: EntityId): number;
  alert(perceiver: EntityId): AlertLevel;
  /** What a perceiver knows, in the order it learned of them. */
  known(perceiver: EntityId): readonly KnownTarget[];
}

export const PERCEPTION_SERVICE: ServiceKey<PerceptionService> = serviceKey<PerceptionService>(
  'perception', 'Add ai() to Game(plugins=[...]): perception, noise and awareness come from the ai plugin.',
);
