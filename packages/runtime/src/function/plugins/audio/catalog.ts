/**
 * Which sounds exist, and how a written reference names one. A sound is written as its
 * handle (`sfx/hit`, what `Assets.sfx.hit` names), the one spelling: its file path
 * (`assets/sfx/hit.ogg`) or a bare name (`hit`) is PP2063 with a fix naming the handle.
 * The handle's folder must match its use. A hosted sound
 * (`https://r2.parallaxpro.ai/assets/audio_sfx/…/<sha>.ogg`, core/remote_assets.ts) is its
 * own handle (the canonical URL), in either folder; it has a file only where the run can
 * fetch it (a browser) — headless it plays silently, like a sound of a data-only run.
 *
 * A synthesized sound has no recording: a built-in `synth/<name>` (synth_presets.ts), or the
 * game's `assets/sfx/<name>.synth.json` (synths.ts), whose handle is `sfx/<name>` like a
 * file's. Either plays through `AudioSound.synth`; it exists even without the asset files
 * (it is data), so data-only runs hear it too.
 */

import { closestMatch, fail, isAssetUrl, isRemoteAsset, remoteAssetProblem, remoteAssetUrl } from '../../../core/index.js';
import type { AudioSound, SynthSpec } from '../../../core/index.js';
import { requireHandleForm } from '../../../resource/index.js';
import { SYNTH_FILE, SYNTH_FOLDER, synthPreset } from './synths.js';

export type AudioFolder = 'sfx' | 'music';

const AUDIO_FILE = /^assets\/(sfx|music)\/([^/]+)\.(ogg|mp3|wav|m4a|aac|flac|webm|opus)$/i;
const HANDLE = /^(sfx|music)\/[a-z0-9_]+$/;
const PRESET = /^synth\/[a-z0-9_]+$/;

/** The handle a written reference names, or a coded error for a malformed one. */
export function audioHandle(written: string, folder: AudioFolder, where: string): string {
  if (isAssetUrl(written)) {
    const problem = remoteAssetProblem(written, folder);
    if (problem !== undefined) {
      fail('PP3500', `${where}: ${problem}`, { fix: `Use a hosted sound URL (https://r2.parallaxpro.ai/assets/….ogg/.mp3), or "${folder}/<name>".` });
    }
    return remoteAssetUrl(written)!;
  }
  if (written.startsWith(`${SYNTH_FOLDER}/`)) {
    if (!PRESET.test(written)) fail('PP3500', `${where}: "${written}" is not a built-in synth sound name`, { fix: 'Write "synth/<name>", e.g. "synth/ui_click" (SDK Synth.ui_click).' });
    if (folder !== 'sfx') {
      fail('PP3500', `${where}: "${written}" is a sound effect, not a music track`, {
        fix: 'Built-in synth sounds are effects: play them with ctx.audio.play or an AudioSource; music takes Assets.music.*.',
      });
    }
    return written;
  }
  // One spelling per sound: its handle. The file path and a bare name are PP2063, naming it.
  requireHandleForm(written, folder, where);
  const handle = written;
  if (!HANDLE.test(handle)) {
    fail('PP3500', `${where}: "${written}" is not a ${folder === 'sfx' ? 'sound' : 'music track'} name`, {
      fix: `Write "${folder}/<snake_case_name>", as \`Assets.${folder}.<name>\` names it.`,
    });
  }
  if (!handle.startsWith(`${folder}/`)) {
    fail('PP3500', `${where}: "${written}" is ${folder === 'sfx' ? 'a music track' : 'a sound effect'}, not ${
      folder === 'sfx' ? 'a sound effect' : 'a music track'}`, {
      fix: folder === 'sfx'
        ? 'Music plays through ctx.audio.music(...) or the scene\'s "music"; ctx.audio.play and AudioSource take Assets.sfx.*.'
        : `ctx.audio.music and the scene's "music" take Assets.music.*; move the file to assets/music/ or play it with ctx.audio.play.`,
    });
  }
  return handle;
}

