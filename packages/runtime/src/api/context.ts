/**
 * `ctx`: the one context every hook receives, stable for the whole game. Core
 * namespaces (world, time, scenes) and methods live here; each plugin's namespace
 * (`ctx.physics`, `ctx.input`…) is mounted from `KernelPlugin.namespace`.
 */

import { fail } from '../core/index.js';
import { eventDefOf } from './declarations.js';
import { modifierInit } from './entity.js';
import type { Entity } from './entity.js';
import { bindArgs } from './kwargs.js';
import type { ContentList } from './content.js';
import { hashString } from './py.js';
import { ScenesApi } from './scenes.js';
import { Handle, Task, Time, tween } from './time.js';
import type { TaskBody } from '../function/kernel/index.js';
import { TextRef } from './types.js';
import { World } from './world.js';
import type { GameRuntime } from './runtime.js';
import { PLAYERS_SERVICE } from '../function/services/index.js';
import { seatPlayers } from './local_players.js';

/**
 * A seat. Without a players plugin (local_players, net) there is one: the local player,
 * who controls no entity.
 */
export class Player {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly #local: boolean;
  readonly #entity: () => Entity | null;

  constructor(id: string, name: string, index: number, local: boolean, entity: () => Entity | null = () => null) {
    this.id = id;
    this.name = name;
    this.index = index;
    this.#local = local;
    this.#entity = entity;
  }

  get local(): boolean { return this.#local; }
  /** The entity this player controls now (from the players service), or None. */
  get entity(): Entity | null { return this.#entity(); }
  __eq__(o: unknown): boolean { return o instanceof Player && o.id === this.id; }
  __hash__(): number { return hashString(`player:${this.id}`); }
}

function resourceId(kind: unknown, where: string): string {
  const id = typeof kind === 'function' ? (kind as { __resource_id__?: unknown }).__resource_id__ : undefined;
  if (typeof id !== 'string') fail('PP3013', `${where}: ${String((kind as { name?: string } | null)?.name ?? kind)} is not a @resource class`);
  return id;
}

/** `{name}` placeholders filled from `args`; `{{`/`}}` are literal braces. */
function formatText(template: string, args: Readonly<Record<string, unknown>>, key: string): string {
  return template.replace(/\{\{|\}\}|\{([a-z_][a-z0-9_]*)\}/gi, (match, name: string | undefined) => {
    if (name === undefined) return match[0]!;
    if (!(name in args)) fail('PP3014', `Text "${key}" needs the argument "${name}"`, { fix: `Pass ${name}= to ctx.text().` });
    return String(args[name]);
  });
}

export class Context {
  readonly world: World;
  readonly time: Time;
  readonly scenes: ScenesApi;
  readonly #rt: GameRuntime;
  readonly #players: readonly Player[] = [new Player('local', 'Player 1', 0, true)];
  /** Players of the players service's seats, by seat index and id (the same object while a seat stays). */
  readonly #seated = new Map<string, Player>();

  constructor(rt: GameRuntime) {
    this.#rt = rt;
    this.world = new World(rt);
    this.time = new Time(rt);
    this.scenes = new ScenesApi(rt);
  }

  /** Every seat in play: the players service's (local_players, net), else the one local player. */
  get players(): Player[] {
    const service = this.#rt.kernel?.tryService(PLAYERS_SERVICE);
    if (service === undefined) return [...this.#players];
    return seatPlayers(service).map((seat) => {
      const key = `${seat.index}:${seat.id}`;
      let player = this.#seated.get(key);
      if (player === undefined || player.name !== seat.name || player.local !== seat.local) {
        player = new Player(seat.id, seat.name, seat.index, seat.local, () => {
          const id = seat.entity();
          return id === null ? null : this.#rt.wrap(id);
        });
        this.#seated.set(key, player);
      }
      return player;
    });
  }
  get seed(): number { return this.#rt.seed; }

  /** Engine-facing (the built-in SettingsPanel): the game's `languages=`. */
  __languages__(): readonly string[] { return this.#rt.game.languages; }

  /** The live resource instance; mutate its fields directly. */
  get(...args: unknown[]): object {
    const a = bindArgs('get', args, { positional: ['resource'], keyword: ['player'], required: ['resource'] }).args;
    const player = a['player'];
    if (player !== undefined && player !== null && !this.players.some((p) => p.__eq__(player))) {
      fail('PP3013', 'get(player=) names a player who is not in the game');
    }
    return this.#rt.resource(resourceId(a['resource'], 'get'));
  }

  modify(...args: unknown[]): void {
    const { kind, field, init } = modifierInit('modify', args);
    this.#rt.kernel.modifyResource(resourceId(kind, 'modify'), field, init);
  }

  base(resource: unknown, field: string): unknown {
    return this.#rt.kernel.resourceBase(resourceId(resource, 'base'), field);
  }

  config(kind: unknown): object { return this.#rt.config(kind); }
  content(kind: unknown): ContentList<unknown> { return this.#rt.contentList(kind); }

  /** Restore these resources to their declared defaults. */
  reset(...resources: unknown[]): void {
    for (const kind of resources) this.#rt.resetResource(resourceId(kind, 'reset'));
  }

  emit(event: unknown): void {
    const ctor = (event as { constructor?: unknown } | null)?.constructor;
    if (typeof event !== 'object' || event === null || typeof (ctor as { __event_def__?: unknown })?.__event_def__ !== 'object') {
      const name = typeof event === 'function' ? event.name : String(event);
      fail('PP3015', `emit() takes an event instance, got ${name}`, { fix: `Construct it: ctx.emit(${name}(...)).` });
    }
    this.#rt.kernel.emit(eventDefOf(ctor, 'emit'), event as Record<string, unknown>);
  }

  /** A localized string in the player's language, with {named} args filled in. */
  text(key: unknown, ...args: unknown[]): string {
    const named = bindArgs('text', args, { restKeywords: true }).restKeywords;
    if (!(key instanceof TextRef)) fail('PP3014', `text() takes a Text key or Localized text, got ${String(key)}`);
    return formatText(this.#rt.localize(key), named, key.key);
  }

  /** Start a task `async def f(ctx, task)`, owned by the caller. */
  run(fn: unknown): Handle {
    if (typeof fn !== 'function') fail('PP3016', 'run() takes an async function `async def f(ctx, task)`');
    const body = (fn as (ctx: Context, task: Task) => unknown)(this, new Task(this.#rt));
    if (typeof body !== 'object' || body === null || typeof (body as { next?: unknown }).next !== 'function') {
      fail('PP3016', 'run() needs an async function', { fix: 'Declare it `async def f(ctx, task)`.' });
    }
    const owner = this.#rt.owner;
    return new Handle(this.#rt.kernel.run(owner, this.#rt.ownedTask(owner, body as TaskBody)));
  }

  tween(...args: unknown[]): Handle { return tween(this.#rt, args); }
}
