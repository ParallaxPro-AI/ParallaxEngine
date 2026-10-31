/**
 * Keys a panel's `data-key` shortcut took. The press is the panel's, not the game's: the
 * keydown stops at the surface (its capture listener on the window), so the game's input
 * never sees it. Without that, a key that closes a modal also reached `toggle_with` and the
 * gameplay actions in the same frame (the modal's mute had just lifted): P on a crafting
 * panel's Close also opened the pause menu. The key's auto-repeats are the panel's too,
 * until a fresh press: they would otherwise read as a new press once the panel was gone.
 */

/** The part of a keydown this needs. */
export interface ClaimableKey {
  readonly code: string;
  readonly repeat: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export class ClaimedKeys {
  readonly #codes = new Set<string>();

  /** A shortcut took this keydown: keep it (and its repeats) from the game's input. */
  claim(e: ClaimableKey): void {
    this.#codes.add(e.code);
    e.preventDefault();
    e.stopPropagation();
  }

  /** True (and stopped) for an auto-repeat of a claimed key. A fresh press ends the claim. */
  swallow(e: ClaimableKey): boolean {
    if (!this.#codes.has(e.code)) return false;
    if (!e.repeat) {
      this.#codes.delete(e.code);
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
}
