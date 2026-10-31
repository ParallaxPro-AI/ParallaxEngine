/**
 * `parallax.chat` (sdk/parallax/chat.pyi): `ChatApi` (the type of `ctx.chat`), `ChatLine`,
 * the ChatMessage and ChatRejected events, and the `chat()` factory `parallax.plugins`
 * re-exports. Lines are checked and relayed by the chat plugin.
 */

import { bindArgs, fail } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import { CHAT_EVENTS, chat as chatPlugin } from '../function/plugins/chat/index.js';
import type { ChatEngine, ChatLine as Line } from '../function/plugins/chat/index.js';
import type { Context, Player } from './context.js';
import { eventHandle } from './events.js';

/** `@on(ChatMessage)`: player (None once they left), name, text, time. */
export const ChatMessage = eventHandle(CHAT_EVENTS.message, 'ChatMessage');
/** `@on(ChatRejected)`: player (who sent it), reason (empty, too_long, rate, filtered), text. Heard by the sender only. */
export const ChatRejected = eventHandle(CHAT_EVENTS.rejected, 'ChatRejected');

function playerAt(kernel: Kernel, seat: number): Player | null {
  return (kernel.context as Context).players.find((p) => p.index === seat) ?? null;
}

/** One line of the chat log. */
export class ChatLine {
  readonly #kernel: Kernel;
  readonly #line: Line;

  constructor(kernel: Kernel, line: Line) {
    this.#kernel = kernel;
    this.#line = line;
  }

  /** Who said it (None once they left the game). */
  get player(): Player | null {
    const p = playerAt(this.#kernel, this.#line.seat);
    return p !== null && p.id === this.#line.player ? p : null;
  }
  /** Their name when they said it. */
  get name(): string { return this.#line.name; }
  get text(): string { return this.#line.text; }
  /** Game time it was accepted. */
  get time(): number { return this.#line.time; }

  toString(): string { return `${this.#line.name}: ${this.#line.text}`; }
}

function playerArg(value: unknown, where: string): Player {
  if (typeof value === 'object' && value !== null && typeof (value as Player).index === 'number' && typeof (value as Player).id === 'string') return value as Player;
  return fail('PP3473', `${where} takes a Player (from ctx.players or an event), got ${value === null || value === undefined ? 'None' : String(value)}`);
}

/** `ctx.chat`: say things, read the log, mute people. */
export class ChatApi {
  readonly #kernel: Kernel;
  readonly #engine: ChatEngine;

  constructor(kernel: Kernel, engine: ChatEngine) {
    this.#kernel = kernel;
    this.#engine = engine;
  }

  /** `send(text, *, player=None)`: say `text` as this machine's player (or a local `player`). False when refused at once. */
  send(...args: unknown[]): boolean {
    const a = bindArgs('send', args, { positional: ['text'], keyword: ['player'], required: ['text'] }).args;
    const player = a['player'];
    const seat = player === undefined || player === null ? this.#engine.localSeat() : playerArg(player, 'send(player=)').index;
    if (typeof a['text'] !== 'string') fail('PP3473', `send() text must be a str, got ${String(a['text'])}`);
    return this.#engine.send(seat, a['text']);
  }

  /** The recent lines, oldest first (muted players left out). */
  get lines(): ChatLine[] {
    return this.#engine.lines().map((l) => new ChatLine(this.#kernel, l));
  }

  /** `mute(player, muted=True)`: hide a player's lines on this machine. */
  mute(...args: unknown[]): void {
    const a = bindArgs('mute', args, { positional: ['player', 'muted'], required: ['player'] }).args;
    this.#engine.mute(playerArg(a['player'], 'mute()').id, a['muted'] === undefined ? true : a['muted'] === true);
  }

  muted(...args: unknown[]): boolean {
    const a = bindArgs('muted', args, { positional: ['player'], required: ['player'] }).args;
    return this.#engine.muted(playerArg(a['player'], 'muted()').id);
  }
}

/** `parallax.plugins.chat(*, max_length=200, per_second=1, burst=5, history=50, filter=None)`. */
export function chat(...args: unknown[]): KernelPlugin {
  const a = bindArgs('chat', args, { keyword: ['max_length', 'per_second', 'burst', 'history', 'filter'] }).args;
  const num = (name: string, fallback: number): number => {
    const v = a[name] ?? fallback;
    if (typeof v !== 'number') fail('PP3470', `chat(${name}=...) must be a number, got ${String(v)}`);
    return v;
  };
  const filter = a['filter'];
  if (filter !== undefined && filter !== null && typeof filter !== 'function') fail('PP3470', 'chat(filter=...) must be a function (ctx, player, text) -> str | None');
  const plugin = chatPlugin({
    maxLength: num('max_length', 200), perSecond: num('per_second', 1), burst: num('burst', 5), history: num('history', 50),
    host: {
      player: playerAt,
      ...(typeof filter === 'function' && {
        filter: (kernel: Kernel, player: unknown, text: string) => (filter as (c: unknown, p: unknown, t: string) => unknown)(kernel.context, player, text) as string | null ?? null,
      }),
    },
  });
  return Object.assign(plugin, { namespace: { name: 'chat', create: (kernel: Kernel) => new ChatApi(kernel, plugin.engine) } });
}
