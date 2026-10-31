/**
 * `parallax.plugins.local_players(...)` (sdk/parallax/plugins.pyi): local multiplayer on one
 * device. The seats, their spawning and cameras live in the local_players plugin; this
 * module binds Python arguments, and `seatPlayers` / `inputSeats` turn the `players`
 * service (local_players or net) into what the runtime hands game code and the input
 * engine.
 */

import { fail } from '../core/index.js';
import type { EntityId } from '../core/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { localPlayers, SPLIT_SCREENS } from '../function/plugins/local_players/index.js';
import type { SplitScreen } from '../function/plugins/local_players/index.js';
import type { ActionSetDecl, Seat } from '../function/plugins/input/index.js';
import type { PlayersService } from '../function/services/index.js';
import { Actions, registerActions } from './input.js';
import { bindArgs } from './kwargs.js';
import { PrefabRef } from './types.js';

function prefabId(value: unknown, what: string): string {
  if (!(value instanceof PrefabRef)) {
    fail('PP3960', `local_players(${what}=) takes a prefab (Prefabs.<id>), got ${value === null || value === undefined ? 'None' : String(value)}`);
  }
  return value.id;
}

function controlsOf(value: unknown): readonly ActionSetDecl[] | 'gamepads' {
  if (value === 'gamepads') return value;
  if (typeof value === 'string' || value === null || value === undefined || typeof (value as Iterable<unknown>)[Symbol.iterator] !== 'function') {
    return fail('PP3960', `local_players(controls=) takes a list of Actions classes (one per seat) or "gamepads", got ${String(value)}`);
  }
  return [...(value as Iterable<unknown>)].map((cls, i) => {
    if (typeof cls !== 'function' || !(cls.prototype instanceof Actions)) {
      fail('PP3960', `local_players(controls=[...]) entry ${i} is not an Actions subclass`, {
        fix: 'Per-seat controls subclass the shared set: class P2Controls(Controls): move = axis2(keyboard=keys.ARROWS).',
      });
    }
    return registerActions(cls);
  });
}

/** `local_players(*, seats, player_prefab, controls, camera_prefab=None, split_screen="vertical")`. */
export function local_players(...args: unknown[]): KernelPlugin {
  const a = bindArgs('local_players', args, {
    keyword: ['seats', 'player_prefab', 'controls', 'camera_prefab', 'split_screen'],
    required: ['seats', 'player_prefab', 'controls'],
  }).args;
  const split = a['split_screen'] ?? 'vertical';
  if (!SPLIT_SCREENS.includes(split as SplitScreen)) {
    fail('PP3960', `local_players(split_screen=${JSON.stringify(split)}) is not a layout`, { fix: `Use one of: ${SPLIT_SCREENS.join(', ')}.` });
  }
  return localPlayers({
    seats: a['seats'] as number,
    playerPrefab: prefabId(a['player_prefab'], 'player_prefab'),
    controls: controlsOf(a['controls']),
    cameraPrefab: a['camera_prefab'] === undefined || a['camera_prefab'] === null ? null : prefabId(a['camera_prefab'], 'camera_prefab'),
    splitScreen: split as SplitScreen,
  });
}

/** The input engine's seats for a players service (controls are the per-seat action sets). */
export function inputSeats(players: PlayersService): Seat[] {
  return players.seats().map((seat) => ({
    index: seat.index,
    keyboard: seat.input.keyboard,
    mouse: seat.input.mouse,
    touch: seat.input.touch,
    gamepad: seat.input.gamepad,
    ...(seat.input.controls !== undefined && { controls: seat.input.controls as ActionSetDecl }),
  }));
}

/** What a runtime needs to present a seat as a `Player`. */
export interface SeatPlayer {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly local: boolean;
  /** The seat's entity now, or null. */
  entity(): EntityId | null;
}

/** The service's seats with live entity lookups, for building `ctx.players`. */
export function seatPlayers(players: PlayersService): SeatPlayer[] {
  return players.seats().map((seat) => ({
    id: seat.id, name: seat.name, index: seat.index, local: seat.local, entity: () => players.entity(seat.index),
  }));
}
