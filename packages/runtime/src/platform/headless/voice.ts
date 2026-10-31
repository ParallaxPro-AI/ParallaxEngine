/**
 * Fake voice devices (core `VoiceDevice`) for playtests: a `FakeVoiceNetwork` makes one
 * device per player; their "audio" is a loudness each test sets (`speak`), carried to
 * peers once their link has opened through the same offer/answer signalling a browser
 * does. Every playback setting is recorded, so tests assert who hears whom and how loud.
 */

import type { MicState, VoiceDevice, VoicePeer, VoicePlayback, VoiceSignal } from '../../core/index.js';

export class FakeVoiceNetwork {
  readonly #devices = new Map<string, FakeVoice>();

  device(id: string, options: { readonly denyMic?: boolean } = {}): FakeVoice {
    const device = new FakeVoice(this, id, options.denyMic === true);
    this.#devices.set(id, device);
    return device;
  }

  /** What `id` sends now (0 when it isn't transmitting or has no live mic). */
  sending(id: string): number {
    const d = this.#devices.get(id);
    return d === undefined || d.mic !== 'live' || !d.transmitting ? 0 : d.micLevel();
  }
}

export class FakeVoice implements VoiceDevice {
  readonly id: string;
  mic: MicState = 'off';
  transmitting = false;
  /** The last playback per peer. */
  readonly playback = new Map<string, VoicePlayback>();
  readonly #network: FakeVoiceNetwork;
  readonly #deny: boolean;
  #level = 0;
  readonly #links = new Map<string, 'connecting' | 'open'>();
  #outbox: VoiceSignal[] = [];

  constructor(network: FakeVoiceNetwork, id: string, deny: boolean) {
    this.#network = network;
    this.id = id;
    this.#deny = deny;
  }

  /** The test's microphone: how loud this player is speaking (0..1). */
  speak(level: number): void {
    this.#level = level;
  }

  openMic(): void { this.mic = this.#deny ? 'denied' : 'live'; }
  closeMic(): void { this.mic = 'off'; }
  micLevel(): number { return this.mic === 'live' ? this.#level : 0; }
  transmit(on: boolean): void { this.transmitting = on; }

  connect(peer: string, initiator: boolean): void {
    if (this.#links.has(peer)) return;
    this.#links.set(peer, 'connecting');
    if (initiator) this.#outbox.push({ peer, payload: JSON.stringify({ t: 'offer', from: this.id }) });
  }

  disconnect(peer: string): void {
    this.#links.delete(peer);
    this.playback.delete(peer);
  }

  receiveSignal(signal: VoiceSignal): void {
    const message = JSON.parse(signal.payload) as { t: string };
    if (!this.#links.has(signal.peer)) return;
    if (message.t === 'offer') {
      this.#links.set(signal.peer, 'open');
      this.#outbox.push({ peer: signal.peer, payload: JSON.stringify({ t: 'answer', from: this.id }) });
    } else if (message.t === 'answer') {
      this.#links.set(signal.peer, 'open');
    }
  }

  takeSignals(): VoiceSignal[] {
    const out = this.#outbox;
    this.#outbox = [];
    return out;
  }

  peers(): readonly VoicePeer[] {
    return [...this.#links].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, state]) => ({
      id, state, level: state === 'open' ? this.#network.sending(id) : 0,
    }));
  }

  play(peer: string, playback: VoicePlayback): void {
    this.playback.set(peer, playback);
  }

  close(): void {
    this.#links.clear();
    this.mic = 'off';
  }
}
