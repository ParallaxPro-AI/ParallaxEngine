/**
 * chat — text chat (sdk/parallax/chat.pyi). Server-authoritative: a line is accepted by
 * the authority (the only game in single player, the host, or the dedicated server), which
 * applies the rules below, logs it and sends it to every client over the `channels`
 * service (services/channels.ts). A client sends its text to the server and shows what
 * comes back, so every player sees the same lines in the same order.
 *
 * The rules, in order (each refusal is `chat_rejected` for the sender only):
 *   empty      nothing but spaces
 *   too_long   more than `max_length` characters (never cut short)
 *   rate       more than `burst` lines at once or `per_second` sustained, per player
 *              (a token bucket on real time)
 *   filtered   the game's `filter(ctx, player, text)` returned None — the profanity hook,
 *              which may also return a replacement text (masking). It runs on the authority.
 *
 * Accepted lines raise `chat_message` everywhere (unless that player is muted here). The log
 * keeps the last `history` lines and is this plugin's snapshot; mutes are local and not
 * replicated.
 */

import { fail } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { EventDef, Kernel, KernelPlugin } from '../../kernel/index.js';
import { CHANNELS_SERVICE, PLAYERS_SERVICE } from '../../services/index.js';

export const CHAT_EVENTS = {
  message: { id: 'chat_message' },
  rejected: { id: 'chat_rejected' },
} as const satisfies Record<string, EventDef>;

