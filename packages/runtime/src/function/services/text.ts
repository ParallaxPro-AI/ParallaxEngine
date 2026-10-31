/**
 * Engine-component text in the player's language. Text that engine components carry as
 * plain strings — a Nameplate's name, a Marker's label, an Interactable's prompt verb, an
 * ability slot's label — is source-language text or a locale key: shown as the player's
 * language has that key (locale/<language>.json), else as written. The same rule as touch
 * button labels; the language is `Settings.language`.
 */

import type { Kernel } from '../kernel/index.js';

const SETTINGS = 'settings';

export function engineText(kernel: Kernel, text: string): string {
  if (text === '' || !kernel.registry.resources.has(SETTINGS)) return text;
  const language = kernel.resource(SETTINGS)['language'];
  if (typeof language !== 'string') return text;
  return kernel.project.locales.get(language)?.strings[text] ?? text;
}
