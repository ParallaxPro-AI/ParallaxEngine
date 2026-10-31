/**
 * `?quality=low|medium|high|auto` (or `?tier=`) in the editor's URL: the graphics quality
 * for this page load, over the one saved in the settings (settings.ts), and not saved.
 * The tiers are the renderer's (render3d quality.ts: auto, low, medium, high); `ultra`
 * is read as high, and an unknown value is ignored.
 */

import type { GraphicsQuality } from './settings.js';

const ALIASES: Readonly<Record<string, GraphicsQuality>> = {
  auto: 'auto', low: 'low', medium: 'medium', med: 'medium', high: 'high', ultra: 'high',
};

/** The quality a URL's query asks for, else undefined. */
export function qualityFromSearch(search: string): GraphicsQuality | undefined {
  const params = new URLSearchParams(search);
  const raw = (params.get('quality') ?? params.get('tier'))?.trim().toLowerCase();
  return raw === undefined ? undefined : ALIASES[raw];
}

/** The page's `?quality=` override, else undefined. */
export function urlQuality(): GraphicsQuality | undefined {
  try {
    return qualityFromSearch(globalThis.location?.search ?? '');
  } catch {
    return undefined;
  }
}
