/**
 * The ease table cinematic keys use: the engine's one table (core `EASES`, the SDK's `Ease`
 * names — sdk/parallax/__init__.pyi), so a cinematic key eases exactly like `math.ease`,
 * tweens and model joints. Every curve maps 0 → 0 and 1 → 1.
 */

import { ease as coreEase, EASE_KINDS, EASES } from '../../../core/index.js';

export { EASES };

export const EASE_NAMES: readonly string[] = EASE_KINDS;

/** The key's default ease (the SDK's `move_to` default). */
export const DEFAULT_EASE = 'in_out_quad';

/** `ease(name, t)` with t clamped to 0–1; the name must be in EASES (the parser checks it). */
export function ease(name: string, t: number): number {
  return coreEase(name, t);
}
