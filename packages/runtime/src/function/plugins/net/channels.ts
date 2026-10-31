/**
 * Plugin messages over the session (services/channels.ts): each rides the reliable channel
 * as `{t: "channel", topic, payload}`. This module holds what the server and the client
 * share — the per-topic inbox messages wait in until their consumer pulls them, and the
 * checks a message must pass before it is sent (a payload too big is refused, never cut).
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { ChannelMessage } from '../../services/index.js';
import { isChannelTopic, MAX_CHANNEL_BYTES, MAX_CHANNEL_TOPIC } from './protocol.js';

/** Messages by topic, oldest first, until `take` drains a topic. */
export class ChannelInbox {
  readonly #topics = new Map<string, ChannelMessage[]>();

  put(topic: string, message: ChannelMessage): void {
    const list = this.#topics.get(topic);
    if (list === undefined) this.#topics.set(topic, [message]);
    else list.push(message);
  }

  take(topic: string): readonly ChannelMessage[] {
    const list = this.#topics.get(topic);
    if (list === undefined) return [];
    this.#topics.delete(topic);
    return list;
  }

  clear(): void {
    this.#topics.clear();
  }
}

/** PP3362 unless the topic and payload fit a channel message. */
export function checkOutgoing(topic: string, payload: Json): void {
  if (!isChannelTopic(topic)) {
    fail('PP3362', `A channel topic must be 1 to ${MAX_CHANNEL_TOPIC} characters, got ${JSON.stringify(topic)}`);
  }
  const size = JSON.stringify(payload ?? null).length;
  if (payload === undefined || size > MAX_CHANNEL_BYTES) {
    fail('PP3362', `A "${topic}" channel message is ${payload === undefined ? 'empty' : `${size} characters of JSON`}; at most ${MAX_CHANNEL_BYTES} fit`, {
      fix: 'Send less at once (split it, or send a reference the other side can look up).',
    });
  }
}
