/**
 * Which entity a seat plays, for HUD and interaction panels (one rule, used by both):
 *
 *   - with a players plugin (local_players, net): the seat's `player.entity`;
 *   - in a one-player game: the only entity carrying the component asked about, or — when
 *     several carry it (an AI with Abilities, say) — the one the active camera follows.
 *
 * Anything else is ambiguous and fails loudly with the fix, rather than guessing.
 */

import { fail } from '../core/index.js';
import type { EntityId } from '../core/index.js';
import type { Kernel } from '../function/kernel/index.js';
import { PLAYERS_SERVICE } from '../function/services/index.js';

const CAMERA = 'camera';

/** Seats in play: the players service's, else the one local seat. */
export function seatIndexes(kernel: Kernel): number[] {
  const players = kernel.tryService(PLAYERS_SERVICE);
  return players === undefined ? [0] : players.seats().filter((s) => s.local).map((s) => s.index);
}

function followed(kernel: Kernel, follow: unknown): EntityId[] {
  if (follow === null || follow === undefined || typeof follow === 'string') return [];
  const list = Array.isArray(follow) ? follow : [follow];
  return list.flatMap((h) => {
    const id = kernel.handles.unwrap(h);
    return id === undefined ? [] : [id];
  });
}

export function seatViewer(kernel: Kernel, seat: number, candidates: readonly EntityId[], what: string): EntityId | null {
  const players = kernel.tryService(PLAYERS_SERVICE);
  if (players !== undefined) {
    const id = players.entity(seat);
    return id !== null && candidates.includes(id) ? id : null;
  }
  if (seat !== 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  for (const row of kernel.world.query([CAMERA])) {
    const camera = row[1]!;
    const view = (camera as { __view__?: { active: boolean; seat: number } }).__view__;
    if (view === undefined || !view.active || view.seat !== 0) continue;
    const target = followed(kernel, camera['follow']).find((id) => candidates.includes(id));
    if (target !== undefined) return target;
  }
  const names = candidates.slice(0, 4).map((id) => {
    const r = kernel.world.get(id);
    return r?.name ?? r?.placedId ?? r?.prefab ?? String(id);
  });
  return fail('PP3556', `${candidates.length} entities have a ${what} component (${names.join(', ')}), and the HUD can't tell which one the player is`, {
    fix: `Make the camera follow the player (Camera(follow=...)), or keep ${what} only on the player's prefab.`,
  });
}
