/**
 * The `players` service: who is playing, provided by a players plugin — `local_players`
 * (seats on one device) or `net` (online players). The api layer builds `ctx.players`,
 * `Player.entity`, `"follow": "local_player"` and the input engine's seats from it; a game
 * with neither plugin has one implicit local player and no service.
 *
 * A seat's number is the kernel's `EntityRecord.owner` for everything spawned for it
 * (`spawn(owner=player)`), which is how input, cameras and per-player panels find their
 * seat.
 */

import type { EntityId } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

/** Which input devices a seat reads (the input plugin's `SeatDevices`). */
export interface SeatInput {
  readonly keyboard: boolean;
  readonly mouse: boolean;
  readonly touch: boolean;
  /** A gamepad slot, every pad ("any"), or none. */
  readonly gamepad: number | 'any' | null;
  /**
   * The seat's controls: the action-set declaration (an input plugin `ActionSetDecl`,
   * opaque here) whose bindings answer for this seat, or undefined for the defaults.
   */
  readonly controls?: unknown;
}

export interface PlayerSeat {
  /** 0-based seat number. */
  readonly index: number;
  /** Stable for the game: `Player.id`. */
  readonly id: string;
  /** Shown to players: `Player.name`. */
  readonly name: string;
  /** Plays on this device (always true for local seats). */
  readonly local: boolean;
  readonly input: SeatInput;
}

export interface PlayersService {
  /** Seats in play, by index (`ctx.players`). */
  seats(): readonly PlayerSeat[];
  /** The entity a seat controls now (`Player.entity`), or null. */
  entity(seat: number): EntityId | null;
}

export const PLAYERS_SERVICE: ServiceKey<PlayersService> = serviceKey<PlayersService>(
  'players', 'Add local_players(...) or net(...) to Game(plugins=[...]).',
);
