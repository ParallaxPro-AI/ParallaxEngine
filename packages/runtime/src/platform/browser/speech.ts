/**
 * Text-to-speech for the browser audio output (`ctx.audio.speak`): the Web Speech API's
 * `speechSynthesis`. Pages without it (or without any voice installed) stay silent — games
 * show spoken lines as subtitles too. The voice hint picks the first installed voice whose
 * name or language contains it (case-insensitive), e.g. "en-GB", "Daniel" or "female".
 */

import type { AudioSpeak } from '../../core/index.js';

/** The parts of `SpeechSynthesisUtterance` used. */
export interface UtteranceLike {
  text: string;
  pitch: number;
  rate: number;
  volume: number;
  voice: VoiceLike | null;
  lang: string;
}

/** The parts of `SpeechSynthesisVoice` used. */
export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
}

/** The parts of `window.speechSynthesis` used, plus a way to make utterances. */
export interface SpeechLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  getVoices(): readonly VoiceLike[];
  utterance(text: string): UtteranceLike;
}

/** The page's speech synthesis, or null where the browser has none. */
export function browserSpeech(): SpeechLike | null {
  const g = globalThis as unknown as {
    speechSynthesis?: { speak(u: unknown): void; cancel(): void; getVoices(): VoiceLike[] };
    SpeechSynthesisUtterance?: new (text: string) => UtteranceLike;
  };
  const synth = g.speechSynthesis;
  const Utterance = g.SpeechSynthesisUtterance;
  if (synth === undefined || Utterance === undefined) return null;
  return {
    speak: (u) => synth.speak(u),
    cancel: () => synth.cancel(),
    getVoices: () => synth.getVoices(),
    utterance: (text) => new Utterance(text),
  };
}

/** Pick an installed voice by a name or language hint ("en-GB", "Daniel", "female"). */
export function pickVoice(voices: readonly VoiceLike[], hint: string | null): VoiceLike | null {
  if (hint === null || hint === '') return null;
  const want = hint.toLowerCase();
  for (const parts of hint.split('|')) {
    const part = parts.trim().toLowerCase();
    if (part === '') continue;
    const found = voices.find((v) => v.name.toLowerCase().includes(part) || v.lang.toLowerCase() === part)
      ?? voices.find((v) => v.lang.toLowerCase().startsWith(part));
    if (found !== undefined) return found;
  }
  return voices.find((v) => v.name.toLowerCase().includes(want)) ?? null;
}

export class SpeechOutput {
  readonly #speech: SpeechLike | null;

  constructor(speech: SpeechLike | null) {
    this.#speech = speech;
  }

  /** Say a line; `busLevel` is the Settings master × sfx volume. */
  speak(command: AudioSpeak, busLevel: number): void {
    const speech = this.#speech;
    if (speech === null) return;
    try {
      if (command.interrupt) speech.cancel();
      const utterance = speech.utterance(command.text);
      utterance.pitch = Math.max(0, Math.min(2, command.pitch));
      utterance.rate = Math.max(0.1, Math.min(4, command.rate));
      utterance.volume = Math.max(0, Math.min(1, command.volume * busLevel));
      const voice = pickVoice(speech.getVoices(), command.voice);
      if (voice !== null) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      if (utterance.volume > 0) speech.speak(utterance);
    } catch {
      // A browser that refuses speech (no user gesture yet, no voices) leaves the line to its subtitle.
    }
  }

  stop(): void {
    try {
      this.#speech?.cancel();
    } catch {
      // nothing to stop
    }
  }
}
