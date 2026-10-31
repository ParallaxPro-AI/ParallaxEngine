/**
 * Autosave: every 30 s, unsaved documents are saved — but
 * not while the game plays (or is paused), and not in the middle of a gizmo drag or another
 * save. A tick that finds a drag or a save under way tries again shortly after, so the edit
 * is kept once the drag ends; a tick during play waits for the next one. No DOM here: the
 * editor feeds it its state and the page's timers (tests use fake timers).
 */

export interface AutosaveState {
  /** There are unsaved documents. */
  readonly dirty: boolean;
  /** The game is playing or paused (not edit mode). */
  readonly playing: boolean;
  /** A gizmo drag is in progress. */
  readonly dragging: boolean;
  /** A save is in progress. */
  readonly saving: boolean;
}

export const AUTOSAVE_MS = 30_000;
/** How soon a tick held back by a drag or a save looks again. */
export const AUTOSAVE_RETRY_MS = 1_000;

export type AutosaveVerdict = 'save' | 'clean' | 'playing' | 'busy';

/** What a tick does in `state`: save, nothing to save, wait for the next tick (playing), or look again soon (busy). */
export function autosaveVerdict(state: AutosaveState): AutosaveVerdict {
  if (!state.dirty) return 'clean';
  if (state.playing) return 'playing';
  if (state.dragging || state.saving) return 'busy';
  return 'save';
}

export interface AutosaveOptions {
  readonly state: () => AutosaveState;
  readonly save: () => Promise<void> | void;
  readonly intervalMs?: number;
  readonly retryMs?: number;
}

export class Autosave {
  readonly #options: AutosaveOptions;
  #interval: ReturnType<typeof setInterval> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;

  constructor(options: AutosaveOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#interval !== undefined;
  }

  start(): void {
    if (this.#interval !== undefined) return;
    this.#interval = setInterval(() => this.tick(), this.#options.intervalMs ?? AUTOSAVE_MS);
  }

  stop(): void {
    if (this.#interval !== undefined) clearInterval(this.#interval);
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#interval = undefined;
    this.#retry = undefined;
  }

  /** One check now (the interval's, or the page being hidden); answers what it did. */
  tick(): AutosaveVerdict {
    if (this.#retry !== undefined) {
      clearTimeout(this.#retry);
      this.#retry = undefined;
    }
    const verdict = autosaveVerdict(this.#options.state());
    if (verdict === 'save') void Promise.resolve(this.#options.save()).catch(() => {});
    else if (verdict === 'busy' && this.#interval !== undefined) {
      this.#retry = setTimeout(() => this.tick(), this.#options.retryMs ?? AUTOSAVE_RETRY_MS);
    }
    return verdict;
  }
}
