/**
 * Pointer lock while the game plays: on a desktop, pressing
 * Play locks the pointer to the game view at once (the Play click is the user gesture a lock
 * needs), for every game unless it opts out with `Game(pointer_lock=False)` (the
 * manifest's `pointerLock: false`). Escape lets it go (the browser does that); a press on the
 * game view, or inside a scripted panel's frame, locks it again, and a press on the view is
 * the capture click, not game input (click to capture). The Game tab locks
 * again; Pause, Stop and the Scene tab free it.
 *
 * While the lock is held, wherever the game wants a cursor (a menu, the chess board, a HUD
 * button) the engine draws its virtual cursor, moved by the mouse, pressing what it is over
 * (platform/browser/input.ts: a lock the host took holds wherever the cursor is free), as the
 * product's engine did for a shown cursor under the lock. Mouse-look reads the same lock.
 */

import type { SessionMode } from './session/index.js';
import type { PlayView } from './viewport.js';

export interface LockSituation {
  readonly mode: SessionMode;
  readonly view: PlayView;
  /** A touch screen (no pointer lock; the touch controls are the input). */
  readonly touch: boolean;
  /** The game's `pointer_lock=` (default True). */
  readonly gameLocks: boolean;
}

/** Whether the game view should hold the pointer lock now. */
export function wantsPointerLock(s: LockSituation): boolean {
  return s.mode === 'playing' && s.view === 'game' && !s.touch && s.gameLocks;
}

/**
 * What a mode or view change does to the lock, called from the gesture that made it: Play,
 * Resume or the Game tab lock ('lock'); Pause, Stop and the Scene tab free the pointer
 * ('release'); anything else leaves it ('keep').
 */
export function lockChange(before: Pick<LockSituation, 'mode' | 'view'>, after: LockSituation): 'lock' | 'release' | 'keep' {
  const was = before.mode === 'playing' && before.view === 'game';
  if (wantsPointerLock(after)) return was ? 'keep' : 'lock';
  return after.mode !== 'playing' || after.view !== 'game' ? 'release' : 'keep';
}

/** Whether a press on the game view should capture the pointer (and be swallowed) instead of reaching the game. */
export function capturesPress(s: LockSituation, press: { readonly pointerType: string; readonly button: number }, locked: boolean): boolean {
  return !locked && press.pointerType === 'mouse' && press.button === 0 && wantsPointerLock(s);
}
