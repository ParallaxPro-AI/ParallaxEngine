/**
 * The stored form of a save document: `{"parallax_save": 1, "info": {...}, "data": {...}}`,
 * one store entry per slot (`slot:<name>`) and one for the profile. `parallax_save` is the
 * engine's container format; the game's own versioning is `data.version` (migrations).
 * `info` (slots only) is what a save menu shows — scene, play time, when, label — read
 * without migrating or loading the document.
 */

import { fail } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { SaveDocument, SlotInfo } from '../../services/index.js';

/** Bumped when the container changes shape. */
export const STORED_FORMAT = 1;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringify(save: SaveDocument, info?: SlotInfo): string {
  return JSON.stringify({ parallax_save: STORED_FORMAT, ...(info !== undefined && { info }), data: save });
}

/** A stored slot's info; a slot written without one shows its scene and nothing else. */
export function parseInfo(text: string, where: string, fix: string): SlotInfo {
  const data = parseStored(text, where, fix);
  const info = (JSON.parse(text) as JsonObject)['info'];
  if (info === undefined) return { scene: data.scene, play_time: 0, saved_at: null, label: '', order: 0 };
  const ok = isObject(info) && typeof info['scene'] === 'string' && typeof info['play_time'] === 'number'
    && (info['saved_at'] === null || typeof info['saved_at'] === 'number') && typeof info['label'] === 'string' && typeof info['order'] === 'number';
  if (!ok) fail('PP3954', `${where} has a bad "info" block`, { fix });
  return info as unknown as SlotInfo;
}

/** A stored document, checked for the parts every document has. */
export function parseStored(text: string, where: string, fix: string): SaveDocument {
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch (error) {
    return fail('PP3954', `${where} is not readable: ${(error as Error).message}`, { fix });
  }
  if (!isObject(parsed) || parsed['parallax_save'] !== STORED_FORMAT || !isObject(parsed['data'])) {
    return fail('PP3954', `${where} is not a save this engine reads (container format ${JSON.stringify(isObject(parsed) ? parsed['parallax_save'] : null)}, expected ${STORED_FORMAT})`, { fix });
  }
  const data = parsed['data'];
  for (const key of ['resources', 'modifiers', 'entities'] as const) {
    if (!isObject(data[key])) fail('PP3954', `${where} has no "${key}" dict`, { fix });
  }
  if (typeof data['scene'] !== 'string') fail('PP3954', `${where} has no scene`, { fix });
  if (data['seed'] !== null && typeof data['seed'] !== 'number') fail('PP3954', `${where} has a bad seed`, { fix });
  // A deep copy: migrations rewrite it in place.
  return structuredClone(data) as unknown as SaveDocument;
}
