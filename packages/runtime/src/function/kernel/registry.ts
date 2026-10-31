/** Lookup of a game's definitions by id, with "did you mean" errors for unknown ids. */

import { closestMatch, fail } from '../../core/index.js';
import type { DiagnosticCode } from '../../core/index.js';
import type {
  BehaviorDef, ComponentDef, EventDef, GameDefinition, ResourceDef, SystemDef,
} from './definitions.js';

function index<T extends { readonly id: string }>(what: string, defs: readonly T[]): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  for (const def of defs) {
    // The same definition object from two plugins is one definition (the shared `seat`).
    if (map.get(def.id) === def) continue;
    if (map.has(def.id)) fail('PP2010', `Two ${what} definitions are named "${def.id}"`);
    map.set(def.id, def);
  }
  return map;
}

function lookup<T>(map: ReadonlyMap<string, T>, id: string, what: string, code: DiagnosticCode, where: string): T {
  const def = map.get(id);
  if (def !== undefined) return def;
  const guess = closestMatch(id, map.keys());
  return fail(code, `Unknown ${what} "${id}" (in ${where})`, {
    fix: guess !== undefined ? `Did you mean "${guess}"?` : `Define it, or remove it from ${where}.`,
  });
}

export class Registry {
  readonly components: ReadonlyMap<string, ComponentDef>;
  readonly resources: ReadonlyMap<string, ResourceDef>;
  readonly events: ReadonlyMap<string, EventDef>;
  readonly behaviors: ReadonlyMap<string, BehaviorDef>;
  /** In run order. */
  readonly systems: readonly SystemDef[];

  constructor(game: GameDefinition, builtInEvents: readonly EventDef[]) {
    this.components = index('component', game.components);
    this.resources = index('resource', game.resources);
    this.events = index('event', [...builtInEvents, ...game.events]);
    this.behaviors = index('behavior', game.behaviors);
    index('system', game.systems);
    this.systems = game.systems;
  }

  component(id: string, where: string): ComponentDef {
    return lookup(this.components, id, 'component', 'PP2050', where);
  }

  behavior(id: string, where: string): BehaviorDef {
    return lookup(this.behaviors, id, 'behavior', 'PP2051', where);
  }

  resource(id: string, where: string): ResourceDef {
    return lookup(this.resources, id, 'resource', 'PP2053', where);
  }
}
