/**
 * Editor settings kept per browser: the graphics quality the editor runs the game at.
 * `auto` follows the device's tier; the others set `Settings.quality` (the renderer's
 * quality ladder) on the running game. Persisted in localStorage, best effort.
 */

import type { Editor } from './editor.js';
import { urlQuality } from './quality_override.js';

export type GraphicsQuality = 'auto' | 'low' | 'medium' | 'high';

export const QUALITIES: readonly GraphicsQuality[] = ['auto', 'low', 'medium', 'high'];

const STORE = 'parallax-editor:quality';

export function savedQuality(): GraphicsQuality {
  try {
    const raw = globalThis.localStorage?.getItem(STORE);
    if (raw !== null && raw !== undefined && (QUALITIES as readonly string[]).includes(raw)) return raw as GraphicsQuality;
  } catch {
    // No storage: the default.
  }
  return 'auto';
}

export function saveQuality(quality: GraphicsQuality): void {
  try {
    globalThis.localStorage?.setItem(STORE, quality);
  } catch {
    // Not kept past this page.
  }
}

/** The game's own `Settings.quality` before the editor first set it, per kernel: what "auto" restores. */
const own = new WeakMap<object, unknown>();

/**
 * Set the running game's `Settings.quality` (when the game declares the settings resource).
 * Games type it as low / medium / high, so "auto" puts back the game's own value (its boot
 * default already follows the device's tier) rather than writing "auto".
 */
export function applyQuality(editor: Editor, quality: GraphicsQuality = urlQuality() ?? savedQuality()): void {
  const kernel = editor.session.runtime.kernel;
  if (kernel.registry.resources.get('settings')?.schema['quality'] === undefined) return;
  const settings = kernel.resource('settings');
  if (!own.has(kernel)) own.set(kernel, settings['quality']);
  settings['quality'] = quality === 'auto' ? own.get(kernel) : quality;
}
