/**
 * The `actions` service: the game's declared actions as other plugins need them — whether
 * a seat pressed or holds one (the interaction plugin's interact key), and how a player
 * reads its bindings on their current device (key hints, prompts, ability slots). The
 * runtime provides it from the input engine (api/action_input.ts); it answers with the
 * same rules as `ctx.input` (remaps, modal muting, `active_when`, scene scopes).
 *
 * Actions are passed as the game's handles (`Controls.interact`), opaque here.
 */

import type { EntityId } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

export type ActionDevice = 'keyboard' | 'gamepad' | 'touch';

/** One thing to press, as a player reads it. */
export interface ActionGlyph {
  readonly device: ActionDevice;
  /** A stable code for styling: a key code ("KeyE"), a gamepad button ("south"), "touch:<label>", "mouse:left", "stick:left". */
  readonly code: string;
  /** What the default look prints ("E", "A", "Jump", "LMB", "WASD"). */
  readonly text: string;
}

export interface ActionsService {
  /** Pressed this frame by `seat`, reading as `owner` (its sets' `active_when`), muted while a modal is open. */
  pressed(action: unknown, seat: number, owner: EntityId | null): boolean;
  held(action: unknown, seat: number, owner: EntityId | null): boolean;
  /** Whether the action's set is live for this reader (scene scope, `active_when`). */
  live(action: unknown, seat: number, owner: EntityId | null): boolean;
  /** The device the seat used last. */
  device(seat: number): ActionDevice;
  /** A declared action by `"<ActionSet>.<action>"` (`"Controls.jump"`), or undefined. */
  find(name: string): unknown;
  /** Every declared action's name, for messages. */
  names(): readonly string[];
  /** What to press for `action` on `device`, remaps applied (empty when it has no binding there). */
  glyphs(action: unknown, device: ActionDevice): readonly ActionGlyph[];
}

export const ACTIONS_SERVICE: ServiceKey<ActionsService> = serviceKey<ActionsService>(
  'actions', 'The runtime provides it (api/runtime.ts: kernel.provide(ACTIONS_SERVICE, actionsService(inputEngine))).',
);