/**
 * The sounds a game can play. Built from the project's file list; `null` = the asset
 * files aren't available (data-only playtests): handles are checked for form and folder,
 * and sounds carry no file.
 */
export class AudioCatalog {
  readonly #files: ReadonlyMap<string, string> | null;
  /** The game's `.synth.json` sounds by handle. */
  readonly #synths: ReadonlyMap<string, { readonly path: string; readonly spec: SynthSpec }>;
  /** Whether hosted sounds are fetched (a browser). */
  readonly #remote: boolean;

  constructor(
    assetFiles: readonly string[] | null, remote = false,
    synths: ReadonlyMap<string, { readonly path: string; readonly spec: SynthSpec }> = new Map(),
  ) {
    this.#remote = remote;
    this.#synths = synths;
    if (assetFiles === null) {
      this.#files = null;
      return;
    }
    const files = new Map<string, string>();
    for (const path of [...assetFiles, ...[...synths.values()].map((s) => s.path).filter((p) => !assetFiles.includes(p))]) {
      const match = SYNTH_FILE.exec(path) ?? AUDIO_FILE.exec(path);
      if (match === null) continue;
      const handle = `${match[1]!.toLowerCase()}/${match[2]!}`;
      const existing = files.get(handle);
      if (existing !== undefined) {
        fail('PP3510', `Two files are the sound "${handle}": ${existing} and ${path}`, {
          fix: 'Keep one format per sound; `Assets.sfx.<name>` must name exactly one file.',
        });
      }
      files.set(handle, path);
    }
    this.#files = files;
  }

  get checked(): boolean {
    return this.#files !== null;
  }

  /** Handles of the existing sounds (in one folder, or all). Empty when unchecked. */
  handles(folder?: AudioFolder): string[] {
    const all = this.#files === null ? [] : [...this.#files.keys()];
    return folder === undefined ? all : all.filter((h) => h.startsWith(`${folder}/`));
  }

  /** Whether a handle has a file (always true when unchecked). */
  has(handle: string): boolean {
    return this.#files === null || this.#files.has(handle) || this.#synths.has(handle) || isRemoteAsset(handle) || PRESET.test(handle);
  }

  /** Every recorded sound file, for the output to preload (synthesized sounds render on demand). */
  files(): string[] {
    return this.#files === null ? [] : [...this.#files.values()].filter((path) => SYNTH_FILE.exec(path) === null);
  }

  /** The synthesized sound a handle names, if it is one. */
  synth(handle: string): SynthSpec | undefined {
    return PRESET.test(handle) ? synthPreset(handle.slice(SYNTH_FOLDER.length + 1), `"${handle}"`) : this.#synths.get(handle)?.spec;
  }

  /** The sound a reference names; an unknown one fails with the closest existing name. */
  sound(written: string, folder: AudioFolder, where: string): AudioSound {
    const handle = audioHandle(written, folder, where);
    if (isRemoteAsset(handle)) return { handle, file: this.#remote ? handle : null };
    if (PRESET.test(handle)) return { handle, file: null, synth: synthPreset(handle.slice(SYNTH_FOLDER.length + 1), where) };
    const synth = this.#synths.get(handle);
    if (synth !== undefined) return { handle, file: null, synth: synth.spec };
    if (this.#files === null) return { handle, file: null };
    const file = this.#files.get(handle);
    if (file === undefined) {
      const known = this.handles(folder);
      const guess = closestMatch(handle, known);
      fail('PP2063', `${where}: unknown ${folder === 'sfx' ? 'sound' : 'music track'} "${handle}"`, {
        fix: guess !== undefined
          ? `Did you mean "${guess}"?`
          : `Add assets/${handle}.ogg (or .mp3/.wav).${known.length > 0 ? ` Known: ${known.slice(0, 8).join(', ')}.` : ''}`,
      });
    }
    return { handle, file };
  }
}
