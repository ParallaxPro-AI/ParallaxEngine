/**
 * The voice port: players' microphones and the audio links between them. The voice plugin
 * decides who talks to whom, when a player transmits (push-to-talk, voice activity, open
 * mic, mute), and how loud and from where each voice is heard (positional, from the
 * talker's entity relative to the camera); a device carries the audio — in the browser over
 * WebRTC (Opus, echo cancellation and noise suppression by the browser), headless as a fake
 * for tests.
 *
 * Signalling (offers, answers, ICE candidates) is opaque text the device produces and
 * consumes; the plugin relays it over the match's net session. Peers are named by the
 * players' stable ids (`Player.id`).
 */

export type MicState = 'off' | 'requesting' | 'live' | 'denied' | 'unavailable';

export type VoiceLinkState = 'connecting' | 'open' | 'closed';

export interface VoicePeer {
  readonly id: string;
  readonly state: VoiceLinkState;
  /** 0..1 loudness of what this peer is sending now (talking indicators). */
  readonly level: number;
}

export interface VoiceSignal {
  /** The peer it is for (outgoing) or from (incoming). */
  readonly peer: string;
  readonly payload: string;
}

/** How one peer's voice is heard now. */
export interface VoicePlayback {
  /** Final gain 0..1: distance falloff × volume × master, 0 when muted. */
  readonly gain: number;
  /** -1 (left) .. 1 (right). */
  readonly pan: number;
}

export interface VoiceDevice {
  readonly mic: MicState;
  /** Ask for the microphone (a browser asks the player; call it from a click or key press). */
  openMic(): void;
  closeMic(): void;
  /** 0..1 loudness of the local microphone now (voice activity reads it). */
  micLevel(): number;
  /** Whether the local microphone's audio is sent to peers now. */
  transmit(on: boolean): void;
  /** Open an audio link; `initiator` makes the offer (exactly one side of a pair is). */
  connect(peer: string, initiator: boolean): void;
  disconnect(peer: string): void;
  receiveSignal(signal: VoiceSignal): void;
  /** Signals to relay since the last call, oldest first. */
  takeSignals(): VoiceSignal[];
  peers(): readonly VoicePeer[];
  play(peer: string, playback: VoicePlayback): void;
  close(): void;
}
