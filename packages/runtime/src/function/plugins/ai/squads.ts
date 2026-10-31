/**
 * Squads: entities whose `SquadMember.squad` names the same squad. A squad has a shared
 * blackboard, a formation (shape + spacing) its members hold around the leader — the
 * member whose role is "leader", else the first in world order — and target sharing: when
 * one member spots a target, every other member with Perception is alerted to where it was
 * seen (`share_targets`, on by default). Squads exist as soon as a member does.
 */

import type { EntityId } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { Blackboard } from './blackboard.js';
import type { Formation } from './formations.js';
import { SQUAD_MEMBER } from './schemas.js';

export interface SquadState {
  readonly blackboard: Blackboard;
  formation: Formation;
  spacing: number;
  shareTargets: boolean;
}

export class Squads {
  readonly #kernel: Kernel;
  readonly #squads = new Map<string, SquadState>();

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  clear(): void {
    this.#squads.clear();
  }

  state(name: string): SquadState {
    let s = this.#squads.get(name);
    if (s === undefined) {
      s = { blackboard: new Blackboard((id) => this.#kernel.world.isAlive(id)), formation: 'wedge', spacing: 2, shareTargets: true };
      this.#squads.set(name, s);
    }
    return s;
  }

  /** Members in world order. */
  members(name: string): EntityId[] {
    return this.#kernel.world.query([SQUAD_MEMBER]).filter(([, f]) => f!['squad'] === name).map(([id]) => id);
  }

  leader(name: string): EntityId | null {
    const rows = this.#kernel.world.query([SQUAD_MEMBER]).filter(([, f]) => f!['squad'] === name);
    return (rows.find(([, f]) => f!['role'] === 'leader') ?? rows[0])?.[0] ?? null;
  }

  squadOf(id: EntityId): string | null {
    const f = this.#kernel.world.get(id)?.components.get(SQUAD_MEMBER);
    return f === undefined ? null : f['squad'] as string;
  }

  /** Every squad that has a member, sorted. */
  names(): string[] {
    return [...new Set(this.#kernel.world.query([SQUAD_MEMBER]).map(([, f]) => f!['squad'] as string))].sort();
  }

  snapshot(): Json {
    return [...this.#squads].map(([name, s]) => ({
      name, blackboard: s.blackboard.encode(), formation: s.formation, spacing: s.spacing, share: s.shareTargets,
    }));
  }

  restore(json: Json): void {
    this.#squads.clear();
    for (const entry of json as JsonObject[]) {
      const s = this.state(entry['name'] as string);
      s.blackboard.restore(entry['blackboard'] as Json);
      s.formation = entry['formation'] as Formation;
      s.spacing = entry['spacing'] as number;
      s.shareTargets = entry['share'] === true;
    }
  }
}
