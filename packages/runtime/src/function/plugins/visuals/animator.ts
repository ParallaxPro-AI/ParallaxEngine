/**
 * The Animator component (sdk/parallax/__init__.pyi `Animator`): its id and schema.
 *
 * Typed fields are the SDK's (`default_clip`, `speed`, `root_motion`, `root_bone`). The
 * animation graph is prefab data the SDK documents on the class — `params`, `layers`,
 * `events`, `ik` — kept as JSON here and compiled by `animation_graph.ts` when the entity
 * arrives (and by `parallax check`, with the same parser). An animator with no `layers`
 * has one implicit layer, "base", driven by `play()` / `play_once()`.
 */

import { t } from '../../kernel/index.js';
import type { Schema } from '../../kernel/index.js';

export const ANIMATOR = 'animator';

export const ROOT_MOTION_MODES = ['off', 'transform', 'character'] as const;
export type RootMotionMode = (typeof ROOT_MOTION_MODES)[number];

/** The prefab-only graph fields (JSON), in documentation order. */
export const ANIMATOR_GRAPH_FIELDS = ['params', 'layers', 'events', 'ik'] as const;

export const ANIMATOR_SCHEMA: Schema = {
  default_clip: { type: { kind: 'optional', of: { kind: 'ref', to: 'clip' } }, default: null },
  /** Playback rate multiplier applied to every clip. */
  speed: t.number({ default: 1, min: 0 }),
  /** "transform": the root bone's travel moves the entity; "character": it is collected for `take_root_motion()`. */
  root_motion: t.enum(ROOT_MOTION_MODES, { default: 'off' }),
  /** The bone root motion reads (None: Hips / pelvis, else the skeleton's first joint). */
  root_bone: { type: { kind: 'optional', of: { kind: 'string' } }, default: null },
  /** name → default: a number, true/false, or "trigger". */
  params: t.json({ default: {} }),
  /** Bottom to top; the first is the base layer. */
  layers: t.json({ default: [] }),
  /** clip → [{"time": seconds, "name": "footstep"}, ...]. */
  events: t.json({ default: {} }),
  /** {"limbs": {...}, "feet": {...}, "look": {...}}. */
  ik: t.json({ default: {} }),
};