export const REJECT_REASONS = ['empty', 'too_long', 'rate', 'filtered'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

const TOPIC = 'chat';

export interface ChatLine {
  /** Increases with every accepted line (the authority's count). */
  readonly serial: number;
  /** The sender's seat and stable id (`Player.id`), and their name when they said it. */
  readonly seat: number;
  readonly player: string;
  readonly name: string;
  readonly text: string;
  /** The authority's game time when it was accepted. */
  readonly time: number;
}

export interface ChatHost {
  /** The game-facing Player for a seat, or null when that seat isn't in play. */
  player(kernel: Kernel, seat: number): unknown;
  /** The profanity hook: the text to keep (maybe masked), or null to refuse. Absent: keep all. */
  readonly filter?: (kernel: Kernel, player: unknown, text: string) => string | null;
}

export interface ChatOptions {
  readonly maxLength: number;
  readonly perSecond: number;
  readonly burst: number;
  readonly history: number;
  readonly host: ChatHost;
}

export interface ChatEngine {
  /** Say `text` as `seat` (a local player). False when refused here at once (empty, too long). */
  send(seat: number, text: string): boolean;
  /** The log, oldest first, without muted players' lines. */
  lines(): readonly ChatLine[];
  mute(player: string, muted: boolean): void;
  muted(player: string): boolean;
  /** The first local seat (who `ctx.chat.send` speaks as by default). */
  localSeat(): number;
}

export interface ChatPlugin extends KernelPlugin {
  readonly engine: ChatEngine;
}

interface Bucket { tokens: number; at: number }

function isLine(value: unknown): value is ChatLine {
  const v = value as Partial<ChatLine> | null;
  return typeof v === 'object' && v !== null && typeof v.serial === 'number' && typeof v.seat === 'number'
    && typeof v.player === 'string' && typeof v.name === 'string' && typeof v.text === 'string' && typeof v.time === 'number';
}

export function chat(options: ChatOptions): ChatPlugin {
  const check = (name: string, value: number, ok: boolean, rule: string): void => {
    if (!ok) fail('PP3470', `chat(${name}=${value}) must be ${rule}`);
  };
  check('max_length', options.maxLength, Number.isInteger(options.maxLength) && options.maxLength >= 1 && options.maxLength <= 2000, 'a whole number from 1 to 2000');
  check('per_second', options.perSecond, options.perSecond > 0 && Number.isFinite(options.perSecond), 'above 0');
  check('burst', options.burst, Number.isInteger(options.burst) && options.burst >= 1, 'a whole number of at least 1');
  check('history', options.history, Number.isInteger(options.history) && options.history >= 1 && options.history <= 1000, 'a whole number from 1 to 1000');

  let installed: Kernel | undefined;
  let log: ChatLine[] = [];
  let serial = 0;
  const mutes = new Set<string>();
  const buckets = new Map<number, Bucket>();
  /** Refusals decided at `send` (before the frame's events), raised at the next input hook. */
  let refusals: { seat: number; reason: RejectReason; text: string }[] = [];

  const kernelOf = (): Kernel => {
    if (installed === undefined) fail('PP9470', 'chat is used before its kernel was built');
    return installed;
  };

  const seatInfo = (kernel: Kernel, seat: number): { id: string; name: string } => {
    const seats = kernel.tryService(PLAYERS_SERVICE)?.seats();
    if (seats === undefined) {
      if (seat !== 0) fail('PP3471', `chat: seat ${seat} is not in play (single player has seat 0)`);
      return { id: 'player-0', name: 'Player 1' };
    }
    const found = seats.find((s) => s.index === seat);
    if (found === undefined) fail('PP3471', `chat: seat ${seat} is not in play`);
    return { id: found.id, name: found.name };
  };

  const reject = (kernel: Kernel, seat: number, reason: RejectReason, text: string): void => {
    const channels = kernel.tryService(CHANNELS_SERVICE);
    const local = channels === undefined || channels.role === 'client' || (kernel.tryService(PLAYERS_SERVICE)?.seats().find((s) => s.index === seat)?.local ?? true);
    if (local) kernel.emit(CHAT_EVENTS.rejected, { player: options.host.player(kernel, seat), reason, text });
    else channels.send(TOPIC, { reject: reason, text }, seat);
  };

  const takeToken = (kernel: Kernel, seat: number): boolean => {
    const now = kernel.time.realNow;
    const bucket = buckets.get(seat) ?? { tokens: options.burst, at: now };
    bucket.tokens = Math.min(options.burst, bucket.tokens + (now - bucket.at) * options.perSecond);
    bucket.at = now;
    buckets.set(seat, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };

  const show = (kernel: Kernel, line: ChatLine): void => {
    log.push(line);
    if (log.length > options.history) log = log.slice(log.length - options.history);
    if (!mutes.has(line.player)) {
      kernel.emit(CHAT_EVENTS.message, { player: options.host.player(kernel, line.seat), name: line.name, text: line.text, time: line.time });
    }
  };

  /** The authority's rules for a line from `seat`. */
  const accept = (kernel: Kernel, seat: number, raw: string): void => {
    const text = raw.trim();
    if (text.length === 0) return reject(kernel, seat, 'empty', raw);
    if ([...text].length > options.maxLength) return reject(kernel, seat, 'too_long', raw);
    if (!takeToken(kernel, seat)) return reject(kernel, seat, 'rate', text);
    let kept: string | null = text;
    if (options.host.filter !== undefined) {
      kept = options.host.filter(kernel, options.host.player(kernel, seat), text);
      if (kept !== null && typeof kept !== 'string') fail('PP3472', `chat filter returned ${String(kept)}`, { fix: 'Return the text to show (a str), or None to refuse it.' });
    }
    if (kept === null) return reject(kernel, seat, 'filtered', text);
    const who = seatInfo(kernel, seat);
    const line: ChatLine = { serial: ++serial, seat, player: who.id, name: who.name, text: kept, time: kernel.time.now };
    show(kernel, line);
    kernel.tryService(CHANNELS_SERVICE)?.send(TOPIC, { line: line as unknown as Json }, 'all');
  };

  const drain = (kernel: Kernel): void => {
    for (const r of refusals) kernel.emit(CHAT_EVENTS.rejected, { player: options.host.player(kernel, r.seat), reason: r.reason, text: r.text });
    refusals = [];
    const channels = kernel.tryService(CHANNELS_SERVICE);
    if (channels === undefined) return;
    for (const message of channels.receive(TOPIC)) {
      const payload = message.payload as JsonObject | null;
      if (typeof payload !== 'object' || payload === null) continue;
      if (channels.role === 'server') {
        // From a client: only plain text is taken; anything else is ignored.
        if (typeof message.from === 'number' && typeof payload['text'] === 'string') accept(kernel, message.from, payload['text']);
      } else if (message.from === 'server') {
        if (isLine(payload['line'])) {
          serial = Math.max(serial, payload['line'].serial);
          show(kernel, payload['line']);
        } else if (typeof payload['reject'] === 'string' && (REJECT_REASONS as readonly string[]).includes(payload['reject'])) {
          const seat = engine.localSeat();
          kernel.emit(CHAT_EVENTS.rejected, { player: options.host.player(kernel, seat), reason: payload['reject'], text: String(payload['text'] ?? '') });
        }
      }
    }
  };

  const engine: ChatEngine = {
    send(seat, text) {
      const kernel = kernelOf();
      if (typeof text !== 'string') fail('PP3473', `chat.send() text must be a str, got ${String(text)}`);
      const trimmed = text.trim();
      if (trimmed.length === 0 || [...trimmed].length > options.maxLength) {
        refusals.push({ seat, reason: trimmed.length === 0 ? 'empty' : 'too_long', text });
        return false;
      }
      const channels = kernel.tryService(CHANNELS_SERVICE);
      if (channels !== undefined && channels.role === 'client') {
        channels.send(TOPIC, { text: trimmed });
        return true;
      }
      accept(kernel, seat, trimmed);
      return true;
    },
    lines: () => log.filter((l) => !mutes.has(l.player)),
    mute(player, muted) {
      if (muted) mutes.add(player);
      else mutes.delete(player);
    },
    muted: (player) => mutes.has(player),
    localSeat() {
      const seats = kernelOf().tryService(PLAYERS_SERVICE)?.seats();
      if (seats === undefined) return 0;
      const local = seats.find((s) => s.local);
      if (local === undefined) fail('PP3471', 'chat.send(): this machine has no local player to speak as', { fix: 'Dedicated servers don\'t chat; pass player= on a host with several seats.' });
      return local.index;
    },
  };

  return {
    id: 'chat',
    events: Object.values(CHAT_EVENTS),
    engine,
    install(kernel) {
      if (installed !== undefined) fail('PP3470', 'This chat plugin is already installed in another kernel', { fix: 'Call chat() once per game.' });
      installed = kernel;
      kernel.addHook('input', () => drain(kernel));
    },
    snapshot: (): Json => ({ serial, log: log.map((l) => ({ ...l })) as unknown as Json, mutes: [...mutes].sort() }),
    restore(_kernel, state) {
      const s = state as JsonObject;
      serial = s['serial'] as number;
      log = (s['log'] as unknown as ChatLine[]).map((l) => ({ ...l }));
      mutes.clear();
      for (const m of s['mutes'] as string[]) mutes.add(m);
    },
  };
}
